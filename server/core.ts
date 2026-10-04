import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type {} from "@fastify/cookie";
import {
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import {
  existsSync,
  writeFileSync,
  openSync,
  closeSync,
  writeSync,
  readSync,
  renameSync,
  unlinkSync,
  lstatSync,
  createReadStream,
  fsyncSync,
} from "node:fs";
import { join } from "node:path";
import { Store, type Entity } from "./store.js";
import {
  canonical,
  sha256,
  recordVersionHash,
  createBundle,
  validateBundle,
  RecordSchema,
  SourceKeySchema,
  type SourceRecord,
  type TransferBundle,
} from "../shared/transfer.js";

const now = () => new Date().toISOString();
const token = () => randomBytes(32).toString("base64url");
const roleNames = ["owner", "admin", "editor", "viewer"];
const states = ["unread", "read", "adopted", "ignored"];
const MAX_ATTACHMENT = 50 * 1024 * 1024;
type Req = FastifyRequest & {
  cookies?: Record<string, string>;
  params: any;
  body: any;
  query: any;
};
type Context = {
  userId: string;
  workspaceId: string;
  role: string;
  device?: Entity;
};

export function fail(
  code: string,
  message: string,
  status = 400,
  details?: unknown,
): never {
  throw Object.assign(new Error(message), {
    code,
    statusCode: status,
    details,
  });
}
function object(value: any): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("INVALID_INPUT", "需要 JSON 对象");
  return value;
}
function str(
  value: any,
  label: string,
  max = 1000,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (!allowEmpty && !value.trim()) ||
    value.includes("\0")
  )
    fail("INVALID_INPUT", `${label}格式不正确`);
  return value;
}
function strings(value: any, label: string, max = 10000): string[] {
  if (
    !Array.isArray(value) ||
    value.length > max ||
    value.some((x) => typeof x !== "string" || !x || x.length > 200)
  )
    fail("INVALID_INPUT", `${label}格式不正确`);
  return [...new Set(value)];
}
function email(value: any): string {
  const result = str(value, "邮箱", 254).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result))
    fail("INVALID_INPUT", "邮箱格式不正确");
  return result;
}
function publicUser(user: any) {
  return { id: user.id, email: user.email, name: user.name };
}
function sameSecret(a: string, b: string): boolean {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
function passwordInput(value: any): string {
  const password = str(value, "密码", 1024);
  if (password.length < 12) fail("WEAK_PASSWORD", "密码至少 12 个字符");
  return password;
}
async function passwordHash(
  password: string,
  salt = randomBytes(16).toString("hex"),
) {
  const hash = await new Promise<Buffer>((resolve, reject) =>
    scrypt(
      password,
      salt,
      64,
      { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  );
  return { salt, hash: hash.toString("hex"), algorithm: "scrypt-N32768-r8-p1" };
}
function checkOrigin(req: FastifyRequest): void {
  const origin = req.headers.origin;
  if (!origin) return;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    fail("ORIGIN_DENIED", "来源不允许", 403);
  }
  if (process.env.XINGJIAN_PUBLIC_URL) {
    let expected: URL;
    try {
      expected = new URL(process.env.XINGJIAN_PUBLIC_URL);
    } catch {
      fail("ORIGIN_CONFIGURATION", "服务来源配置无效", 500);
    }
    if (parsed.origin === expected.origin) return;
  }
  if (
    parsed.host !== req.headers.host ||
    parsed.protocol !== `${req.protocol}:`
  )
    fail("ORIGIN_DENIED", "来源不允许", 403);
}
export function audit(
  store: Store,
  uid: string,
  wid: string | undefined,
  action: string,
  targetId?: string,
  details: Record<string, any> = {},
) {
  // Callers must pass structured non-secret details, not arbitrary request bodies.
  store.put(
    "audit",
    {
      id: randomUUID(),
      actor_id: uid,
      workspace_id: wid,
      action,
      target_id: targetId,
      details,
      created_at: now(),
    },
    uid,
    wid,
  );
}
function member(store: Store, wid: string, uid: string) {
  return store.get("membership", `${wid}:${uid}`);
}
function privateWorkspace(w: any) {
  return w.kind !== "team";
}
function requireTeamWorkspace(store: Store, wid: string) {
  if (store.get("workspace", wid)?.kind !== "team")
    fail(
      "TEAM_REQUIRED",
      "请明确创建团队工作区并分享选定快照；个人或旧版私有空间不可邀请成员或作为分享目的地",
      403,
    );
}
function requireMembership(
  store: Store,
  wid: string,
  uid: string,
  write = false,
) {
  const m = member(store, wid, uid),
    w = store.get("workspace", wid);
  if (!m || !w || (privateWorkspace(w) && w.created_by !== uid))
    fail("WORKSPACE_NOT_FOUND", "工作区不存在或无权访问", 404);
  if (write && m.role === "viewer") fail("READ_ONLY", "当前角色仅可查看", 403);
  return m;
}
export function resolveToken(store: Store, raw: string): Entity | undefined {
  if (!raw || raw.length > 1000) return;
  const d = store.get<Entity>("device", sha256(raw));
  if (
    !d ||
    d.revoked_at ||
    !d.expires_at ||
    Date.parse(d.expires_at) <= Date.now() ||
    !store.get("user", d.user_id)
  )
    return;
  return d;
}
function deviceAllowed(req: FastifyRequest, d: Entity): boolean {
  const path = req.url.split("?")[0];
  const prefix = `/api/w/${d.workspace_id}/`;
  if (!path.startsWith(prefix)) return false;
  const rest = path.slice(prefix.length);
  const scopes: string[] = d.scopes ?? [];
  if (
    req.method === "GET" &&
    /^(materials(?:\/[^/]+)?|datasets(?:\/[^/]+)?|artifacts(?:\/[^/]+)?|attachments\/[^/]+)$/.test(
      rest,
    )
  )
    return scopes.includes("read");
  if (req.method === "GET" && rest === "export")
    return scopes.includes("export");
  if (req.method === "GET" && /^jobs\/[^/]+\/export$/.test(rest))
    return scopes.includes("export");
  if (req.method === "POST" && rest === "import")
    return scopes.includes("import");
  if (
    /^uploads(?:\/[^/]+(?:\/(?:chunks|complete))?)?$/.test(rest) &&
    ["POST", "PUT", "DELETE"].includes(req.method)
  )
    return scopes.includes("upload");
  if (/^jobs(?:\/[^/]+(?:\/(?:approve|pause|resume|cancel))?)?$/.test(rest))
    return req.method === "GET"
      ? scopes.includes("read")
      : scopes.includes("process");
  return false;
}
export function actor(
  request: FastifyRequest,
  store: Store,
): { userId: string; device?: Entity } {
  const req = request as Req;
  if (req.headers.authorization) {
    const match = /^Bearer ([^\s]+)$/.exec(req.headers.authorization);
    const d = match && resolveToken(store, match[1]);
    if (!d) fail("UNAUTHENTICATED", "设备令牌无效或已过期", 401);
    if (!deviceAllowed(req, d))
      fail("TOKEN_SCOPE_DENIED", "设备令牌不允许此操作", 403);
    requireMembership(store, d.workspace_id, d.user_id);
    return { userId: d.user_id, device: d };
  }
  const raw = req.cookies?.session;
  const session = raw && store.get("session", sha256(raw));
  if (
    !session ||
    Date.parse(session.expires_at) <= Date.now() ||
    !store.get("user", session.user_id)
  )
    fail("UNAUTHENTICATED", "请先登录", 401);
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    checkOrigin(req);
    const csrf = req.headers["x-csrf-token"];
    if (typeof csrf !== "string" || !sameSecret(csrf, session.csrf))
      fail("CSRF_INVALID", "请求校验失败，请刷新登录状态", 403);
  }
  return { userId: session.user_id };
}
export function workspace(
  request: FastifyRequest,
  store: Store,
  write = false,
): Context {
  const req = request as Req;
  const a = actor(req, store);
  const wid = str(req.params.wid, "工作区", 200);
  if (a.device && a.device.workspace_id !== wid)
    fail("TOKEN_SCOPE_DENIED", "令牌限定于已配对工作区", 403);
  const m = requireMembership(store, wid, a.userId, write);
  return { ...a, workspaceId: wid, role: m.role };
}
function accountOnly(req: FastifyRequest, store: Store) {
  const a = actor(req, store);
  if (a.device) fail("TOKEN_SCOPE_DENIED", "需要账户会话", 403);
  return a.userId;
}
function scoped(
  store: Store,
  kind: string,
  id: string,
  wid: string,
  active = true,
): any {
  const item = store.get(kind, id);
  if (!item || item.workspace_id !== wid || (active && item.archived_at))
    fail("NOT_FOUND", "记录不存在或无权访问", 404);
  return item;
}
function listWorkspaces(store: Store, uid: string) {
  return store.list("membership", { userId: uid }).flatMap((m) => {
    const w = store.get("workspace", m.workspace_id);
    return w && (!privateWorkspace(w) || w.created_by === uid)
      ? [{ ...w, role: m.role }]
      : [];
  });
}
function newWorkspace(
  store: Store,
  uid: string,
  name: string,
  kind: "personal" | "team" = "team",
) {
  const w = {
    id: randomUUID(),
    name,
    kind,
    created_by: uid,
    created_at: now(),
  };
  store.put("workspace", w, undefined, w.id);
  store.put(
    "membership",
    {
      id: `${w.id}:${uid}`,
      workspace_id: w.id,
      user_id: uid,
      role: "owner",
      created_at: now(),
    },
    uid,
    w.id,
  );
  audit(store, uid, w.id, "workspace.create", w.id);
  return { ...w, role: "owner" };
}
function reading(
  store: Store,
  material: any,
  uid: string,
  includeHistory = true,
) {
  const s = store.get(
    "reading_state",
    `${material.workspace_id}:${material.id}:${uid}`,
  );
  return {
    ...material,
    ...(s
      ? {
          status: s.status,
          tags: s.tags,
          starred: s.starred,
          reading_position: s.reading_position,
        }
      : {}),
    ...(includeHistory ? { revisions: material.revisions ?? [] } : {}),
  };
}
function recordFor(material: any, revision: any): SourceRecord {
  const metadata = revision.record_meta ?? material;
  const record: SourceRecord = {
    source_key: material.source_key,
    group_id: material.group_id,
    author_id: metadata.author_id,
    author_name: metadata.author_name,
    title: metadata.title,
    text: revision.text,
    entity_type: material.entity_type,
    created_at: metadata.created_at,
    source_url: metadata.source_url,
    coverage: revision.coverage,
    fragments: revision.fragments,
    captured_at: revision.captured_at,
    hash: revision.hash,
    ...(metadata.parent_entity_id
      ? { parent_entity_id: metadata.parent_entity_id }
      : {}),
    ...(revision.images ? { images: revision.images } : {}),
    ...(revision.files ? { files: revision.files } : {}),
  };
  return { ...record, version_hash: recordVersionHash(record) };
}

export function ingestRecord(
  store: Store,
  wid: string,
  uid: string,
  input: SourceRecord,
): { id: string; revision_id: string; status: string } {
  requireMembership(store, wid, uid, true);
  let record: SourceRecord;
  try {
    record = RecordSchema.parse(input);
    validateBundle(createBundle({ records: [record] }));
  } catch (e) {
    fail("INVALID_RECORD", e instanceof Error ? e.message : "资料格式不正确");
  }
  return store.transaction(() => {
    const identity = canonical(record.source_key);
    let material = store.findMaterialBySource(wid, identity);
    if (material && material.author_id !== record.author_id)
      fail(
        "SOURCE_AUTHOR_CONFLICT",
        "同一来源标识的作者发生冲突，需先核对源站证据",
        409,
      );
    if (
      material?.parent_entity_id &&
      (record as any).parent_entity_id &&
      material.parent_entity_id !== (record as any).parent_entity_id
    )
      fail("SOURCE_PARENT_CONFLICT", "同一评论来源标识的父主题发生冲突", 409);
    if (
      record.entity_type &&
      record.entity_type !== record.source_key.entity_type
    )
      fail("SOURCE_TYPE_CONFLICT", "内容类型与来源标识不一致");
    const metadata = {
      author_id: record.author_id,
      author_name: record.author_name,
      title: record.title,
      created_at: record.created_at,
      source_url: record.source_url,
      parent_entity_id: (record as any).parent_entity_id,
    };
    const contentKey = sha256(
      canonical({
        text: record.text,
        coverage: record.coverage,
        fragments: record.fragments,
        images: record.images ?? [],
        files: record.files ?? [],
        metadata,
      }),
    );
    const previous = material?.revisions?.find(
      (r: any) => r.content_key === contentKey,
    );
    if (previous)
      return { id: material.id, revision_id: previous.id, status: "unchanged" };
    const revision = {
      id: randomUUID(),
      material_id: material?.id ?? randomUUID(),
      hash: sha256(record.text),
      version_hash: recordVersionHash(record),
      text: record.text,
      fragments: record.fragments,
      coverage: record.coverage,
      captured_at: record.captured_at,
      content_key: contentKey,
      images: record.images ?? [],
      files: record.files ?? [],
      record_meta: metadata,
      source_truth: "client_reported",
    };
    const existed = !!material;
    const previousHead = material;
    const currentCapture = material?.revisions?.find(
      (r: any) => r.id === material.revision_id,
    )?.captured_at;
    const makeHead =
      !currentCapture ||
      !Number.isFinite(Date.parse(currentCapture)) ||
      !Number.isFinite(Date.parse(record.captured_at)) ||
      Date.parse(record.captured_at) >= Date.parse(currentCapture);
    material = {
      ...(material ?? {
        id: revision.material_id,
        workspace_id: wid,
        source_key: record.source_key,
        source_identity: identity,
        status: "unread",
        tags: [],
        starred: false,
        revisions: [],
        created_by: uid,
      }),
      group_id: record.group_id,
      author_id: record.author_id,
      author_name: record.author_name,
      title: record.title,
      text: record.text,
      entity_type: record.source_key.entity_type,
      parent_entity_id: (record as any).parent_entity_id,
      created_at: record.created_at,
      source_url: record.source_url,
      coverage: record.coverage,
      revision_id: revision.id,
      updated_at: now(),
      archived_at: undefined,
      revisions: [...(material?.revisions ?? []), revision],
    };
    if (!makeHead)
      material = {
        ...previousHead,
        updated_at: now(),
        revisions: material.revisions,
      };
    store.put(
      "revision",
      { ...revision, workspace_id: wid, source_key: record.source_key },
      uid,
      wid,
    );
    store.put("material", material, uid, wid);
    for (const artifact of store.list("artifact", { workspaceId: wid })) {
      if (
        artifact.citations?.some(
          (c: any) =>
            c.material_id === material.id &&
            c.revision_id !== material.revision_id,
        )
      )
        store.put("artifact", { ...artifact, stale: true });
    }
    audit(
      store,
      uid,
      wid,
      existed ? "material.revision" : "material.import",
      material.id,
      { revision_id: revision.id },
    );
    return {
      id: material.id,
      revision_id: revision.id,
      status: existed ? "updated" : "created",
    };
  });
}
function revisionFor(store: Store, wid: string, mid: string, rid: string) {
  const m = scoped(store, "material", mid, wid, false);
  const r = m.revisions.find((x: any) => x.id === rid);
  if (!r) fail("REVISION_NOT_FOUND", "原文版本不存在", 404);
  return { material: m, revision: r };
}
function validateCitations(store: Store, wid: string, value: any) {
  if (!Array.isArray(value) || value.length > 10000)
    fail("INVALID_INPUT", "引用格式不正确");
  return value.map((c) => {
    object(c);
    const { material, revision } = revisionFor(
      store,
      wid,
      str(c.material_id, "资料", 200),
      str(c.revision_id, "版本", 200),
    );
    const versionHash = recordVersionHash(recordFor(material, revision));
    if (c.version_hash !== undefined && c.version_hash !== versionHash)
      fail("CITATION_INVALID", "引用版本指纹与固定原文版本不一致");
    const out: any = {
      material_id: material.id,
      revision_id: revision.id,
      version_hash: versionHash,
      source_key: material.source_key,
    };
    if (c.label !== undefined) out.label = str(c.label, "引用标签", 100);
    if (c.citation_id !== undefined)
      out.citation_id = str(c.citation_id, "引用标识", 200);
    if (c.fragment_id !== undefined) {
      out.fragment_id = str(c.fragment_id, "段落", 200);
      if (!revision.fragments.some((f: any) => f.id === out.fragment_id))
        fail("CITATION_INVALID", "引用段落不属于原文版本");
    }
    if (c.quote !== undefined) {
      out.quote = str(c.quote, "引用文本", 10000, true);
      if (!revision.text.includes(out.quote))
        fail("CITATION_INVALID", "引用文本不属于原文版本");
    }
    return out;
  });
}
function checkBase(item: any, base: any): void {
  if (
    base !== item.revision &&
    base !== item.revision_id &&
    base !== item.current_revision
  )
    fail("REVISION_CONFLICT", "成果已变更，请先读取最新版本", 409, {
      revision: item.revision,
      revision_id: item.revision_id,
    });
}
function appendArtifact(
  store: Store,
  item: any,
  uid: string,
  patch: any,
  reason: string,
) {
  const next = {
    ...item,
    ...patch,
    revision: (item.revision ?? 0) + 1,
    revision_id: randomUUID(),
    updated_at: now(),
  };
  next.current_revision = next.revision_id;
  const version = {
    id: next.revision_id,
    revision: next.revision,
    title: next.title,
    body: next.body,
    citations: next.citations,
    status: next.status,
    created_at: now(),
    created_by: uid,
    reason,
  };
  next.revisions = [...(item.revisions ?? []), version];
  store.put("artifact", next, item.created_by ?? uid, next.workspace_id);
  audit(store, uid, next.workspace_id, `artifact.${reason}`, next.id, {
    revision: next.revision,
  });
  return next;
}
export function createArtifact(
  store: Store,
  wid: string,
  uid: string,
  input: any,
) {
  requireMembership(store, wid, uid, true);
  const b = object(input);
  if (b.dataset_id !== undefined)
    scoped(store, "dataset", str(b.dataset_id, "专题", 200), wid);
  return store.transaction(() =>
    appendArtifact(
      store,
      {
        id: randomUUID(),
        workspace_id: wid,
        title: str(b.title, "成果标题", 1000),
        body: str(b.body ?? "", "成果正文", 1000000, true),
        citations: validateCitations(store, wid, b.citations ?? []),
        dataset_id: b.dataset_id,
        status: ["draft", "edited", "adopted"].includes(b.status)
          ? b.status
          : "draft",
        stale: (b.citations ?? []).some(
          (ref: any) =>
            store.get("material", ref.material_id)?.revision_id !==
            ref.revision_id,
        ),
        created_at: now(),
        created_by: uid,
        ...(b.model_attribution
          ? { model_attribution: str(b.model_attribution, "模型归因", 1000) }
          : {}),
        ...(b.job_id ? { job_id: str(b.job_id, "任务", 200) } : {}),
      },
      uid,
      {},
      b.job_id ? "process" : "create",
    ),
  );
}
function proposalView(proposal: any, artifact: any) {
  const conflict =
    !proposal.adopted_at &&
    !proposal.rejected_at &&
    proposal.base_revision !== artifact.revision_id;
  return {
    ...proposal,
    conflict,
    status: proposal.rejected_at
      ? "rejected"
      : proposal.adopted_at
        ? "adopted"
        : conflict
          ? "conflict"
          : "pending",
  };
}
export function createProposal(
  store: Store,
  wid: string,
  uid: string,
  input: any,
) {
  requireMembership(store, wid, uid, true);
  const b = object(input);
  return store.transaction(() => {
    const artifact = scoped(
      store,
      "artifact",
      str(b.artifact_id, "目标成果", 200),
      wid,
    );
    const base = artifact.revisions.find(
      (r: any) => r.id === b.base_revision || r.revision === b.base_revision,
    );
    if (!base)
      fail("REVISION_NOT_FOUND", "提案缺少目标成果的固定历史版本", 404);
    const job = scoped(store, "job", str(b.job_id, "提案任务", 200), wid);
    if (
      job.kind !== "process" ||
      job.user_id !== uid ||
      (job.target_artifact_id && job.target_artifact_id !== artifact.id)
    )
      fail("PROPOSAL_INVALID", "提案任务与执行者或目标成果不一致", 403);
    let draft: any;
    if (b.draft_artifact_id !== undefined) {
      draft = scoped(
        store,
        "artifact",
        str(b.draft_artifact_id, "提案草稿", 200),
        wid,
      );
      if (draft.id === artifact.id || draft.job_id !== job.id)
        fail("PROPOSAL_INVALID", "提案草稿不属于本次生成任务", 409);
    }
    const p = {
      id: randomUUID(),
      workspace_id: wid,
      artifact_id: artifact.id,
      base_revision: base.id,
      base_revision_number: base.revision,
      base_title: base.title,
      base_body: base.body,
      base_citations: base.citations,
      title: str(b.title, "提案标题", 1000),
      body: str(b.body ?? "", "提案正文", 1000000, true),
      citations: validateCitations(store, wid, b.citations ?? []),
      job_id: job.id,
      ...(draft ? { draft_artifact_id: draft.id } : {}),
      created_by: uid,
      created_at: now(),
      status: artifact.revision_id === base.id ? "pending" : "conflict",
    };
    store.put("proposal", p, uid, wid);
    audit(store, uid, wid, "proposal.create", p.id, {
      artifact_id: artifact.id,
      base_revision: base.id,
      job_id: job.id,
      conflict: p.status === "conflict",
    });
    return proposalView(p, artifact);
  });
}
export function datasetMaterials(store: Store, d: any): string[] {
  if (d.mode === "manual")
    return (d.material_ids as string[]).filter((id) => {
      const m = store.get("material", id);
      return m?.workspace_id === d.workspace_id && !m.archived_at;
    });
  const rule = d.rule ?? {};
  return store
    .materialSummaries(d.workspace_id, {
      q: rule.q,
      groupId: rule.group_id,
      authorId: rule.author_id,
    })
    .filter((m) => {
      const tags = reading(store, m, d.created_by, false).tags;
      return !rule.tags || rule.tags.every((t: string) => tags.includes(t));
    })
    .map((m) => m.id);
}
export function resolveDataset(store: Store, d: any): string[] {
  return datasetMaterials(store, d);
}
function datasetView(store: Store, d: any) {
  return {
    ...d,
    material_ids: datasetMaterials(store, d),
    snapshots: (d.snapshot_ids ?? [])
      .map((id: string) => store.get("snapshot", id))
      .filter(Boolean),
  };
}
function datasetInput(store: Store, wid: string, b: any) {
  const mode = b.mode ?? "manual";
  if (!["manual", "dynamic"].includes(mode))
    fail("INVALID_INPUT", "专题模式不正确");
  const ids = strings(b.material_ids ?? [], "资料列表");
  ids.forEach((id) => scoped(store, "material", id, wid));
  const rule: any = {};
  if (b.rule !== undefined) {
    object(b.rule);
    for (const key of ["q", "group_id", "author_id"])
      if (b.rule[key] !== undefined)
        rule[key] = str(b.rule[key], key, key === "q" ? 1000 : 200, true);
    if (b.rule.tags !== undefined)
      rule.tags = strings(b.rule.tags, "标签", 100);
  }
  return { name: str(b.name, "专题名称", 200), mode, material_ids: ids, rule };
}

export function createRecoveryToken(store: Store, userId: string): string {
  if (!store.get("user", userId)) fail("USER_NOT_FOUND", "用户不存在", 404);
  const raw = token();
  store.put(
    "recovery",
    {
      id: sha256(raw),
      user_id: userId,
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    },
    userId,
  );
  return raw;
}

export function exportBundle(
  store: Store,
  ctx: Context,
  mids: string[],
  aids: string[],
  includeAnnotations: boolean,
  includeAttachments: boolean,
  fixed: { material_id: string; revision_id: string }[] = [],
): TransferBundle {
  const materials = new Map<string, any>();
  const records = new Map<string, SourceRecord>();
  const add = (m: any, r: any) => {
    materials.set(m.id, m);
    records.set(`${m.id}:${r.id}`, recordFor(m, r));
  };
  for (const id of mids) {
    const m = scoped(store, "material", id, ctx.workspaceId);
    add(
      m,
      m.revisions.find((r: any) => r.id === m.revision_id),
    );
  }
  for (const item of fixed) {
    const { material, revision } = revisionFor(
      store,
      ctx.workspaceId,
      item.material_id,
      item.revision_id,
    );
    add(material, revision);
  }
  const artifacts = aids.map((id) =>
    scoped(store, "artifact", id, ctx.workspaceId),
  );
  const portable = (c: any) => {
    const { material, revision } = revisionFor(
      store,
      ctx.workspaceId,
      c.material_id,
      c.revision_id,
    );
    add(material, revision);
    return {
      ...c,
      source_key: material.source_key,
      revision_id: revision.hash,
      version_hash: recordVersionHash(recordFor(material, revision)),
    };
  };
  const portableArtifacts = artifacts.map((a) => ({
    id: a.id,
    title: a.title,
    body: a.body,
    citations: (a.citations ?? []).map(portable),
    status: a.status,
    created_at: a.created_at,
    model_attribution: a.model_attribution,
  }));
  const annotations = includeAnnotations
    ? store
        .list("annotation", {
          workspaceId: ctx.workspaceId,
          userId: ctx.userId,
        })
        .filter((a) => materials.has(a.material_id))
        .map(portable)
    : [];
  const attachments: TransferBundle["attachments"] = includeAttachments
    ? store
        .list("attachment", { workspaceId: ctx.workspaceId })
        .filter(
          (a) =>
            !a.archived_at &&
            a.record_source_key &&
            [...materials.values()].some(
              (m) => canonical(m.source_key) === canonical(a.record_source_key),
            ),
        )
        .map((a) => ({
          id: a.id,
          hash: a.hash,
          size: a.size,
          name: a.name,
          mime: a.mime,
          record_source_key: a.record_source_key,
          status: a.status === "available" ? "available" : "missing",
        }))
    : [];
  return createBundle({
    records: [...records.values()],
    annotations,
    artifacts: portableArtifacts,
    attachments,
    coverage: {
      revision_references: "source_key+version_hash",
      legacy_revision_references: "unique_source_key+sha256",
      attachments: includeAttachments ? "metadata_only" : "excluded",
    },
  });
}
function importBundle(store: Store, ctx: Context, bundle: TransferBundle) {
  type Reference = {
    id: string;
    revision_id: string;
    status: string;
    version_hash: string;
  };
  const references = new Map<string, Reference>();
  const textReferences = new Map<string, Map<string, Reference>>();
  const identityReferences = new Map<string, Map<string, Reference>>();
  const materialMappings = new Map<string, string>();
  const records = [...bundle.records]
    .sort((a, b) => a.captured_at.localeCompare(b.captured_at))
    .map((record) => {
      const result = ingestRecord(store, ctx.workspaceId, ctx.userId, record);
      const identity = canonical(record.source_key),
        textHash = sha256(record.text),
        versionHash = recordVersionHash(record),
        mapped = { ...result, version_hash: versionHash };
      references.set(`${identity}:${versionHash}`, mapped);
      const textKey = `${identity}:${textHash}`,
        sameText = textReferences.get(textKey) ?? new Map<string, Reference>();
      sameText.set(result.revision_id, mapped);
      textReferences.set(textKey, sameText);
      const sameSource =
        identityReferences.get(identity) ?? new Map<string, Reference>();
      sameSource.set(result.revision_id, mapped);
      identityReferences.set(identity, sameSource);
      return { source_key: record.source_key, hash: textHash, ...mapped };
    });
  const mappedReference = (c: any) => {
    if (!c.source_key)
      fail("REFERENCE_INVALID", "跨工作区引用必须携带 source_key");
    const identity = canonical(c.source_key);
    let mapped: Reference | undefined;
    if (c.version_hash !== undefined)
      mapped = references.get(`${identity}:${c.version_hash}`);
    else {
      mapped = references.get(`${identity}:${c.revision_id}`);
      if (!mapped) {
        const candidates = /^[a-f0-9]{64}$/.test(c.revision_id)
          ? textReferences.get(`${identity}:${c.revision_id}`)
          : identityReferences.get(identity);
        if (candidates && candidates.size > 1)
          fail(
            "REFERENCE_AMBIGUOUS",
            "旧版引用无法区分同一来源的多个原文版本，请从来源重新导出含版本指纹的包",
            400,
            { source_key: c.source_key, candidates: candidates.size },
          );
        mapped = candidates?.values().next().value;
      }
    }
    if (!mapped) fail("REFERENCE_INVALID", "引用缺少对应原文");
    materialMappings.set(c.material_id, mapped.id);
    return {
      ...c,
      material_id: mapped.id,
      revision_id: mapped.revision_id,
      version_hash: mapped.version_hash,
      source_key: c.source_key,
    };
  };
  const annotations = bundle.annotations.map((annotation) => {
    const mapped = mappedReference(annotation);
    const { revision } = revisionFor(
      store,
      ctx.workspaceId,
      mapped.material_id,
      mapped.revision_id,
    );
    if (
      mapped.end <= mapped.start ||
      mapped.end > revision.text.length ||
      revision.text.slice(mapped.start, mapped.end) !== mapped.quote
    )
      fail("ANNOTATION_INVALID", "批注锚点与导入原文不一致");
    const a = {
      ...mapped,
      id: randomUUID(),
      imported_id: annotation.id,
      workspace_id: ctx.workspaceId,
      user_id: ctx.userId,
      created_at: annotation.created_at ?? now(),
    };
    store.put("annotation", a, ctx.userId, ctx.workspaceId);
    return { imported_id: annotation.id, id: a.id };
  });
  const artifacts = bundle.artifacts.map((artifact) => {
    const citations = validateCitations(
      store,
      ctx.workspaceId,
      artifact.citations.map(mappedReference),
    );
    const a = appendArtifact(
      store,
      {
        id: randomUUID(),
        workspace_id: ctx.workspaceId,
        title: artifact.title,
        body: artifact.body,
        citations,
        status: artifact.status,
        created_at: artifact.created_at ?? now(),
        created_by: ctx.userId,
        stale: citations.some(
          (ref: any) =>
            store.get("material", ref.material_id)?.revision_id !==
            ref.revision_id,
        ),
        imported_id: artifact.id,
        model_attribution: artifact.model_attribution,
      },
      ctx.userId,
      {},
      "import",
    );
    return { imported_id: artifact.id, id: a.id, revision_id: a.revision_id };
  });
  const attachments = bundle.attachments.map((portable) => {
    safeFilename(portable.name);
    const ready = store
      .list("attachment", { workspaceId: ctx.workspaceId })
      .find(
        (a) =>
          a.hash === portable.hash &&
          a.size === portable.size &&
          a.status === "available",
      );
    const a = {
      ...portable,
      id: ready?.id ?? randomUUID(),
      workspace_id: ctx.workspaceId,
      status: ready ? "available" : "missing",
      imported_id: portable.id,
      created_by: ctx.userId,
    };
    store.put(
      "attachment",
      a,
      ready?.created_by ?? ctx.userId,
      ctx.workspaceId,
    );
    return {
      imported_id: portable.id,
      id: a.id,
      status: a.status,
      hash: a.hash,
    };
  });
  audit(store, ctx.userId, ctx.workspaceId, "bundle.import", bundle.bundle_id, {
    records: records.length,
    artifacts: artifacts.length,
    annotations: annotations.length,
  });
  return {
    bundle_id: bundle.bundle_id,
    records,
    artifacts,
    annotations,
    attachments,
    source_truth: "client_reported",
  };
}
function safeFilename(value: any) {
  const name = str(value, "文件名", 300);
  if (/[\\/:\x00-\x1f]/.test(name) || name === "." || name === "..")
    fail("UNSAFE_FILENAME", "文件名不得包含路径或控制字符");
  return name;
}
async function fileDigest(path: string) {
  if (lstatSync(path).isSymbolicLink())
    fail("UNSAFE_FILE", "附件路径异常", 500);
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest("hex");
}

export async function registerCore(
  app: FastifyInstance,
  store: Store,
): Promise<void> {
  // Never infer privacy from display names. Existing explicit memberships are the only legacy team evidence.
  store.transaction(() => {
    for (const w of store.list("workspace"))
      if (w.kind === undefined) {
        const memberships = store.list("membership", { workspaceId: w.id });
        const creatorOwns = memberships.some(
          (m) => m.user_id === w.created_by && m.role === "owner",
        );
        const kind =
          creatorOwns && new Set(memberships.map((m) => m.user_id)).size > 1
            ? "team"
            : "legacy_private";
        store.put("workspace", { ...w, kind, kind_migrated_at: now() });
        audit(store, w.created_by, w.id, "workspace.kind_migrate", w.id, {
          kind,
          reason:
            kind === "team"
              ? "existing_creator_owned_memberships"
              : "privacy_default",
        });
      }
  });
  // A process interruption must not leave a completed chunk upload permanently in a verification lock.
  // Completion always rechecks bytes and authorization; this is not an availability grant.
  for (const u of store.list("upload"))
    if (u.state === "verifying")
      store.put("upload", { ...u, state: "pending", recovered_at: now() });
  const sessionResponse = (
    req: FastifyRequest,
    reply: FastifyReply,
    user: any,
  ) => {
    const raw = token();
    const csrf = token();
    const expires = Date.now() + 7 * 24 * 60 * 60 * 1000;
    store.put(
      "session",
      {
        id: sha256(raw),
        user_id: user.id,
        csrf,
        created_at: now(),
        expires_at: new Date(expires).toISOString(),
      },
      user.id,
    );
    for (const s of store.list("session", { userId: user.id }).slice(0, -20))
      store.remove("session", s.id);
    reply.setCookie("session", raw, {
      path: "/",
      httpOnly: true,
      secure: req.protocol === "https" || process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60,
    });
    return {
      user: publicUser(user),
      workspaces: listWorkspaces(store, user.id),
      csrf,
    };
  };
  app.post(
    "/api/auth/register",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
      checkOrigin(request);
      const b = object(request.body);
      const address = email(b.email);
      const name = str(b.name, "姓名", 100).trim();
      const password = await passwordHash(passwordInput(b.password));
      const user = store.transaction(() => {
        if (store.list("user").some((u) => u.email === address))
          fail("EMAIL_EXISTS", "邮箱已注册", 409);
        const u = {
          id: randomUUID(),
          email: address,
          name,
          password,
          created_at: now(),
        };
        store.put("user", u, u.id);
        newWorkspace(store, u.id, `${name}的资料库`, "personal");
        audit(store, u.id, undefined, "auth.register", u.id);
        return u;
      });
      reply.code(201);
      return sessionResponse(request, reply, user);
    },
  );
  app.post(
    "/api/auth/login",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      checkOrigin(request);
      const b = object(request.body);
      const address = email(b.email);
      const pw = str(b.password, "密码", 1024);
      const user = store.list("user").find((u) => u.email === address);
      const actual = await passwordHash(
        pw,
        user?.password?.salt ?? "8f15d856a7fa7e6c489f979f3a9be61e",
      );
      // Recovery may commit while scrypt is running. Never mint a session from a stale credential snapshot.
      const current = user && store.get("user", user.id);
      if (
        !current ||
        current.password.salt !== user.password.salt ||
        !sameSecret(actual.hash, current.password.hash)
      )
        fail("LOGIN_INVALID", "邮箱或密码不正确", 401);
      audit(store, current.id, undefined, "auth.login", current.id);
      return sessionResponse(request, reply, current);
    },
  );
  app.get("/api/me", async (request) => {
    const uid = accountOnly(request, store);
    const session = store.get(
      "session",
      sha256((request as Req).cookies!.session),
    );
    return {
      user: publicUser(store.get("user", uid)),
      workspaces: listWorkspaces(store, uid),
      csrf: session.csrf,
    };
  });
  app.post("/api/auth/logout", async (request, reply) => {
    const uid = accountOnly(request, store);
    store.remove("session", sha256((request as Req).cookies!.session));
    reply.clearCookie("session", {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
    });
    audit(store, uid, undefined, "auth.logout");
    return { ok: true };
  });
  app.post(
    "/api/auth/recovery/request",
    { config: { rateLimit: { max: 3, timeWindow: "1 minute" } } },
    async (request) => {
      checkOrigin(request);
      const b = object(request.body);
      email(b.email);
      return {
        accepted: true,
        message: "请联系管理员获取一次性恢复令牌；系统不会模拟发送邮件。",
      };
    },
  );
  app.post(
    "/api/auth/recovery/complete",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request) => {
      checkOrigin(request);
      const b = object(request.body);
      const id = sha256(str(b.token, "恢复令牌", 1000));
      const recovery = store.get("recovery", id);
      if (
        !recovery ||
        Date.parse(recovery.expires_at) <= Date.now() ||
        recovery.used_at
      )
        fail("RECOVERY_INVALID", "恢复令牌无效或已过期", 400);
      const password = await passwordHash(passwordInput(b.password));
      store.transaction(() => {
        const current = store.get("recovery", id);
        if (
          !current ||
          current.used_at ||
          Date.parse(current.expires_at) <= Date.now()
        )
          fail("RECOVERY_INVALID", "恢复令牌已失效");
        const user = store.get("user", current.user_id);
        if (!user) fail("RECOVERY_INVALID", "恢复令牌无效");
        store.put("user", { ...user, password });
        store.put("recovery", { ...current, used_at: now() });
        for (const s of store.list("session", { userId: user.id }))
          store.remove("session", s.id);
        audit(store, user.id, undefined, "auth.recovery", user.id);
      });
      return { ok: true };
    },
  );
  app.get("/api/workspaces", async (request) =>
    listWorkspaces(store, accountOnly(request, store)),
  );
  app.post("/api/workspaces", async (request) => {
    const uid = accountOnly(request, store);
    return store.transaction(() =>
      newWorkspace(
        store,
        uid,
        str(object(request.body).name, "工作区名称", 200),
      ),
    );
  });
  app.post("/api/w/:wid/leave", async (request) => {
    const c = workspace(request, store);
    return store.transaction(() => {
      const membership = requireMembership(store, c.workspaceId, c.userId);
      if (membership.role === "owner")
        fail(
          "OWNER_MUST_TRANSFER",
          "所有者请先转交所有权并调整自己的角色，再退出工作区",
          409,
        );
      store.remove("membership", membership.id);
      for (const d of store.list("device", {
        userId: c.userId,
        workspaceId: c.workspaceId,
      }))
        store.put("device", { ...d, revoked_at: now() });
      audit(store, c.userId, c.workspaceId, "workspace.leave", c.workspaceId);
      return { left: true, workspace_id: c.workspaceId };
    });
  });
  app.get("/api/w/:wid/team", async (request) => {
    const c = workspace(request, store);
    const w = store.get("workspace", c.workspaceId);
    return store
      .list("membership", { workspaceId: c.workspaceId })
      .filter((m) => !privateWorkspace(w) || m.user_id === w.created_by)
      .map((m) => {
        const user = publicUser(store.get("user", m.user_id));
        return { ...m, name: user.name, email: user.email, user };
      });
  });
  app.post("/api/w/:wid/invites", async (request) => {
    const c = workspace(request, store, true);
    if (!["owner", "admin"].includes(c.role))
      fail("ROLE_DENIED", "仅管理员可邀请成员", 403);
    requireTeamWorkspace(store, c.workspaceId);
    const b = object(request.body);
    const invitedEmail = email(b.email);
    const role = b.role ?? "editor";
    if (
      !["admin", "editor", "viewer"].includes(role) ||
      (role === "admin" && c.role !== "owner")
    )
      fail("ROLE_DENIED", "无法授予该角色", 403);
    const raw = token();
    const invitation = {
      id: sha256(raw),
      workspace_id: c.workspaceId,
      email: invitedEmail,
      role,
      created_by: c.userId,
      created_at: now(),
      expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
    };
    store.put("invite", invitation, c.userId, c.workspaceId);
    audit(store, c.userId, c.workspaceId, "team.invite", undefined, { role });
    return {
      token: raw,
      expires_at: invitation.expires_at,
      role,
      email: invitedEmail,
    };
  });
  app.post("/api/invites/accept", async (request) => {
    const uid = accountOnly(request, store);
    const id = sha256(str(object(request.body).token, "邀请令牌", 1000));
    return store.transaction(() => {
      const inv = store.get("invite", id);
      const user = store.get("user", uid);
      if (
        !inv ||
        inv.used_at ||
        Date.parse(inv.expires_at) <= Date.now() ||
        !store.get("workspace", inv.workspace_id)
      )
        fail("INVITE_INVALID", "邀请无效或已过期", 400);
      requireTeamWorkspace(store, inv.workspace_id);
      if (inv.email !== user.email)
        fail("INVITE_ACCOUNT_MISMATCH", "邀请限定于指定邮箱", 403);
      const inviter = member(store, inv.workspace_id, inv.created_by);
      if (
        !inviter ||
        !["owner", "admin"].includes(inviter.role) ||
        (inv.role === "admin" && inviter.role !== "owner")
      )
        fail("INVITE_INVALID", "邀请创建者已失去授权");
      if (!member(store, inv.workspace_id, uid))
        store.put(
          "membership",
          {
            id: `${inv.workspace_id}:${uid}`,
            workspace_id: inv.workspace_id,
            user_id: uid,
            role: inv.role,
            created_at: now(),
          },
          uid,
          inv.workspace_id,
        );
      store.put("invite", { ...inv, used_at: now(), accepted_by: uid });
      audit(store, uid, inv.workspace_id, "team.join", uid);
      return {
        ...store.get<any>("workspace", inv.workspace_id),
        role: member(store, inv.workspace_id, uid).role,
      };
    });
  });
  app.patch("/api/w/:wid/team/:userId", async (request) => {
    const c = workspace(request, store, true);
    const req = request as Req;
    if (c.role !== "owner")
      fail("ROLE_DENIED", "仅工作区所有者可调整角色", 403);
    const role = object(req.body).role;
    if (!roleNames.includes(role)) fail("INVALID_INPUT", "角色不正确");
    return store.transaction(() => {
      const m = member(store, c.workspaceId, req.params.userId);
      if (!m) fail("NOT_FOUND", "成员不存在", 404);
      if (
        m.role === "owner" &&
        role !== "owner" &&
        store
          .list("membership", { workspaceId: c.workspaceId })
          .filter((x) => x.role === "owner").length <= 1
      )
        fail("LAST_OWNER", "不能移除最后一位所有者", 409);
      store.put("membership", { ...m, role });
      audit(store, c.userId, c.workspaceId, "team.role", m.user_id, { role });
      return { ...m, role };
    });
  });
  app.delete("/api/w/:wid/team/:userId", async (request) => {
    const c = workspace(request, store, true);
    const uid = (request as Req).params.userId;
    if (!["owner", "admin"].includes(c.role))
      fail("ROLE_DENIED", "仅管理员可移除成员", 403);
    return store.transaction(() => {
      const m = member(store, c.workspaceId, uid);
      if (!m) fail("NOT_FOUND", "成员不存在", 404);
      if (c.role === "admin" && ["owner", "admin"].includes(m.role))
        fail("ROLE_DENIED", "无法移除此角色", 403);
      if (
        m.role === "owner" &&
        store
          .list("membership", { workspaceId: c.workspaceId })
          .filter((x) => x.role === "owner").length <= 1
      )
        fail("LAST_OWNER", "不能移除最后一位所有者", 409);
      store.remove("membership", m.id);
      for (const d of store.list("device", {
        userId: uid,
        workspaceId: c.workspaceId,
      }))
        store.put("device", { ...d, revoked_at: now() });
      audit(store, c.userId, c.workspaceId, "team.remove", uid);
      return { ok: true };
    });
  });
  app.get("/api/w/:wid/materials", async (request) => {
    const c = workspace(request, store);
    const q = (request as Req).query ?? {};
    const filters = {
      ...(q.group_id ? { groupId: str(q.group_id, "星球筛选", 200) } : {}),
      ...(q.author_id ? { authorId: str(q.author_id, "作者筛选", 200) } : {}),
      ...(q.q ? { q: str(q.q, "搜索文本", 1000) } : {}),
    };
    return store
      .materialSummaries(c.workspaceId, filters)
      .map((m) => reading(store, m, c.userId, false))
      .filter((m) => !q.status || m.status === q.status);
  });
  app.get("/api/w/:wid/materials/:id", async (request) => {
    const c = workspace(request, store);
    const m = scoped(
      store,
      "material",
      (request as Req).params.id,
      c.workspaceId,
    );
    return {
      ...reading(store, m, c.userId),
      comments: store
        .materialComments(c.workspaceId, m.group_id, m.source_key.entity_id)
        .map((comment) => reading(store, comment, c.userId)),
      attachments: store
        .list("attachment", { workspaceId: c.workspaceId })
        .filter(
          (a) =>
            a.record_source_key &&
            canonical(a.record_source_key) === canonical(m.source_key),
        ),
    };
  });
  app.patch("/api/w/:wid/materials/:id", async (request) => {
    const c = workspace(request, store);
    const req = request as Req;
    const m = scoped(store, "material", req.params.id, c.workspaceId);
    const b = object(req.body);
    const prev = reading(store, m, c.userId);
    const patch: any = {};
    for (const key of Object.keys(b))
      if (!["status", "tags", "starred", "reading_position"].includes(key))
        fail("IMMUTABLE_SOURCE", "原文只能追加新版本，不能手工覆盖");
    if (b.status !== undefined) {
      if (!states.includes(b.status)) fail("INVALID_INPUT", "阅读状态不正确");
      patch.status = b.status;
    }
    if (b.tags !== undefined) patch.tags = strings(b.tags, "标签", 100);
    if (b.starred !== undefined) {
      if (typeof b.starred !== "boolean")
        fail("INVALID_INPUT", "收藏状态不正确");
      patch.starred = b.starred;
    }
    if (b.reading_position !== undefined) {
      if (
        !Number.isFinite(b.reading_position) ||
        b.reading_position < 0 ||
        b.reading_position > m.text.length
      )
        fail("INVALID_INPUT", "阅读位置不正确");
      patch.reading_position = b.reading_position;
    }
    const s = {
      id: `${c.workspaceId}:${m.id}:${c.userId}`,
      workspace_id: c.workspaceId,
      material_id: m.id,
      user_id: c.userId,
      status: prev.status,
      tags: prev.tags,
      starred: prev.starred,
      reading_position: prev.reading_position ?? 0,
      ...patch,
      updated_at: now(),
    };
    store.put("reading_state", s, c.userId, c.workspaceId);
    audit(store, c.userId, c.workspaceId, "material.reading", m.id, {
      fields: Object.keys(patch),
    });
    return reading(store, m, c.userId);
  });
  app.delete("/api/w/:wid/materials/:id", async (request) => {
    const c = workspace(request, store, true);
    const m = scoped(
      store,
      "material",
      (request as Req).params.id,
      c.workspaceId,
    );
    store.put("material", { ...m, archived_at: now() });
    audit(store, c.userId, c.workspaceId, "material.archive", m.id);
    return { ok: true };
  });
  app.get("/api/w/:wid/annotations", async (request) => {
    const c = workspace(request, store);
    const mid = (request as Req).query?.material_id;
    if (mid) scoped(store, "material", mid, c.workspaceId);
    return store
      .list("annotation", { workspaceId: c.workspaceId, userId: c.userId })
      .filter((a) => !mid || a.material_id === mid);
  });
  app.post("/api/w/:wid/annotations", async (request) => {
    const c = workspace(request, store);
    const b = object(request.body);
    const { material, revision } = revisionFor(
      store,
      c.workspaceId,
      str(b.material_id, "资料", 200),
      str(b.revision_id, "版本", 200),
    );
    const quote = str(b.quote, "批注引用", 10000);
    const note = str(b.note ?? "", "批注正文", 10000, true);
    if (
      !Number.isInteger(b.start) ||
      !Number.isInteger(b.end) ||
      b.start < 0 ||
      b.end <= b.start ||
      b.end > revision.text.length ||
      revision.text.slice(b.start, b.end) !== quote
    )
      fail("ANNOTATION_INVALID", "批注锚点与原文不一致");
    const a = {
      id: randomUUID(),
      workspace_id: c.workspaceId,
      user_id: c.userId,
      material_id: material.id,
      revision_id: revision.id,
      source_key: material.source_key,
      start: b.start,
      end: b.end,
      quote,
      note,
      created_at: now(),
    };
    store.put("annotation", a, c.userId, c.workspaceId);
    audit(store, c.userId, c.workspaceId, "annotation.create", a.id);
    return a;
  });
  app.patch("/api/w/:wid/annotations/:id", async (request) => {
    const c = workspace(request, store);
    const req = request as Req;
    const a = scoped(store, "annotation", req.params.id, c.workspaceId);
    if (a.user_id !== c.userId) fail("NOT_FOUND", "批注不存在", 404);
    const b = object(req.body);
    if (Object.keys(b).some((k) => k !== "note"))
      fail("IMMUTABLE_ANCHOR", "批注锚点不可覆盖");
    const next = {
      ...a,
      note: str(b.note, "批注正文", 10000, true),
      updated_at: now(),
    };
    store.put("annotation", next);
    audit(store, c.userId, c.workspaceId, "annotation.edit", a.id);
    return next;
  });
  app.delete("/api/w/:wid/annotations/:id", async (request) => {
    const c = workspace(request, store);
    const a = scoped(
      store,
      "annotation",
      (request as Req).params.id,
      c.workspaceId,
    );
    if (a.user_id !== c.userId) fail("NOT_FOUND", "批注不存在", 404);
    store.remove("annotation", a.id);
    audit(store, c.userId, c.workspaceId, "annotation.delete", a.id);
    return { ok: true };
  });
  app.get("/api/w/:wid/datasets", async (request) => {
    const c = workspace(request, store);
    return store
      .list("dataset", { workspaceId: c.workspaceId })
      .filter((d) => !d.archived_at)
      .map((d) => datasetView(store, d));
  });
  app.post("/api/w/:wid/datasets", async (request) => {
    const c = workspace(request, store, true);
    const data = datasetInput(store, c.workspaceId, object(request.body));
    const d = {
      id: randomUUID(),
      workspace_id: c.workspaceId,
      created_by: c.userId,
      created_at: now(),
      snapshot_ids: [],
      ...data,
    };
    store.put("dataset", d, c.userId, c.workspaceId);
    audit(store, c.userId, c.workspaceId, "dataset.create", d.id);
    return datasetView(store, d);
  });
  app.get("/api/w/:wid/datasets/:id", async (request) => {
    const c = workspace(request, store);
    return datasetView(
      store,
      scoped(store, "dataset", (request as Req).params.id, c.workspaceId),
    );
  });
  app.patch("/api/w/:wid/datasets/:id", async (request) => {
    const c = workspace(request, store, true);
    const req = request as Req;
    const d = scoped(store, "dataset", req.params.id, c.workspaceId);
    const b = object(req.body);
    if (
      Object.keys(b).some(
        (k) => !["name", "mode", "material_ids", "rule"].includes(k),
      )
    )
      fail("INVALID_INPUT", "专题字段不正确");
    const next = {
      ...d,
      ...datasetInput(store, c.workspaceId, { ...d, ...b }),
      updated_at: now(),
    };
    store.put("dataset", next);
    audit(store, c.userId, c.workspaceId, "dataset.edit", d.id);
    return datasetView(store, next);
  });
  app.delete("/api/w/:wid/datasets/:id", async (request) => {
    const c = workspace(request, store, true);
    const d = scoped(
      store,
      "dataset",
      (request as Req).params.id,
      c.workspaceId,
    );
    store.put("dataset", { ...d, archived_at: now() });
    audit(store, c.userId, c.workspaceId, "dataset.archive", d.id);
    return { ok: true };
  });
  app.post("/api/w/:wid/datasets/:id/freeze", async (request) => {
    const c = workspace(request, store, true);
    const d = scoped(
      store,
      "dataset",
      (request as Req).params.id,
      c.workspaceId,
    );
    return store.transaction(() => {
      const items = datasetMaterials(store, d).map((id) => {
        const m = scoped(store, "material", id, c.workspaceId);
        return { material_id: m.id, revision_id: m.revision_id };
      });
      const snapshot = {
        id: randomUUID(),
        dataset_id: d.id,
        workspace_id: c.workspaceId,
        name: d.name,
        items,
        records: items,
        created_by: c.userId,
        created_at: now(),
        frozen: true,
      };
      store.put("snapshot", snapshot, c.userId, c.workspaceId);
      store.put("dataset", {
        ...d,
        snapshot_ids: [...d.snapshot_ids, snapshot.id],
        last_snapshot_id: snapshot.id,
      });
      audit(store, c.userId, c.workspaceId, "dataset.freeze", d.id, {
        snapshot_id: snapshot.id,
        count: items.length,
      });
      return snapshot;
    });
  });
  app.get("/api/w/:wid/artifacts", async (request) => {
    const c = workspace(request, store);
    return store
      .list("artifact", { workspaceId: c.workspaceId })
      .filter((a) => !a.archived_at);
  });
  app.get("/api/w/:wid/artifacts/:id", async (request) => {
    const c = workspace(request, store);
    return scoped(store, "artifact", (request as Req).params.id, c.workspaceId);
  });
  app.get("/api/w/:wid/artifacts/:id/proposals", async (request) => {
    const c = workspace(request, store);
    const a = scoped(
      store,
      "artifact",
      (request as Req).params.id,
      c.workspaceId,
    );
    return store
      .list("proposal", { workspaceId: c.workspaceId })
      .filter((p) => p.artifact_id === a.id)
      .map((p) => proposalView(p, a));
  });
  app.delete(
    "/api/w/:wid/artifacts/:id/proposals/:proposal_id",
    async (request) => {
      const c = workspace(request, store, true);
      const req = request as Req;
      const a = scoped(store, "artifact", req.params.id, c.workspaceId);
      return store.transaction(() => {
        const p = scoped(
          store,
          "proposal",
          req.params.proposal_id,
          c.workspaceId,
        );
        if (p.artifact_id !== a.id || p.adopted_at)
          fail("PROPOSAL_INVALID", "提案不属于此成果或已采用", 409);
        if (p.rejected_at) return { ...proposalView(p, a), replayed: true };
        const rejected = {
          ...p,
          status: "rejected",
          rejected_at: now(),
          rejected_by: c.userId,
        };
        store.put("proposal", rejected);
        audit(store, c.userId, c.workspaceId, "proposal.reject", p.id, {
          artifact_id: a.id,
        });
        return proposalView(rejected, a);
      });
    },
  );
  app.post("/api/w/:wid/artifacts", async (request) => {
    const c = workspace(request, store, true);
    return createArtifact(store, c.workspaceId, c.userId, request.body);
  });
  app.patch("/api/w/:wid/artifacts/:id", async (request) => {
    const c = workspace(request, store, true);
    const req = request as Req;
    const b = object(req.body);
    return store.transaction(() => {
      const a = scoped(store, "artifact", req.params.id, c.workspaceId);
      checkBase(a, b.base_revision);
      const patch: any = {};
      if (
        Object.keys(b).some(
          (k) =>
            !["base_revision", "title", "body", "citations", "status"].includes(
              k,
            ),
        )
      )
        fail("INVALID_INPUT", "成果字段不正确");
      if (b.title !== undefined) patch.title = str(b.title, "成果标题", 1000);
      if (b.body !== undefined)
        patch.body = str(b.body, "成果正文", 1000000, true);
      if (b.citations !== undefined)
        patch.citations = validateCitations(store, c.workspaceId, b.citations);
      if (b.status !== undefined) {
        if (!["draft", "edited", "adopted"].includes(b.status))
          fail("INVALID_INPUT", "成果状态不正确");
        patch.status = b.status;
      }
      patch.stale = (patch.citations ?? a.citations).some(
        (ref: any) =>
          store.get("material", ref.material_id)?.revision_id !==
          ref.revision_id,
      );
      return appendArtifact(store, a, c.userId, patch, "edit");
    });
  });
  app.post("/api/w/:wid/artifacts/:id/adopt", async (request) => {
    const c = workspace(request, store, true);
    const req = request as Req;
    const b = object(req.body);
    return store.transaction(() => {
      const a = scoped(store, "artifact", req.params.id, c.workspaceId);
      checkBase(a, b.base_revision);
      let proposal: any = {},
        selected: any;
      if (b.proposal_id !== undefined) {
        const p = scoped(
          store,
          "proposal",
          str(b.proposal_id, "提案", 200),
          c.workspaceId,
        );
        if (
          p.artifact_id !== a.id ||
          p.adopted_at ||
          p.rejected_at ||
          p.status === "rejected"
        )
          fail("PROPOSAL_INVALID", "提案不属于此成果或已采用或已拒绝", 409);
        if (p.base_revision !== undefined) checkBase(a, p.base_revision);
        proposal = {
          ...(p.title !== undefined
            ? { title: str(p.title, "提案标题", 1000) }
            : {}),
          body: str(p.body, "提案正文", 1000000, true),
          citations: validateCitations(store, c.workspaceId, p.citations ?? []),
        };
        selected = p;
      }
      const stale = (proposal.citations ?? a.citations).some(
        (ref: any) =>
          store.get("material", ref.material_id)?.revision_id !==
          ref.revision_id,
      );
      const next = appendArtifact(
        store,
        a,
        c.userId,
        { ...proposal, stale, status: "adopted" },
        "adopt",
      );
      if (selected)
        store.put("proposal", {
          ...selected,
          status: "adopted",
          adopted_at: now(),
          adopted_by: c.userId,
          adopted_revision_id: next.revision_id,
        });
      for (const ref of next.citations) {
        const material = scoped(
          store,
          "material",
          ref.material_id,
          c.workspaceId,
        );
        const prev = reading(store, material, c.userId);
        store.put(
          "reading_state",
          {
            id: `${c.workspaceId}:${material.id}:${c.userId}`,
            workspace_id: c.workspaceId,
            user_id: c.userId,
            material_id: material.id,
            status: "adopted",
            tags: prev.tags,
            starred: prev.starred,
            reading_position: prev.reading_position ?? 0,
            updated_at: now(),
          },
          c.userId,
          c.workspaceId,
        );
      }
      return next;
    });
  });
  app.get("/api/w/:wid/export", async (request) => {
    const c = workspace(request, store);
    const q = (request as Req).query ?? {};
    const parse = (v: any) =>
      typeof v === "string"
        ? strings(v.split(",").filter(Boolean), "导出选择")
        : [];
    const mids = parse(q.material_ids);
    const aids = parse(q.artifact_ids);
    const bundle = exportBundle(
      store,
      c,
      mids,
      aids,
      q.annotations === "true",
      q.attachments === "true",
    );
    audit(store, c.userId, c.workspaceId, "bundle.export", bundle.bundle_id, {
      records: bundle.records.length,
      artifacts: bundle.artifacts.length,
    });
    return bundle;
  });
  app.post("/api/w/:wid/import", async (request) => {
    const c = workspace(request, store, true);
    const b = object(request.body);
    let bundle: TransferBundle;
    try {
      bundle = validateBundle(b.bundle);
    } catch (e) {
      fail("BUNDLE_INVALID", e instanceof Error ? e.message : "导入包不正确");
    }
    const key = str(request.headers["x-idempotency-key"], "幂等键", 128);
    const receiptId = sha256(`${c.userId}:${c.workspaceId}:${key}`);
    const bundleReceipt = sha256(
      `${c.userId}:${c.workspaceId}:${bundle.bundle_id}`,
    );
    const bodyHash = sha256(canonical(b.bundle));
    return store.transaction(() => {
      const existing =
        store.get("import_receipt", receiptId) ??
        store.get("import_bundle", bundleReceipt);
      if (existing) {
        if (existing.body_hash !== bodyHash)
          fail("IDEMPOTENCY_CONFLICT", "幂等键或包标识已用于不同内容", 409);
        store.put(
          "import_receipt",
          { ...existing, id: receiptId },
          c.userId,
          c.workspaceId,
        );
        return { ...existing.result, replayed: true };
      }
      const result = importBundle(store, c, bundle);
      const receipt = {
        id: receiptId,
        body_hash: bodyHash,
        result,
        created_at: now(),
      };
      store.put("import_receipt", receipt, c.userId, c.workspaceId);
      store.put(
        "import_bundle",
        { ...receipt, id: bundleReceipt },
        c.userId,
        c.workspaceId,
      );
      return result;
    });
  });
  app.post("/api/w/:wid/share", async (request) => {
    const c = workspace(request, store, true);
    const b = object(request.body);
    const target = str(b.target_workspace_id, "目标工作区", 200);
    const role = requireMembership(store, target, c.userId, true).role;
    requireTeamWorkspace(store, target);
    if (target === c.workspaceId) fail("INVALID_INPUT", "请选择其他工作区");
    const mids = strings(b.material_ids ?? [], "资料列表");
    const aids = strings(b.artifact_ids ?? [], "成果列表");
    if (b.include_raw !== undefined && typeof b.include_raw !== "boolean")
      fail("INVALID_INPUT", "原文分享开关不正确");
    if (
      b.include_attachments !== undefined &&
      typeof b.include_attachments !== "boolean"
    )
      fail("INVALID_INPUT", "附件分享开关不正确");
    if (b.include_attachments && !b.include_raw)
      fail("SHARE_POLICY", "分享附件需要明确包含原文");
    mids.forEach((id) => scoped(store, "material", id, c.workspaceId));
    aids.forEach((id) => scoped(store, "artifact", id, c.workspaceId));
    return store.transaction(() => {
      const dest: Context = { userId: c.userId, workspaceId: target, role };
      const existingMaterials = new Set(
        store
          .materialSummaries(target, { includeArchived: true })
          .map((m) => m.id),
      );
      const existingArtifacts = new Set(
        store.list("artifact", { workspaceId: target }).map((a) => a.id),
      );
      const existingAttachments = new Set(
        store.list("attachment", { workspaceId: target }).map((a) => a.id),
      );
      let result: any;
      if (b.include_raw) {
        // Selected artifacts must not implicitly expand the explicitly approved raw selection.
        for (const id of aids)
          for (const ref of scoped(store, "artifact", id, c.workspaceId)
            .citations ?? [])
            if (!mids.includes(ref.material_id))
              fail("SHARE_SELECTION", "成果引用原文不在已批准分享列表中");
        result = importBundle(
          store,
          dest,
          exportBundle(store, c, mids, aids, false, !!b.include_attachments),
        );
        if (b.include_attachments) {
          for (const mapped of result.attachments) {
            const source = store.get("attachment", mapped.imported_id);
            const attachment = store.get("attachment", mapped.id);
            if (
              source?.workspace_id === c.workspaceId &&
              source.status === "available" &&
              existsSync(join(store.blobDir, source.hash))
            )
              store.put("attachment", { ...attachment, status: "available" });
          }
        }
      } else {
        result = {
          materials: [],
          skipped_material_ids: mids,
          skipped_reason: mids.length
            ? "未批准包含原文，仅分享所选成果"
            : undefined,
          artifacts: aids.map((id) => {
            const a = scoped(store, "artifact", id, c.workspaceId);
            const copy = appendArtifact(
              store,
              {
                id: randomUUID(),
                workspace_id: target,
                title: a.title,
                body: a.body,
                citations: [],
                status: a.status,
                reference_metadata: (a.citations ?? []).map((ref: any) => {
                  const m = scoped(
                    store,
                    "material",
                    ref.material_id,
                    c.workspaceId,
                    false,
                  );
                  return {
                    source_key: m.source_key,
                    source_url: m.source_url,
                    title: m.title,
                    availability: "reference_only",
                  };
                }),
                stale: false,
                created_at: now(),
                created_by: c.userId,
                shared_from: { workspace_id: c.workspaceId, artifact_id: a.id },
              },
              c.userId,
              {},
              "share",
            );
            return {
              imported_id: id,
              id: copy.id,
              revision_id: copy.revision_id,
            };
          }),
          attachments: [],
        };
      }
      const share = {
        id: randomUUID(),
        workspace_id: c.workspaceId,
        source_workspace_id: c.workspaceId,
        target_workspace_id: target,
        created_by: c.userId,
        created_at: now(),
        material_ids: mids,
        artifact_ids: aids,
        include_raw: !!b.include_raw,
        include_attachments: !!b.include_attachments,
        material_copies: [
          ...new Set<string>((result.records ?? []).map((r: any) => r.id)),
        ].map((id) => ({
          id,
          created_new: !existingMaterials.has(id),
          revision_ids: store
            .get("material", id)
            .revisions.map((r: any) => r.id),
        })),
        artifact_copies: (result.artifacts ?? []).map((a: any) => ({
          id: a.id,
          created_new: !existingArtifacts.has(a.id),
          revision_id: a.revision_id,
        })),
        attachment_copies: (result.attachments ?? []).map((a: any) => ({
          id: a.id,
          created_new: !existingAttachments.has(a.id),
        })),
      };
      store.put("share", share, c.userId, c.workspaceId);
      audit(store, c.userId, c.workspaceId, "workspace.share", target, {
        material_ids: b.include_raw ? mids : [],
        artifact_ids: aids,
        include_raw: !!b.include_raw,
        include_attachments: !!b.include_attachments,
        share_id: share.id,
      });
      audit(store, c.userId, target, "workspace.receive", undefined, {
        source_workspace_id: c.workspaceId,
      });
      return { ...result, share_id: share.id, share };
    });
  });
  app.get("/api/w/:wid/shares", async (request) => {
    const c = workspace(request, store);
    return store
      .list("share", { workspaceId: c.workspaceId })
      .filter(
        (s) => s.created_by === c.userId || ["owner", "admin"].includes(c.role),
      );
  });
  app.delete("/api/w/:wid/shares/:id", async (request) => {
    const c = workspace(request, store, true);
    const s = scoped(store, "share", (request as Req).params.id, c.workspaceId);
    if (s.created_by !== c.userId && !["owner", "admin"].includes(c.role))
      fail("ROLE_DENIED", "无法撤销他人的分享", 403);
    if (s.revoked_at) return { ...s.revoke_result, replayed: true };
    // Revocation may remove our unchanged copies, never another user's subsequent work.
    return store.transaction(() => {
      const archived: string[] = [];
      const retained: string[] = [];
      for (const copy of s.artifact_copies) {
        const a = store.get("artifact", copy.id);
        if (!a || a.workspace_id !== s.target_workspace_id || a.archived_at)
          continue;
        if (copy.created_new && a.revision_id === copy.revision_id) {
          store.put("artifact", {
            ...a,
            archived_at: now(),
            share_revoked: s.id,
          });
          archived.push(a.id);
        } else retained.push(a.id);
      }
      for (const copy of s.material_copies) {
        const m = store.get("material", copy.id);
        if (!m || m.workspace_id !== s.target_workspace_id || m.archived_at)
          continue;
        const derived =
          store
            .list("artifact", { workspaceId: s.target_workspace_id })
            .some(
              (a) =>
                !a.archived_at &&
                a.citations?.some((ref: any) => ref.material_id === m.id),
            ) ||
          store
            .list("annotation", { workspaceId: s.target_workspace_id })
            .some((a) => a.material_id === m.id) ||
          store
            .list("snapshot", { workspaceId: s.target_workspace_id })
            .some((snapshot) =>
              snapshot.items.some((ref: any) => ref.material_id === m.id),
            );
        if (
          copy.created_new &&
          !derived &&
          m.revisions.every((r: any) => copy.revision_ids.includes(r.id))
        ) {
          store.put("material", {
            ...m,
            archived_at: now(),
            share_revoked: s.id,
          });
          archived.push(m.id);
        } else retained.push(m.id);
      }
      for (const copy of s.attachment_copies) {
        const a = store.get("attachment", copy.id);
        if (!a || a.workspace_id !== s.target_workspace_id) continue;
        const inUse = store
          .materialSummaries(s.target_workspace_id)
          .some(
            (m) =>
              a.record_source_key &&
              canonical(m.source_key) === canonical(a.record_source_key),
          );
        if (copy.created_new && !inUse) {
          store.put("attachment", {
            ...a,
            archived_at: now(),
            share_revoked: s.id,
          });
          archived.push(a.id);
        } else retained.push(a.id);
      }
      const result = {
        share_id: s.id,
        revoked: true,
        archived,
        retained,
        retained_reason: retained.length
          ? "已有独立版本、批注、冻结快照或其他引用，未删除派生数据"
          : undefined,
      };
      store.put("share", { ...s, revoked_at: now(), revoke_result: result });
      audit(store, c.userId, c.workspaceId, "workspace.revoke_share", s.id, {
        archived,
        retained,
      });
      return result;
    });
  });
  app.post("/api/w/:wid/uploads", async (request) => {
    const c = workspace(request, store, true);
    const b = object(request.body);
    const hash = str(b.hash, "附件哈希", 64);
    if (
      !/^[a-f0-9]{64}$/.test(hash) ||
      !Number.isSafeInteger(b.size) ||
      b.size < 0 ||
      b.size > MAX_ATTACHMENT
    )
      fail("INVALID_INPUT", "附件哈希或大小不正确");
    const name = safeFilename(b.name);
    const mime = str(b.mime ?? "application/octet-stream", "附件类型", 200);
    const sourceKey =
      b.record_source_key === undefined
        ? undefined
        : SourceKeySchema.parse(b.record_source_key);
    const u = {
      id: randomUUID(),
      workspace_id: c.workspaceId,
      user_id: c.userId,
      hash,
      size: b.size,
      name,
      mime,
      record_source_key: sourceKey,
      offset: 0,
      state: "pending",
      created_at: now(),
    };
    writeFileSync(join(store.blobDir, `${u.id}.part`), Buffer.alloc(0), {
      flag: "wx",
      mode: 0o600,
    });
    store.put("upload", u, c.userId, c.workspaceId);
    audit(store, c.userId, c.workspaceId, "upload.create", u.id, {
      size: u.size,
    });
    return { id: u.id, offset: 0 };
  });
  app.put("/api/w/:wid/uploads/:id/chunks", async (request) => {
    const c = workspace(request, store, true);
    const req = request as Req;
    const u = scoped(store, "upload", req.params.id, c.workspaceId);
    const b = object(req.body);
    if (u.user_id !== c.userId) fail("NOT_FOUND", "上传不存在", 404);
    if (u.state !== "pending")
      fail("UPLOAD_STATE", "上传已完成、失败或正在校验", 409);
    const raw = str(b.data_base64, "分片", 1400000);
    if (
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        raw,
      )
    )
      fail("INVALID_INPUT", "分片不是合法 base64");
    const bytes = Buffer.from(raw, "base64");
    if (
      !bytes.length ||
      bytes.length > 1024 * 1024 ||
      bytes.toString("base64") !== raw ||
      !Number.isSafeInteger(b.offset) ||
      b.offset < 0 ||
      b.offset + bytes.length > u.size
    )
      fail("INVALID_INPUT", "分片大小或位置不正确");
    const path = join(store.blobDir, `${u.id}.part`);
    if (!existsSync(path) || lstatSync(path).isSymbolicLink())
      fail("UPLOAD_MISSING", "上传临时文件不可用", 409);
    if (b.offset < u.offset) {
      if (b.offset + bytes.length > u.offset)
        fail("UPLOAD_OFFSET", "分片与已有范围部分重叠", 409, {
          offset: u.offset,
        });
      const existing = Buffer.alloc(bytes.length);
      const fd = openSync(path, "r");
      try {
        readSync(fd, existing, 0, existing.length, b.offset);
      } finally {
        closeSync(fd);
      }
      if (!existing.equals(bytes))
        fail("UPLOAD_CONFLICT", "已提交的分片内容不可改变", 409);
      return { id: u.id, offset: u.offset, replayed: true };
    }
    if (b.offset !== u.offset)
      fail("UPLOAD_OFFSET", "上传位置不匹配", 409, { offset: u.offset });
    const fd = openSync(path, "r+");
    try {
      let written = 0;
      while (written < bytes.length)
        written += writeSync(
          fd,
          bytes,
          written,
          bytes.length - written,
          b.offset + written,
        );
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    store.put("upload", {
      ...u,
      offset: u.offset + bytes.length,
      updated_at: now(),
    });
    return { id: u.id, offset: u.offset + bytes.length };
  });
  app.post("/api/w/:wid/uploads/:id/complete", async (request) => {
    const c = workspace(request, store, true);
    const u = scoped(
      store,
      "upload",
      (request as Req).params.id,
      c.workspaceId,
    );
    if (u.user_id !== c.userId) fail("NOT_FOUND", "上传不存在", 404);
    if (u.state === "complete")
      return scoped(store, "attachment", u.attachment_id, c.workspaceId);
    if (u.state !== "pending" || u.offset !== u.size)
      fail("UPLOAD_INCOMPLETE", "附件尚未完整上传或不可继续", 409, {
        offset: u.offset,
        size: u.size,
      });
    store.put("upload", { ...u, state: "verifying" });
    const path = join(store.blobDir, `${u.id}.part`),
      final = join(store.blobDir, u.hash);
    try {
      // Rename may have succeeded immediately before a crash while the SQLite receipt had not committed.
      const candidate = existsSync(path) ? path : final;
      if (
        !existsSync(candidate) ||
        lstatSync(candidate).size !== u.size ||
        (await fileDigest(candidate)) !== u.hash
      ) {
        store.put("upload", { ...u, state: "failed" });
        fail("HASH_MISMATCH", "附件哈希校验失败", 422);
      }
      workspace(request, store, true);
      if (candidate === path) {
        if (existsSync(final)) {
          if (
            lstatSync(final).size !== u.size ||
            (await fileDigest(final)) !== u.hash
          )
            fail("HASH_MISMATCH", "已有附件内容损坏", 422);
          workspace(request, store, true);
          unlinkSync(path);
        } else renameSync(path, final);
      }
      return store.transaction(() => {
        const a = {
          id: randomUUID(),
          workspace_id: c.workspaceId,
          hash: u.hash,
          size: u.size,
          name: u.name,
          mime: u.mime,
          record_source_key: u.record_source_key,
          status: "available",
          created_by: c.userId,
          created_at: now(),
        };
        store.put("attachment", a, c.userId, c.workspaceId);
        store.put("upload", { ...u, state: "complete", attachment_id: a.id });
        audit(store, c.userId, c.workspaceId, "upload.complete", a.id, {
          hash: a.hash,
          size: a.size,
        });
        return a;
      });
    } catch (error) {
      if (store.get("upload", u.id)?.state === "verifying")
        store.put("upload", { ...u, state: "pending" });
      throw error;
    }
  });
  app.delete("/api/w/:wid/uploads/:id", async (request) => {
    const c = workspace(request, store, true);
    const u = scoped(
      store,
      "upload",
      (request as Req).params.id,
      c.workspaceId,
    );
    if (u.user_id !== c.userId) fail("NOT_FOUND", "上传不存在", 404);
    if (u.state === "verifying")
      fail("UPLOAD_STATE", "校验过程中无法取消", 409);
    const path = join(store.blobDir, `${u.id}.part`);
    if (existsSync(path)) unlinkSync(path);
    store.remove("upload", u.id);
    audit(store, c.userId, c.workspaceId, "upload.cancel", u.id);
    return { ok: true };
  });
  app.get("/api/w/:wid/attachments/:id", async (request, reply) => {
    const c = workspace(request, store);
    const a = scoped(
      store,
      "attachment",
      (request as Req).params.id,
      c.workspaceId,
    );
    const path = join(store.blobDir, a.hash);
    if (
      a.status !== "available" ||
      !/^[a-f0-9]{64}$/.test(a.hash) ||
      !existsSync(path)
    )
      fail("ATTACHMENT_MISSING", "附件尚未上传或不可用", 404);
    if (lstatSync(path).size !== a.size || (await fileDigest(path)) !== a.hash)
      fail("HASH_MISMATCH", "附件完整性校验失败", 422);
    workspace(request, store);
    reply
      .header("Content-Type", "application/octet-stream")
      .header("X-Content-Type-Options", "nosniff")
      .header(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(a.name)}`,
      )
      .header("Cache-Control", "private, no-store");
    return reply.send(createReadStream(path));
  });
  app.post("/api/devices/pair", async (request) => {
    const uid = accountOnly(request, store);
    const b = object(request.body);
    const wid = str(b.workspace_id, "工作区", 200);
    const m = requireMembership(store, wid, uid);
    const code = randomBytes(6).toString("hex").toUpperCase();
    const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    store.put(
      "pairing",
      {
        id: sha256(code),
        user_id: uid,
        workspace_id: wid,
        label: str(b.label ?? "浏览器插件", "设备名称", 100),
        role: m.role,
        expires_at: expires,
        created_at: now(),
      },
      uid,
      wid,
    );
    audit(store, uid, wid, "device.pair");
    return { code: code.match(/.{4}/g)!.join("-"), expires_at: expires };
  });
  app.post(
    "/api/devices/claim",
    { config: { rateLimit: { max: 6, timeWindow: "1 minute" } } },
    async (request) => {
      const b = object(request.body);
      const code = str(b.code, "配对码", 30).replace(/-/g, "").toUpperCase();
      if (!/^[A-F0-9]{12}$/.test(code))
        fail("PAIRING_INVALID", "配对码无效或已过期", 400);
      return store.transaction(() => {
        const p = store.get("pairing", sha256(code));
        if (!p || p.claimed_at || Date.parse(p.expires_at) <= Date.now())
          fail("PAIRING_INVALID", "配对码无效或已过期", 400);
        const m = requireMembership(store, p.workspace_id, p.user_id);
        const raw = token();
        const d = {
          id: sha256(raw),
          user_id: p.user_id,
          workspace_id: p.workspace_id,
          label: str(b.label ?? p.label, "设备名称", 100),
          scopes:
            m.role === "viewer"
              ? ["read", "export"]
              : ["read", "import", "upload", "export"],
          created_at: now(),
          expires_at: new Date(Date.now() + 30 * 86400000).toISOString(),
        };
        store.put("device", d, p.user_id, p.workspace_id);
        store.put("pairing", { ...p, claimed_at: now() });
        audit(store, p.user_id, p.workspace_id, "device.claim", d.id);
        return {
          token: raw,
          id: d.id,
          workspace_id: p.workspace_id,
          expires_at: d.expires_at,
          scopes: d.scopes,
        };
      });
    },
  );
  app.get("/api/devices", async (request) => {
    const uid = accountOnly(request, store);
    return store
      .list("device", { userId: uid })
      .filter((d) => d.kind !== "mcp")
      .map((d) => ({
        id: d.id,
        label: d.label,
        workspace_id: d.workspace_id,
        scopes: d.scopes,
        created_at: d.created_at,
        expires_at: d.expires_at,
        revoked_at: d.revoked_at,
      }));
  });
  app.delete("/api/devices/:id", async (request) => {
    const uid = accountOnly(request, store);
    const d = store.get("device", (request as Req).params.id);
    if (!d || d.user_id !== uid) fail("NOT_FOUND", "设备不存在", 404);
    store.put("device", { ...d, revoked_at: now() });
    audit(store, uid, d.workspace_id, "device.revoke", d.id);
    return { ok: true };
  });
  app.get("/api/w/:wid/audit", async (request) => {
    const c = workspace(request, store);
    if (!["owner", "admin"].includes(c.role))
      fail("ROLE_DENIED", "仅管理员可查看审计", 403);
    return store
      .list("audit", { workspaceId: c.workspaceId })
      .slice(-500)
      .reverse();
  });
}
