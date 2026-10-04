import type {
  Bundle,
  Fragment,
  Material,
  Revision,
  SourceKey,
  SourceRecord,
} from "./types";
import {
  createBundle,
  RecordSchema,
  recordVersionHash,
  fragmentsFor as sharedFragments,
  validateBundle as validatePortable,
  type TransferBundle,
} from "../shared/transfer";
export const VERSION = "1.0.0";
export const now = () => new Date().toISOString();
export const uid = () => crypto.randomUUID();
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return (
    "{" +
    Object.keys(value as object)
      .filter((k) => (value as any)[k] !== undefined)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canonical((value as any)[k]))
      .join(",") +
    "}"
  );
}
export async function sha256(
  value: string | Uint8Array | ArrayBuffer,
): Promise<string> {
  const bytes =
    typeof value === "string"
      ? new TextEncoder().encode(value)
      : value instanceof Uint8Array
        ? new Uint8Array(value)
        : value;
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
export function sourceIdentity(key: SourceKey): string {
  return [key.platform, key.group_id, key.entity_type, key.entity_id].join(":");
}
export function cleanUrl(raw: unknown): string {
  if (typeof raw !== "string") return "";
  try {
    const u = new URL(raw);
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
      return "";
    u.search = "";
    u.hash = "";
    return u.href;
  } catch {
    return "";
  }
}
export function baseUrl(raw: string): string {
  const u = new URL(raw.trim());
  if (u.username || u.password || u.search || u.hash)
    throw new Error("API 地址不能包含账号、密码、查询参数或片段。");
  if (
    u.protocol !== "https:" &&
    !(
      u.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)
    )
  )
    throw new Error("只允许 HTTPS 或本机 HTTP 地址。");
  return u.href.replace(/\/+$/, "");
}
export function originUrl(raw: string): string {
  const value = baseUrl(raw);
  const u = new URL(value);
  if (u.pathname !== "/") throw new Error("工作台地址只填 origin，不含路径。");
  return u.origin;
}
export function providerEndpoint(
  base: string,
  operation: "models" | "chat" | "responses" | "anthropic",
): string {
  return (
    baseUrl(base) +
    "/" +
    {
      models: "models",
      chat: "chat/completions",
      responses: "responses",
      anthropic: "messages",
    }[operation]
  );
}
export async function fragmentsFor(text: string): Promise<Fragment[]> {
  return sharedFragments(text);
}
export function revisionRecord(
  material: Material,
  revision: Revision,
): SourceRecord {
  const record = RecordSchema.parse(
    revision.record ?? {
      ...recordOf(material),
      title: revision.title,
      text: revision.text,
      hash: revision.hash,
      fragments: revision.fragments,
      coverage: revision.coverage,
      captured_at: revision.captured_at,
    },
  );
  return {
    ...record,
    hash: revision.hash,
    version_hash: recordVersionHash(record),
  };
}
interface Reference {
  material_id: string;
  revision_id: string;
  version_hash?: string;
  source_key?: SourceKey;
  quote?: string;
  fragment_id?: string;
  start?: number;
  end?: number;
}
/** A text hash or legacy UUID is usable only if the frozen version is uniquely identifiable. */
export function resolveReference(
  ref: Reference,
  materials: Material[],
): { material: Material; revision: Revision; record: SourceRecord } {
  const matching = materials.filter((m) =>
      ref.source_key
        ? sourceIdentity(m.source_key) === sourceIdentity(ref.source_key)
        : m.id === ref.material_id,
    ),
    candidates: {
      material: Material;
      revision: Revision;
      record: SourceRecord;
    }[] = [];
  for (const m of matching) {
    const revisions = m.revisions.length
      ? m.revisions
      : [
          {
            id: m.revision_id,
            material_id: m.id,
            title: m.title,
            text: m.text,
            hash: m.hash ?? "",
            fragments: m.fragments,
            coverage: m.coverage,
            captured_at: m.captured_at,
            record: recordOf(m),
          },
        ];
    for (const r of revisions) {
      const record = revisionRecord(m, r);
      if (
        !candidates.some((c) => c.record.version_hash === record.version_hash)
      )
        candidates.push({ material: m, revision: r, record });
    }
  }
  let found = candidates;
  if (ref.version_hash)
    found = found.filter((c) => c.record.version_hash === ref.version_hash);
  else {
    const exact = found.filter((c) => c.revision.id === ref.revision_id),
      full = found.filter((c) => c.record.version_hash === ref.revision_id);
    if (exact.length) found = exact;
    else if (full.length) found = full;
    else if (/^[a-f0-9]{64}$/.test(ref.revision_id))
      found = found.filter((c) => c.revision.hash === ref.revision_id);
  }
  if (ref.quote)
    found = found.filter((c) =>
      ref.start !== undefined && ref.end !== undefined
        ? c.record.text.slice(ref.start, ref.end) === ref.quote
        : c.record.text.includes(ref.quote!),
    );
  if (ref.fragment_id)
    found = found.filter((c) =>
      c.record.fragments.some((f) => f.id === ref.fragment_id),
    );
  if (found.length !== 1)
    throw new Error(
      found.length
        ? "来源版本存在歧义；同正文的标题/完整度版本不能自动改绑。"
        : "固定来源版本未找到；不能改绑最新原文。",
    );
  return found[0];
}
export async function makeBundle(
  records: SourceRecord[],
  annotations: Bundle["annotations"] = [],
  artifacts: Bundle["artifacts"] = [],
  attachments: Bundle["attachments"] = [],
  materialKeys: Record<string, SourceKey> = {},
  materials: Material[] = [],
): Promise<TransferBundle> {
  const portableRecords: SourceRecord[] = records.map((r) => ({
      ...r,
      version_hash: recordVersionHash(r),
    })),
    referenceRecords: SourceRecord[] = [];
  const portableReference = (ref: Reference) => {
    if (materials.length) {
      const fixed = resolveReference(
        { ...ref, source_key: ref.source_key ?? materialKeys[ref.material_id] },
        materials,
      );
      if (
        ![...portableRecords, ...referenceRecords].some(
          (r) =>
            sourceIdentity(r.source_key) ===
              sourceIdentity(fixed.record.source_key) &&
            r.version_hash === fixed.record.version_hash,
        )
      )
        referenceRecords.push(fixed.record);
      return {
        ...ref,
        source_key: fixed.record.source_key,
        revision_id: fixed.revision.hash,
        version_hash: fixed.record.version_hash,
      };
    }
    return {
      ...ref,
      source_key: ref.source_key ?? materialKeys[ref.material_id],
    };
  };
  const anns = annotations.map((a) => ({ ...a, ...portableReference(a) })),
    arts = artifacts.map((a) => ({
      ...a,
      citations: a.citations.map((c) => ({ ...c, ...portableReference(c) })),
      model_attribution: a.model_attribution
        ? JSON.stringify(a.model_attribution)
        : undefined,
    }));
  const allRecords = [...referenceRecords, ...portableRecords],
    hasOriginals = allRecords.every((r) => {
      const required = (r.files?.length ?? 0) + (r.images?.length ?? 0);
      return (
        !required ||
        attachments.filter(
          (a) =>
            a.source_key &&
            sourceIdentity(a.source_key) === sourceIdentity(r.source_key) &&
            a.status === "available",
        ).length >= required
      );
    });
  return createBundle({
    producer: { name: "xingjian-extension", version: VERSION },
    records: allRecords as TransferBundle["records"],
    annotations: anns,
    artifacts: arts,
    attachments: attachments.map((a) => ({
      ...a,
      record_source_key: (a as any).source_key,
    })),
    coverage: {
      body: allRecords.every((r) => r.coverage.body === "complete")
        ? "complete"
        : "partial",
      comments: allRecords.every((r) => r.coverage.comments === "complete")
        ? "complete"
        : "partial",
      attachments:
        hasOriginals &&
        allRecords.every((r) => r.coverage.attachments === "complete") &&
        attachments.every((a) => a.status === "available")
          ? "complete"
          : "partial",
      attachments_omitted: !hasOriginals,
      provenance_verification: "client_reported",
      reference_records_included: referenceRecords.length,
    },
  });
}
export async function validateBundle(raw: unknown): Promise<TransferBundle> {
  const checked = validatePortable(raw);
  if (!raw || typeof raw !== "object") throw new Error("资料包不是对象。");
  const b = raw as Bundle;
  if (
    b.schema_version !== 1 ||
    typeof b.bundle_id !== "string" ||
    typeof b.digest !== "string" ||
    !Array.isArray(b.records) ||
    !Array.isArray(b.annotations) ||
    !Array.isArray(b.artifacts) ||
    !Array.isArray(b.attachments)
  )
    throw new Error("只支持 TransferBundle v1。");
  const { digest, ...payload } = b;
  if ((await sha256(canonical(payload))) !== digest)
    throw new Error("资料包摘要校验失败。");
  const states = ["complete", "partial", "inaccessible", "failed"];
  const keys = new Set<string>();
  for (const r of b.records) {
    if (
      !r.source_key ||
      r.source_key.platform !== "zsxq" ||
      !r.source_key.group_id ||
      !r.source_key.entity_id ||
      typeof r.text !== "string" ||
      !r.coverage ||
      !states.includes(r.coverage.body) ||
      !states.includes(r.coverage.comments) ||
      !states.includes(r.coverage.attachments) ||
      !Array.isArray(r.coverage.reasons)
    )
      throw new Error("材料来源或覆盖度无效。");
    if (r.text.length > 500000) throw new Error("单条材料超过 50 万字符。");
    const k =
      sourceIdentity(r.source_key) +
      ":" +
      (r.version_hash ?? recordVersionHash(r));
    if (keys.has(k)) throw new Error("同一资料包有重复来源版本。");
    keys.add(k);
    if (r.source_url && cleanUrl(r.source_url) !== r.source_url)
      throw new Error("来源链接包含敏感参数或不安全协议。");
    if (r.hash && (await sha256(r.text)) !== r.hash)
      throw new Error("材料正文摘要不匹配。");
  }
  return checked;
}
export function recordOf(material: Material): SourceRecord {
  const record: SourceRecord = {
    source_key: material.source_key,
    group_id: material.group_id,
    author_id: material.author_id,
    author_name: material.author_name,
    title: material.title,
    text: material.text,
    created_at: material.created_at,
    source_url: cleanUrl(material.source_url),
    coverage: material.coverage,
    fragments: material.fragments,
    captured_at: material.captured_at,
    hash: material.hash,
    entity_type: material.source_key.entity_type,
    parent_entity_id: material.parent_entity_id,
    images: material.images,
    files: material.files,
  };
  return { ...record, version_hash: recordVersionHash(record) };
}
export function csvCell(value: unknown): string {
  let s = String(value ?? "");
  if (/^[\s]*[=+\-@]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
}
export function materialsCsv(materials: Material[]): string {
  return (
    "\uFEFF" +
    [
      [
        "标题",
        "作者",
        "星球ID",
        "来源类型",
        "时间",
        "来源链接",
        "正文完整度",
        "正文",
      ],
      ...materials.map((m) => [
        m.title,
        m.author_name,
        m.group_id,
        m.source_key.entity_type,
        m.created_at,
        m.source_url,
        m.coverage.body,
        m.text,
      ]),
    ]
      .map((row) => row.map(csvCell).join(","))
      .join("\r\n")
  );
}
export function markdownMaterial(m: Material): string {
  return `# ${m.title || "未命名材料"}\n\n- 来源作者：${m.author_name} (${m.author_id})\n- 当前星球：${m.group_id}\n- 来源类型：${m.source_key.entity_type}\n- 来源：${cleanUrl(m.source_url)}\n- 版本：${m.revision_id}\n- 完整度：正文 ${m.coverage.body} / 讨论 ${m.coverage.comments} / 附件 ${m.coverage.attachments}\n\n${m.text}\n\n${m.coverage.reasons.map((r) => "> " + r).join("\n")}\n`;
}
export function bytesBase64(bytes: Uint8Array): string {
  let result = "";
  for (let i = 0; i < bytes.length; i += 16384)
    result += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return btoa(result);
}
export function base64Bytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}
export function safeFileName(value: string): string {
  return (
    (value
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
      .trim()
      .slice(0, 100) || "星笺资料") + ".md"
  );
}
