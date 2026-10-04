import { strFromU8, strToU8, zipSync } from "fflate";
import { assertNoCredentials, readArchive } from "../../extension/archive";
import {
  canonical,
  sha256,
  validateBundle,
  type TransferBundle,
} from "../../shared/transfer";
import { api, endpoint } from "./api";

export interface LocalArchive {
  bundle: TransferBundle;
  blobs: Record<string, Uint8Array>;
  filename: string;
}
export interface UploadState {
  id: string;
  offset: number;
  complete?: boolean;
}
async function hashBytes(bytes: Uint8Array) {
  if (!globalThis.crypto?.subtle) return sha256(bytes);
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
export async function parseArchive(file: File): Promise<LocalArchive> {
  if (file.size > 200 * 1024 * 1024)
    throw new Error("本次文件上限 200 MiB，请拆分导入。");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const files = file.name.toLowerCase().endsWith(".zip")
    ? readArchive(bytes)
    : { "bundle.json": bytes };
  if (!files["bundle.json"])
    throw new Error("ZIP 中没有 bundle.json；不会读取未知文件。");
  if (files["bundle.json"].length > 16 * 1024 * 1024)
    throw new Error(
      "业务 JSON 超过本次导入上限 16 MiB，请分批导出/导入；附件使用独立分片通道。未上传任何文件。",
    );
  const raw: unknown = JSON.parse(strFromU8(files["bundle.json"]));
  assertNoCredentials(raw);
  const bundle = validateBundle(raw);
  const blobs: Record<string, Uint8Array> = {};
  for (const attachment of bundle.attachments) {
    const data = files[`attachments/${attachment.hash}`];
    if (!data) continue;
    if (
      data.byteLength !== attachment.size ||
      (await hashBytes(data)) !== attachment.hash
    )
      throw new Error(
        `附件 ${attachment.name} 的大小或 SHA-256 不符，未上传任何资料。`,
      );
    blobs[attachment.hash] = data;
  }
  return { bundle, blobs, filename: file.name };
}
export async function createArchive(
  wid: string,
  bundle: TransferBundle,
  progress: (text: string) => void = () => {},
): Promise<Uint8Array> {
  const json = strToU8(JSON.stringify(bundle, null, 2));
  if (json.length > 16 * 1024 * 1024)
    throw new Error(
      "本次原文证据包超过 16 MiB，请分批选择导出，避免生成无法恢复的 ZIP。",
    );
  const files: Record<string, Uint8Array> = { "bundle.json": json };
  let count = 0,
    total = 0;
  for (const a of bundle.attachments.filter((a) => a.status === "available")) {
    if (files[`attachments/${a.hash}`]) continue;
    total += a.size;
    if (total > 180 * 1024 * 1024)
      throw new Error("所选附件总量超过本次 ZIP 上限 180 MiB，请分批导出。");
    progress(`读取附件 ${++count}：${a.name}`);
    const response = await fetch(
      endpoint(wid, `/attachments/${encodeURIComponent(a.id)}`),
      { credentials: "same-origin", cache: "no-store" },
    );
    if (!response.ok)
      throw new Error(
        `附件 ${a.name} 下载失败（${response.status}），未生成不完整 ZIP；请重试或选择 JSON 元信息包。`,
      );
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length !== a.size || (await hashBytes(bytes)) !== a.hash)
      throw new Error(`附件 ${a.name} 校验失败，未导出损坏原件。`);
    files[`attachments/${a.hash}`] = bytes;
  }
  const missing = bundle.attachments.filter((a) => a.status !== "available");
  files["README.txt"] = strToU8(
    `集见 TransferBundle v1。包含固定历史原文、批注、成果与引用，成果引用也会携带其证据原文。\n已保存附件原件 ${count} 个，经 SHA-256 和大小校验；缺失或待保存 ${missing.length} 个，见 bundle.json。\n不包含 Cookie、Key、登录态或私有设备身份。\n`,
  );
  progress("生成 ZIP…");
  return zipSync(files, { level: 1 });
}
const b64 = (bytes: Uint8Array) => {
  let text = "";
  for (let i = 0; i < bytes.length; i += 8192)
    text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
};
export async function uploadArchiveAttachments(
  wid: string,
  archive: LocalArchive,
  states: Map<string, UploadState>,
  progress: (text: string) => void = () => {},
) {
  const done = new Set<string>();
  for (const attachment of archive.bundle.attachments) {
    const bytes = archive.blobs[attachment.hash];
    if (!bytes || done.has(attachment.hash)) continue;
    done.add(attachment.hash);
    const key = `${wid}:${attachment.hash}:${canonical(attachment.record_source_key)}`;
    let state = states.get(key);
    if (!state) {
      state = await api<UploadState>(endpoint(wid, "/uploads"), {
        method: "POST",
        body: {
          hash: attachment.hash,
          size: attachment.size,
          name: attachment.name,
          mime: attachment.mime,
          record_source_key: attachment.record_source_key,
        },
      });
      states.set(key, state);
    }
    if (state.complete) continue;
    while (state.offset < bytes.length) {
      progress(
        `上传 ${attachment.name} · ${Math.round((state.offset / bytes.length) * 100)}%`,
      );
      const chunk = bytes.subarray(
        state.offset,
        Math.min(bytes.length, state.offset + 1024 * 1024),
      );
      const result = await api<{ offset: number }>(
        endpoint(wid, `/uploads/${state.id}/chunks`),
        {
          method: "PUT",
          body: { offset: state.offset, data_base64: b64(chunk) },
        },
      );
      if (result.offset <= state.offset || result.offset > bytes.length)
        throw new Error("附件上传服务返回无效断点，已停止。");
      state.offset = result.offset;
      states.set(key, state);
    }
    progress(`校验 ${attachment.name}…`);
    await api(endpoint(wid, `/uploads/${state.id}/complete`), {
      method: "POST",
    });
    state.complete = true;
    states.set(key, state);
  }
}
export function importKey(bundle: TransferBundle) {
  return `web-${sha256(`${bundle.bundle_id}:${bundle.digest}`).slice(0, 64)}`;
}
