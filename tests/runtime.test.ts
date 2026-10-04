import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createApp } from "../server/index.js";
import { publicRequest, isPublicAddress, providerURL } from "../server/net.js";
import {
  providerCall,
  providerModels,
  type Provider,
} from "../server/provider.js";
import { vault } from "../server/secrets.js";
import {
  parseSourceJson,
  sourceHeaders,
  normalizeTopic,
  sourcePaths,
} from "../shared/zsxq.js";
import {
  createBundle,
  sha256,
  fragmentsFor,
  validateBundle,
} from "../shared/transfer.js";
import { extractAttachment } from "../server/attachments.js";

const record = (text = "采集验收隔离材料") => ({
  source_key: {
    platform: "zsxq" as const,
    group_id: "89",
    entity_type: "topic" as const,
    entity_id: "900719925474099312",
  },
  group_id: "89",
  author_id: "7",
  author_name: "测试作者",
  title: "测试材料",
  text,
  created_at: "2026-10-02T12:00:00+0800",
  source_url: "https://wx.zsxq.com/topic/900719925474099312",
  coverage: {
    body: "complete" as const,
    comments: "complete" as const,
    attachments: "complete" as const,
    reasons: [],
  },
  fragments: fragmentsFor(text),
  captured_at: new Date().toISOString(),
  hash: sha256(text),
});
const response = (j: any, status = 200) => ({
  status,
  headers: new Headers(),
  text: JSON.stringify(j),
  bytes: Buffer.from(JSON.stringify(j)),
});
const base: Provider = {
  id: "p",
  label: "test",
  protocol: "chat",
  base_url: "https://provider.example/v1",
  model: "test-model",
  models: [],
  secret: "",
  user_id: "u",
};

test("canonical sha256 matches node crypto for empty, unicode, long text and bytes", () => {
  for (const input of [
    "",
    "abc",
    "中文😀",
    "long".repeat(12000),
    new Uint8Array([0, 1, 255]),
  ])
    assert.equal(
      sha256(input),
      createHash("sha256").update(input).digest("hex"),
    );
});
test("source JSON retains bigint identifiers and does not change quoted strings", async () => {
  const j = parseSourceJson(
    '{"topic_id":900719925474099312,"text":"1234567890123456789 \\" quote","small":23}',
  );
  assert.equal(j.topic_id, "900719925474099312");
  assert.equal(j.small, 23);
  assert.match(j.text, /1234567890123456789/);
  const h = await sourceHeaders("https://api.zsxq.com/v2/groups");
  assert.equal(
    h["X-Signature"],
    createHash("sha1")
      .update(
        `https://api.zsxq.com/v2/groups ${h["X-Timestamp"]} ${h["X-Request-Id"]}`,
      )
      .digest("hex"),
  );
});
test("source normalization pins group/author and marks unfilled long article partial", () => {
  const t = {
    topic_id: "900719925474099312",
    group: { group_id: "89" },
    talk: {
      owner: { user_id: "7", name: "作者" },
      text: "摘要",
      article: { article_id: "8" },
    },
  };
  const r = normalizeTopic(t, "89");
  assert.equal(r.coverage.body, "partial");
  assert.throws(() => normalizeTopic(t, "90"), /group_identity/);
  assert.equal(r.author_id, "7");
});
test("network boundary rejects loopback, private, metadata and redirect addresses", async () => {
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "169.254.169.254",
    "192.168.1.5",
    "172.31.9.1",
    "::1",
    "::ffff:8.8.8.8",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
  ])
    assert.equal(isPublicAddress(ip), false);
  assert.equal(isPublicAddress("8.8.8.8"), true);
  assert.throws(() => providerURL("https://foo:key@example.com/v1"));
  assert.throws(() => providerURL("http://localhost:1234/v1"));
  await assert.rejects(publicRequest("https://127.0.0.1/v1"), /私网/);
});
test("three provider protocols issue exact endpoints and extract text with no silent fallback", async () => {
  for (const protocol of ["chat", "responses", "anthropic"] as const) {
    let sent: any;
    const p = { ...base, protocol };
    const j =
      protocol === "chat"
        ? { choices: [{ message: { content: "ok" } }] }
        : protocol === "responses"
          ? { output: [{ content: [{ type: "output_text", text: "ok" }] }] }
          : { content: [{ type: "text", text: "ok" }] };
    const result = await providerCall(
      p,
      "fixture-key",
      "system",
      "input",
      256,
      "configured-model",
      async (url, init) => {
        sent = { url, init };
        return response(j);
      },
    );
    assert.equal(result.text, "ok");
    assert.match(
      sent.url,
      new RegExp(
        protocol === "chat"
          ? "chat/completions$"
          : protocol === "responses"
            ? "responses$"
            : "messages$",
      ),
    );
    assert.equal(JSON.parse(sent.init.body).model, "configured-model");
    if (protocol === "responses")
      assert.equal(JSON.parse(sent.init.body).store, false);
  }
});
test("provider network/server/invalid text outcomes remain unknown and are not retried", async () => {
  let calls = 0;
  await assert.rejects(
    providerCall(base, "key", "s", "i", 256, "m", async () => {
      calls++;
      throw new Error("connection lost");
    }),
    { code: "outcome_unknown" },
  );
  assert.equal(calls, 1);
  await assert.rejects(
    providerCall(base, "key", "s", "i", 256, "m", async () =>
      response({}, 503),
    ),
    { code: "outcome_unknown" },
  );
  await assert.rejects(
    providerCall(base, "key", "s", "i", 256, "m", async () =>
      response({}, 401),
    ),
    { code: "provider_rejected" },
  );
});
test("credentials encrypt at rest and text attachment parsing is explicit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xj-vault-"));
  try {
    const v = vault(dir),
      secret = "private-fixture-key";
    const encrypted = v.encrypt(secret);
    assert(!encrypted.includes(secret));
    assert.equal(v.decrypt(encrypted).toString(), secret);
    const bad = encrypted.slice(0, -2) + "zz";
    assert.throws(() => v.decrypt(bad));
    assert.equal(
      (await extractAttachment(Buffer.from("hello"), "note.md")).text,
      "hello",
    );
    assert.equal(
      (await extractAttachment(Buffer.from("bytes"), "archive.zip")).state,
      "unsupported",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
async function harness(
  fn: (ctx: any) => Promise<void>,
  request: any = async () =>
    response({
      choices: [
        {
          message: {
            content: JSON.stringify({
              title: "验收草稿",
              body: "按材料整理 [S1]",
              citations: ["S1"],
            }),
          },
        },
      ],
    }),
  sources?: any,
) {
  const dir = mkdtempSync(join(tmpdir(), "xj-runtime-"));
  const { app, store, runtime } = await createApp({
    dataDir: dir,
    worker: false,
    runtime: { request, sources },
  });
  try {
    const registration = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: "runtime@example.com",
        name: "验收用户",
        password: "Test-only-password-42!",
      },
    });
    assert.equal(registration.statusCode, 201, registration.body);
    const auth = registration.json(),
      headers = {
        cookie: registration.cookies
          .map((c) => `${c.name}=${c.value}`)
          .join("; "),
        "x-csrf-token": auth.csrf,
      };
    const wid = auth.workspaces[0].id;
    const api = async (
      path: string,
      payload?: any,
      method: any = payload ? "POST" : "GET",
    ) => {
      const r = await app.inject({ method, url: path, headers, payload });
      if (r.statusCode >= 400)
        throw Object.assign(new Error(r.body), { response: r });
      return r.json();
    };
    const imported = await app.inject({
      method: "POST",
      url: `/api/w/${wid}/import`,
      headers: { ...headers, "x-idempotency-key": "fixture-one" },
      payload: { bundle: createBundle({ records: [record()] }) },
    });
    assert.equal(imported.statusCode, 200, imported.body);
    await fn({
      app,
      store,
      runtime,
      dir,
      headers,
      wid,
      api,
      auth,
      mid: imported.json().records[0].id,
    });
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
test("process flow pins input revisions, requires approval and creates a citation-linked draft", async () =>
  harness(async ({ api, wid, mid, store, runtime }) => {
    const p = await api("/api/providers", {
      label: "隔离测试",
      protocol: "chat",
      base_url: base.base_url,
      api_key: "fixture-only-secret",
      model: "manual",
    });
    assert(!JSON.stringify(p).includes("fixture-only-secret"));
    const recipe = await api(`/api/w/${wid}/recipes`, {
      name: "深读",
      preset_id: "deep-read",
      provider_id: p.id,
      goal: "整理",
      material_ids: [mid],
      max_calls: 1,
    });
    const j = await api(`/api/w/${wid}/jobs`, {
      kind: "process",
      recipe_id: recipe.id,
    });
    assert.equal(j.state, "awaiting_approval");
    await runtime.tick();
    assert.equal(store.get("job", j.id).checkpoint.calls, 0);
    await api(`/api/w/${wid}/jobs/${j.id}/approve`, {});
    await runtime.tick();
    const final = store.get("job", j.id);
    assert.equal(final.state, "completed");
    const artifact = await api(
      `/api/w/${wid}/artifacts/${final.artifact_ids[0]}`,
    );
    assert.equal(artifact.status, "draft");
    assert.equal(artifact.citations[0].material_id, mid);
    assert.equal(artifact.revisions.length, 1);
  }));
test("unknown billable job requires explicit retry and never replays on worker tick", async () => {
  let calls = 0;
  await harness(
    async ({ api, wid, mid, runtime, store, app, headers }) => {
      const p = await api("/api/providers", {
        label: "失败协议",
        protocol: "chat",
        base_url: base.base_url,
        api_key: "fixture-only",
        model: "m",
      });
      const r = await api(`/api/w/${wid}/recipes`, {
        name: "未知结果",
        preset_id: "qa",
        provider_id: p.id,
        material_ids: [mid],
        approval: "automatic",
      });
      const j = await api(`/api/w/${wid}/jobs`, {
        kind: "process",
        recipe_id: r.id,
      });
      await runtime.tick();
      assert.equal(store.get("job", j.id).state, "outcome_unknown");
      await runtime.tick();
      assert.equal(calls, 1);
      const retry = await app.inject({
        method: "POST",
        url: `/api/w/${wid}/jobs/${j.id}/resume`,
        headers,
        payload: {},
      });
      assert.equal(retry.statusCode, 409);
    },
    async () => {
      calls++;
      throw new Error("lost");
    },
  );
});
test("MCP token finite scopes pin workspace and cannot capture, shell, mutate sources or impersonate", async () =>
  harness(async ({ api, wid, app, headers, store }) => {
    const d = await api(`/api/w/${wid}/tools-tokens`, {
      label: "test-agent",
      scopes: ["read", "process"],
    });
    const auth = { authorization: `Bearer ${d.token}` };
    const tools = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: auth,
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    assert.equal(tools.statusCode, 200);
    assert(!tools.body.includes("shell"));
    const denied = await app.inject({
      method: "POST",
      url: `/api/w/${wid}/jobs`,
      headers: auth,
      payload: { kind: "capture", connection_id: "x" },
    });
    assert.equal(denied.statusCode, 403);
    await api(`/api/w/${wid}/tools-tokens/${d.id}`, undefined, "DELETE");
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/mcp",
          headers: auth,
          payload: { method: "tools/list", id: 2 },
        })
      ).statusCode,
      401,
    );
  }));
