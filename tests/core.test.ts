import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { createStore, type Store } from "../server/store.js";
import {
  registerCore,
  ingestRecord,
  createRecoveryToken,
  resolveToken,
  resolveDataset,
  createArtifact,
  createProposal,
} from "../server/core.js";
import {
  createBundle,
  fragmentsFor,
  sha256,
  recordVersionHash,
  validateBundle,
  type SourceRecord,
} from "../shared/transfer.js";

type Session = { cookie: string; csrf: string; uid: string; wid: string };
type Fixture = {
  app: FastifyInstance;
  store: Store;
  dir: string;
  restart: () => Promise<void>;
  close: () => Promise<void>;
};
async function coreApp(store: Store) {
  const app = Fastify({ bodyLimit: 4 * 1024 * 1024 });
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  app.setErrorHandler((e: any, _req, reply) =>
    reply.code(e.statusCode ?? 500).send({
      error: {
        code: e.code ?? "INTERNAL",
        message: e.message,
        details: e.details,
      },
    }),
  );
  await registerCore(app, store);
  await app.ready();
  return app;
}
async function fixture(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "xingjian-core-test-"));
  let store = createStore(dir),
    app = await coreApp(store);
  const result: Fixture = {
    app,
    store,
    dir,
    restart: async () => {
      await app.close();
      store.close();
      store = createStore(dir);
      app = await coreApp(store);
      result.store = store;
      result.app = app;
    },
    close: async () => {
      await app.close();
      store.close();
      const p = resolve(dir);
      assert.ok(
        p.startsWith(
          `${resolve(tmpdir())}${process.platform === "win32" ? "\\" : "/"}xingjian-core-test-`,
        ),
      );
      rmSync(p, { recursive: true, force: true });
    },
  };
  return result;
}
async function signup(f: Fixture, name = "Alice"): Promise<Session> {
  const res = await f.app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      email: `${name.toLowerCase()}@example.test`,
      name,
      password: "test-password-1234",
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json();
  const setCookie = res.headers["set-cookie"] as string;
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  return {
    cookie: setCookie.split(";")[0],
    csrf: body.csrf,
    uid: body.user.id,
    wid: body.workspaces[0].id,
  };
}
function headers(s: Session) {
  return { cookie: s.cookie, "x-csrf-token": s.csrf };
}
function route(s: Session, path: string) {
  return `/api/w/${s.wid}/${path}`;
}
async function request(
  f: Fixture,
  s: Session,
  method: any,
  path: string,
  payload?: any,
  extra: any = {},
) {
  return f.app.inject({
    method,
    url: path.startsWith("/api/") ? path : route(s, path),
    payload,
    headers: { ...headers(s), ...extra },
  });
}
function record(
  id = "topic-1",
  text = "第一段资料\n内容保持原始。\n\n第二段资料",
  overrides: Partial<SourceRecord> = {},
): SourceRecord {
  return {
    source_key: {
      platform: "zsxq",
      group_id: "group-1",
      entity_type: "topic",
      entity_id: id,
    },
    group_id: "group-1",
    author_id: "author-1",
    author_name: "测试作者",
    title: "隔离测试资料",
    text,
    created_at: "2026-10-03T00:00:00.000Z",
    source_url: "https://wx.zsxq.com/topic/test",
    captured_at: "2026-10-03T01:00:00.000Z",
    coverage: {
      body: "complete",
      comments: "partial",
      attachments: "inaccessible",
      reasons: ["测试数据不连接源站"],
    },
    fragments: fragmentsFor(text),
    hash: sha256(text),
    ...overrides,
  };
}
async function invite(
  f: Fixture,
  owner: Session,
  invited: Session,
  role = "editor",
) {
  const user = f.store.get("user", invited.uid);
  const inv = await request(f, owner, "POST", "invites", {
    email: user.email,
    role,
  });
  assert.equal(inv.statusCode, 200, inv.body);
  const accepted = await request(f, invited, "POST", "/api/invites/accept", {
    token: inv.json().token,
  });
  assert.equal(accepted.statusCode, 200, accepted.body);
  return { ...invited, wid: owner.wid };
}
async function teamSignup(f: Fixture, name = "Alice"): Promise<Session> {
  const session = await signup(f, name);
  const team = await request(f, session, "POST", "/api/workspaces", {
    name: `${name}测试团队`,
  });
  assert.equal(team.statusCode, 200, team.body);
  assert.equal(team.json().kind, "team");
  return { ...session, wid: team.json().id };
}

test("Store WAL, explicit scope, update preservation and nested transaction rollback survive reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "xingjian-core-test-"));
  let store = createStore(dir);
  try {
    assert.equal(
      store.db.prepare("PRAGMA journal_mode").get()!.journal_mode,
      "wal",
    );
    store.put(
      "example",
      { id: "one", workspace_id: "forged", n: 1 },
      "u1",
      "w1",
    );
    store.put("example", { id: "one", n: 2 });
    assert.equal(
      store.list("example", { userId: "u1", workspaceId: "w1" })[0].n,
      2,
    );
    assert.equal(store.list("example", { workspaceId: "forged" }).length, 0);
    assert.throws(() =>
      store.transaction(() => {
        store.put("example", { id: "two" });
        store.transaction(() => {
          store.put("example", { id: "three" });
        });
        throw new Error("abort");
      }),
    );
    assert.equal(store.get("example", "two"), undefined);
    assert.equal(store.get("example", "three"), undefined);
    assert.throws(
      () => store.transaction(() => Promise.resolve(true)),
      /synchronous/,
    );
    store.close();
    store = createStore(dir);
    assert.equal(store.get("example", "one").n, 2);
  } finally {
    store.close();
    assert.ok(resolve(dir).startsWith(resolve(tmpdir())));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("material identity lookup is workspace scoped and the query plan uses the unique source index", async () => {
  const f = await fixture();
  try {
    const a = await signup(f),
      b = await signup(f, "Bob"),
      list = f.store.list.bind(f.store);
    // A regression to scanning all historical material JSON would fail immediately.
    f.store.list = ((kind: string, scope: any = {}) => {
      assert.notEqual(
        kind,
        "material",
        "ingest identity lookup must not scan full material history",
      );
      return list(kind, scope);
    }) as Store["list"];
    const first = ingestRecord(f.store, a.wid, a.uid, record()),
      foreign = ingestRecord(f.store, b.wid, b.uid, record());
    const identity = f.store.get("material", first.id).source_identity;
    assert.equal(f.store.findMaterialBySource(a.wid, identity).id, first.id);
    assert.equal(f.store.findMaterialBySource(b.wid, identity).id, foreign.id);
    assert.equal(
      f.store.findMaterialBySource("missing-workspace", identity),
      undefined,
    );
    assert.equal(
      ingestRecord(f.store, a.wid, a.uid, record()).status,
      "unchanged",
    );
    const plan = f.store.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT json FROM records WHERE kind='material' AND workspace_id=? AND json_extract(json,'$.source_identity')=?",
      )
      .all(a.wid, identity);
    assert.ok(
      plan.some((row) =>
        String(row.detail).includes("USING INDEX materials_source"),
      ),
      JSON.stringify(plan),
    );
    assert.ok(!plan.some((row) => /^SCAN records/.test(String(row.detail))));
  } finally {
    await f.close();
  }
});

test("registration/login use hashed password+session, enforce CSRF and never return credential fields", async () => {
  const f = await fixture();
  try {
    const a = await signup(f);
    const stored = f.store.get("user", a.uid);
    assert.equal(stored.password.algorithm, "scrypt-N32768-r8-p1");
    assert.notEqual(stored.password.hash, "test-password-1234");
    assert.equal(f.store.get("session", a.cookie.split("=")[1]), undefined);
    const me = await request(f, a, "GET", "/api/me");
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().user.password, undefined);
    const bad = await f.app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: { cookie: a.cookie },
      payload: { name: "拒绝 CSRF" },
    });
    assert.equal(bad.statusCode, 403);
    const wrongOrigin = await request(
      f,
      a,
      "POST",
      "/api/workspaces",
      { name: "禁止跨源" },
      { origin: "https://foreign.example" },
    );
    assert.equal(wrongOrigin.statusCode, 403);
    const duplicate = await f.app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: "ALICE@example.test",
        name: "Duplicate",
        password: "test-password-1234",
      },
    });
    assert.equal(duplicate.statusCode, 409);
    const wrong = await f.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "alice@example.test", password: "wrong-password-123" },
    });
    assert.equal(wrong.statusCode, 401);
    const logged = await f.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "alice@example.test", password: "test-password-1234" },
    });
    assert.equal(logged.statusCode, 200);
    assert.equal(
      (await request(f, a, "POST", "/api/auth/logout")).statusCode,
      200,
    );
    assert.equal((await request(f, a, "GET", "/api/me")).statusCode, 401);
    assert.ok(!JSON.stringify(f.store.list("audit")).includes("test-password"));
  } finally {
    await f.close();
  }
});

test("out-of-band recovery token is single use and revokes all account sessions", async () => {
  const f = await fixture();
  try {
    const a = await signup(f);
    const req = await f.app.inject({
      method: "POST",
      url: "/api/auth/recovery/request",
      payload: { email: "alice@example.test" },
    });
    assert.equal(req.statusCode, 200);
    assert.equal(req.json().token, undefined);
    assert.equal(f.store.list("recovery").length, 0);
    const recovery = createRecoveryToken(f.store, a.uid);
    const complete = await f.app.inject({
      method: "POST",
      url: "/api/auth/recovery/complete",
      payload: { token: recovery, password: "new-password-5678" },
    });
    assert.equal(complete.statusCode, 200);
    assert.equal((await request(f, a, "GET", "/api/me")).statusCode, 401);
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/auth/recovery/complete",
          payload: { token: recovery, password: "another-password-5678" },
        })
      ).statusCode,
      400,
    );
  } finally {
    await f.close();
  }
});

test("credential rotation while scrypt is pending cannot recreate an old-password session", async () => {
  const f = await fixture();
  try {
    const a = await signup(f),
      originalList = f.store.list.bind(f.store),
      sessionsBefore = f.store.list("session").length;
    let sawSnapshot!: () => void;
    const snapshotRead = new Promise<void>((r) => {
      sawSnapshot = r;
    });
    // A fixture-only observation hook makes the await boundary deterministic without delaying production scrypt.
    f.store.list = ((kind: string, scope: any = {}) => {
      const rows = originalList(kind, scope);
      if (kind === "user") sawSnapshot();
      return rows;
    }) as Store["list"];
    const pending = f.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "alice@example.test", password: "test-password-1234" },
    });
    await snapshotRead;
    const user = f.store.get("user", a.uid);
    f.store.put("user", {
      ...user,
      password: { ...user.password, hash: "0".repeat(128) },
    });
    const result = await pending;
    assert.equal(result.statusCode, 401, result.body);
    assert.equal(result.json().error.code, "LOGIN_INVALID");
    assert.equal(f.store.list("session").length, sessionsBefore);
  } finally {
    await f.close();
  }
});

test("workspace IDOR and invitation email binding, viewer limits and last owner protection", async () => {
  const f = await fixture();
  try {
    const a = await teamSignup(f);
    const b = await signup(f, "Bob");
    const e = await signup(f, "Eve");
    assert.equal(
      (await request(f, b, "GET", route(a, "materials"))).statusCode,
      404,
    );
    const inv = await request(f, a, "POST", "invites", {
      email: "bob@example.test",
      role: "viewer",
    });
    assert.equal(
      (
        await request(f, e, "POST", "/api/invites/accept", {
          token: inv.json().token,
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await request(f, b, "POST", "/api/invites/accept", {
          token: inv.json().token,
        })
      ).statusCode,
      200,
    );
    const viewer = { ...b, wid: a.wid };
    assert.equal(
      (await request(f, viewer, "POST", "datasets", { name: "不允许" }))
        .statusCode,
      403,
    );
    assert.equal(
      (
        await request(f, viewer, "POST", "invites", {
          email: "eve@example.test",
          role: "owner",
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (await request(f, a, "PATCH", `team/${a.uid}`, { role: "viewer" }))
        .statusCode,
      409,
    );
    assert.equal(
      (await request(f, a, "DELETE", `team/${a.uid}`)).statusCode,
      409,
    );
    const team = (await request(f, a, "GET", "team")).json();
    assert.equal(team[0].user.password, undefined);
    assert.equal(team[0].name, "Alice");
  } finally {
    await f.close();
  }
});

test("personal spaces cannot expand membership or receive shares, and explicit teams receive selected snapshots only", async () => {
  const f = await fixture();
  try {
    const a = await signup(f),
      b = await signup(f, "Bob");
    assert.equal(f.store.get("workspace", a.wid).kind, "personal");
    const selected = ingestRecord(f.store, a.wid, a.uid, record()),
      excluded = ingestRecord(f.store, a.wid, a.uid, record("excluded"));
    const deniedInvite = await request(f, a, "POST", "invites", {
      email: "bob@example.test",
      role: "editor",
    });
    assert.equal(deniedInvite.statusCode, 403);
    assert.equal(deniedInvite.json().error.code, "TEAM_REQUIRED");
    const legacyInvite = "fixture-only-preexisting-private-invite";
    f.store.put(
      "invite",
      {
        id: sha256(legacyInvite),
        workspace_id: a.wid,
        email: "bob@example.test",
        role: "editor",
        created_by: a.uid,
        expires_at: new Date(Date.now() + 60000).toISOString(),
      },
      a.uid,
      a.wid,
    );
    assert.equal(
      (
        await request(f, b, "POST", "/api/invites/accept", {
          token: legacyInvite,
        })
      ).json().error.code,
      "TEAM_REQUIRED",
    );
    assert.equal(f.store.get("membership", `${a.wid}:${b.uid}`), undefined);
    const t = (
      await request(f, a, "POST", "/api/workspaces", {
        name: "看起来像个人资料库",
        kind: "personal",
      })
    ).json();
    assert.equal(t.kind, "team");
    assert.equal(f.store.materialSummaries(t.id).length, 0);
    const dest = { ...a, wid: t.id };
    const backToPrivate = await request(f, dest, "POST", "share", {
      target_workspace_id: a.wid,
    });
    assert.equal(backToPrivate.statusCode, 403);
    assert.equal(backToPrivate.json().error.code, "TEAM_REQUIRED");
    const shared = await request(f, a, "POST", "share", {
      target_workspace_id: t.id,
      material_ids: [selected.id],
      include_raw: true,
    });
    assert.equal(shared.statusCode, 200, shared.body);
    assert.equal(f.store.materialSummaries(t.id).length, 1);
    assert.equal(
      f.store.materialSummaries(t.id)[0].source_key.entity_id,
      "topic-1",
    );
    assert.ok(f.store.get("material", excluded.id));
    // Even an inconsistent persisted membership cannot convert a marked personal space into a shared one.
    f.store.put(
      "membership",
      {
        id: `${a.wid}:${b.uid}`,
        workspace_id: a.wid,
        user_id: b.uid,
        role: "editor",
      },
      b.uid,
      a.wid,
    );
    assert.equal(
      (await request(f, b, "GET", route(a, "materials"))).statusCode,
      404,
    );
    assert.ok(
      !(await request(f, b, "GET", "/api/workspaces"))
        .json()
        .some((w: any) => w.id === a.wid),
    );
    const privateDevice = "fixture-only-inconsistent-private-device";
    f.store.put(
      "device",
      {
        id: sha256(privateDevice),
        user_id: b.uid,
        workspace_id: a.wid,
        scopes: ["read"],
        expires_at: new Date(Date.now() + 60000).toISOString(),
      },
      b.uid,
      a.wid,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "GET",
          url: route(a, "materials"),
          headers: { authorization: `Bearer ${privateDevice}` },
        })
      ).statusCode,
      404,
    );
    assert.deepEqual(
      (await request(f, a, "GET", "team")).json().map((m: any) => m.user_id),
      [a.uid],
    );
  } finally {
    await f.close();
  }
});

test("legacy workspace kind migration is evidence based, privacy first and persistent across restarts", async () => {
  const f = await fixture();
  try {
    const a = await signup(f),
      b = await signup(f, "Bob"),
      legacy = f.store.get("workspace", a.wid);
    const { kind: _privateKind, ...withoutKind } = legacy;
    f.store.put("workspace", { ...withoutKind, name: "公开多人团队" });
    const team = (
        await request(f, a, "POST", "/api/workspaces", { name: "私人资料库" })
      ).json(),
      owner = { ...a, wid: team.id };
    await invite(f, owner, b);
    const {
      kind: _teamKind,
      role: _role,
      ...teamWithoutKind
    } = f.store.get("workspace", team.id);
    f.store.put("workspace", teamWithoutKind);
    const orphan = { id: "orphan-legacy", name: "Team", created_by: b.uid };
    f.store.put("workspace", orphan, undefined, orphan.id);
    f.store.put(
      "membership",
      {
        id: `${orphan.id}:${a.uid}`,
        workspace_id: orphan.id,
        user_id: a.uid,
        role: "owner",
      },
      a.uid,
      orphan.id,
    );
    f.store.put(
      "membership",
      {
        id: `${orphan.id}:${b.uid}`,
        workspace_id: orphan.id,
        user_id: b.uid,
        role: "editor",
      },
      b.uid,
      orphan.id,
    );
    await f.restart();
    assert.equal(f.store.get("workspace", a.wid).kind, "legacy_private");
    assert.equal(f.store.get("workspace", team.id).kind, "team");
    assert.equal(f.store.get("workspace", orphan.id).kind, "legacy_private");
    assert.equal(
      (
        await request(f, a, "POST", "invites", { email: "bob@example.test" })
      ).json().error.code,
      "TEAM_REQUIRED",
    );
    assert.equal(
      (await request(f, a, "GET", `/api/w/${orphan.id}/materials`)).statusCode,
      404,
    );
    assert.equal(
      (await request(f, b, "GET", `/api/w/${team.id}/materials`)).statusCode,
      200,
    );
    const migratedAt = f.store.get("workspace", a.wid).kind_migrated_at;
    const migrations = f.store
      .list("audit")
      .filter((e) => e.action === "workspace.kind_migrate").length;
    await f.restart();
    assert.equal(f.store.get("workspace", a.wid).kind_migrated_at, migratedAt);
    assert.equal(
      f.store.list("audit").filter((e) => e.action === "workspace.kind_migrate")
        .length,
      migrations,
    );
  } finally {
    await f.close();
  }
});

test("materials source versions remain immutable, reading and annotations remain personal", async () => {
  const f = await fixture();
  try {
    const a = await teamSignup(f);
    const b = await signup(f, "Bob");
    const teammate = await invite(f, a, b);
    const first = ingestRecord(f.store, a.wid, a.uid, record());
    const secondText = "更新后的原文";
    const annotation = await request(f, a, "POST", "annotations", {
      material_id: first.id,
      revision_id: first.revision_id,
      start: 0,
      end: 3,
      quote: "第一段",
      note: "个人批注",
    });
    assert.equal(annotation.statusCode, 200, annotation.body);
    assert.equal(
      (
        await request(f, a, "POST", "annotations", {
          material_id: first.id,
          revision_id: first.revision_id,
          start: 0,
          end: 3,
          quote: "不匹配",
          note: "错误",
        })
      ).statusCode,
      400,
    );
    const second = ingestRecord(
      f.store,
      a.wid,
      a.uid,
      record("topic-1", secondText, {
        captured_at: "2026-10-03T02:00:00.000Z",
      }),
    );
    assert.equal(first.id, second.id);
    assert.notEqual(first.revision_id, second.revision_id);
    assert.equal(
      f.store.get("material", first.id).revisions[0].text,
      record().text,
    );
    assert.equal(
      ingestRecord(
        f.store,
        a.wid,
        a.uid,
        record("topic-1", secondText, {
          captured_at: "2026-10-03T03:00:00.000Z",
        }),
      ).status,
      "unchanged",
    );
    assert.equal(
      (await request(f, a, "PATCH", `materials/${first.id}`, { text: "覆盖" }))
        .statusCode,
      400,
    );
    assert.equal(
      (
        await request(f, a, "PATCH", `materials/${first.id}`, {
          status: "read",
          tags: ["研究"],
          starred: true,
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (await request(f, teammate, "GET", `materials/${first.id}`)).json()
        .status,
      "unread",
    );
    assert.equal(
      (await request(f, teammate, "GET", "annotations")).json().length,
      0,
    );
    assert.equal(
      (
        await request(
          f,
          teammate,
          "PATCH",
          `annotations/${annotation.json().id}`,
          { note: "越权修改" },
        )
      ).statusCode,
      404,
    );
  } finally {
    await f.close();
  }
});

test("material list uses SQL summaries, searches beyond 600 characters and preserves private reading overlays", async () => {
  const f = await fixture();
  try {
    const a = await teamSignup(f),
      b = await signup(f, "Bob"),
      text = "A".repeat(650) + "末尾检索命中🚀 literal%_";
    const first = ingestRecord(
      f.store,
      a.wid,
      a.uid,
      record("summary", text, { author_name: "Δοκιμή作者" }),
    );
    const latest = ingestRecord(
      f.store,
      a.wid,
      a.uid,
      record("summary", text, {
        title: "摘要精确标题",
        author_name: "Δοκιμή作者",
        captured_at: "2026-10-03T02:00:00.000Z",
      }),
    );
    ingestRecord(
      f.store,
      a.wid,
      a.uid,
      record("different", "其他资料完全没有关键词"),
    );
    ingestRecord(f.store, b.wid, b.uid, record("foreign", text));
    await request(f, a, "PATCH", `materials/${first.id}`, {
      status: "read",
      tags: ["private-tag"],
      starred: true,
      reading_position: 650,
    });
    const list = f.store.list.bind(f.store);
    f.store.list = ((kind: string, scope: any = {}) => {
      assert.notEqual(
        kind,
        "material",
        "listing must use the SQL projection rather than reading all historical bodies",
      );
      return list(kind, scope);
    }) as Store["list"];
    const r = await request(
      f,
      a,
      "GET",
      "materials?q=" + encodeURIComponent("末尾检索命中"),
    );
    assert.equal(r.statusCode, 200, r.body);
    const rows = r.json();
    assert.equal(rows.length, 1);
    const summary = rows[0];
    assert.equal(summary.text, "A".repeat(600));
    assert.equal(summary.snippet, summary.text);
    assert.equal(summary.full_text_length, Array.from(text).length);
    assert.equal(summary.revision_count, 2);
    assert.equal(summary.revisions, undefined);
    assert.equal(summary.projection, "summary");
    assert.equal(summary.id, first.id);
    assert.equal(summary.revision_id, latest.revision_id);
    assert.equal(summary.title, "摘要精确标题");
    assert.equal(summary.author_name, "Δοκιμή作者");
    assert.equal(summary.status, "read");
    assert.deepEqual(summary.tags, ["private-tag"]);
    assert.equal(summary.starred, true);
    assert.equal(summary.reading_position, 650);
    assert.equal(summary.coverage.body, "complete");
    assert.equal(
      (
        await request(f, a, "GET", "materials?q=" + encodeURIComponent("%_"))
      ).json().length,
      1,
    );
    assert.equal(
      (
        await request(
          f,
          a,
          "GET",
          "materials?q=" + encodeURIComponent("ΔΟΚΙΜΉ作者"),
        )
      ).json().length,
      1,
    );
    assert.equal(
      (await request(f, a, "GET", "materials?group_id=not-group")).json()
        .length,
      0,
    );
    assert.equal(
      (await request(f, a, "GET", "materials?author_id=not-author")).json()
        .length,
      0,
    );
    // The complete source remains available only at the explicit single-material route.
    f.store.list = list;
    const detail = (await request(f, a, "GET", `materials/${first.id}`)).json();
    assert.equal(detail.text, text);
    assert.equal(detail.revisions.length, 2);
    assert.equal(detail.revisions[0].text, text);
    const viewer = await invite(f, a, b, "viewer");
    const otherView = (
      await request(
        f,
        viewer,
        "GET",
        "materials?q=" + encodeURIComponent("末尾检索命中"),
      )
    ).json()[0];
    assert.equal(otherView.status, "unread");
    assert.deepEqual(otherView.tags, []);
    assert.equal(otherView.revisions, undefined);
  } finally {
    await f.close();
  }
});

test("dynamic datasets resolve rules while frozen snapshots pin revision IDs", async () => {
  const f = await fixture();
  try {
    const a = await teamSignup(f),
      b = await signup(f, "Bob"),
      teammate = await invite(f, a, b);
    const first = ingestRecord(
      f.store,
      a.wid,
      a.uid,
      record("topic-1", "A".repeat(650) + "超出摘要的检索词"),
    );
    await request(f, a, "PATCH", `materials/${first.id}`, { tags: ["研究"] });
    const list = f.store.list.bind(f.store);
    f.store.list = ((kind: string, scope: any = {}) => {
      assert.notEqual(
        kind,
        "material",
        "dynamic evaluation must not parse full material histories",
      );
      return list(kind, scope);
    }) as Store["list"];
    const created = await request(f, a, "POST", "datasets", {
      name: "动态研究",
      mode: "dynamic",
      rule: {
        q: "超出摘要的检索词",
        group_id: "group-1",
        author_id: "author-1",
        tags: ["研究"],
      },
    });
    assert.equal(created.statusCode, 200, created.body);
    const d = created.json();
    assert.deepEqual(resolveDataset(f.store, d), [first.id]);
    await request(f, teammate, "PATCH", `materials/${first.id}`, { tags: [] });
    assert.deepEqual(
      resolveDataset(f.store, d),
      [first.id],
      "another member's tags must not change the creator's dynamic rule",
    );
    const frozen = (
      await request(f, a, "POST", `datasets/${d.id}/freeze`)
    ).json();
    assert.equal(frozen.items[0].revision_id, first.revision_id);
    ingestRecord(
      f.store,
      a.wid,
      a.uid,
      record("topic-1", "新版本超出摘要的检索词", {
        captured_at: "2026-10-03T02:00:00.000Z",
      }),
    );
    await request(f, a, "PATCH", `materials/${first.id}`, { tags: [] });
    const view = (await request(f, a, "GET", `datasets/${d.id}`)).json();
    assert.equal(view.material_ids.length, 0);
    assert.equal(view.snapshots[0].items[0].revision_id, first.revision_id);
  } finally {
    await f.close();
  }
});

test("artifact version conflicts never overwrite, citations authorize source and updates mark stale", async () => {
  const f = await fixture();
  try {
    const a = await signup(f);
    const b = await signup(f, "Bob");
    const m = ingestRecord(f.store, a.wid, a.uid, record());
    const artifact = createArtifact(f.store, a.wid, a.uid, {
      title: "成果",
      body: "初版",
      citations: [
        {
          material_id: m.id,
          revision_id: m.revision_id,
          quote: "第一段",
          label: "S1",
          citation_id: "citation-one",
        },
      ],
    });
    assert.equal(artifact.revision, 1);
    assert.equal(artifact.citations[0].label, "S1");
    assert.equal(artifact.citations[0].citation_id, "citation-one");
    const edit = await request(f, a, "PATCH", `artifacts/${artifact.id}`, {
      base_revision: 1,
      body: "人工第二版",
    });
    assert.equal(edit.statusCode, 200);
    const conflict = await request(f, a, "PATCH", `artifacts/${artifact.id}`, {
      base_revision: 1,
      body: "旧版本覆盖",
    });
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().error.details.revision, 2);
    assert.equal(f.store.get("artifact", artifact.id).body, "人工第二版");
    assert.equal(f.store.get("artifact", artifact.id).revisions.length, 2);
    assert.equal(
      (await request(f, b, "GET", `artifacts/${artifact.id}`)).statusCode,
      404,
    );
    assert.equal(
      (
        await request(f, b, "POST", "artifacts", {
          title: "越权引用",
          citations: [{ material_id: m.id, revision_id: m.revision_id }],
        })
      ).statusCode,
      404,
    );
    ingestRecord(
      f.store,
      a.wid,
      a.uid,
      record("topic-1", "不同原文", {
        captured_at: "2026-10-03T02:00:00.000Z",
      }),
    );
    assert.equal(
      (await request(f, a, "GET", `artifacts/${artifact.id}`)).json().stale,
      true,
    );
    assert.equal(
      (
        await request(f, a, "POST", `artifacts/${artifact.id}/adopt`, {
          base_revision: edit.json().revision_id,
        })
      ).statusCode,
      200,
    );
  } finally {
    await f.close();
  }
});

test("AI update proposals preserve frozen bases and require explicit nonconflicting adoption without automatic edits", async () => {
  const f = await fixture();
  try {
    const a = await signup(f),
      outsider = await signup(f, "Bob"),
      first = ingestRecord(f.store, a.wid, a.uid, record());
    const target = createArtifact(f.store, a.wid, a.uid, {
      title: "人工原稿",
      body: "原稿版本一",
      citations: [
        { material_id: first.id, revision_id: first.revision_id, label: "S1" },
      ],
    });
    const newer = ingestRecord(
      f.store,
      a.wid,
      a.uid,
      record("topic-1", "来源新正文", {
        captured_at: "2026-10-03T02:00:00.000Z",
      }),
    );
    f.store.put(
      "job",
      {
        id: "proposal-job",
        kind: "process",
        workspace_id: a.wid,
        user_id: a.uid,
        target_artifact_id: target.id,
      },
      a.uid,
      a.wid,
    );
    const citations = [
        { material_id: newer.id, revision_id: newer.revision_id, label: "S1" },
      ],
      draft = createArtifact(f.store, a.wid, a.uid, {
        title: "AI新稿",
        body: "待审核的改写 [S1]",
        citations,
        job_id: "proposal-job",
      });
    const proposal = createProposal(f.store, a.wid, a.uid, {
      artifact_id: target.id,
      base_revision: 1,
      title: draft.title,
      body: draft.body,
      citations,
      job_id: "proposal-job",
      draft_artifact_id: draft.id,
    });
    assert.equal(proposal.status, "pending");
    assert.equal(proposal.base_revision, target.revision_id);
    assert.equal(proposal.base_body, "原稿版本一");
    assert.equal(f.store.get("artifact", target.id).body, "原稿版本一");
    assert.equal(f.store.get("artifact", target.id).revision, 1);
    const list = await request(f, a, "GET", `artifacts/${target.id}/proposals`);
    assert.equal(list.statusCode, 200);
    assert.equal(list.json()[0].draft_artifact_id, draft.id);
    assert.equal(
      (
        await request(
          f,
          outsider,
          "GET",
          route(a, `artifacts/${target.id}/proposals`),
        )
      ).statusCode,
      404,
    );
    const adopted = await request(
      f,
      a,
      "POST",
      `artifacts/${target.id}/adopt`,
      { base_revision: target.revision_id, proposal_id: proposal.id },
    );
    assert.equal(adopted.statusCode, 200, adopted.body);
    assert.equal(adopted.json().body, draft.body);
    assert.equal(adopted.json().title, draft.title);
    assert.equal(adopted.json().revision, 2);
    assert.equal(adopted.json().stale, false);
    assert.equal(adopted.json().revisions[0].body, "原稿版本一");
    assert.equal(f.store.get("proposal", proposal.id).status, "adopted");
    assert.equal(
      (
        await request(f, a, "POST", `artifacts/${target.id}/adopt`, {
          base_revision: 2,
          proposal_id: proposal.id,
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (
        await request(
          f,
          a,
          "DELETE",
          `artifacts/${target.id}/proposals/${proposal.id}`,
        )
      ).statusCode,
      409,
    );
  } finally {
    await f.close();
  }
});

test("late AI proposals retain conflicts, rejected proposals stay auditable and cross-workspace references fail", async () => {
  const f = await fixture();
  try {
    const a = await teamSignup(f),
      other = await signup(f, "Bob"),
      m = ingestRecord(f.store, a.wid, a.uid, record()),
      foreign = ingestRecord(f.store, other.wid, other.uid, record());
    const target = createArtifact(f.store, a.wid, a.uid, {
        title: "原稿",
        body: "固定基线",
        citations: [],
      }),
      base = target.revision_id;
    f.store.put(
      "job",
      {
        id: "late-job",
        kind: "process",
        workspace_id: a.wid,
        user_id: a.uid,
        target_artifact_id: target.id,
      },
      a.uid,
      a.wid,
    );
    await request(f, a, "PATCH", `artifacts/${target.id}`, {
      base_revision: 1,
      body: "生成期间人工改为第二版",
    });
    const input = {
      artifact_id: target.id,
      base_revision: base,
      title: "迟到AI提案",
      body: "AI 不覆盖人工稿",
      citations: [{ material_id: m.id, revision_id: m.revision_id }],
      job_id: "late-job",
    };
    const late = createProposal(f.store, a.wid, a.uid, input);
    assert.equal(late.status, "conflict");
    assert.equal(late.base_body, "固定基线");
    const rejectedAdopt = await request(
      f,
      a,
      "POST",
      `artifacts/${target.id}/adopt`,
      { base_revision: 2, proposal_id: late.id },
    );
    assert.equal(rejectedAdopt.statusCode, 409);
    assert.equal(rejectedAdopt.json().error.code, "REVISION_CONFLICT");
    assert.equal(
      f.store.get("artifact", target.id).body,
      "生成期间人工改为第二版",
    );
    const fresh = createProposal(f.store, a.wid, a.uid, {
      ...input,
      base_revision: 2,
    });
    assert.equal(fresh.status, "pending");
    await request(f, a, "PATCH", `artifacts/${target.id}`, {
      base_revision: 2,
      body: "第三版人工稿",
    });
    const listed = (
      await request(f, a, "GET", `artifacts/${target.id}/proposals`)
    ).json();
    assert.equal(listed.find((p: any) => p.id === fresh.id).status, "conflict");
    const rejected = await request(
      f,
      a,
      "DELETE",
      `artifacts/${target.id}/proposals/${fresh.id}`,
    );
    assert.equal(rejected.statusCode, 200);
    assert.equal(rejected.json().status, "rejected");
    assert.equal(
      (
        await request(
          f,
          a,
          "DELETE",
          `artifacts/${target.id}/proposals/${fresh.id}`,
        )
      ).json().replayed,
      true,
    );
    assert.equal(
      (
        await request(f, a, "POST", `artifacts/${target.id}/adopt`, {
          base_revision: 3,
          proposal_id: fresh.id,
        })
      ).json().error.code,
      "PROPOSAL_INVALID",
    );
    assert.equal(f.store.get("artifact", target.id).revision, 3);
    assert.equal(f.store.get("proposal", fresh.id).body, "AI 不覆盖人工稿");
    assert.throws(
      () =>
        createProposal(f.store, a.wid, a.uid, {
          ...input,
          citations: [
            { material_id: foreign.id, revision_id: foreign.revision_id },
          ],
        }),
      /无权访问/,
    );
    assert.equal(f.store.list("proposal", { workspaceId: a.wid }).length, 2);
    const viewer = await invite(f, a, other, "viewer");
    assert.equal(
      (await request(f, viewer, "GET", `artifacts/${target.id}/proposals`))
        .statusCode,
      200,
    );
    assert.equal(
      (
        await request(
          f,
          viewer,
          "DELETE",
          `artifacts/${target.id}/proposals/${late.id}`,
        )
      ).statusCode,
      403,
    );
  } finally {
    await f.close();
  }
});

test("TransferBundle import validates digest/hash/ranges and is atomic and idempotent", async () => {
  const f = await fixture();
  try {
    const a = await signup(f);
    const bundle = createBundle({ records: [record()] });
    const imported = await request(
      f,
      a,
      "POST",
      "import",
      { bundle },
      { "x-idempotency-key": "receipt-one" },
    );
    assert.equal(imported.statusCode, 200, imported.body);
    const replay = await request(
      f,
      a,
      "POST",
      "import",
      { bundle },
      { "x-idempotency-key": "receipt-one" },
    );
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.json().replayed, true);
    assert.equal(f.store.list("material", { workspaceId: a.wid }).length, 1);
    const secondKey = await request(
      f,
      a,
      "POST",
      "import",
      { bundle },
      { "x-idempotency-key": "receipt-two" },
    );
    assert.equal(secondKey.json().replayed, true);
    const other = createBundle({ records: [record("topic-2")] });
    assert.equal(
      (
        await request(
          f,
          a,
          "POST",
          "import",
          { bundle: other },
          { "x-idempotency-key": "receipt-one" },
        )
      ).statusCode,
      409,
    );
    const changed = structuredClone(bundle);
    changed.records[0].text = "篡改";
    assert.equal(
      (
        await request(
          f,
          a,
          "POST",
          "import",
          { bundle: changed },
          { "x-idempotency-key": "tampered" },
        )
      ).statusCode,
      400,
    );
    const badHash = createBundle({
      records: [record("bad", "真实文本", { hash: "f".repeat(64) })],
    });
    assert.equal(
      (
        await request(
          f,
          a,
          "POST",
          "import",
          { bundle: badHash },
          { "x-idempotency-key": "bad-hash" },
        )
      ).statusCode,
      400,
    );
    const atomic = createBundle({
      records: [record("topic-atomic")],
      annotations: [
        {
          id: "bad-annotation",
          source_key: record("topic-atomic").source_key,
          material_id: "foreign",
          revision_id: sha256(record().text),
          start: 0,
          end: 1,
          quote: "错",
          note: "",
        },
      ],
    });
    assert.equal(
      (
        await request(
          f,
          a,
          "POST",
          "import",
          { bundle: atomic },
          { "x-idempotency-key": "atomic" },
        )
      ).statusCode,
      400,
    );
    assert.equal(f.store.list("material", { workspaceId: a.wid }).length, 1);
    assert.equal(
      (await request(f, a, "POST", "import", { bundle })).statusCode,
      400,
    );
    assert.equal(
      f.store.get("material", imported.json().records[0].id).revisions[0]
        .source_truth,
      "client_reported",
    );
  } finally {
    await f.close();
  }
});

test("export/import preserve referenced older revisions, annotation anchors and citations across workspaces", async () => {
  const f = await fixture();
  try {
    const a = await signup(f);
    const b = await signup(f, "Bob");
    const m = ingestRecord(f.store, a.wid, a.uid, record());
    await request(f, a, "POST", "annotations", {
      material_id: m.id,
      revision_id: m.revision_id,
      start: 0,
      end: 3,
      quote: "第一段",
      note: "旧版批注",
    });
    const a1 = createArtifact(f.store, a.wid, a.uid, {
      title: "旧版引用",
      body: "可溯源",
      citations: [
        {
          material_id: m.id,
          revision_id: m.revision_id,
          quote: "第一段",
          label: "S1",
        },
      ],
    });
    ingestRecord(
      f.store,
      a.wid,
      a.uid,
      record("topic-1", "新版资料", {
        captured_at: "2026-10-03T02:00:00.000Z",
      }),
    );
    const exported = await request(
      f,
      a,
      "GET",
      `export?material_ids=${m.id}&artifact_ids=${a1.id}&annotations=true`,
    );
    assert.equal(exported.statusCode, 200, exported.body);
    const bundle = exported.json();
    assert.equal(validateBundle(bundle).records.length, 2);
    assert.equal(bundle.annotations[0].revision_id, sha256(record().text));
    const imported = await request(
      f,
      b,
      "POST",
      "import",
      { bundle },
      { "x-idempotency-key": "restore-old" },
    );
    assert.equal(imported.statusCode, 200, imported.body);
    const note = f.store.get("annotation", imported.json().annotations[0].id);
    const material = f.store.get("material", note.material_id);
    assert.equal(
      material.revisions
        .find((r: any) => r.id === note.revision_id)
        .text.slice(note.start, note.end),
      note.quote,
    );
    assert.equal(material.text, "新版资料");
    assert.notEqual(note.material_id, m.id);
    const artifact = f.store.get("artifact", imported.json().artifacts[0].id);
    assert.equal(artifact.citations[0].revision_id, note.revision_id);
    assert.equal(artifact.citations[0].label, "S1");
    assert.equal(artifact.stale, true);
  } finally {
    await f.close();
  }
});

test("explicit sharing skips raw by default and revocation retains independently edited derivatives", async () => {
  const f = await fixture();
  try {
    const a = await signup(f);
    const m = ingestRecord(f.store, a.wid, a.uid, record());
    const artifact = createArtifact(f.store, a.wid, a.uid, {
      title: "可分享成果",
      body: "分享版本",
      citations: [{ material_id: m.id, revision_id: m.revision_id }],
    });
    const target = (
      await request(f, a, "POST", "/api/workspaces", { name: "团队工作区" })
    ).json();
    const dest = { ...a, wid: target.id };
    const list = f.store.list.bind(f.store);
    f.store.list = ((kind: string, scope: any = {}) => {
      assert.notEqual(
        kind,
        "material",
        "share identity checks must not load unrelated material histories",
      );
      return list(kind, scope);
    }) as Store["list"];
    const noRaw = await request(f, a, "POST", "share", {
      target_workspace_id: target.id,
      material_ids: [m.id],
      artifact_ids: [artifact.id],
    });
    assert.equal(noRaw.statusCode, 200, noRaw.body);
    assert.deepEqual(noRaw.json().skipped_material_ids, [m.id]);
    assert.equal(f.store.materialSummaries(target.id).length, 0);
    const copyId = noRaw.json().artifacts[0].id;
    const copy = f.store.get("artifact", copyId);
    assert.equal(copy.citations.length, 0);
    assert.equal(copy.reference_metadata.length, 1);
    await request(f, dest, "PATCH", `artifacts/${copyId}`, {
      base_revision: 1,
      body: "团队人工修改",
    });
    const revoked = await request(
      f,
      a,
      "DELETE",
      `shares/${noRaw.json().share_id}`,
    );
    assert.equal(revoked.statusCode, 200);
    assert.ok(revoked.json().retained.includes(copyId));
    assert.equal(
      (await request(f, dest, "GET", `artifacts/${copyId}`)).json().body,
      "团队人工修改",
    );
    f.store.put(
      "attachment",
      {
        id: "share-attachment",
        workspace_id: a.wid,
        hash: sha256("fixture-only-not-downloaded"),
        size: 27,
        name: "missing.bin",
        mime: "application/octet-stream",
        status: "missing",
        record_source_key: record().source_key,
      },
      a.uid,
      a.wid,
    );
    const raw = await request(f, a, "POST", "share", {
      target_workspace_id: target.id,
      material_ids: [m.id],
      artifact_ids: [artifact.id],
      include_raw: true,
      include_attachments: true,
    });
    assert.equal(raw.statusCode, 200, raw.body);
    const mid = raw.json().records[0].id;
    assert.equal(
      (await request(f, dest, "GET", `materials/${mid}`)).statusCode,
      200,
    );
    const r = await request(f, a, "DELETE", `shares/${raw.json().share_id}`);
    assert.ok(r.json().archived.includes(mid));
    assert.equal(
      (await request(f, dest, "GET", `materials/${mid}`)).statusCode,
      404,
    );
    assert.equal((await request(f, a, "GET", "shares")).json().length, 2);
  } finally {
    await f.close();
  }
});

test("attachment chunk replay, hash validation, safe filenames and authorized binary download", async () => {
  const f = await fixture();
  try {
    const a = await signup(f);
    const b = await signup(f, "Bob");
    const bytes = Buffer.from("附件测试 bytes");
    const unsafe = await request(f, a, "POST", "uploads", {
      name: "../../outside.txt",
      hash: sha256(bytes),
      size: bytes.length,
      mime: "text/plain",
    });
    assert.equal(unsafe.statusCode, 400);
    const up = await request(f, a, "POST", "uploads", {
      name: "测试资料.txt",
      hash: sha256(bytes),
      size: bytes.length,
      mime: "text/plain",
      record_source_key: record().source_key,
    });
    assert.equal(up.statusCode, 200);
    const id = up.json().id;
    assert.equal(
      (await request(f, a, "POST", `uploads/${id}/complete`, {})).statusCode,
      409,
    );
    const part = { offset: 0, data_base64: bytes.toString("base64") };
    assert.equal(
      (await request(f, a, "PUT", `uploads/${id}/chunks`, part)).statusCode,
      200,
    );
    assert.equal(
      (await request(f, a, "PUT", `uploads/${id}/chunks`, part)).json()
        .replayed,
      true,
    );
    assert.equal(
      (
        await request(f, a, "PUT", `uploads/${id}/chunks`, {
          offset: 0,
          data_base64: Buffer.alloc(bytes.length, 65).toString("base64"),
        })
      ).statusCode,
      409,
    );
    const completed = await request(f, a, "POST", `uploads/${id}/complete`, {});
    assert.equal(completed.statusCode, 200, completed.body);
    const attachment = completed.json();
    assert.equal(
      (await request(f, a, "POST", `uploads/${id}/complete`, {})).json().id,
      attachment.id,
    );
    const download = await request(f, a, "GET", `attachments/${attachment.id}`);
    assert.equal(download.statusCode, 200);
    assert.deepEqual(download.rawPayload, bytes);
    assert.equal(download.headers["x-content-type-options"], "nosniff");
    assert.equal(
      (await request(f, b, "GET", route(a, `attachments/${attachment.id}`)))
        .statusCode,
      404,
    );
    assert.equal(
      (await request(f, b, "GET", `attachments/${attachment.id}`)).statusCode,
      404,
    );
    const bad = (
      await request(f, a, "POST", "uploads", {
        name: "bad.bin",
        hash: "a".repeat(64),
        size: 3,
        mime: "application/octet-stream",
      })
    ).json();
    await request(f, a, "PUT", `uploads/${bad.id}/chunks`, {
      offset: 0,
      data_base64: Buffer.from("abc").toString("base64"),
    });
    assert.equal(
      (await request(f, a, "POST", `uploads/${bad.id}/complete`, {}))
        .statusCode,
      422,
    );
    assert.equal(existsSync(join(f.store.blobDir, "a".repeat(64))), false);
    assert.equal(f.store.list("attachment").length, 1);
  } finally {
    await f.close();
  }
});

test("attachment package availability is not trusted without verified workspace upload", async () => {
  const f = await fixture();
  try {
    const a = await signup(f);
    const b = await signup(f, "Bob");
    const bytes = Buffer.from("workspace-owned");
    const u = (
      await request(f, a, "POST", "uploads", {
        name: "private.bin",
        hash: sha256(bytes),
        size: bytes.length,
        mime: "application/octet-stream",
      })
    ).json();
    await request(f, a, "PUT", `uploads/${u.id}/chunks`, {
      offset: 0,
      data_base64: bytes.toString("base64"),
    });
    await request(f, a, "POST", `uploads/${u.id}/complete`, {});
    const bundle = createBundle({
      attachments: [
        {
          id: "foreign",
          name: "private.bin",
          mime: "application/octet-stream",
          hash: sha256(bytes),
          size: bytes.length,
          status: "available",
          record_source_key: record().source_key,
        },
      ],
    });
    const imported = (
      await request(
        f,
        b,
        "POST",
        "import",
        { bundle },
        { "x-idempotency-key": "no-read-by-hash" },
      )
    ).json();
    assert.equal(imported.attachments[0].status, "missing");
    assert.equal(
      (await request(f, b, "GET", `attachments/${imported.attachments[0].id}`))
        .statusCode,
      404,
    );
  } finally {
    await f.close();
  }
});

test("cold restart recovers interrupted verification and rename-before-receipt attachment commits", async () => {
  const f = await fixture();
  try {
    const a = await signup(f),
      bytes = Buffer.from("cold-restart-upload-fixture"),
      hash = sha256(bytes),
      uploads: string[] = [];
    for (const name of ["before-hash.bin", "after-rename.bin"]) {
      const u = (
        await request(f, a, "POST", "uploads", {
          name,
          size: bytes.length,
          hash,
          mime: "application/octet-stream",
        })
      ).json();
      assert.equal(
        (
          await request(f, a, "PUT", `uploads/${u.id}/chunks`, {
            offset: 0,
            data_base64: bytes.toString("base64"),
          })
        ).statusCode,
        200,
      );
      f.store.put("upload", {
        ...f.store.get("upload", u.id),
        state: "verifying",
      });
      uploads.push(u.id);
    }
    // Simulate the last durable filesystem state between rename and the SQLite receipt commit.
    renameSync(
      join(f.store.blobDir, `${uploads[1]}.part`),
      join(f.store.blobDir, hash),
    );
    await f.restart();
    for (const id of uploads) {
      assert.equal(f.store.get("upload", id).state, "pending");
      const r = await request(f, a, "POST", `uploads/${id}/complete`, {});
      assert.equal(r.statusCode, 200, r.body);
      assert.equal(r.json().status, "available");
      const download = await request(f, a, "GET", `attachments/${r.json().id}`);
      assert.equal(download.statusCode, 200);
      assert.deepEqual(download.rawPayload, bytes);
      assert.equal(
        (await request(f, a, "POST", `uploads/${id}/complete`, {})).json().id,
        r.json().id,
      );
    }
  } finally {
    await f.close();
  }
});

test("device pairing single-use tokens pin workspace, narrow scope and immediate revocation", async () => {
  const f = await fixture();
  try {
    const a = await signup(f);
    const another = (
      await request(f, a, "POST", "/api/workspaces", { name: "另一个" })
    ).json();
    const p = (
      await request(f, a, "POST", "/api/devices/pair", {
        workspace_id: a.wid,
        label: "Edge",
      })
    ).json();
    const claim = await f.app.inject({
      method: "POST",
      url: "/api/devices/claim",
      payload: { code: p.code, label: "Edge local" },
    });
    assert.equal(claim.statusCode, 200, claim.body);
    const d = claim.json();
    assert.ok(resolveToken(f.store, d.token));
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/devices/claim",
          payload: { code: p.code },
        })
      ).statusCode,
      400,
    );
    const auth = { authorization: `Bearer ${d.token}` };
    const bundle = createBundle({ records: [record()] });
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: route(a, "import"),
          headers: { ...auth, "x-idempotency-key": "device-import" },
          payload: { bundle },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "GET",
          url: `/api/w/${another.id}/materials`,
          headers: auth,
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "GET",
          url: route(a, "team"),
          headers: auth,
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "GET",
          url: "/api/providers",
          headers: auth,
        })
      ).statusCode,
      404,
    ); // No provider routes in this isolated core app.
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: route(a, "share"),
          headers: auth,
          payload: { target_workspace_id: another.id },
        })
      ).statusCode,
      403,
    );
    f.store.put(
      "device",
      {
        id: "mcp-only",
        kind: "mcp",
        user_id: a.uid,
        workspace_id: a.wid,
        label: "独立工具令牌",
        scopes: ["read"],
      },
      a.uid,
      a.wid,
    );
    const listed = await request(f, a, "GET", "/api/devices");
    assert.ok(!listed.body.includes(d.token));
    assert.deepEqual(
      listed.json().map((item: any) => item.id),
      [d.id],
    );
    assert.ok(f.store.get("device", "mcp-only"));
    assert.equal(
      (await request(f, a, "DELETE", `/api/devices/${d.id}`)).statusCode,
      200,
    );
    assert.equal(resolveToken(f.store, d.token), undefined);
    assert.equal(
      (
        await f.app.inject({
          method: "GET",
          url: route(a, "materials"),
          headers: auth,
        })
      ).statusCode,
      401,
    );
  } finally {
    await f.close();
  }
});

test("member removal invalidates paired devices and outstanding invitations from removed admins", async () => {
  const f = await fixture();
  try {
    const a = await teamSignup(f);
    const b = await signup(f, "Bob");
    const e = await signup(f, "Eve");
    const admin = await invite(f, a, b, "admin");
    const inv = (
      await request(f, admin, "POST", "invites", {
        email: "eve@example.test",
        role: "editor",
      })
    ).json();
    const pairing = (
      await request(f, admin, "POST", "/api/devices/pair", {
        workspace_id: a.wid,
        label: "Chrome",
      })
    ).json();
    const d = (
      await f.app.inject({
        method: "POST",
        url: "/api/devices/claim",
        payload: { code: pairing.code },
      })
    ).json();
    assert.equal(
      (await request(f, a, "DELETE", `team/${b.uid}`)).statusCode,
      200,
    );
    assert.equal(resolveToken(f.store, d.token), undefined);
    assert.equal(
      (await request(f, e, "POST", "/api/invites/accept", { token: inv.token }))
        .statusCode,
      400,
    );
  } finally {
    await f.close();
  }
});

test("nonowners can leave their own team, immediately revoke devices and preserve shared content", async () => {
  const f = await fixture();
  try {
    const a = await teamSignup(f),
      b = await signup(f, "Bob"),
      viewer = await signup(f, "Viewer"),
      editor = await invite(f, a, b, "editor"),
      guest = await invite(f, a, viewer, "viewer");
    const m = ingestRecord(f.store, a.wid, b.uid, record()),
      artifact = createArtifact(f.store, a.wid, b.uid, {
        title: "团队保留成果",
        body: "退出不删除团队资料",
        citations: [{ material_id: m.id, revision_id: m.revision_id }],
      });
    const pair = (
        await request(f, editor, "POST", "/api/devices/pair", {
          workspace_id: a.wid,
          label: "team-device",
        })
      ).json(),
      device = (
        await f.app.inject({
          method: "POST",
          url: "/api/devices/claim",
          payload: { code: pair.code },
        })
      ).json();
    assert.ok(resolveToken(f.store, device.token));
    assert.equal(
      (await request(f, a, "POST", "leave", {})).json().error.code,
      "OWNER_MUST_TRANSFER",
    );
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: route(a, "leave"),
          headers: { authorization: `Bearer ${device.token}` },
          payload: {},
        })
      ).statusCode,
      403,
    );
    const left = await request(f, editor, "POST", "leave", { user_id: a.uid });
    assert.equal(left.statusCode, 200);
    assert.equal(left.json().left, true);
    assert.equal(f.store.get("membership", `${a.wid}:${b.uid}`), undefined);
    assert.ok(f.store.get("membership", `${a.wid}:${a.uid}`));
    assert.equal(resolveToken(f.store, device.token), undefined);
    assert.equal(
      (await request(f, editor, "GET", "materials")).statusCode,
      404,
    );
    assert.equal(
      (await request(f, a, "GET", `materials/${m.id}`)).statusCode,
      200,
    );
    assert.equal(
      (await request(f, a, "GET", `artifacts/${artifact.id}`)).json().body,
      "退出不删除团队资料",
    );
    assert.equal(
      (await request(f, guest, "POST", "leave", {})).statusCode,
      200,
    );
    assert.equal(
      f.store.get("membership", `${a.wid}:${viewer.uid}`),
      undefined,
    );
    assert.equal((await request(f, b, "GET", "/api/me")).statusCode, 200);
  } finally {
    await f.close();
  }
});

test("same source author conflicts fail atomically while title changes create an immutable revision", async () => {
  const f = await fixture();
  try {
    const a = await signup(f);
    const m = ingestRecord(f.store, a.wid, a.uid, record());
    const next = ingestRecord(
      f.store,
      a.wid,
      a.uid,
      record("topic-1", record().text, {
        title: "标题变更",
        captured_at: "2026-10-03T02:00:00.000Z",
      }),
    );
    assert.equal(next.status, "updated");
    assert.notEqual(next.revision_id, m.revision_id);
    assert.equal(f.store.get("material", m.id).title, "标题变更");
    assert.throws(
      () =>
        ingestRecord(
          f.store,
          a.wid,
          a.uid,
          record("topic-1", record().text, { author_id: "different-author" }),
        ),
      /作者发生冲突/,
    );
    assert.equal(f.store.get("material", m.id).author_id, "author-1");
    assert.equal(f.store.get("material", m.id).revisions.length, 2);
    const old = ingestRecord(
      f.store,
      a.wid,
      a.uid,
      record("topic-1", "更早版本", {
        captured_at: "2026-09-03T00:00:00.000Z",
      }),
    );
    assert.ok(old.revision_id);
    assert.equal(f.store.get("material", m.id).title, "标题变更");
    assert.equal(f.store.get("material", m.id).revision_id, next.revision_id);
  } finally {
    await f.close();
  }
});

test("detail comments are flat and current-group bound, attachment binding is exact and file corruption is detected", async () => {
  const f = await fixture();
  try {
    const a = await signup(f),
      b = await signup(f, "Bob");
    const m = ingestRecord(f.store, a.wid, a.uid, record());
    const comment: SourceRecord = record("comment-1", "当前主题评论", {
      source_key: {
        platform: "zsxq",
        group_id: "group-1",
        entity_type: "comment",
        entity_id: "comment-1",
      },
      parent_entity_id: "topic-1",
      entity_type: "comment",
    });
    const related = ingestRecord(f.store, a.wid, a.uid, comment);
    await request(f, a, "PATCH", `materials/${related.id}`, {
      status: "read",
      tags: ["评论标签"],
    });
    ingestRecord(f.store, a.wid, a.uid, {
      ...comment,
      source_key: {
        ...comment.source_key,
        group_id: "group-2",
        entity_id: "foreign-comment",
      },
      group_id: "group-2",
    });
    ingestRecord(f.store, b.wid, b.uid, comment);
    ingestRecord(f.store, a.wid, a.uid, {
      ...comment,
      source_key: { ...comment.source_key, entity_id: "other-parent" },
      parent_entity_id: "different-topic",
    });
    const archived = ingestRecord(f.store, a.wid, a.uid, {
      ...comment,
      source_key: { ...comment.source_key, entity_id: "archived-comment" },
    });
    await request(f, a, "DELETE", `materials/${archived.id}`);
    const data = Buffer.from("binding-check");
    const u = (
      await request(f, a, "POST", "uploads", {
        name: "bound.bin",
        hash: sha256(data),
        size: data.length,
        mime: "application/octet-stream",
        record_source_key: record().source_key,
      })
    ).json();
    await request(f, a, "PUT", `uploads/${u.id}/chunks`, {
      offset: 0,
      data_base64: data.toString("base64"),
    });
    const attachment = (
      await request(f, a, "POST", `uploads/${u.id}/complete`, {})
    ).json();
    const list = f.store.list.bind(f.store);
    f.store.list = ((kind: string, scope: any = {}) => {
      assert.notEqual(
        kind,
        "material",
        "reader comments must use the SQL relation rather than scanning the corpus",
      );
      return list(kind, scope);
    }) as Store["list"];
    const view = (await request(f, a, "GET", `materials/${m.id}`)).json();
    assert.equal(view.comments.length, 1);
    assert.equal(view.comments[0].group_id, "group-1");
    assert.equal(view.comments[0].replies, undefined);
    assert.equal(view.comments[0].status, "read");
    assert.deepEqual(view.comments[0].tags, ["评论标签"]);
    assert.equal(view.attachments[0].id, attachment.id);
    const plan = f.store.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT json FROM records WHERE kind='material' AND workspace_id=? AND json_extract(json,'$.entity_type')='comment' AND json_extract(json,'$.archived_at') IS NULL AND json_extract(json,'$.group_id')=? AND json_extract(json,'$.parent_entity_id')=? ORDER BY rowid",
      )
      .all(a.wid, "group-1", "topic-1");
    assert.ok(
      plan.some((row) =>
        String(row.detail).includes("USING INDEX material_comments"),
      ),
      JSON.stringify(plan),
    );
    writeFileSync(
      join(f.store.blobDir, attachment.hash),
      Buffer.alloc(data.length, 65),
    );
    assert.equal(
      (await request(f, a, "GET", `attachments/${attachment.id}`)).statusCode,
      422,
    );
  } finally {
    await f.close();
  }
});

test("portable full-version fingerprints preserve same-text historical metadata, citations and annotation anchors", async () => {
  const f = await fixture();
  try {
    const a = await signup(f),
      b = await signup(f, "Bob"),
      original = record();
    const first = ingestRecord(f.store, a.wid, a.uid, original);
    const artifact = createArtifact(f.store, a.wid, a.uid, {
      title: "固定历史版本",
      body: "历史版本结论 [S1]",
      citations: [
        {
          material_id: first.id,
          revision_id: first.revision_id,
          label: "S1",
          citation_id: "c-s1",
        },
      ],
    });
    const quote = original.text.slice(0, 3);
    const note = await request(f, a, "POST", "annotations", {
      material_id: first.id,
      revision_id: first.revision_id,
      start: 0,
      end: 3,
      quote,
      note: "锚定旧标题与完整度",
    });
    assert.equal(note.statusCode, 200);
    const latest = ingestRecord(
      f.store,
      a.wid,
      a.uid,
      record("topic-1", original.text, {
        title: "同正文的新标题",
        author_name: "作者展示名变更",
        captured_at: "2026-10-03T02:00:00.000Z",
        coverage: { ...original.coverage, comments: "complete", reasons: [] },
      }),
    );
    assert.notEqual(first.revision_id, latest.revision_id);
    const exported = await request(
      f,
      a,
      "GET",
      `export?material_ids=${first.id}&artifact_ids=${artifact.id}&annotations=true`,
    );
    assert.equal(exported.statusCode, 200, exported.body);
    const bundle = validateBundle(exported.json());
    assert.equal(bundle.records.length, 2);
    assert.equal(new Set(bundle.records.map((r) => r.hash)).size, 1);
    assert.equal(new Set(bundle.records.map((r) => r.version_hash)).size, 2);
    assert.equal(
      bundle.artifacts[0].citations[0].version_hash,
      recordVersionHash(original),
    );
    assert.equal(
      bundle.annotations[0].version_hash,
      recordVersionHash(original),
    );
    const imported = await request(
      f,
      b,
      "POST",
      "import",
      { bundle },
      { "x-idempotency-key": "same-text-metadata" },
    );
    assert.equal(imported.statusCode, 200, imported.body);
    const copied = f.store.get("artifact", imported.json().artifacts[0].id),
      copiedNote = f.store.get("annotation", imported.json().annotations[0].id),
      material = f.store.get("material", copied.citations[0].material_id);
    const oldRevision = material.revisions.find(
      (r: any) => r.id === copied.citations[0].revision_id,
    );
    assert.equal(material.title, "同正文的新标题");
    assert.equal(oldRevision.record_meta.title, original.title);
    assert.equal(oldRevision.coverage.comments, "partial");
    assert.equal(copiedNote.revision_id, oldRevision.id);
    assert.equal(copied.citations[0].version_hash, recordVersionHash(original));
    assert.equal(copied.citations[0].label, "S1");
    assert.equal(copied.citations[0].citation_id, "c-s1");
    assert.equal(copied.stale, true);
  } finally {
    await f.close();
  }
});

test("legacy single-version hashes remain compatible, ambiguous legacy references roll back the whole bundle", async () => {
  const f = await fixture();
  try {
    const a = await signup(f),
      r = record(),
      citation = {
        material_id: "foreign-material",
        revision_id: sha256(r.text),
        source_key: r.source_key,
        label: "S1",
      };
    const artifact = {
      id: "foreign-artifact",
      title: "旧格式",
      body: "旧格式单版本 [S1]",
      citations: [citation],
      status: "draft" as const,
    };
    const legacy = createBundle({ records: [r], artifacts: [artifact] });
    const imported = await request(
      f,
      a,
      "POST",
      "import",
      { bundle: legacy },
      { "x-idempotency-key": "legacy-one" },
    );
    assert.equal(imported.statusCode, 200, imported.body);
    const copied = f.store.get("artifact", imported.json().artifacts[0].id);
    assert.equal(copied.citations[0].version_hash, recordVersionHash(r));
    const b = await signup(f, "Bob"),
      next = record("topic-1", r.text, {
        title: "同正文另一个版本",
        captured_at: "2026-10-03T02:00:00.000Z",
      });
    const ambiguous = createBundle({
      records: [r, next],
      artifacts: [artifact],
    });
    const denied = await request(
      f,
      b,
      "POST",
      "import",
      { bundle: ambiguous },
      { "x-idempotency-key": "legacy-ambiguous" },
    );
    assert.equal(denied.statusCode, 400, denied.body);
    assert.equal(denied.json().error.code, "REFERENCE_AMBIGUOUS");
    assert.equal(f.store.list("material", { workspaceId: b.wid }).length, 0);
    assert.equal(f.store.list("revision", { workspaceId: b.wid }).length, 0);
    assert.equal(
      f.store.list("import_receipt", { workspaceId: b.wid }).length,
      0,
    );
    const explicitWrong = createBundle({
      records: [r],
      artifacts: [
        {
          ...artifact,
          citations: [{ ...citation, version_hash: "0".repeat(64) }],
        },
      ],
    });
    const wrong = await request(
      f,
      b,
      "POST",
      "import",
      { bundle: explicitWrong },
      { "x-idempotency-key": "version-exact-only" },
    );
    assert.equal(wrong.statusCode, 400);
    assert.equal(wrong.json().error.code, "REFERENCE_INVALID");
    assert.equal(f.store.list("material", { workspaceId: b.wid }).length, 0);
  } finally {
    await f.close();
  }
});

test("version fingerprints normalize transport defaults, reject tampering and cannot be forged in live citations", async () => {
  const f = await fixture();
  try {
    const a = await signup(f),
      r = record(),
      version = recordVersionHash(r);
    assert.equal(
      recordVersionHash({
        ...r,
        entity_type: "topic",
        images: [],
        files: [],
        captured_at: "2026-10-04T00:00:00.000Z",
        hash: "f".repeat(64),
        version_hash: "a".repeat(64),
      }),
      version,
    );
    assert.notEqual(recordVersionHash({ ...r, title: "新标题" }), version);
    assert.notEqual(
      recordVersionHash({
        ...r,
        coverage: { ...r.coverage, comments: "complete" },
      }),
      version,
    );
    const forged = createBundle({
      records: [{ ...r, version_hash: "0".repeat(64) }],
    });
    assert.throws(() => validateBundle(forged), /version_hash_mismatch/);
    assert.throws(
      () => ingestRecord(f.store, a.wid, a.uid, forged.records[0]),
      /version_hash_mismatch/,
    );
    assert.equal(f.store.list("material").length, 0);
    const m = ingestRecord(f.store, a.wid, a.uid, r);
    const invalid = await request(f, a, "POST", "artifacts", {
      title: "错误指纹",
      body: "不保存",
      citations: [
        {
          material_id: m.id,
          revision_id: m.revision_id,
          version_hash: "0".repeat(64),
        },
      ],
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json().error.code, "CITATION_INVALID");
    assert.equal(f.store.list("artifact").length, 0);
  } finally {
    await f.close();
  }
});
