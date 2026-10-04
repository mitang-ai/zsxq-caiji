import {
  canonical,
  now,
  originUrl,
  sha256,
  uid,
  bytesBase64,
} from "./browser-core";
import { get, meta, put, setMeta, appendEvent } from "./database";
import { grantOrigin } from "./ai";
import { secret, setSecret } from "./vault";
import type { Attachment, Job, SyncTarget } from "./types";
import type { TransferBundle } from "../shared/transfer";
export async function pair(
  origin: string,
  code: string,
  label: string,
): Promise<SyncTarget> {
  const target = originUrl(origin);
  await grantOrigin(target);
  if (!code.trim() || code.length > 200)
    throw new Error("填写工作台设备页生成的配对码。");
  const r = await fetch(target + "/api/devices/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: code.trim(),
      label: label.trim() || "浏览器星笺插件",
    }),
    credentials: "omit",
    redirect: "error",
    signal: AbortSignal.timeout(20000),
  });
  const body = await r.json();
  if (!r.ok) throw new Error(body.error?.message ?? "配对失败。");
  if (typeof body.token !== "string" || typeof body.workspace_id !== "string")
    throw new Error("配对响应缺少设备令牌或绑定空间。");
  const selected: SyncTarget = {
    origin: target,
    workspace_id: body.workspace_id,
    label,
    paired_at: now(),
  };
  await setSecret("device:" + target, body.token);
  await setMeta("sync-target", selected);
  return selected;
}
export async function unpair(): Promise<void> {
  const target = await meta<SyncTarget | null>("sync-target", null);
  if (target) await setSecret("device:" + target.origin, "");
  await setMeta("sync-target", null);
}
async function targetRequest(
  target: SyncTarget,
  path: string,
  method = "GET",
  body?: unknown,
  key?: string,
): Promise<any> {
  if (
    !path.startsWith("/api/w/" + encodeURIComponent(target.workspace_id) + "/")
  )
    throw new Error("同步请求不在配对空间。");
  if (!(await chrome.permissions.contains({ origins: [target.origin + "/*"] })))
    throw new Error("工作台 origin 授权已撤销。");
  const token = await secret("device:" + target.origin);
  if (!token) throw new Error("设备令牌随浏览器重启锁定/清除，请重新配对。");
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: "Bearer " + token,
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (key) headers["X-Idempotency-Key"] = key;
  const response = await fetch(target.origin + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "omit",
    redirect: "error",
    signal: AbortSignal.timeout(60000),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error?.message ?? "同步返回 HTTP " + response.status);
  return data;
}
export async function uploadAttachment(
  target: SyncTarget,
  attachment: Attachment,
  job: Job,
): Promise<void> {
  if (!attachment.blob || attachment.status !== "available")
    throw new Error("附件 " + attachment.name + " 缺少本机原件。");
  const bytes = new Uint8Array(await attachment.blob.arrayBuffer());
  if (
    bytes.length !== attachment.size ||
    (await sha256(bytes)) !== attachment.hash
  )
    throw new Error("附件本机哈希校验失败。");
  const root = "/api/w/" + encodeURIComponent(target.workspace_id);
  job.checkpoint.uploads ??= {};
  let session = job.checkpoint.uploads[attachment.id];
  if (session?.complete) return;
  if (!session) {
    session = await targetRequest(target, root + "/uploads", "POST", {
      hash: attachment.hash,
      size: attachment.size,
      name: attachment.name,
      mime: attachment.mime,
      record_source_key: attachment.source_key,
    });
    job.checkpoint.uploads[attachment.id] = {
      id: String(session.id),
      offset: Number(session.offset) || 0,
    };
    await put("jobs", job);
  }
  let offset = Number(session.offset) || 0;
  const upload_id = String(session.id);
  if (
    !upload_id ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > bytes.length
  )
    throw new Error("已保存上传会话位置无效。");
  while (offset < bytes.length) {
    const state = await get<Job>("jobs", job.id);
    if (state?.status === "paused" || state?.status === "cancelled")
      throw new Error(
        "附件上传已暂停；重新确认后复用相同会话，重复片由服务端核对。",
      );
    const chunk = bytes.subarray(offset, offset + 1024 * 1024);
    const reply = await targetRequest(
      target,
      root + "/uploads/" + encodeURIComponent(upload_id) + "/chunks",
      "PUT",
      { offset, data_base64: bytesBase64(chunk) },
    );
    const next = Number(reply.offset);
    if (
      !Number.isSafeInteger(next) ||
      next < offset + chunk.length ||
      next > bytes.length
    )
      throw new Error("上传偏移与实际分块不一致。");
    offset = next;
    job.checkpoint.uploads[attachment.id].offset = offset;
    await appendEvent(
      job,
      "附件 " +
        attachment.name +
        " 已上传 " +
        offset +
        "/" +
        bytes.length +
        " 字节。",
    );
  }
  const receipt = await targetRequest(
    target,
    root + "/uploads/" + encodeURIComponent(upload_id) + "/complete",
    "POST",
    {},
  );
  job.checkpoint.uploads[attachment.id].complete = true;
  job.checkpoint.uploads[attachment.id].receipt = receipt;
  await appendEvent(
    job,
    "附件 " + attachment.name + " 服务端完成整文件哈希校验。",
  );
}
export async function syncBundle(
  bundle: TransferBundle,
  attachments: Attachment[],
  existingId?: string,
  onProgress: () => void = () => {},
): Promise<any> {
  const target = await meta<SyncTarget | null>("sync-target", null);
  if (!target) throw new Error("先配对指定工作台；配对不会上传本地资料。");
  const request_key = await sha256(
    canonical({
      digest: bundle.digest,
      target: target.origin,
      workspace: target.workspace_id,
    }),
  );
  const cached = await meta<any>("receipt:" + request_key, null);
  if (cached) return cached;
  const job: Job = existingId
    ? (await get<Job>("jobs", existingId))!
    : {
        id: uid(),
        kind: "sync",
        title: "同步到 " + target.origin + " / " + target.workspace_id,
        status: "queued",
        created_at: now(),
        updated_at: now(),
        events: [],
        checkpoint: { bundle, target, request_key, uploads: {} },
      };
  if (!job) throw new Error("同步任务不存在。");
  if (
    canonical(job.checkpoint.bundle) !== canonical(bundle) ||
    canonical(job.checkpoint.target) !== canonical(target)
  )
    throw new Error("同步内容或目标发生变化，请重新预览确认。");
  await setMeta("job-control:" + job.id, "run");
  job.status = "running";
  await appendEvent(job, "用户显式确认本次包含项与绑定目标后开始同步。");
  onProgress();
  try {
    for (const a of attachments) await uploadAttachment(target, a, job);
    const state = await get<Job>("jobs", job.id);
    if (state?.status === "paused" || state?.status === "cancelled") return;
    const receipt = await targetRequest(
      target,
      "/api/w/" + encodeURIComponent(target.workspace_id) + "/import",
      "POST",
      { bundle },
      request_key,
    );
    await setMeta("receipt:" + request_key, {
      ...receipt,
      target,
      verified_at: now(),
    });
    job.checkpoint.receipt = receipt;
    job.status = "complete";
    await appendEvent(
      job,
      "收到服务端逐项导入回执；仅回执列出的项视为已导入。",
    );
    onProgress();
    return receipt;
  } catch (error) {
    job.status = "paused";
    job.reason = error instanceof Error ? error.message : "上传中断";
    await appendEvent(job, "同步停止，保留相同幂等键与断点：" + job.reason);
    onProgress();
    throw error;
  }
}
