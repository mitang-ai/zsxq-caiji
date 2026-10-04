import {
  sourcePaths,
  normalizeGroups,
  normalizeTopic,
  answerRecord,
  commentRecord,
  unwrapSource,
} from "../shared/zsxq";
import {
  now,
  uid,
  base64Bytes,
  sha256,
  sourceIdentity,
  cleanUrl,
} from "./browser-core";
import { appendEvent, get, ingest, put, list, setMeta } from "./database";
import type { Attachment, Job, Scope, SourceRecord } from "./types";
export const SOURCE_ORIGIN = "https://wx.zsxq.com";
export type SourceOperation =
  | "self"
  | "groups"
  | "members"
  | "searchMembers"
  | "topics"
  | "detail"
  | "comments"
  | "article"
  | "fileDownload";
export interface SourceRequest {
  operation: SourceOperation;
  group_id?: string;
  topic_id?: string;
  article_id?: string;
  file_id?: string;
  image_id?: string;
  end_time?: string;
  index?: string;
  query?: string;
  count?: number;
}
export function sourcePath(req: SourceRequest): string {
  const count = Math.max(
      1,
      Math.min(req.operation === "comments" ? 30 : 20, Number(req.count) || 20),
    ),
    query = new URLSearchParams();
  let path: string;
  switch (req.operation) {
    case "self":
      return sourcePaths.self;
    case "groups":
      return sourcePaths.groups;
    case "article":
      return sourcePaths.article(req.article_id!);
    case "fileDownload":
      return sourcePaths.fileDownload(req.file_id!);
    case "members":
      path = sourcePaths.members(req.group_id!);
      break;
    case "searchMembers":
      path = sourcePaths.searchMembers(req.group_id!);
      if (!req.query || req.query.length > 100)
        throw new Error("成员搜索必须填 1–100 字符。");
      query.set("keyword", req.query);
      break;
    case "topics":
      path = sourcePaths.topics(req.group_id!);
      query.set("scope", "all");
      break;
    case "detail":
      return sourcePaths.detail(req.topic_id!);
    case "comments":
      path = sourcePaths.comments(req.topic_id!);
      query.set("sort_type", "by_interactions_count");
      query.set("with_sticky", "false");
      if (req.index) {
        if (req.index.length > 200) throw new Error("评论游标过长。");
        query.set("index", req.index);
      }
      break;
    default:
      throw new Error("不支持的来源业务动作。");
  }
  query.set("count", String(count));
  if (req.end_time) {
    if (req.end_time.length > 100) throw new Error("分页游标过长。");
    query.set("end_time", req.end_time);
  }
  return path + "?" + query;
}
export function pageIdentity(url: string): {
  group_id?: string;
  topic_id?: string;
} {
  const u = new URL(url);
  if (u.origin !== SOURCE_ORIGIN)
    throw new Error("请先打开已登录的 wx.zsxq.com 星球页面。");
  const route = u.pathname + u.hash;
  return {
    group_id: route.match(/(?:group|group_detail)\/(\d{1,24})(?:[/?#]|$)/)?.[1],
    topic_id: route.match(/(?:topic_detail|topic)\/(\d{1,24})(?:[/?#]|$)/)?.[1],
  };
}
export async function requestSource(req: SourceRequest): Promise<any> {
  sourcePath(req);
  const reply = await chrome.runtime.sendMessage({
    type: "source-business",
    request: req,
  });
  if (!reply?.ok) throw new Error(reply?.error ?? "来源请求没有返回。");
  return unwrapSource(reply.data);
}
export async function sourceContext(): Promise<{
  tab_id: number;
  url: string;
  group_id?: string;
  topic_id?: string;
}> {
  const reply = await chrome.runtime.sendMessage({ type: "source-context" });
  if (!reply?.ok) throw new Error(reply?.error ?? "没有找到知识星球页面。");
  return reply.context;
}
export async function groups(): Promise<{ id: string; name: string }[]> {
  return normalizeGroups(await requestSource({ operation: "groups" }));
}
export async function members(
  group_id: string,
  query = "",
): Promise<{ id: string; name: string }[]> {
  const d = await requestSource({
    operation: query ? "searchMembers" : "members",
    group_id,
    query,
    count: 20,
  });
  return (d.members ?? d.users ?? [])
    .map((m: any) => ({
      id: String(m.user_id ?? m.user?.user_id ?? m.owner?.user_id ?? ""),
      name: String(m.name ?? m.user?.name ?? m.owner?.name ?? "未命名成员"),
    }))
    .filter((m: any) => /^\d{1,24}$/.test(m.id));
}
export function withinScope(record: SourceRecord, scope: Scope): boolean {
  const time = Date.parse(record.created_at);
  return (
    record.group_id === scope.group_id &&
    (!scope.author_id || record.author_id === scope.author_id) &&
    scope.types.includes(record.source_key.entity_type) &&
    (!scope.from ||
      (Number.isFinite(time) && time >= Date.parse(scope.from))) &&
    (!scope.to || (Number.isFinite(time) && time <= Date.parse(scope.to)))
  );
}
function stopDate(records: SourceRecord[], scope: Scope): boolean {
  return (
    !!scope.from &&
    records.some(
      (r) =>
        Number.isFinite(Date.parse(r.created_at)) &&
        Date.parse(r.created_at) < Date.parse(scope.from!),
    )
  );
}
async function expandedTopic(raw: any): Promise<any> {
  const topic = structuredClone(raw),
    part =
      topic.talk ?? topic.question ?? topic.task ?? topic.solution ?? topic;
  const article = part.article;
  if (article && !article.content && article.article_id) {
    try {
      const data = await requestSource({
          operation: "article",
          article_id: String(article.article_id),
        }),
        a = data.article ?? data;
      if (typeof a.content === "string")
        part.article = { ...article, content: a.content };
    } catch {
      /* A failed fixed-route read remains partial; no guessed fallback. */
    }
  }
  return topic;
}
async function saveAttachments(
  record: SourceRecord,
  raw: any,
  enabled: boolean,
): Promise<void> {
  const part = raw.talk ?? raw.question ?? raw.task ?? raw.solution ?? raw;
  if (Array.isArray(part.images))
    record.images = part.images
      .map((i: any) => ({
        id: String(i.image_id ?? ""),
        url: cleanUrl(i.original?.url ?? ""),
      }))
      .filter(
        (i: any) => /^\d{1,24}$/.test(i.id) && i.url.startsWith("https://"),
      );
  let complete = true;
  if (
    /<img\b/i.test(String(part.article?.content ?? "")) &&
    !part.images?.length
  ) {
    complete = false;
    record.coverage.reasons.push(
      "长文含内嵌图像，但未返回可固定 image-ID 的原件元信息，附件覆盖保持 partial。",
    );
  }
  if ((part.images?.length ?? 0) > 0) {
    for (const image of part.images) {
      const id = String(image.image_id ?? "");
      if (!enabled) {
        complete = false;
        record.coverage.reasons.push("图片 " + id + " 本次未选择取得原件。");
        continue;
      }
      try {
        if (!/^\d{1,24}$/.test(id) || !image.original?.url)
          throw new Error("image_original_shape_unverified");
        const attachmentId =
          "source-image:" + sourceIdentity(record.source_key) + ":" + id;
        if ((await get<Attachment>("attachments", attachmentId))?.blob)
          continue;
        const topic_id = record.parent_entity_id ?? record.source_key.entity_id;
        if (!/^\d{1,24}$/.test(topic_id))
          throw new Error("image_parent_unverified");
        const reply = await chrome.runtime.sendMessage({
          type: "source-image",
          request: { operation: "detail", topic_id, image_id: id },
        });
        if (!reply?.ok) throw new Error("image_unavailable");
        const bytes = base64Bytes(reply.binary.data);
        if (
          bytes.length > 50 * 1024 * 1024 ||
          !String(reply.binary.mime).startsWith("image/")
        )
          throw new Error("image_type_unverified");
        const mime = String(reply.binary.mime).split(";")[0],
          extension =
            (
              {
                "image/jpeg": ".jpg",
                "image/png": ".png",
                "image/webp": ".webp",
                "image/gif": ".gif",
                "image/avif": ".avif",
              } as Record<string, string>
            )[mime] ?? "";
        await put("attachments", {
          id: attachmentId,
          name: "原图-" + id + extension,
          mime,
          size: bytes.length,
          hash: await sha256(bytes),
          blob: new Blob([new Uint8Array(bytes)], { type: mime }),
          source_key: record.source_key,
          status: "available",
        } satisfies Attachment);
      } catch {
        complete = false;
        record.coverage.reasons.push(
          "图片 " +
            id +
            " 未取得固定详情中可核验的 original 原件；保持 partial。",
        );
      }
    }
  }
  if (!record.files?.length) {
    record.coverage.attachments = complete ? "complete" : "partial";
    return;
  }
  if (!enabled) {
    record.coverage.attachments = "partial";
    record.coverage.reasons.push("本次未选择下载附件原件。");
    return;
  }
  for (const file of record.files) {
    if ((file.size ?? 0) > 50 * 1024 * 1024) {
      complete = false;
      record.coverage.reasons.push(
        "附件 " + file.name + " 超过单件 50 MiB 上限。",
      );
      continue;
    }
    try {
      const previous = (await list<Attachment>("attachments")).find(
        (a) =>
          a.id ===
            "source-file:" +
              sourceIdentity(record.source_key) +
              ":" +
              file.id &&
          a.status === "available" &&
          !!a.blob,
      );
      if (previous) continue;
      const reply = await chrome.runtime.sendMessage({
        type: "source-binary",
        request: { operation: "fileDownload", file_id: file.id },
      });
      if (!reply?.ok) throw new Error(reply?.error ?? "附件读取失败");
      const bytes = base64Bytes(reply.binary.data);
      if (bytes.length > 50 * 1024 * 1024) throw new Error("附件过大");
      await put("attachments", {
        id: "source-file:" + sourceIdentity(record.source_key) + ":" + file.id,
        name: file.name,
        mime: file.mime ?? reply.binary.mime ?? "application/octet-stream",
        size: bytes.length,
        hash: await sha256(bytes),
        blob: new Blob([new Uint8Array(bytes)], {
          type: file.mime ?? reply.binary.mime ?? "application/octet-stream",
        }),
        source_key: record.source_key,
        status: "available",
      } satisfies Attachment);
    } catch {
      complete = false;
      record.coverage.reasons.push(
        "附件 " + file.name + " 未取得可校验原件；不保留临时下载凭据。",
      );
    }
  }
  record.coverage.attachments = complete ? "complete" : "partial";
}
/** Inspect actual returned comment-shaped child objects, not guessed reply endpoint or field names. */
export function returnedComments(
  comments: any[],
): { comment: any; depth: number; parent_comment_id?: string; path: string }[] {
  const rows: {
      comment: any;
      depth: number;
      parent_comment_id?: string;
      path: string;
    }[] = [],
    seen = new Set<string>();
  const shaped = (v: any) =>
    v &&
    typeof v === "object" &&
    /^\d{1,24}$/.test(String(v.comment_id ?? "")) &&
    /^\d{1,24}$/.test(String(v.owner?.user_id ?? v.user?.user_id ?? "")) &&
    typeof v.text === "string";
  const visit = (
    value: any,
    depth: number,
    parent: string | undefined,
    path: string,
  ) => {
    if (depth > 20 || rows.length >= 10000 || !shaped(value)) return;
    const id = String(value.comment_id);
    if (!seen.has(id)) {
      seen.add(id);
      rows.push({ comment: value, depth, parent_comment_id: parent, path });
    }
    for (const [key, child] of Object.entries(value)) {
      if (["owner", "user"].includes(key)) continue;
      if (Array.isArray(child))
        child.forEach((v, i) =>
          visit(v, depth + 1, id, path + "." + key + "[" + i + "]"),
        );
      else if (shaped(child)) visit(child, depth + 1, id, path + "." + key);
    }
  };
  comments.forEach((c, i) => visit(c, 0, undefined, "comments[" + i + "]"));
  return rows;
}
export async function currentTopic(
  groupId?: string,
): Promise<{ saved: number; reason: string }> {
  const context = await sourceContext();
  if (!context.topic_id)
    throw new Error(
      "当前浏览器页不是帖详情页。打开具体帖子后再保存，或使用范围采集。",
    );
  const data = await requestSource({
    operation: "detail",
    topic_id: context.topic_id,
  });
  const t = await expandedTopic(data.topic ?? data);
  const gid =
    groupId ??
    String(t.group?.group_id ?? t.group_id ?? context.group_id ?? "");
  const r = normalizeTopic(t, gid);
  await saveAttachments(r, t, false);
  await ingest(r);
  const answer = answerRecord(t, gid);
  if (answer) await ingest(answer);
  return {
    saved: answer ? 2 : 1,
    reason:
      r.coverage.reasons.join("；") ||
      "已保存 API 返回的当前帖正文；讨论与附件覆盖度分别标记。",
  };
}
export async function createCapture(scope: Scope): Promise<Job> {
  if (
    !/^\d{1,24}$/.test(scope.group_id) ||
    (scope.author_id && !/^\d{1,24}$/.test(scope.author_id))
  )
    throw new Error("星球和成员必须使用稳定数字 ID。");
  if (
    !Number.isInteger(scope.max_pages) ||
    scope.max_pages < 1 ||
    scope.max_pages > 100
  )
    throw new Error("每次 1–100 页，串行采集。");
  if (
    scope.max_comments_pages !== undefined &&
    (!Number.isInteger(scope.max_comments_pages) ||
      scope.max_comments_pages < 1 ||
      scope.max_comments_pages > 100)
  )
    throw new Error("每帖本批评论预算 1–100 页。");
  const self = await requestSource({ operation: "self" }),
    source_user_id = String(self.user?.user_id ?? self.user_id ?? "");
  if (!/^\d{1,24}$/.test(source_user_id))
    throw new Error("尚未验证当前源站账号身份，先登录并检查来源连接。");
  const job: Job = {
    id: uid(),
    kind: "capture",
    title:
      "星球 " +
      scope.group_id +
      (scope.author_id ? " / 成员 " + scope.author_id : ""),
    status: "queued",
    created_at: now(),
    updated_at: now(),
    events: [],
    scope,
    checkpoint: {
      page: 0,
      end_time: null,
      saved: 0,
      finished: false,
      source_user_id,
    },
  };
  return put("jobs", job);
}
export async function runCapture(
  id: string,
  onProgress: () => void = () => {},
): Promise<void> {
  let job = await get<Job>("jobs", id);
  if (!job?.scope) throw new Error("采集任务不存在。");
  if (job.status === "complete" || job.status === "cancelled") return;
  const scope = job.scope;
  await setMeta("job-control:" + id, "run");
  job.status = "running";
  await appendEvent(
    job,
    "开始串行读取；浏览器必须保持登录，关闭完整页将暂停。",
  );
  onProgress();
  try {
    const self = await requestSource({ operation: "self" });
    if (
      String(self.user?.user_id ?? self.user_id ?? "") !==
      job.checkpoint.source_user_id
    )
      throw new Error(
        "源站账号与创建任务时不一致；原断点保留，请用原账号登录。",
      );
    job.checkpoint.pending_comments ??= {};
    const stopped = async () => {
      const j = await get<Job>("jobs", id);
      return j?.status === "paused" || j?.status === "cancelled";
    };
    const readComments = async (topicId: string) => {
      const checkpoint = (job!.checkpoint.pending_comments[topicId] ??= {
        index: undefined,
        page: 0,
        seen: [],
      });
      for (let n = 0; n < (scope.max_comments_pages ?? 5); n++) {
        if (await stopped()) return;
        const data = await requestSource({
          operation: "comments",
          topic_id: topicId,
          index: checkpoint.index,
          count: 30,
        });
        if (!Array.isArray(data.comments))
          throw new Error("评论返回结构未识别，保留该主题断点。");
        let fresh = 0;
        for (const row of returnedComments(data.comments)) {
          const cr = commentRecord(row.comment, topicId, scope.group_id);
          if (checkpoint.seen.includes(cr.source_key.entity_id)) continue;
          checkpoint.seen.push(cr.source_key.entity_id);
          fresh++;
          if (withinScope(cr, scope)) {
            if (row.depth) {
              cr.title = "子回复 · 主题 " + topicId;
              cr.coverage.reasons.push(
                "已归档本次实际返回的子回复节点：" +
                  row.path +
                  "；父评论 " +
                  row.parent_comment_id +
                  "，不代表回复分页完整。",
              );
            }
            await ingest(cr);
            job!.checkpoint.saved++;
            checkpoint.archive ??= [];
            checkpoint.archive.push({
              id: cr.source_key.entity_id,
              author: cr.author_name,
              author_id: cr.author_id,
              text: cr.text,
              depth: row.depth,
              parent_comment_id: row.parent_comment_id,
              source_url: cr.source_url,
              source_key: cr.source_key,
            });
          }
        }
        if (checkpoint.archive?.length) {
          const body =
            "# 本次可读讨论归档 · 主题 " +
            topicId +
            "\n\n星球 " +
            scope.group_id +
            (scope.author_id
              ? "，仅成员 " + scope.author_id + " 的返回节点"
              : "，源站本次实际返回节点") +
            "。未读到的子回复/独立分页仍是 partial。\n\n" +
            checkpoint.archive
              .map(
                (r: any) =>
                  "## " +
                  (r.depth ? "子回复" : "评论") +
                  " " +
                  r.id +
                  " · " +
                  r.author +
                  " (" +
                  r.author_id +
                  ")\n\n" +
                  (r.parent_comment_id
                    ? "父评论：" + r.parent_comment_id + "\n\n"
                    : "") +
                  r.text +
                  "\n\n来源：" +
                  r.source_url,
              )
              .join("\n\n---\n\n");
          const bytes = new TextEncoder().encode(body);
          await put("attachments", {
            id: "discussion:" + job!.id + ":" + topicId,
            name: "讨论归档-" + topicId + ".md",
            mime: "text/markdown;charset=utf-8",
            size: bytes.length,
            hash: await sha256(bytes),
            blob: new Blob([bytes]),
            source_key: checkpoint.archive[0].source_key,
            status: "available",
          } satisfies Attachment);
        }
        checkpoint.page++;
        const next =
          data.index === undefined || data.index === null
            ? ""
            : String(data.index);
        if (!data.comments.length || (data.comments.length < 30 && !next)) {
          delete job!.checkpoint.pending_comments[topicId];
          await appendEvent(
            job!,
            "主题 " + topicId + " 评论列表已到末页；嵌套回复未冒充完整讨论树。",
          );
          return;
        }
        if (!next || next === checkpoint.index || !fresh) {
          checkpoint.reason =
            "评论 index 游标缺失/重复或本页仅重复评论；保持 partial。";
          await appendEvent(job!, "主题 " + topicId + "：" + checkpoint.reason);
          return;
        }
        checkpoint.index = next;
        await appendEvent(
          job!,
          "主题 " +
            topicId +
            " 评论已读 " +
            checkpoint.page +
            " 页，按 comment_id 去重并保存 index 断点。",
        );
        onProgress();
        await new Promise((r) => setTimeout(r, 900));
      }
      checkpoint.reason = "达到每帖本批评论页数预算，继续时从 index 恢复。";
      await appendEvent(
        job!,
        "主题 " + topicId + " 评论部分完成：" + checkpoint.reason,
      );
    };
    for (const tid of Object.keys(job.checkpoint.pending_comments)) {
      await readComments(tid);
      if (await stopped()) return;
    }
    for (
      let page = Number(job.checkpoint.page) || 0;
      !job.checkpoint.finished && page < scope.max_pages;
      page++
    ) {
      const state = await get<Job>("jobs", id);
      if (state?.status === "paused" || state?.status === "cancelled") return;
      const data = await requestSource({
        operation: "topics",
        group_id: scope.group_id,
        end_time: job.checkpoint.end_time || undefined,
        count: 20,
      });
      const topics = data.topics;
      if (!Array.isArray(topics))
        throw new Error(
          "来源没有返回可识别的 topics 列表，已保留断点；未继续猜测接口。",
        );
      if (!topics.length) {
        job.checkpoint.finished = true;
        break;
      }
      const records: SourceRecord[] = [];
      for (const raw of topics) {
        const active = await get<Job>("jobs", id);
        if (active?.status === "paused" || active?.status === "cancelled")
          return;
        const basic = normalizeTopic(raw, scope.group_id);
        records.push(basic);
        let t = raw,
          detailRead = false;
        const candidateAnswer = answerRecord(raw, scope.group_id);
        if (
          withinScope(basic, scope) ||
          (candidateAnswer && withinScope(candidateAnswer, scope)) ||
          (scope.types.includes("answer") && !raw.answer)
        ) {
          try {
            const detail = await requestSource({
              operation: "detail",
              topic_id: String(raw.topic_id),
            });
            t = await expandedTopic(detail.topic ?? detail);
            detailRead = true;
          } catch {
            job.checkpoint.partial_body = true;
          }
        }
        const r = normalizeTopic(t, scope.group_id);
        if (!detailRead) {
          r.coverage.body = "partial";
          r.coverage.reasons.push(
            "只取得主题列表/摘要，固定详情接口未读到；不视为完整正文。",
          );
        }
        if (withinScope(r, scope)) {
          if (!scope.include_comments && r.coverage.comments === "partial")
            r.coverage.reasons.push("本次未选择读取讨论。");
          await saveAttachments(r, t, scope.include_attachments);
          await ingest(r);
          job.checkpoint.saved++;
          if (
            r.coverage.body !== "complete" ||
            r.coverage.attachments !== "complete"
          )
            job.checkpoint.partial_body = true;
        }
        if (t.answer?.article) {
          const expanded = await expandedTopic({ talk: t.answer });
          t.answer = expanded.talk;
        }
        const a = answerRecord(t, scope.group_id);
        if (a && withinScope(a, scope)) {
          if (!detailRead) {
            a.coverage.body = "partial";
            a.coverage.reasons.push("回答仅来自列表，未读到固定主题详情。");
          }
          await saveAttachments(
            a,
            { talk: t.answer },
            scope.include_attachments,
          );
          await ingest(a);
          job.checkpoint.saved++;
          if (
            a.coverage.body !== "complete" ||
            a.coverage.attachments !== "complete"
          )
            job.checkpoint.partial_body = true;
        }
        if (scope.include_comments && scope.types.includes("comment")) {
          const topicId = String(t.topic_id);
          job.checkpoint.pending_comments[topicId] ??= {
            index: undefined,
            page: 0,
            seen: [],
          };
          try {
            await readComments(topicId);
          } catch {
            await appendEvent(
              job,
              "主题 " +
                topicId +
                " 评论读取失败，保留 index 断点，不把他人评论归入主帖作者。",
            );
          }
        }
      }
      const cursor = String(topics.at(-1)?.create_time ?? "");
      job.checkpoint.page = page + 1;
      if (!cursor || cursor === job.checkpoint.end_time) {
        job.reason = "分页游标缺失或未变化，停止以免重复请求。";
        break;
      }
      job.checkpoint.end_time = cursor;
      await appendEvent(
        job,
        "已读取 " +
          job.checkpoint.page +
          " 页，保存/更新 " +
          job.checkpoint.saved +
          " 条；讨论按真实作者单独归属。",
      );
      onProgress();
      if (topics.length < 20 || stopDate(records, scope)) {
        job.checkpoint.finished = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 900));
    }
    const state = await get<Job>("jobs", id);
    if (state?.status === "paused" || state?.status === "cancelled") return;
    job.status =
      job.checkpoint.finished &&
      !job.checkpoint.partial_body &&
      !Object.keys(job.checkpoint.pending_comments).length
        ? "complete"
        : "partial";
    if (!job.checkpoint.finished)
      job.reason ??= "达到本次页数上限，保留 end_time 断点；不是全量星球归档。";
    await appendEvent(
      job,
      job.status === "complete"
        ? "本次可读取列表已结束；详情正文已单独读回。"
        : "部分采集完成：" +
            (job.reason ??
              "正文、附件或评论存在未完整读取项，查看材料覆盖度与主题断点。"),
    );
    onProgress();
  } catch (error) {
    job.status = "paused";
    job.reason = error instanceof Error ? error.message : "来源读取失败";
    await appendEvent(job, "停止并保留断点：" + job.reason);
    onProgress();
  }
}
