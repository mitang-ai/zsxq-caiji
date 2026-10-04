import { fragmentsFor, sha256, type SourceRecord } from "./transfer.js";
const numeric = (value: unknown) => {
  const s = String(value ?? "");
  if (!/^\d{1,24}$/.test(s)) throw new Error("invalid_source_id");
  return s;
};
// Observed in the currently served wx.zsxq.com/chunk-KILRP42Q.js on 2026-10-03.
// Response IDs must be preserved as strings before JSON.parse.
export function parseSourceJson(text: string): any {
  let out = "",
    quoted = false,
    escape = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      out += c;
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') {
      quoted = true;
      out += c;
      continue;
    }
    if (/\d/.test(c)) {
      let j = i;
      while (j < text.length && /[\d.eE+\-]/.test(text[j])) j++;
      const s = text.slice(i, j);
      out += /^\d{16,}$/.test(s) ? JSON.stringify(s) : s;
      i = j - 1;
    } else out += c;
  }
  return JSON.parse(out);
}
export async function sourceHeaders(url: string) {
  const requestId = crypto.randomUUID(),
    timestamp = Math.floor(Date.now() / 1000).toString();
  const bytes = new TextEncoder().encode(
    `${url.replace(/'/g, "%27")} ${timestamp} ${requestId}`,
  );
  const signature = [
    ...new Uint8Array(await crypto.subtle.digest("SHA-1", bytes)),
  ]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return {
    "X-Request-Id": requestId,
    "X-Timestamp": timestamp,
    "X-Version": "2.96.0",
    "X-Signature": signature,
    "X-Aduid": crypto.randomUUID(),
  };
}
export const sourcePaths = {
  self: "/v2/users/self",
  groups: "/v2/groups",
  topics: (g: string) => `/v2/groups/${numeric(g)}/topics`,
  members: (g: string) => `/v2/groups/${numeric(g)}/members`,
  searchMembers: (g: string) => `/v2/search/groups/${numeric(g)}/members`,
  detail: (t: string) => `/v2/topics/${numeric(t)}/info`,
  comments: (t: string) => `/v2/topics/${numeric(t)}/comments`,
  article: (a: string) => {
    if (!/^[\w-]{1,100}$/.test(a)) throw new Error("invalid_article_id");
    return `/v2/articles/${a}`;
  },
  fileDownload: (f: string) => `/v2/files/${numeric(f)}/download_url`,
};
export function unwrapSource(raw: any): any {
  const b = raw.body ?? raw;
  if (raw.success === false || b.succeeded === false)
    throw Object.assign(new Error("source_rejected"), {
      code: raw.error ? "official_denied" : String(b.code ?? "source_rejected"),
      status: raw.status_code ?? 400,
    });
  return b.resp_data ?? b;
}
export function normalizeGroups(
  raw: any,
): { id: string; group_id: string; name: string }[] {
  const d = unwrapSource(raw);
  return (d.groups ?? []).map((g: any) => ({
    id: numeric(g.group_id),
    group_id: numeric(g.group_id),
    name: String(g.name ?? "未命名星球"),
  }));
}
export function plainText(s: unknown): string {
  return String(s ?? "")
    .replace(/<e\b[^>]*title="([^"]*)"[^>]*\/?\s*>/g, (_m, title) => {
      try {
        return decodeURIComponent(title);
      } catch {
        return title;
      }
    })
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}
export function observedComments(
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
    v: any,
    depth: number,
    parent: string | undefined,
    path: string,
  ) => {
    if (depth > 20 || rows.length >= 10000 || !shaped(v)) return;
    const id = String(v.comment_id);
    if (seen.has(id)) return;
    seen.add(id);
    rows.push({ comment: v, depth, parent_comment_id: parent, path });
    for (const [key, child] of Object.entries(v)) {
      if (["owner", "user"].includes(key)) continue;
      if (Array.isArray(child))
        child.forEach((item, i) =>
          visit(item, depth + 1, id, `${path}.${key}[${i}]`),
        );
      else if (shaped(child)) visit(child, depth + 1, id, `${path}.${key}`);
    }
  };
  comments.forEach((c, i) => visit(c, 0, undefined, `comments[${i}]`));
  return rows;
}
export function normalizeTopic(raw: any, groupId: string): SourceRecord {
  const t = raw.topic ?? raw;
  const gid = numeric(t.group?.group_id ?? t.group_id ?? groupId);
  if (gid !== numeric(groupId)) throw new Error("group_identity_mismatch");
  const tid = numeric(t.topic_id);
  const part = t.talk ?? t.question ?? t.task ?? t.solution ?? t;
  const owner = part.owner ?? t.owner;
  const aid = numeric(owner?.user_id);
  const text = plainText(
    part.article?.content ?? part.text ?? t.content ?? t.text,
  );
  const article = part.article;
  const files = (part.files ?? []).map((f: any) => ({
    id: String(f.file_id),
    name: String(f.name ?? "附件"),
    size: f.size,
  }));
  const images = (part.images ?? [])
    .map((i: any) => ({
      id: String(i.image_id),
      url: String(i.original?.url ?? i.large?.url ?? i.thumbnail?.url ?? ""),
    }))
    .filter((i: any) => {
      try {
        const u = new URL(i.url);
        return (
          u.protocol === "https:" && !u.username && !u.password && !u.search
        );
      } catch {
        return false;
      }
    });
  const reasons =
    article && !article.content ? ["长文正文尚未通过详情阅读验证"] : [];
  return {
    source_key: {
      platform: "zsxq",
      group_id: gid,
      entity_type: "topic",
      entity_id: tid,
    },
    group_id: gid,
    entity_type: "topic",
    author_id: aid,
    author_name: String(owner?.name ?? ""),
    title: String(part.title ?? t.title ?? text.slice(0, 80)),
    text,
    created_at: String(t.create_time ?? ""),
    source_url: `https://wx.zsxq.com/topic/${tid}`,
    coverage: {
      body: article && !article.content ? "partial" : "complete",
      comments:
        (t.comments_count ?? t.counts?.comments) !== undefined &&
        Number(t.comments_count ?? t.counts?.comments) === 0
          ? "complete"
          : "partial",
      attachments: files.length || part.images?.length ? "partial" : "complete",
      reasons,
    },
    fragments: fragmentsFor(text),
    captured_at: new Date().toISOString(),
    hash: sha256(text),
    files,
    images,
  };
}
export function answerRecord(topic: any, groupId: string): SourceRecord | null {
  const a = topic.answer;
  if (!a?.owner?.user_id) return null;
  const r = normalizeTopic(
    { ...topic, talk: { ...a }, question: undefined },
    groupId,
  );
  r.source_key.entity_type = "answer";
  r.source_key.entity_id = `${topic.topic_id}:answer`;
  r.entity_type = "answer";
  r.parent_entity_id = String(topic.topic_id);
  r.coverage.comments = "complete";
  return r;
}
export function commentRecord(
  comment: any,
  topicId: string,
  groupId: string,
): SourceRecord {
  const owner = comment.owner ?? comment.user;
  const text = plainText(comment.text);
  return {
    source_key: {
      platform: "zsxq",
      group_id: numeric(groupId),
      entity_type: "comment",
      entity_id: numeric(comment.comment_id),
    },
    group_id: groupId,
    parent_entity_id: topicId,
    entity_type: "comment",
    author_id: numeric(owner?.user_id),
    author_name: String(owner?.name ?? ""),
    title: `评论 · 主题 ${numeric(topicId)}`,
    text,
    created_at: String(comment.create_time ?? ""),
    source_url: `https://wx.zsxq.com/topic/${numeric(topicId)}`,
    coverage: {
      body: "complete",
      comments: "partial",
      attachments: "partial",
      reasons: ["评论上下文单独保存；不代表作者主帖"],
    },
    fragments: fragmentsFor(text),
    captured_at: new Date().toISOString(),
    hash: sha256(text),
  };
}
