import type { FastifyInstance } from "fastify";
import { randomUUID, randomBytes } from "node:crypto";
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "./store.js";
import {
  actor,
  workspace,
  fail,
  ingestRecord,
  createArtifact,
  createProposal,
  resolveDataset,
  resolveToken,
  exportBundle,
} from "./core.js";
import { vault } from "./secrets.js";
import { providerCall, providerModels, type Provider } from "./provider.js";
import { providerURL, publicRequest } from "./net.js";
import { SourceManager, type Connection } from "./source.js";
import { presets, analysisInstructions } from "../shared/recipes.js";
import {
  normalizeGroups,
  normalizeTopic,
  answerRecord,
  commentRecord,
  sourcePaths,
  plainText,
  observedComments,
} from "../shared/zsxq.js";
import {
  canonical,
  sha256,
  fragmentsFor,
  createBundle,
  type SourceRecord,
} from "../shared/transfer.js";
import { extractAttachment } from "./attachments.js";
type Job = {
  id: string;
  user_id: string;
  workspace_id: string;
  kind: "capture" | "process";
  state: string;
  created_at: string;
  updated_at: string;
  events: any[];
  checkpoint: any;
  scope: any;
  connection_id?: string;
  recipe: any;
  inputs: any[];
  processed: number;
  approved: boolean;
  error?: any;
  artifact_ids: string[];
  [key: string]: any;
};
const now = () => new Date().toISOString();
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
function cleanProvider(p: any) {
  const { secret, user_id, ...safe } = p;
  return { ...safe, has_key: !!secret };
}
function cleanConnection(c: any) {
  const { secret, user_id, ...safe } = c;
  return safe;
}
const body = (r: any): any => r.body ?? {};
const own = <T>(store: Store, kind: string, id: string, uid: string): T => {
  const item = store.get(kind, id);
  if (!item || item.user_id !== uid)
    fail("not_found", "对象不存在或无权访问", 404);
  return item;
};
function event(
  store: Store,
  j: Job,
  action: string,
  message: string,
  details?: any,
) {
  const current = store.get("job", j.id);
  if (
    current &&
    ["paused", "cancelled"].includes(current.state) &&
    !["resume", "approve", "stopped"].includes(action)
  )
    j.state = current.state;
  j.updated_at = now();
  const merged = new Map<string, any>();
  for (const e of [...(current?.events ?? []), ...j.events])
    merged.set(e.id, e);
  j.events = [...merged.values()].sort((a, b) => a.at.localeCompare(b.at));
  j.events.push({
    id: randomUUID(),
    at: now(),
    action,
    message,
    ...(details ? { details } : {}),
  });
  store.put("job", j, j.user_id, j.workspace_id);
}
export type RuntimeOptions = {
  startWorker?: boolean;
  request?: typeof publicRequest;
  download?: typeof publicRequest;
  sources?: SourceManager;
};
export async function registerRuntime(
  app: FastifyInstance,
  store: Store,
  options: RuntimeOptions = {},
) {
  const secrets = vault(store.dataDir);
  const sources = options.sources ?? new SourceManager(store.dataDir);
  const running = new Map<string, AbortController>();
  let stopping = false,
    ticking = false;
  const authorizeJob = (j: Job) => {
    const m = store.get("membership", `${j.workspace_id}:${j.user_id}`);
    const w = store.get("workspace", j.workspace_id);
    if (
      !store.get("user", j.user_id) ||
      !w ||
      !m ||
      m.role === "viewer" ||
      (w.kind !== "team" && w.created_by !== j.user_id)
    )
      fail(
        "policy_denied",
        "当前任务执行者已失去此空间的编辑权限；未继续读取或外发",
        403,
      );
  };
  for (const j of store.recoverableJobs<Job>())
    if (["running", "queued"].includes(j.state)) {
      j.state = j.checkpoint?.call_pending ? "outcome_unknown" : "paused";
      event(
        store,
        j,
        "recovered",
        "进程中断，已保存断点；不会自动重放模型调用",
      );
    }
  app.get("/api/providers", (r) =>
    store
      .list("provider", { userId: actor(r, store).userId })
      .map(cleanProvider),
  );
  app.post("/api/providers", async (r) => {
    const uid = actor(r, store).userId,
      b = body(r);
    if (
      !["chat", "responses", "anthropic"].includes(b.protocol) ||
      typeof b.model !== "string" ||
      !b.model.trim() ||
      b.model.length > 300 ||
      typeof b.api_key !== "string" ||
      !b.api_key.trim() ||
      b.api_key.length > 10000 ||
      /[\r\n\0]/.test(b.api_key) ||
      typeof b.label !== "string" ||
      !b.label.trim() ||
      b.label.length > 100 ||
      (b.models !== undefined &&
        (!Array.isArray(b.models) ||
          b.models.length > 1000 ||
          b.models.some(
            (x: any) => typeof x !== "string" || !x.trim() || x.length > 300,
          )))
    )
      fail("invalid_provider", "请填写名称、协议、模型 ID 和 API Key");
    providerURL(b.base_url);
    const p = {
      id: randomUUID(),
      user_id: uid,
      label: String(b.label).slice(0, 100),
      protocol: b.protocol,
      base_url: String(b.base_url).replace(/\/$/, ""),
      model: String(b.model).slice(0, 300),
      models: (b.models ?? [])
        .filter((m: any) => typeof m === "string")
        .slice(0, 1000),
      secret: secrets.encrypt(String(b.api_key)),
      created_at: now(),
    };
    store.put("provider", p, uid);
    return cleanProvider(p);
  });
  app.post(
    "/api/providers/discover",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (r) => {
      const uid = actor(r, store).userId,
        b = body(r);
      if (!["chat", "responses", "anthropic"].includes(b.protocol))
        fail("invalid_protocol", "请选择模型协议");
      providerURL(b.base_url);
      let key = typeof b.api_key === "string" ? b.api_key.trim() : "";
      if (!key && b.provider_id) {
        const existing = own<Provider>(store, "provider", b.provider_id, uid);
        if (existing.base_url !== String(b.base_url).replace(/\/$/, ""))
          fail(
            "key_destination_changed",
            "地址已变化，不能把已保存的Key外发到新地址；请重新填写对应Key",
          );
        key = secrets.decrypt(existing.secret).toString();
      }
      if (!key || key.length > 10000 || /[\r\n\0]/.test(key))
        fail(
          "key_required",
          "发现模型只需要地址、协议与Key，不要求先填写模型ID",
        );
      const p: Provider = {
        id: "discovery",
        user_id: uid,
        label: "临时模型发现",
        base_url: String(b.base_url).replace(/\/$/, ""),
        protocol: b.protocol,
        secret: "",
        model: "",
        models: [],
      };
      return {
        models: await providerModels(p, key, options.request),
        verified: false,
        saved: false,
      };
    },
  );
  app.patch("/api/providers/:id", (r) => {
    const uid = actor(r, store).userId,
      p = own<any>(store, "provider", (r.params as any).id, uid),
      b = body(r);
    if (b.base_url !== undefined) {
      providerURL(b.base_url);
      b.base_url = String(b.base_url).replace(/\/$/, "");
      if (b.base_url !== p.base_url && !b.api_key)
        fail(
          "key_destination_changed",
          "新地址必须重新填写其对应Key；不能把旧地址的Key无声外发到新目的地",
        );
    }
    if (
      b.api_key !== undefined &&
      (typeof b.api_key !== "string" ||
        !b.api_key.trim() ||
        b.api_key.length > 10000 ||
        /[\r\n\0]/.test(b.api_key))
    )
      fail("invalid_key", "API Key格式无效");
    for (const k of ["label", "model"])
      if (
        b[k] !== undefined &&
        (typeof b[k] !== "string" ||
          !b[k].trim() ||
          b[k].length > (k === "label" ? 100 : 300))
      )
        fail("invalid_provider", "名称或模型ID无效");
    if (
      b.models !== undefined &&
      (!Array.isArray(b.models) ||
        b.models.length > 1000 ||
        b.models.some(
          (x: any) => typeof x !== "string" || !x.trim() || x.length > 300,
        ))
    )
      fail("invalid_models", "模型列表格式无效");
    if (b.protocol && !["chat", "responses", "anthropic"].includes(b.protocol))
      fail("invalid_protocol", "未知模型协议");
    for (const k of ["label", "base_url", "model", "protocol", "models"])
      if (b[k] !== undefined) p[k] = b[k];
    if (b.api_key) p.secret = secrets.encrypt(b.api_key);
    store.put("provider", p, uid);
    return cleanProvider(p);
  });
  app.delete("/api/providers/:id", (r) => {
    const uid = actor(r, store).userId,
      p = own<any>(store, "provider", (r.params as any).id, uid);
    store.remove("provider", p.id);
    return { ok: true };
  });
  app.post("/api/providers/:id/test", async (r) => {
    const uid = actor(r, store).userId,
      p = own<Provider>(store, "provider", (r.params as any).id, uid),
      b = body(r);
    const key = secrets.decrypt(p.secret).toString();
    if (b.mode === "models") {
      const models = await providerModels(p, key, options.request);
      p.models = models;
      store.put("provider", p, uid);
      return { capability: "models", models };
    }
    if (b.mode !== "call") fail("invalid_test", "请选择 models 或 call 测试");
    return {
      ...(await providerCall(
        p,
        key,
        "Reply briefly.",
        "请回复“连接成功”。",
        256,
        p.model,
        options.request,
        true,
      )),
      capability: "text",
    };
  });
  app.get("/api/connections", (r) =>
    store
      .list("connection", { userId: actor(r, store).userId })
      .map(cleanConnection),
  );
  app.post("/api/connections", (r) => {
    const uid = actor(r, store).userId,
      b = body(r);
    if (!["browser", "official"].includes(b.channel) || !b.label)
      fail("invalid_connection", "选择通道并填写名称");
    if (b.channel === "official" && !b.mcp_url)
      fail("mcp_url_required", "请填写官方密钥管理页提供的 MCP 链接");
    if (b.mcp_url) {
      const u = new URL(b.mcp_url);
      if (
        u.protocol !== "https:" ||
        !(u.hostname === "zsxq.com" || u.hostname.endsWith(".zsxq.com"))
      )
        fail("official_host_denied", "仅接受知识星球官方 MCP 地址");
    }
    if (
      b.policy &&
      !["browser_only", "official_only", "auto"].includes(b.policy)
    )
      fail("invalid_policy", "选择 browser_only、official_only 或 auto");
    const c: Connection = {
      id: randomUUID(),
      user_id: uid,
      label: String(b.label).slice(0, 100),
      channel: b.channel,
      policy:
        b.policy ??
        (b.channel === "browser" ? "browser_only" : "official_only"),
      state: "awaiting_login",
      created_at: now(),
      ...(b.mcp_url ? { secret: secrets.encrypt(b.mcp_url) } : {}),
    };
    store.put("connection", c, uid);
    return cleanConnection(c);
  });
  app.delete("/api/connections/:id", async (r) => {
    const uid = actor(r, store).userId,
      c = own<Connection>(store, "connection", (r.params as any).id, uid);
    if (store.connectionBusy(uid, c.id))
      fail("connection_busy", "先暂停或取消正在使用的采集任务", 409);
    if (sources.isActive(c.id)) await sources.close();
    c.state = "revoked";
    delete c.secret;
    store.put("connection", c, uid);
    return cleanConnection(c);
  });
  app.post("/api/connections/:id/open", async (r) => {
    const uid = actor(r, store).userId,
      c = own<Connection>(store, "connection", (r.params as any).id, uid);
    if (c.state === "revoked") fail("connection_revoked", "连接已撤销");
    if (c.channel !== "browser") fail("not_browser", "官方连接请检测 MCP");
    await sources.open(c);
    return cleanConnection(c);
  });
  app.post("/api/connections/:id/verify", async (r) => {
    const uid = actor(r, store).userId,
      c = own<Connection>(store, "connection", (r.params as any).id, uid);
    if (c.state === "revoked") fail("connection_revoked", "连接已撤销");
    try {
      Object.assign(c, await sources.verify(c));
      c.groups = normalizeGroups(await sources.request(c, sourcePaths.groups));
      store.put("connection", c, uid);
      return cleanConnection(c);
    } catch (e: any) {
      c.state =
        e.code === "identity_mismatch"
          ? "identity_mismatch"
          : e.code === "official_denied"
            ? "policy_denied"
            : "awaiting_login";
      store.put("connection", c, uid);
      throw e;
    }
  });
  app.get("/api/connections/:id/screen", async (r) => {
    const c = own<Connection>(
      store,
      "connection",
      (r.params as any).id,
      actor(r, store).userId,
    );
    if (c.channel !== "browser" || c.state === "revoked")
      fail("not_browser", "连接不可用");
    return sources.screen(c);
  });
  app.post("/api/connections/:id/input", async (r) => {
    const c = own<Connection>(
      store,
      "connection",
      (r.params as any).id,
      actor(r, store).userId,
    );
    if (c.channel !== "browser" || c.state === "revoked")
      fail("not_browser", "连接不可用");
    return sources.input(c, body(r));
  });
  app.get("/api/connections/:id/groups", async (r) => {
    const c = own<Connection>(
      store,
      "connection",
      (r.params as any).id,
      actor(r, store).userId,
    );
    if (c.state !== "ready") fail("login_required", "请先验证来源账号");
    const groups = normalizeGroups(
      await sources.request(c, sourcePaths.groups),
    );
    c.groups = groups;
    store.put("connection", c, c.user_id);
    return groups;
  });
  app.get("/api/connections/:id/groups/:gid/members", async (r) => {
    const { id, gid } = r.params as any;
    const c = own<Connection>(store, "connection", id, actor(r, store).userId);
    if (c.state !== "ready" || !c.groups?.some((g) => g.id === gid))
      fail("scope_denied", "星球不在已验证连接范围");
    const q = String((r.query as any).q ?? "").slice(0, 200);
    const d = await sources.request(
      c,
      q ? sourcePaths.searchMembers(gid) : sourcePaths.members(gid),
      q ? { keyword: q, count: 20 } : { count: 20 },
    );
    return (d.members ?? []).map((m: any) => ({
      id: String(m.user_id ?? m.user?.user_id),
      user_id: String(m.user_id ?? m.user?.user_id),
      name: String(m.name ?? m.user?.name ?? ""),
      group_id: gid,
    }));
  });
  app.get("/api/recipes/presets", (r) => {
    actor(r, store);
    return presets;
  });
  app.get("/api/w/:wid/recipes", (r) => {
    const { workspaceId } = workspace(r, store);
    return store.list("recipe", { workspaceId });
  });
  const parseRecipe = (b: any, uid: string) => {
    if (!presets.some((p) => p.id === b.preset_id) || !b.name || !b.provider_id)
      fail("invalid_recipe", "填写名称、模板和模型配置");
    own(store, "provider", b.provider_id, uid);
    const max_output_tokens = Number(b.max_output_tokens ?? 2048),
      input_limit = Number(b.input_limit ?? 60000),
      max_calls = Number(b.max_calls ?? 1);
    if (
      !Number.isInteger(max_output_tokens) ||
      max_output_tokens < 256 ||
      max_output_tokens > 32000 ||
      !Number.isInteger(input_limit) ||
      input_limit < 1000 ||
      input_limit > 200000 ||
      !Number.isInteger(max_calls) ||
      max_calls < 1 ||
      max_calls > 20
    )
      fail(
        "invalid_budget",
        "输出 token 256–32000，输入字数 1000–200000，调用次数 1–20",
      );
    return {
      name: String(b.name).slice(0, 200),
      preset_id: b.preset_id,
      goal: String(b.goal ?? "").slice(0, 4000),
      provider_id: b.provider_id,
      model: String(b.model ?? ""),
      max_output_tokens,
      input_limit,
      max_calls,
      approval: b.approval === "automatic" ? "automatic" : "manual",
      material_ids: b.material_ids ?? [],
      dataset_id: b.dataset_id ?? null,
    };
  };
  app.post("/api/w/:wid/recipes", (r) => {
    const { userId, workspaceId } = workspace(r, store, true),
      data = parseRecipe(body(r), userId);
    const recipe = {
      id: randomUUID(),
      user_id: userId,
      workspace_id: workspaceId,
      ...data,
      created_at: now(),
    };
    store.put("recipe", recipe, userId, workspaceId);
    return recipe;
  });
  app.patch("/api/w/:wid/recipes/:id", (r) => {
    const { userId, workspaceId } = workspace(r, store, true),
      recipe = store.get("recipe", (r.params as any).id);
    if (
      !recipe ||
      recipe.workspace_id !== workspaceId ||
      recipe.user_id !== userId
    )
      fail("not_found", "流程不存在或不是你的模型配置", 404);
    Object.assign(recipe, parseRecipe({ ...recipe, ...body(r) }, userId));
    store.put("recipe", recipe, userId, workspaceId);
    return recipe;
  });
  app.delete("/api/w/:wid/recipes/:id", (r) => {
    const { userId, workspaceId } = workspace(r, store, true),
      recipe = store.get("recipe", (r.params as any).id);
    if (
      !recipe ||
      recipe.workspace_id !== workspaceId ||
      recipe.user_id !== userId
    )
      fail("not_found", "流程不存在", 404);
    store.remove("recipe", recipe.id);
    return { ok: true };
  });
  app.get("/api/w/:wid/jobs", (r) => {
    const { workspaceId } = workspace(r, store);
    return store.jobSummaries(workspaceId);
  });
  app.get("/api/w/:wid/jobs/:id", (r) => {
    const { workspaceId } = workspace(r, store),
      j = store.get("job", (r.params as any).id);
    if (!j || j.workspace_id !== workspaceId)
      fail("not_found", "任务不存在", 404);
    return {
      ...j,
      inputs: j.inputs?.map((i: any) => ({
        material_id: i.material_id,
        revision_id: i.revision_id,
        title: i.title,
      })),
      recipe: j.recipe ? { ...j.recipe, provider_id: undefined } : undefined,
    };
  });
  app.get("/api/w/:wid/jobs/:id/export", (r) => {
    const ctx = workspace(r, store),
      j = store.get("job", (r.params as any).id);
    if (!j || j.workspace_id !== ctx.workspaceId)
      fail("not_found", "任务不存在", 404);
    const q = r.query as any,
      offset = Number(q.offset ?? 0),
      limit = Number(q.limit ?? 100);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 1000
    )
      fail("invalid_page", "导出偏移和批量应为非负整数及 1–1000");
    const fixed =
      j.kind === "capture" ? (j.checkpoint.saved_records ?? []) : [];
    if (j.kind === "capture" && !fixed.length)
      fail(
        "task_receipts_missing",
        "此任务没有固定版本保存回执；不会改用整个星球或当前资料头版本",
        409,
      );
    const selected = fixed.slice(offset, offset + limit),
      aids =
        j.kind === "process"
          ? j.artifact_ids.slice(offset, offset + limit)
          : [];
    const bundle = exportBundle(store, ctx, [], aids, false, false, selected),
      total = j.kind === "capture" ? fixed.length : j.artifact_ids.length;
    const result = createBundle({
      ...bundle,
      coverage: {
        ...bundle.coverage,
        task_id: j.id,
        task_state: j.state,
        fixed_capture_revisions: j.kind === "capture",
        offset,
        limit,
        total,
        next_offset: offset + limit < total ? offset + limit : null,
        attachments: "excluded_use_library_explicit_zip",
      },
    });
    if (Buffer.byteLength(JSON.stringify(result)) > 16 * 1024 * 1024)
      fail(
        "export_too_large",
        "本批 JSON 超过 16 MiB，请降低每批条数后重新导出",
        413,
      );
    return result;
  });
  app.post("/api/w/:wid/jobs", (r) => {
    const { userId, workspaceId, device } = workspace(r, store, true),
      b = body(r);
    if (!["capture", "process"].includes(b.kind))
      fail("invalid_job", "未知任务类型");
    if (device && b.kind !== "process")
      fail(
        "policy_denied",
        "外部 Agent 令牌不允许读取源站登录态或创建采集",
        403,
      );
    const j: Job = {
      id: randomUUID(),
      workspace_id: workspaceId,
      user_id: userId,
      kind: b.kind,
      state: "queued",
      created_at: now(),
      updated_at: now(),
      events: [],
      checkpoint: { page: 0, seen: [], calls: 0 },
      scope: {},
      recipe: null,
      inputs: [],
      processed: 0,
      approved: false,
      artifact_ids: [],
    };
    if (b.kind === "capture") {
      const c = own<Connection>(store, "connection", b.connection_id, userId);
      if (c.state !== "ready") fail("login_required", "来源连接尚未验证");
      const s = b.scope ?? {};
      if (
        !/^\d+$/.test(String(s.group_id)) ||
        (s.author_id && !/^\d+$/.test(String(s.author_id))) ||
        !c.groups?.some((g) => g.id === s.group_id)
      )
        fail("scope_denied", "选择已验证账号加入的星球及稳定成员 ID");
      const max_pages = Number(s.max_pages ?? 10);
      if (!Number.isInteger(max_pages) || max_pages < 1 || max_pages > 1000)
        fail("invalid_budget", "页数上限应为 1–1000");
      if (
        (s.from && isNaN(Date.parse(s.from))) ||
        (s.to && isNaN(Date.parse(s.to)))
      )
        fail("invalid_time", "日期范围无效");
      j.scope = {
        group_id: s.group_id,
        author_id: s.author_id ?? null,
        from: s.from ?? null,
        to: s.to ?? null,
        types:
          Array.isArray(s.types) &&
          s.types.every((t: string) =>
            ["topic", "answer", "comment"].includes(t),
          )
            ? s.types
            : ["topic", "answer", "comment"],
        max_pages,
        include_comments: !!s.include_comments,
        include_attachments: !!s.include_attachments,
      };
      j.connection_id = c.id;
      j.channel = c.channel;
      j.source_account_id = c.source_account_id;
      j.approved = true;
    } else {
      const recipe = store.get("recipe", b.recipe_id);
      if (
        !recipe ||
        recipe.workspace_id !== workspaceId ||
        recipe.user_id !== userId
      )
        fail("recipe_denied", "请选择属于自己的流程与模型");
      j.recipe = { ...recipe };
      own<Provider>(store, "provider", recipe.provider_id, userId);
      let ids = b.material_ids ?? recipe.material_ids;
      if (recipe.dataset_id) {
        const d = store.get("dataset", recipe.dataset_id);
        if (!d || d.workspace_id !== workspaceId)
          fail("dataset_denied", "专题不可用");
        const snapshot = d.last_snapshot_id
          ? store.get("snapshot", d.last_snapshot_id)
          : null;
        if (snapshot) ids = snapshot.items.map((i: any) => i.material_id);
        else ids = resolveDataset(store, d);
      }
      if (!Array.isArray(ids) || !ids.length || ids.length > 1000)
        fail("empty_materials", "选择 1–1000 份材料");
      if (
        (device || recipe.approval === "automatic") &&
        !recipe.dataset_id &&
        ids.some((id: string) => !recipe.material_ids.includes(id))
      )
        fail(
          "policy_denied",
          "自动执行或外部 Agent 不能扩大流程预先选定的材料范围",
          403,
        );
      for (const id of [...new Set(ids)] as string[]) {
        const m = store.get("material", id);
        if (!m || m.workspace_id !== workspaceId || m.archived_at)
          fail("material_denied", "选择的材料不可用");
        let revision =
          store.get("revision", m.revision_id) ?? m.revisions?.at(-1);
        const d = recipe.dataset_id
          ? store.get("dataset", recipe.dataset_id)
          : null;
        const snapshot = d?.last_snapshot_id
          ? store.get("snapshot", d.last_snapshot_id)
          : null;
        const frozen = snapshot?.items?.find((i: any) => i.material_id === id);
        if (frozen) revision = store.get("revision", frozen.revision_id);
        if (!revision) fail("revision_missing", "材料版本不可用");
        j.inputs.push({
          material_id: m.id,
          revision_id: revision.id,
          text: revision.text,
          title: revision.record_meta?.title ?? m.title,
          author_id: revision.record_meta?.author_id ?? m.author_id,
          author_name: revision.record_meta?.author_name ?? m.author_name,
          entity_type: m.entity_type,
          parent_entity_id: m.parent_entity_id,
          source_key: m.source_key,
          coverage: revision.coverage,
        });
      }
      if (b.target_artifact_id) {
        if (device)
          fail("policy_denied", "外部Agent不得扩大既定流程的输入前稿范围", 403);
        const target = store.get("artifact", b.target_artifact_id);
        if (
          !target ||
          target.workspace_id !== workspaceId ||
          target.archived_at
        )
          fail("target_denied", "待改写稿件不可用");
        if (
          ![
            target.revision,
            target.revision_id,
            target.current_revision,
          ].includes(b.base_revision)
        )
          fail(
            "REVISION_CONFLICT",
            "目标稿件已经变化，请重新查看后建立提案",
            409,
          );
        j.target_artifact_id = target.id;
        j.target = {
          id: target.id,
          revision_id: target.revision_id,
          revision: target.revision,
          title: target.title,
          body: target.body,
          citations: target.citations,
        };
      }
      j.state =
        recipe.approval === "automatic" && !j.target
          ? "queued"
          : "awaiting_approval";
      j.approved = recipe.approval === "automatic" && !j.target;
      j.plan = {
        destination: cleanProvider(
          own<Provider>(store, "provider", recipe.provider_id, userId),
        ).base_url,
        model: recipe.model || store.get("provider", recipe.provider_id).model,
        materials: j.inputs.length,
        input_characters: j.inputs.reduce((n, i) => n + i.text.length, 0),
        max_calls: recipe.max_calls,
        max_output_tokens: recipe.max_output_tokens,
        execution: "server",
        partial_materials: j.inputs.filter((i) =>
          Object.values(i.coverage ?? {}).includes("partial"),
        ).length,
        ...(j.target
          ? {
              previous_draft: {
                id: j.target.id,
                revision_id: j.target.revision_id,
                title: j.target.title,
                input_characters: j.target.body.length,
              },
              output: "proposal_without_overwrite",
            }
          : {}),
      };
      const provider = own<Provider>(
        store,
        "provider",
        recipe.provider_id,
        userId,
      );
      j.provider_fingerprint = sha256(
        canonical({
          base_url: provider.base_url,
          protocol: provider.protocol,
          model: provider.model,
          secret: provider.secret,
        }),
      );
    }
    store.put("job", j, userId, workspaceId);
    event(
      store,
      j,
      "created",
      j.kind === "capture"
        ? "来源只读采集范围已固定"
        : "分析输入版本已固定，请确认外发目的地和预算",
    );
    if (options.startWorker !== false) void tick();
    return j;
  });
  app.post("/api/w/:wid/jobs/:id/:action", (r) => {
    const { userId, workspaceId, device } = workspace(r, store, true),
      { id, action } = r.params as any;
    const j = store.get("job", id) as Job;
    if (!j || j.workspace_id !== workspaceId || j.user_id !== userId)
      fail("not_found", "任务不存在或不是你的执行凭据", 404);
    if (device && (j.kind === "capture" || action === "approve"))
      fail("policy_denied", "外部 Agent 不得操作源站采集或代替人工批准", 403);
    if (action === "approve") {
      if (j.state !== "awaiting_approval")
        fail("invalid_transition", "任务不在等待审批");
      j.approved = true;
      j.state = "queued";
    } else if (action === "pause") {
      if (!["queued", "running", "rate_limited"].includes(j.state))
        fail("invalid_transition", "当前任务不能暂停");
      j.state = "paused";
      running.get(id)?.abort();
    } else if (action === "cancel") {
      if (["completed", "cancelled"].includes(j.state))
        fail("invalid_transition", "任务已经结束");
      j.state = "cancelled";
      running.get(id)?.abort();
    } else if (action === "retry_failed") {
      if (
        running.has(id) ||
        j.kind !== "capture" ||
        ![
          "completed",
          "partial",
          "failed",
          "login_required",
          "rate_limited",
          "paused",
        ].includes(j.state)
      )
        fail("invalid_transition", "只可重试已停止采集任务中的已知失败项");
      const ids = [
        ...new Set(
          (j.checkpoint.failures ?? [])
            .map((x: any) => String(x.topic_id))
            .filter((id: string) => /^\d{1,24}$/.test(id)),
        ),
      ];
      if (!ids.length) fail("no_failed_items", "此任务没有已记录的失败主题");
      const c = own<Connection>(store, "connection", j.connection_id!, userId);
      if (c.state !== "ready" || c.source_account_id !== j.source_account_id)
        fail("identity_mismatch", "先重新验证同一来源账号");
      j.checkpoint.retry_topic_ids = ids;
      j.checkpoint.retry_original_coverage = j.coverage ?? {
        range: "partial",
        reason: "原任务范围未证明完整",
      };
      j.state = "queued";
      j.error = undefined;
    } else if (action === "resume") {
      if (running.has(id))
        fail(
          "execution_in_progress",
          "上次请求尚未结束，先等待执行器保存最终状态再恢复",
          409,
        );
      if (
        ![
          "paused",
          "failed",
          "login_required",
          "rate_limited",
          "budget_paused",
          "outcome_unknown",
          "partial",
        ].includes(j.state)
      )
        fail("invalid_transition", "当前任务不能恢复");
      if (j.state === "outcome_unknown" && !body(r).retry_unknown)
        fail(
          "unknown_confirmation_required",
          "请检查服务商记录，并明确确认重新调用可能再次计费",
          409,
        );
      if (j.checkpoint.unparsed_response)
        fail(
          "output_review_required",
          "已保留本次计费输出。请人工整理或另建明确审批的新任务，不能重放同一批次",
          409,
        );
      if (j.kind === "capture") {
        const c = own<Connection>(
          store,
          "connection",
          j.connection_id!,
          userId,
        );
        if (c.state !== "ready" || c.source_account_id !== j.source_account_id)
          fail("identity_mismatch", "先重新验证同一来源账号");
        if (j.state === "partial" && j.checkpoint.page >= j.scope.max_pages)
          j.scope.max_pages = Math.min(1000, j.scope.max_pages + 10);
      }
      if (j.state === "budget_paused")
        fail(
          "budget_exceeded",
          "复制流程调整预算并使用已保存的材料重新开始；当前输入版本不会被无声改动",
        );
      j.state = "queued";
      j.checkpoint.call_pending = false;
      j.error = undefined;
    } else fail("invalid_action", "未知任务操作");
    event(
      store,
      j,
      action,
      "用户" +
        (
          {
            approve: "确认计划",
            pause: "暂停",
            cancel: "取消",
            resume: "恢复",
            retry_failed: "仅重试本任务已知失败主题",
          } as any
        )[action],
    );
    if (options.startWorker !== false) void tick();
    return j;
  });

  async function capture(j: Job) {
    let c = own<Connection>(store, "connection", j.connection_id!, j.user_id);
    const read = async (path: string, query: Record<string, unknown> = {}) => {
      authorizeJob(j);
      if (store.get("job", j.id)?.state !== "running")
        throw Object.assign(new Error("任务已停止"), { code: "job_stopped" });
      try {
        return await sources.request(c, path, query);
      } catch (error) {
        const id = j.checkpoint.active_topic_id;
        if (id) {
          const stage = path.includes("/comments")
            ? "comments"
            : path.includes("/articles")
              ? "article"
              : path.includes("/files")
                ? "attachments"
                : "detail";
          const old = (j.checkpoint.failures ?? []).find(
            (x: any) => x.topic_id === id,
          );
          j.checkpoint.failures = [
            ...(j.checkpoint.failures ?? []).filter(
              (x: any) => x.topic_id !== id,
            ),
            {
              topic_id: id,
              stages: [...new Set([...(old?.stages ?? []), stage])],
              at: now(),
            },
          ];
        }
        throw error;
      }
    };
    try {
      Object.assign(c, await sources.verify(c));
      if (c.source_account_id !== j.source_account_id)
        throw Object.assign(new Error("来源账号不一致"), {
          code: "identity_mismatch",
        });
      await read(sourcePaths.topics(j.scope.group_id), {
        count: 1,
        scope: "all",
      });
    } catch (e: any) {
      if (c.policy !== "auto" || e.code === "identity_mismatch") throw e;
      const fallback = store
        .list("connection", { userId: j.user_id })
        .find(
          (other) =>
            other.id !== c.id &&
            other.state === "ready" &&
            other.source_account_id === j.source_account_id &&
            other.groups?.some((g: any) => g.id === j.scope.group_id) &&
            other.channel !== c.channel,
        );
      if (!fallback) throw e;
      c = fallback;
      Object.assign(c, await sources.verify(c));
      await read(sourcePaths.topics(j.scope.group_id), {
        count: 1,
        scope: "all",
      });
      j.actual_connection_id = c.id;
      event(store, j, "channel_selected", "已切换到同一已验证账号的授权通道", {
        channel: c.channel,
        connection_id: c.id,
      });
    }
    j.channel = c.channel;
    const groups = normalizeGroups(await read(sourcePaths.groups));
    if (!groups.some((g) => g.id === j.scope.group_id))
      throw new Error("source_group_not_joined");
    sources.setBusy(c.channel === "browser");
    try {
      const seen = new Set<string>(j.checkpoint.seen ?? []),
        retryMode = Array.isArray(j.checkpoint.retry_topic_ids);
      let ended = false;
      while (
        retryMode
          ? j.checkpoint.retry_topic_ids.length
          : j.checkpoint.page < j.scope.max_pages
      ) {
        authorizeJob(j);
        if (store.get("job", j.id).state !== "running") return;
        const query: any = { count: 20, scope: "all" };
        if (j.checkpoint.cursor) query.end_time = j.checkpoint.cursor;
        else if (j.scope.to)
          query.end_time = new Date(j.scope.to)
            .toISOString()
            .replace("Z", "+0000");
        const d = retryMode
          ? { topics: [{ topic_id: j.checkpoint.retry_topic_ids[0] }] }
          : await read(sourcePaths.topics(j.scope.group_id), query);
        const topics = d.topics ?? [];
        let fresh = 0;
        for (const summary of topics) {
          const topicId = String(summary.topic_id);
          if (seen.has(topicId) && !retryMode) continue;
          if (
            j.scope.from &&
            Date.parse(summary.create_time) < Date.parse(j.scope.from)
          ) {
            ended = true;
            break;
          }
          if (store.get("job", j.id).state !== "running") return;
          const failedStages = new Set<string>();
          j.checkpoint.active_topic_id = topicId;
          const stageFailure = (stage: string) => {
            failedStages.add(stage);
            j.checkpoint.failures = [
              ...(j.checkpoint.failures ?? []).filter(
                (x: any) => x.topic_id !== topicId,
              ),
              { topic_id: topicId, stages: [...failedStages], at: now() },
            ];
          };
          let topic = summary,
            detailComplete = true;
          try {
            const detail = await read(sourcePaths.detail(topicId));
            topic = detail.topic ?? detail;
          } catch (e: any) {
            stageFailure("detail");
            if (
              retryMode ||
              ["login_required", "rate_limited"].includes(e.code)
            )
              throw e;
            detailComplete = false;
            event(
              store,
              j,
              "detail_missing",
              "详情未获取，将标记正文部分获取",
              { topic_id: topicId },
            );
          }
          let rec = normalizeTopic(topic, j.scope.group_id);
          if (!detailComplete) {
            rec.coverage.body = "partial";
            rec.coverage.reasons.push("主题详情读取失败；只保留列表返回文本");
          }
          const article = topic.talk?.article;
          if (
            article &&
            !article.content &&
            article.article_id &&
            c.channel === "browser"
          ) {
            try {
              const a = await read(
                sourcePaths.article(String(article.article_id)),
              );
              const content = a.article?.content ?? a.content;
              if (typeof content !== "string")
                throw new Error("article_content_missing");
              rec.text = plainText(content);
              rec.fragments = fragmentsFor(rec.text);
              rec.hash = sha256(rec.text);
              rec.coverage.body = "complete";
              rec.coverage.reasons = rec.coverage.reasons.filter(
                (r) => !r.includes("长文"),
              );
            } catch {
              stageFailure("article");
              rec.coverage.reasons.push("长文读取失败，需要在源站人工查看");
            }
          }
          const comments: any[] = [];
          let commentsComplete =
            (topic.comments_count ?? topic.counts?.comments) !== undefined &&
            Number(topic.comments_count ?? topic.counts?.comments) === 0;
          if (j.scope.include_comments && !commentsComplete) {
            let index: string | undefined;
            const ids = new Set<string>();
            for (let p = 0; p < 100; p++) {
              const cd = await read(sourcePaths.comments(topicId), {
                count: 30,
                sort_type: "by_interactions_count",
                with_sticky: false,
                index,
              });
              const cs = cd.comments ?? [];
              let newCount = 0;
              for (const x of cs) {
                const id = String(x.comment_id);
                if (!ids.has(id)) {
                  comments.push(x);
                  ids.add(id);
                  newCount++;
                }
              }
              const next = cd.index ?? cd.next_index;
              if (!cs.length || (cs.length < 30 && !next)) {
                commentsComplete = true;
                break;
              }
              if (!next || next === index || !newCount) break;
              index = String(next);
              await pause(600);
            }
          }
          rec.coverage.comments = commentsComplete ? "complete" : "partial";
          const save = (record: SourceRecord, context = false) => {
            authorizeJob(j);
            if (store.get("job", j.id)?.state !== "running")
              throw Object.assign(new Error("任务已停止，未继续保存新资料"), {
                code: "job_stopped",
              });
            if (
              !context &&
              j.scope.author_id &&
              record.author_id !== j.scope.author_id
            )
              return;
            if (
              !context &&
              !j.scope.types.includes(record.source_key.entity_type)
            )
              return;
            return store.transaction(() => {
              const receipt = ingestRecord(
                store,
                j.workspace_id,
                j.user_id,
                record,
              );
              const revision = store.get("revision", receipt.revision_id);
              if (revision) {
                revision.source_truth = "server_observed";
                store.put("revision", revision);
                const material = store.get("material", receipt.id);
                material.revisions = material.revisions.map((v: any) =>
                  v.id === revision.id ? revision : v,
                );
                store.put("material", material);
              }
              j.checkpoint.material_ids ??= [];
              if (!j.checkpoint.material_ids.includes(receipt.id))
                j.checkpoint.material_ids.push(receipt.id);
              j.processed = j.checkpoint.material_ids.length;
              j.checkpoint.saved_records = [
                ...(j.checkpoint.saved_records ?? []).filter(
                  (x: any) => x.material_id !== receipt.id,
                ),
                { material_id: receipt.id, revision_id: receipt.revision_id },
              ];
              if (context) {
                j.checkpoint.context_material_ids ??= [];
                if (!j.checkpoint.context_material_ids.includes(receipt.id))
                  j.checkpoint.context_material_ids.push(receipt.id);
              }
              store.put("job", j, j.user_id, j.workspace_id);
              return receipt;
            });
          };
          const receipt = save(rec);
          const answer = answerRecord(topic, j.scope.group_id);
          if (answer) save(answer);
          const observed = observedComments(comments);
          for (const row of observed) {
            const cr = commentRecord(row.comment, topicId, j.scope.group_id);
            if (row.parent_comment_id)
              cr.title =
                "回复 · 评论 " + row.parent_comment_id + " · 主题 " + topicId;
            save(
              cr,
              !!receipt &&
                j.scope.include_comments &&
                cr.author_id !== j.scope.author_id,
            );
          }
          if (observed.some((row) => row.depth > 0)) {
            rec.coverage.comments = "partial";
            rec.coverage.reasons.push(
              "已归档实际返回的子回复；不能证明所有子回复分页已覆盖",
            );
            save(rec);
          }
          if (j.scope.include_attachments && receipt) {
            let all = true;
            for (const image of (
              topic.talk ??
              topic.question ??
              topic.task ??
              topic.solution ??
              topic
            ).images ?? []) {
              try {
                authorizeJob(j);
                if (c.channel === "official")
                  throw new Error("official_image_unverified");
                const raw = image.original?.url;
                if (
                  !/^\d{1,24}$/.test(String(image.image_id)) ||
                  typeof raw !== "string"
                )
                  throw new Error("image_missing");
                const u = new URL(raw);
                if (
                  u.protocol !== "https:" ||
                  u.username ||
                  u.password ||
                  !u.hostname.endsWith(".zsxq.com")
                )
                  throw new Error("image_host_unverified");
                const bytes = await (options.download ?? publicRequest)(
                  raw,
                  {
                    signal: AbortSignal.any([
                      running.get(j.id)!.signal,
                      AbortSignal.timeout(90000),
                    ]),
                  },
                  50 * 1024 * 1024,
                );
                const mime = bytes.headers.get("content-type") ?? "";
                if (bytes.status !== 200 || !mime.startsWith("image/"))
                  throw new Error("image_download_failed");
                authorizeJob(j);
                const hash = sha256(bytes.bytes);
                if (!existsSync(join(store.blobDir, hash)))
                  writeFileSync(join(store.blobDir, hash), bytes.bytes, {
                    mode: 0o600,
                  });
                if (
                  !store
                    .list("attachment", { workspaceId: j.workspace_id })
                    .some(
                      (a) =>
                        a.hash === hash &&
                        canonical(a.record_source_key) ===
                          canonical(rec.source_key),
                    )
                )
                  store.put(
                    "attachment",
                    {
                      id: randomUUID(),
                      workspace_id: j.workspace_id,
                      hash,
                      size: bytes.bytes.length,
                      name:
                        "image-" +
                        String(image.image_id) +
                        "." +
                        (mime.includes("png")
                          ? "png"
                          : mime.includes("webp")
                            ? "webp"
                            : "jpg"),
                      mime,
                      record_source_key: rec.source_key,
                      status: "available",
                      created_at: now(),
                      created_by: j.user_id,
                      parse_state: "unsupported",
                      parse_reason: "图片原件已保存，未自动 OCR",
                    },
                    j.user_id,
                    j.workspace_id,
                  );
                event(store, j, "image_saved", "已校验图片原件", {
                  image_id: String(image.image_id),
                  hash,
                });
              } catch {
                all = false;
              }
            }
            for (const f of rec.files ?? []) {
              if (c.channel === "official") {
                all = false;
                continue;
              }
              try {
                const fd = await read(sourcePaths.fileDownload(f.id));
                const url = fd.download_url ?? fd.url;
                if (typeof url !== "string")
                  throw new Error("download_unavailable");
                authorizeJob(j);
                const downloaded = await (options.download ?? publicRequest)(
                  url,
                  {
                    signal: AbortSignal.any([
                      running.get(j.id)!.signal,
                      AbortSignal.timeout(90000),
                    ]),
                  },
                  50 * 1024 * 1024,
                );
                if (downloaded.status !== 200)
                  throw new Error("download_failed");
                authorizeJob(j);
                const hash = sha256(downloaded.bytes),
                  blob = join(store.blobDir, hash);
                if (!existsSync(blob))
                  writeFileSync(blob, downloaded.bytes, { mode: 0o600 });
                const existing = store
                  .list("attachment", { workspaceId: j.workspace_id })
                  .find(
                    (a) =>
                      a.hash === hash &&
                      canonical(a.record_source_key) ===
                        canonical(rec.source_key),
                  );
                if (!existing) {
                  const parsed = await extractAttachment(
                    downloaded.bytes,
                    f.name,
                  );
                  store.put(
                    "attachment",
                    {
                      id: randomUUID(),
                      workspace_id: j.workspace_id,
                      hash,
                      size: downloaded.bytes.length,
                      name: f.name,
                      mime:
                        downloaded.headers.get("content-type") ??
                        "application/octet-stream",
                      record_source_key: rec.source_key,
                      status: "available",
                      created_at: now(),
                      created_by: j.user_id,
                      parse_state: parsed.state,
                      extracted_text: parsed.text,
                      parse_reason: parsed.reason,
                    },
                    j.user_id,
                    j.workspace_id,
                  );
                }
                event(store, j, "attachment_saved", "已校验并保存附件原件", {
                  name: f.name,
                  hash,
                });
              } catch {
                all = false;
              }
            }
            if (all) {
              rec.coverage.attachments = "complete";
              const updated = save(rec);
              if (updated)
                event(store, j, "coverage_updated", "附件完整度已读回");
            } else
              event(
                store,
                j,
                "attachments_partial",
                "附件原件缺失；不会宣称完整归档",
              );
          }
          if (j.scope.include_comments && !commentsComplete)
            stageFailure("comments");
          if (
            j.scope.include_attachments &&
            rec.coverage.attachments !== "complete"
          )
            stageFailure("attachments");
          if (!failedStages.size)
            j.checkpoint.failures = (j.checkpoint.failures ?? []).filter(
              (x: any) => x.topic_id !== topicId,
            );
          if (retryMode) j.checkpoint.retry_topic_ids.shift();
          j.checkpoint.active_topic_id = null;
          seen.add(topicId);
          fresh++;
          j.checkpoint.seen = [...seen];
          event(store, j, "saved", "已保存来源版本", {
            topic_id: topicId,
            processed: j.processed,
          });
          await pause(650);
        }
        if (retryMode) {
          if (!j.checkpoint.retry_topic_ids.length) ended = true;
          continue;
        }
        const cursor = topics.at(-1)?.create_time;
        j.checkpoint.page++;
        if (ended || !topics.length || topics.length < 20) {
          ended = true;
          break;
        }
        if (!cursor || cursor === j.checkpoint.cursor || !fresh) {
          j.checkpoint.range_reason = "分页游标未推进，无法证明覆盖完整";
          break;
        }
        j.checkpoint.cursor = cursor;
        event(store, j, "checkpoint", "已保存分页断点", {
          page: j.checkpoint.page,
        });
        await pause(1000);
      }
      j.coverage = retryMode
        ? j.checkpoint.retry_original_coverage
        : {
            range: ended ? "complete" : "partial",
            reason: ended
              ? "已到达空页或指定时间边界"
              : (j.checkpoint.range_reason ??
                "到达用户页数上限；可手动恢复继续"),
          };
      if (retryMode) j.checkpoint.retry_topic_ids = null;
      j.state =
        j.coverage.range === "complete" && !(j.checkpoint.failures ?? []).length
          ? "completed"
          : "partial";
      event(
        store,
        j,
        "finished",
        (j.checkpoint.failures ?? []).length
          ? "范围与已知失败项分别记录；可仅重试失败主题"
          : ended
            ? "范围读取结束；正文/讨论/附件完整度分别保留"
            : "已保存部分结果，范围尚未读完",
      );
    } finally {
      sources.setBusy(false);
    }
  }
  async function processJob(j: Job) {
    const p = own<Provider>(store, "provider", j.recipe.provider_id, j.user_id);
    const fingerprint = sha256(
      canonical({
        base_url: p.base_url,
        protocol: p.protocol,
        model: p.model,
        secret: p.secret,
      }),
    );
    if (fingerprint !== j.provider_fingerprint) {
      j.provider_fingerprint = fingerprint;
      j.plan = {
        ...j.plan,
        destination: p.base_url,
        model: j.recipe.model || p.model,
      };
      j.state = "awaiting_approval";
      j.approved = false;
      event(
        store,
        j,
        "plan_changed",
        "模型连接配置已变化；需重新确认外发计划，本次尚未调用",
      );
      return;
    }
    const key = secrets.decrypt(p.secret).toString();
    const baselineSize = j.target
      ? j.target.body.length + j.target.title.length
      : 0;
    const groups: any[][] = [[]];
    let size = baselineSize;
    for (const [index, i] of j.inputs.entries()) {
      if (i.text.length + baselineSize > j.recipe.input_limit) {
        j.state = "budget_paused";
        event(store, j, "budget", "单份材料超过输入字数预算；未截断或外发");
        return;
      }
      if (size + i.text.length > j.recipe.input_limit) {
        groups.push([]);
        size = baselineSize;
      }
      groups.at(-1)!.push({ ...i, label: `S${index + 1}` });
      size += i.text.length;
    }
    if (groups.length > j.recipe.max_calls) {
      j.state = "budget_paused";
      event(
        store,
        j,
        "budget",
        `需要 ${groups.length} 次分批调用，超过许可 ${j.recipe.max_calls} 次；未外发`,
      );
      return;
    }
    for (let n = j.checkpoint.calls ?? 0; n < groups.length; n++) {
      authorizeJob(j);
      if (store.get("job", j.id).state !== "running") return;
      const chunk = groups[n],
        input = canonical({
          SOURCES: chunk.map((i) => ({
            label: i.label,
            title: i.title,
            text: i.text,
            author_id: i.author_id,
            author_name: i.author_name,
            entity_type: i.entity_type,
            parent_entity_id: i.parent_entity_id,
            source_key: i.source_key,
            coverage: i.coverage,
          })),
          ...(j.target
            ? {
                PREVIOUS_DRAFT: {
                  title: j.target.title,
                  body: j.target.body,
                  revision_id: j.target.revision_id,
                  role: "untrusted_previous_draft_not_new_source",
                },
              }
            : {}),
        });
      if (
        (j.checkpoint.attempts ?? j.checkpoint.calls ?? 0) >= j.recipe.max_calls
      ) {
        j.state = "budget_paused";
        event(
          store,
          j,
          "budget",
          "包括结果未知的外发尝试已达到调用预算；未再次外发",
        );
        return;
      }
      j.checkpoint.attempts =
        (j.checkpoint.attempts ?? j.checkpoint.calls ?? 0) + 1;
      j.checkpoint.call_pending = true;
      event(store, j, "model_sent", "按确认计划发送固定版本资料", {
        batch: n + 1,
        destination: p.base_url,
        model: j.recipe.model || p.model,
      });
      const request: typeof publicRequest = (url, init, max) =>
        (options.request ?? publicRequest)(
          url,
          {
            ...init,
            signal: AbortSignal.any([
              running.get(j.id)!.signal,
              AbortSignal.timeout(90000),
            ]),
          },
          max,
        );
      const response = await providerCall(
        p,
        key,
        analysisInstructions(j.recipe.preset_id, j.recipe.goal),
        input,
        j.recipe.max_output_tokens,
        j.recipe.model || p.model,
        request,
      );
      j.checkpoint.calls = n + 1;
      j.checkpoint.call_pending = false;
      j.checkpoint.last_output = response.text;
      j.usage ??= [];
      j.usage.push(response.usage);
      event(
        store,
        j,
        "model_received",
        "已收到本批模型输出，调用次数与结果已落盘",
      );
      if (response.truncated) {
        j.checkpoint.unparsed_response = response.text;
        j.state = "partial";
        event(
          store,
          j,
          "output_truncated",
          "模型标记输出截断或未完成；保留已计费结果，不冒充完整成果",
          { stop_reason: response.stop_reason },
        );
        return;
      }
      let parsed: any;
      try {
        parsed = JSON.parse(
          response.text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, ""),
        );
      } catch {
        j.checkpoint.call_pending = false;
        j.checkpoint.unparsed_response = response.text;
        j.state = "partial";
        event(
          store,
          j,
          "output_invalid",
          "已收到计费输出，但不是约定 JSON，保留输出供人工处理，不重试",
        );
        return;
      }
      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        typeof parsed.title !== "string" ||
        !parsed.title.trim() ||
        parsed.title.length > 1000 ||
        parsed.title.includes("\0") ||
        typeof parsed.body !== "string" ||
        parsed.body.length > 1000000 ||
        parsed.body.includes("\0") ||
        !Array.isArray(parsed.citations) ||
        parsed.citations.length > 10000 ||
        parsed.citations.some(
          (l: any) =>
            typeof l !== "string" || !chunk.some((i) => i.label === l),
        ) ||
        [...String(parsed.body).matchAll(/\[(S\d+)\]/g)].some(
          (m) => !parsed.citations.includes(m[1]),
        )
      ) {
        j.checkpoint.call_pending = false;
        j.checkpoint.unparsed_response = response.text;
        j.state = "partial";
        event(
          store,
          j,
          "invalid_citations",
          "模型输出或引用无法核验，保留原始输出，未采纳",
        );
        return;
      }
      const citations = parsed.citations.map((label: string) => {
        const i = chunk.find((i) => i.label === label)!;
        return {
          material_id: i.material_id,
          revision_id: i.revision_id,
          source_key: i.source_key,
          label,
        };
      });
      store.transaction(() => {
        const artifact = createArtifact(store, j.workspace_id, j.user_id, {
          title: parsed.title,
          body: parsed.body,
          citations,
          status: "draft",
          model_attribution: `${p.label} / ${response.model}`,
          job_id: j.id,
        });
        if (j.target) {
          const proposal = createProposal(store, j.workspace_id, j.user_id, {
            artifact_id: j.target.id,
            base_revision: j.target.revision_id,
            title: parsed.title,
            body: parsed.body,
            citations,
            job_id: j.id,
            draft_artifact_id: artifact.id,
          });
          j.proposal_ids ??= [];
          j.proposal_ids.push(proposal.id);
        }
        j.artifact_ids.push(artifact.id);
        j.checkpoint.call_pending = false;
        j.processed += chunk.length;
        event(store, j, "draft_saved", "已保存 AI 草稿；等待人工复核与采纳", {
          artifact_id: artifact.id,
          batch: n + 1,
        });
      });
    }
    if (["paused", "cancelled"].includes(store.get("job", j.id).state)) return;
    j.state = "completed";
    event(store, j, "finished", "流程完成，成果保留为草稿");
  }
  async function tick() {
    if (ticking || stopping) return;
    ticking = true;
    try {
      const j = store.nextQueuedJob<Job>();
      if (!j) return;
      const controller = new AbortController();
      running.set(j.id, controller);
      j.state = "running";
      event(store, j, "started", "串行执行器开始任务");
      try {
        authorizeJob(j);
        if (j.kind === "capture") await capture(j);
        else await processJob(j);
      } catch (e: any) {
        const state = store.get("job", j.id)?.state;
        if (["paused", "cancelled"].includes(state)) {
          j.state = j.checkpoint.call_pending ? "outcome_unknown" : state;
        } else
          j.state =
            e.code === "outcome_unknown"
              ? "outcome_unknown"
              : e.code === "login_required"
                ? "login_required"
                : e.code === "rate_limited"
                  ? "rate_limited"
                  : "failed";
        j.error = { code: e.code ?? "execution_failed", message: e.message };
        if (
          j.connection_id &&
          ["login_required", "identity_mismatch"].includes(e.code)
        ) {
          const c = store.get("connection", j.connection_id);
          c.state =
            e.code === "identity_mismatch" ? "identity_mismatch" : "expired";
          store.put("connection", c, c.user_id);
        }
        event(store, j, "stopped", j.error.message);
      } finally {
        running.delete(j.id);
      }
    } finally {
      ticking = false;
    }
  }
  const timer =
    options.startWorker === false
      ? undefined
      : setInterval(() => void tick(), 1000);
  timer?.unref();
  // A finite, workspace-pinned MCP surface. No shell, CDP, arbitrary URL or source write.
  app.get("/api/w/:wid/tools-tokens", (r) => {
    const { userId, workspaceId } = workspace(r, store);
    return store
      .list("device", { userId, workspaceId })
      .filter((d) => d.kind === "mcp")
      .map(({ id, label, scopes, created_at, expires_at, revoked_at }) => ({
        id,
        label,
        scopes,
        created_at,
        expires_at,
        revoked_at,
      }));
  });
  app.post("/api/w/:wid/tools-tokens", (r) => {
    const { userId, workspaceId } = workspace(r, store, true),
      b = body(r),
      token = randomBytes(32).toString("base64url");
    if (
      !b.label ||
      !Array.isArray(b.scopes) ||
      b.scopes.some((s: string) => !["read", "process", "export"].includes(s))
    )
      fail("invalid_scope", "选择 read/process/export 的有限能力");
    const d = {
      id: sha256(token),
      user_id: userId,
      workspace_id: workspaceId,
      label: String(b.label).slice(0, 100),
      scopes: b.scopes,
      kind: "mcp",
      created_at: now(),
      expires_at: new Date(Date.now() + 90 * 86400000).toISOString(),
    };
    store.put("device", d, userId, workspaceId);
    return { ...d, token };
  });
  app.delete("/api/w/:wid/tools-tokens/:id", (r) => {
    const { userId, workspaceId } = workspace(r, store, true),
      d = store.get("device", (r.params as any).id);
    if (
      !d ||
      d.user_id !== userId ||
      d.workspace_id !== workspaceId ||
      d.kind !== "mcp"
    )
      fail("not_found", "令牌不存在", 404);
    d.revoked_at = now();
    store.put("device", d, userId, workspaceId);
    return { ok: true };
  });
  app.post("/mcp", async (r, reply) => {
    const token = String(r.headers.authorization ?? "").replace(/^Bearer /, "");
    const d = resolveToken(store, token);
    if (
      !d ||
      d.kind !== "mcp" ||
      !store.get("membership", `${d.workspace_id}:${d.user_id}`)
    )
      return reply
        .code(401)
        .send({ error: { code: "unauthorized", message: "MCP 令牌无效" } });
    const b = body(r);
    const respond = (result: any) => ({ jsonrpc: "2.0", id: b.id, result });
    if (b.method === "initialize")
      return respond({
        protocolVersion: "2025-03-26",
        serverInfo: { name: "星笺", version: "1.0.0" },
        capabilities: { tools: {} },
      });
    if (b.method === "notifications/initialized") return reply.code(202).send();
    const definitions = [
      {
        name: "list_materials",
        scope: "read",
        description: "List materials in the pinned workspace",
        inputSchema: {
          type: "object",
          properties: { q: { type: "string" } },
          additionalProperties: false,
        },
      },
      {
        name: "get_material",
        scope: "read",
        description: "Read one material and fixed source versions",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          additionalProperties: false,
        },
      },
      {
        name: "job_status",
        scope: "read",
        description: "Read process status",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          additionalProperties: false,
        },
      },
      {
        name: "create_process_job",
        scope: "process",
        description:
          "Create a bounded job with a user-owned recipe; manual approval stays required",
        inputSchema: {
          type: "object",
          properties: {
            recipe_id: { type: "string" },
            material_ids: { type: "array", items: { type: "string" } },
          },
          required: ["recipe_id"],
          additionalProperties: false,
        },
      },
      {
        name: "export_bundle",
        scope: "export",
        description: "Export explicitly selected workspace records",
        inputSchema: {
          type: "object",
          properties: {
            material_ids: { type: "array", items: { type: "string" } },
          },
          required: ["material_ids"],
          additionalProperties: false,
        },
      },
    ];
    if (b.method === "tools/list")
      return respond({
        tools: definitions
          .filter((t) => d.scopes.includes(t.scope))
          .map(({ scope, ...t }) => t),
      });
    if (b.method !== "tools/call")
      return {
        jsonrpc: "2.0",
        id: b.id,
        error: { code: -32601, message: "Method not found" },
      };
    const name = b.params?.name,
      args = b.params?.arguments ?? {},
      definition = definitions.find((t) => t.name === name);
    if (!definition || !d.scopes.includes(definition.scope))
      return respond({
        isError: true,
        content: [{ type: "text", text: "policy_denied" }],
      });
    const base = `/api/w/${d.workspace_id}`;
    let url = base,
      method: any = "GET",
      payload: any;
    if (name === "list_materials")
      url += `/materials?q=${encodeURIComponent(String(args.q ?? ""))}`;
    if (name === "get_material")
      url += `/materials/${encodeURIComponent(String(args.id))}`;
    if (name === "job_status")
      url += `/jobs/${encodeURIComponent(String(args.id))}`;
    if (name === "export_bundle")
      url += `/export?material_ids=${encodeURIComponent((args.material_ids ?? []).join(","))}`;
    if (name === "create_process_job") {
      url += "/jobs";
      method = "POST";
      payload = {
        kind: "process",
        recipe_id: args.recipe_id,
        material_ids: args.material_ids,
      };
    }
    const res = await app.inject({
      url,
      method,
      payload,
      headers: { authorization: `Bearer ${token}` },
    });
    return respond({
      isError: res.statusCode >= 400,
      content: [{ type: "text", text: res.body }],
    });
  });
  return {
    sources,
    tick,
    status() {
      return {
        running_job_ids: [...running.keys()],
        closing: stopping,
        source_browser_open: sources.hasOpenBrowser?.() ?? false,
      };
    },
    async close() {
      stopping = true;
      clearInterval(timer);
      for (const c of running.values()) c.abort();
      try {
        await sources.close();
      } finally {
        while (ticking) await pause(25);
      }
    },
  };
}
