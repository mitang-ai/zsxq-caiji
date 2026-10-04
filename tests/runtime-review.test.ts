import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { InjectOptions } from "fastify";
import { createApp } from "../server/index.js";
import type { RuntimeOptions } from "../server/runtime.js";
import {
  createBundle,
  fragmentsFor,
  sha256,
  type SourceRecord,
} from "../shared/transfer.js";

// Every source/model is injected. No test opens a browser or makes an external request.
type Auth = { uid: string; wid: string; headers: Record<string, string> };
const modelResponse = (
  output: unknown = {
    title: "隔离验收草稿",
    body: "材料结论 [S1]",
    citations: ["S1"],
  },
) => {
  const text = JSON.stringify({
    choices: [
      {
        message: {
          content: typeof output === "string" ? output : JSON.stringify(output),
        },
      },
    ],
    model: "fixture-model",
    usage: { total_tokens: 12 },
  });
  return {
    status: 200,
    headers: new Headers(),
    text,
    bytes: Buffer.from(text),
  };
};
function record(
  id = "123",
  text = "隔离材料，不来自任何真实账户",
  overrides: Partial<SourceRecord> = {},
): SourceRecord {
  return {
    source_key: {
      platform: "zsxq",
      group_id: "89",
      entity_type: "topic",
      entity_id: id,
    },
    group_id: "89",
    author_id: "7",
    author_name: "隔离作者",
    title: "冻结前标题",
    text,
    created_at: "2026-10-01T00:00:00.000Z",
    source_url: `https://wx.zsxq.com/topic/${id}`,
    coverage: {
      body: "complete",
      comments: "complete",
      attachments: "complete",
      reasons: [],
    },
    fragments: fragmentsFor(text),
    captured_at: "2026-10-02T00:00:00.000Z",
    hash: sha256(text),
    ...overrides,
  };
}
async function fixture(options: RuntimeOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "xj-runtime-review-"));
  const defaultSources = {
    isActive: () => false,
    async close() {},
    setBusy() {},
  };
  const { app, store, runtime } = await createApp({
    dataDir: dir,
    worker: false,
    runtime: {
      request: async () => modelResponse(),
      sources: defaultSources as any,
      ...options,
    },
  });
  async function register(name = "owner"): Promise<Auth> {
    const r = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: `${name}@example.test`,
        name,
        password: "Fixture-only-password-42!",
      },
    });
    assert.equal(r.statusCode, 201, r.body);
    const b = r.json();
    return {
      uid: b.user.id,
      wid: b.workspaces[0].id,
      headers: {
        cookie: r.cookies.map((c) => `${c.name}=${c.value}`).join("; "),
        "x-csrf-token": b.csrf,
      },
    };
  }
  async function send(
    a: Auth,
    method: InjectOptions["method"],
    url: string,
    payload?: any,
    headers?: Record<string, string>,
  ) {
    return app.inject({
      method,
      url,
      headers: { ...a.headers, ...headers },
      payload,
    });
  }
  async function api(
    a: Auth,
    method: InjectOptions["method"],
    url: string,
    payload?: any,
  ) {
    const r = await send(a, method, url, payload);
    assert.ok(
      r.statusCode >= 200 && r.statusCode < 300,
      `${method} ${url}: ${r.body}`,
    );
    return r.json();
  }
  async function material(a: Auth, source = record()) {
    const r = await send(
      a,
      "POST",
      `/api/w/${a.wid}/import`,
      { bundle: createBundle({ records: [source] }) },
      {
        "x-idempotency-key": `fixture-${source.source_key.entity_id}-${source.captured_at}-${sha256(source.title + source.text)}`,
      },
    );
    assert.equal(r.statusCode, 200, r.body);
    return r.json().records[0];
  }
  async function provider(a: Auth) {
    return api(a, "POST", "/api/providers", {
      label: "fixture-provider",
      protocol: "chat",
      base_url: "https://fixture-provider.example/v1",
      api_key: "fixture-only-key",
      model: "fixture-model",
    });
  }
  async function recipe(
    a: Auth,
    pid: string,
    mid: string,
    overrides: Record<string, unknown> = {},
  ) {
    return api(a, "POST", `/api/w/${a.wid}/recipes`, {
      name: "隔离有界流程",
      preset_id: "qa",
      provider_id: pid,
      material_ids: [mid],
      max_calls: 1,
      ...overrides,
    });
  }
  return {
    app,
    store,
    runtime,
    register,
    api,
    send,
    material,
    provider,
    recipe,
    async close() {
      await app.close();
      const root = resolve(tmpdir()),
        target = resolve(dir);
      assert.ok(
        target.startsWith(root + sep) &&
          target.split(sep).at(-1)!.startsWith("xj-runtime-review-"),
      );
      rmSync(target, { recursive: true, force: true });
    },
  };
}

test("process-only tokens cannot approve manual jobs or act on an existing capture job", async () => {
  const f = await fixture();
  try {
    const a = await f.register(),
      m = await f.material(a),
      p = await f.provider(a),
      recipe = await f.recipe(a, p.id, m.id);
    const device = await f.api(a, "POST", `/api/w/${a.wid}/tools-tokens`, {
      label: "process-only",
      scopes: ["process"],
    });
    const bearer = { authorization: `Bearer ${device.token}` };
    const c = await f.api(a, "POST", "/api/connections", {
      channel: "browser",
      label: "fixture-source",
    });
    f.store.put(
      "connection",
      {
        ...f.store.get("connection", c.id),
        state: "ready",
        source_account_id: "7",
        groups: [{ id: "89" }],
      },
      a.uid,
    );
    const capture = await f.api(a, "POST", `/api/w/${a.wid}/jobs`, {
      kind: "capture",
      connection_id: c.id,
      scope: { group_id: "89" },
    });
    await f.api(a, "POST", `/api/w/${a.wid}/jobs/${capture.id}/pause`, {});
    for (const action of ["resume", "cancel", "approve", "pause"]) {
      const r = await f.app.inject({
        method: "POST",
        url: `/api/w/${a.wid}/jobs/${capture.id}/${action}`,
        headers: bearer,
        payload: {},
      });
      assert.equal(r.statusCode, 403, r.body);
      assert.equal(r.json().error.code, "policy_denied");
    }
    assert.equal(f.store.get("job", capture.id).state, "paused");
    const process = await f.api(a, "POST", `/api/w/${a.wid}/jobs`, {
      kind: "process",
      recipe_id: recipe.id,
    });
    const approve = await f.app.inject({
      method: "POST",
      url: `/api/w/${a.wid}/jobs/${process.id}/approve`,
      headers: bearer,
      payload: {},
    });
    assert.equal(approve.statusCode, 403);
    assert.equal(f.store.get("job", process.id).state, "awaiting_approval");
    assert.equal(
      (
        await f.app.inject({
          method: "GET",
          url: "/api/providers",
          headers: bearer,
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "GET",
          url: "/api/connections",
          headers: bearer,
        })
      ).statusCode,
      403,
    );
  } finally {
    await f.close();
  }
});

test("empty frozen snapshots never fall back to current dataset materials", async () => {
  const f = await fixture();
  try {
    const a = await f.register(),
      m = await f.material(a),
      p = await f.provider(a);
    const d = await f.api(a, "POST", `/api/w/${a.wid}/datasets`, {
      name: "空冻结",
      mode: "manual",
      material_ids: [],
    });
    const frozen = await f.api(
      a,
      "POST",
      `/api/w/${a.wid}/datasets/${d.id}/freeze`,
      {},
    );
    assert.equal(frozen.items.length, 0);
    await f.api(a, "PATCH", `/api/w/${a.wid}/datasets/${d.id}`, {
      name: "空冻结",
      mode: "manual",
      material_ids: [m.id],
    });
    const recipe = await f.recipe(a, p.id, m.id, { dataset_id: d.id });
    const r = await f.send(a, "POST", `/api/w/${a.wid}/jobs`, {
      kind: "process",
      recipe_id: recipe.id,
    });
    assert.equal(r.statusCode, 400, r.body);
    assert.equal(r.json().error.code, "empty_materials");
    assert.equal(f.store.list("job").length, 0);
  } finally {
    await f.close();
  }
});

test("nonempty frozen input uses the original revision text and title after source metadata changes", async () => {
  const f = await fixture();
  try {
    const a = await f.register(),
      first = await f.material(a),
      p = await f.provider(a);
    const d = await f.api(a, "POST", `/api/w/${a.wid}/datasets`, {
      name: "冻结版本",
      mode: "manual",
      material_ids: [first.id],
    });
    await f.api(a, "POST", `/api/w/${a.wid}/datasets/${d.id}/freeze`, {});
    await f.material(
      a,
      record("123", "后续新正文", {
        title: "变更后的新标题",
        captured_at: "2026-10-03T00:00:00.000Z",
      }),
    );
    const recipe = await f.recipe(a, p.id, first.id, { dataset_id: d.id });
    const j = await f.api(a, "POST", `/api/w/${a.wid}/jobs`, {
      kind: "process",
      recipe_id: recipe.id,
    });
    assert.equal(j.inputs[0].revision_id, first.revision_id);
    assert.equal(j.inputs[0].text, record().text);
    assert.equal(j.inputs[0].title, record().title);
  } finally {
    await f.close();
  }
});

for (const [name, output] of [
  ["invalid JSON", "received-paid-output-not-json"],
  ["null JSON", null],
  [
    "empty title",
    { title: "", body: "已计费原始输出 [S1]", citations: ["S1"] },
  ],
  [
    "NUL title",
    { title: "标题\0不能保存", body: "输出 [S1]", citations: ["S1"] },
  ],
  [
    "oversized title",
    { title: "X".repeat(1001), body: "输出 [S1]", citations: ["S1"] },
  ],
  ["NUL body", { title: "标题", body: "输出\0 [S1]", citations: ["S1"] }],
  [
    "unlisted body citation",
    { title: "标题", body: "正文没有列入引用数组 [S2]", citations: ["S1"] },
  ],
  [
    "invalid citations",
    { title: "保留输出", body: "坏引用 [S99]", citations: ["S99"] },
  ],
] as const) {
  test(`received ${name} consumes one call and cannot resume/replay the paid batch`, async () => {
    let calls = 0;
    const f = await fixture({
      request: async () => {
        calls++;
        return modelResponse(output);
      },
    });
    try {
      const a = await f.register(),
        m = await f.material(a),
        p = await f.provider(a),
        r = await f.recipe(a, p.id, m.id, { approval: "automatic" });
      const j = await f.api(a, "POST", `/api/w/${a.wid}/jobs`, {
        kind: "process",
        recipe_id: r.id,
      });
      await f.runtime.tick();
      const stored = f.store.get("job", j.id);
      assert.equal(stored.state, "partial");
      assert.equal(stored.checkpoint.calls, 1);
      assert.equal(stored.checkpoint.attempts, 1);
      assert.equal(stored.checkpoint.call_pending, false);
      assert.ok(stored.checkpoint.unparsed_response);
      assert.equal(stored.usage.length, 1);
      const retry = await f.send(
        a,
        "POST",
        `/api/w/${a.wid}/jobs/${j.id}/resume`,
        { retry_unknown: true },
      );
      assert.equal(retry.statusCode, 409);
      assert.equal(retry.json().error.code, "output_review_required");
      await f.runtime.tick();
      assert.equal(calls, 1);
      assert.equal(f.store.list("artifact").length, 0);
    } finally {
      await f.close();
    }
  });
}

for (const [protocol, reason] of [
  ["chat", "length"],
  ["chat", "content_filter"],
  ["responses", "incomplete"],
  ["anthropic", "max_tokens"],
] as const) {
  test(`${protocol} ${reason} preserves paid output as partial even when the text is valid JSON`, async () => {
    let calls = 0;
    const output = JSON.stringify({
      title: "貌似完整的被截断输出",
      body: "输出 [S1]",
      citations: ["S1"],
    });
    const f = await fixture({
      request: async () => {
        calls++;
        const raw =
          protocol === "chat"
            ? {
                choices: [
                  { message: { content: output }, finish_reason: reason },
                ],
              }
            : protocol === "responses"
              ? {
                  status: "incomplete",
                  incomplete_details: { reason: "max_output_tokens" },
                  output: [
                    { content: [{ type: "output_text", text: output }] },
                  ],
                }
              : {
                  content: [{ type: "text", text: output }],
                  stop_reason: reason,
                };
        const text = JSON.stringify(raw);
        return {
          status: 200,
          headers: new Headers(),
          text,
          bytes: Buffer.from(text),
        };
      },
    });
    try {
      const a = await f.register(),
        m = await f.material(a),
        p = await f.provider(a);
      await f.api(a, "PATCH", `/api/providers/${p.id}`, { protocol });
      const r = await f.recipe(a, p.id, m.id, { approval: "automatic" }),
        j = await f.api(a, "POST", `/api/w/${a.wid}/jobs`, {
          kind: "process",
          recipe_id: r.id,
        });
      await f.runtime.tick();
      const stored = f.store.get("job", j.id);
      assert.equal(stored.state, "partial");
      assert.equal(stored.checkpoint.calls, 1);
      assert.equal(stored.checkpoint.attempts, 1);
      assert.equal(stored.checkpoint.unparsed_response, output);
      assert.ok(
        stored.events.some((e: any) => e.action === "output_truncated"),
      );
      assert.equal(f.store.list("artifact").length, 0);
      assert.equal(
        (
          await f.send(a, "POST", `/api/w/${a.wid}/jobs/${j.id}/resume`, {
            retry_unknown: true,
          })
        ).statusCode,
        409,
      );
      await f.runtime.tick();
      assert.equal(calls, 1);
    } finally {
      await f.close();
    }
  });
}

for (const maxCalls of [1, 2]) {
  test(`explicit unknown-result retry never exceeds the preauthorized ${maxCalls}-attempt budget`, async () => {
    let calls = 0;
    const f = await fixture({
      request: async () => {
        calls++;
        if (calls === 1) throw new Error("isolated transport result unknown");
        return modelResponse();
      },
    });
    try {
      const a = await f.register(),
        m = await f.material(a),
        p = await f.provider(a),
        r = await f.recipe(a, p.id, m.id, {
          approval: "automatic",
          max_calls: maxCalls,
        });
      const j = await f.api(a, "POST", `/api/w/${a.wid}/jobs`, {
        kind: "process",
        recipe_id: r.id,
      });
      await f.runtime.tick();
      const unknown = f.store.get("job", j.id);
      assert.equal(unknown.state, "outcome_unknown");
      assert.equal(unknown.checkpoint.attempts, 1);
      assert.equal(unknown.checkpoint.calls, 0);
      assert.equal(
        (await f.send(a, "POST", `/api/w/${a.wid}/jobs/${j.id}/resume`, {}))
          .statusCode,
        409,
      );
      await f.api(a, "POST", `/api/w/${a.wid}/jobs/${j.id}/resume`, {
        retry_unknown: true,
      });
      await f.runtime.tick();
      const final = f.store.get("job", j.id);
      assert.equal(calls, maxCalls);
      assert.equal(final.checkpoint.attempts, maxCalls);
      assert.equal(final.state, maxCalls === 1 ? "budget_paused" : "completed");
      assert.equal(final.checkpoint.calls, maxCalls === 1 ? 0 : 1);
      await f.runtime.tick();
      assert.equal(calls, maxCalls);
    } finally {
      await f.close();
    }
  });
}

test("deleting an inactive personal connection does not close another users active source context", async () => {
  let active: string | undefined,
    closes = 0;
  const sources = {
    async open(c: any) {
      active = c.id;
      return {};
    },
    isActive(id: string) {
      return active === id;
    },
    async close() {
      closes++;
      active = undefined;
    },
    setBusy() {},
  };
  const f = await fixture({ sources: sources as any });
  try {
    const a = await f.register(),
      b = await f.register("other");
    const ca = await f.api(a, "POST", "/api/connections", {
      channel: "browser",
      label: "source-a",
    });
    const cb = await f.api(b, "POST", "/api/connections", {
      channel: "browser",
      label: "source-b",
    });
    await f.api(b, "POST", `/api/connections/${cb.id}/open`, {});
    assert.equal(active, cb.id);
    await f.api(a, "DELETE", `/api/connections/${ca.id}`);
    assert.equal(closes, 0);
    assert.equal(active, cb.id);
    assert.equal(f.store.get("connection", cb.id).state, "awaiting_login");
    await f.api(b, "DELETE", `/api/connections/${cb.id}`);
    assert.equal(closes, 1);
    assert.equal(active, undefined);
  } finally {
    await f.close();
  }
});

test("provider destination or credentials changing requires a fresh approval without an outbound call", async () => {
  let calls = 0;
  const urls: string[] = [];
  const f = await fixture({
    request: async (url) => {
      calls++;
      urls.push(String(url));
      return modelResponse();
    },
  });
  try {
    const a = await f.register(),
      m = await f.material(a),
      p = await f.provider(a),
      r = await f.recipe(a, p.id, m.id, { approval: "automatic" });
    const j = await f.api(a, "POST", `/api/w/${a.wid}/jobs`, {
      kind: "process",
      recipe_id: r.id,
    });
    await f.api(a, "PATCH", `/api/providers/${p.id}`, {
      base_url: "https://changed-fixture.example/v1",
      api_key: "changed-fixture-only-key",
      model: "changed-model",
    });
    await f.runtime.tick();
    assert.equal(calls, 0);
    const changed = f.store.get("job", j.id);
    assert.equal(changed.state, "awaiting_approval");
    assert.equal(changed.approved, false);
    assert.equal(
      changed.plan.destination,
      "https://changed-fixture.example/v1",
    );
    await f.api(a, "POST", `/api/w/${a.wid}/jobs/${j.id}/approve`, {});
    await f.runtime.tick();
    assert.equal(calls, 1);
    assert.match(
      urls[0],
      /^https:\/\/changed-fixture\.example\/v1\/chat\/completions$/,
    );
    assert.equal(f.store.get("job", j.id).state, "completed");
  } finally {
    await f.close();
  }
});

test("removing an editor before execution prevents queued personal-provider jobs from sending workspace data", async () => {
  let calls = 0;
  const f = await fixture({
    request: async () => {
      calls++;
      return modelResponse();
    },
  });
  try {
    const personal = await f.register(),
      editor = await f.register("editor"),
      team = await f.api(personal, "POST", "/api/workspaces", {
        name: "隔离执行权限团队",
      }),
      owner = { ...personal, wid: team.id },
      m = await f.material(owner);
    const inv = await f.api(owner, "POST", `/api/w/${owner.wid}/invites`, {
      email: "editor@example.test",
      role: "editor",
    });
    await f.api(editor, "POST", "/api/invites/accept", { token: inv.token });
    const teamEditor = { ...editor, wid: owner.wid },
      p = await f.provider(editor),
      r = await f.recipe(teamEditor, p.id, m.id, { approval: "automatic" });
    const j = await f.api(teamEditor, "POST", `/api/w/${owner.wid}/jobs`, {
      kind: "process",
      recipe_id: r.id,
    });
    await f.api(owner, "DELETE", `/api/w/${owner.wid}/team/${editor.uid}`);
    await f.runtime.tick();
    assert.equal(
      calls,
      0,
      "removed member must fail before provider receives cached workspace input",
    );
    assert.equal(f.store.get("job", j.id).checkpoint.calls, 0);
    assert.equal(
      (await f.send(teamEditor, "GET", `/api/w/${owner.wid}/jobs/${j.id}`))
        .statusCode,
      404,
    );
  } finally {
    await f.close();
  }
});

test("resume cannot clear the pending checkpoint while the previous billable call is still running", async () => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((r) => {
      entered = r;
    }),
    released = new Promise<void>((r) => {
      release = r;
    });
  const f = await fixture({
    request: async () => {
      entered();
      await released;
      throw new Error("isolated transport lost after cancellation");
    },
  });
  try {
    const a = await f.register(),
      m = await f.material(a),
      p = await f.provider(a),
      r = await f.recipe(a, p.id, m.id, { approval: "automatic" });
    const j = await f.api(a, "POST", `/api/w/${a.wid}/jobs`, {
      kind: "process",
      recipe_id: r.id,
    });
    const running = f.runtime.tick();
    await started;
    await f.api(a, "POST", `/api/w/${a.wid}/jobs/${j.id}/pause`, {});
    const resume = await f.send(
      a,
      "POST",
      `/api/w/${a.wid}/jobs/${j.id}/resume`,
      {},
    );
    release();
    await running;
    assert.equal(
      resume.statusCode,
      409,
      "in-flight model call must settle before a paused job can resume",
    );
    assert.equal(f.store.get("job", j.id).state, "outcome_unknown");
    assert.ok(
      f.store.get("job", j.id).events.some((e: any) => e.action === "pause"),
      "settling the old worker must preserve the user pause audit event",
    );
    const unknown = await f.send(
      a,
      "POST",
      `/api/w/${a.wid}/jobs/${j.id}/resume`,
      {},
    );
    assert.equal(unknown.statusCode, 409);
    assert.equal(unknown.json().error.code, "unknown_confirmation_required");
  } finally {
    release();
    await f.close();
  }
});

test("runtime update flow discloses the frozen previous draft, creates a proposal and never auto-overwrites the target", async () => {
  let calls = 0,
    outbound: any;
  const f = await fixture({
    request: async (_url, init) => {
      calls++;
      outbound = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
      return modelResponse();
    },
  });
  try {
    const a = await f.register(),
      old = await f.material(a),
      p = await f.provider(a);
    const target = await f.api(a, "POST", `/api/w/${a.wid}/artifacts`, {
      title: "人工原稿",
      body: "来源更新前人工写作 [S1]",
      citations: [
        { material_id: old.id, revision_id: old.revision_id, label: "S1" },
      ],
    });
    const latest = await f.material(
        a,
        record("123", "新增来源证据正文", {
          captured_at: "2026-10-03T00:00:00.000Z",
        }),
      ),
      r = await f.recipe(a, p.id, latest.id, { approval: "automatic" });
    const j = await f.api(a, "POST", `/api/w/${a.wid}/jobs`, {
      kind: "process",
      recipe_id: r.id,
      target_artifact_id: target.id,
      base_revision: target.revision_id,
    });
    assert.equal(
      j.state,
      "awaiting_approval",
      "adding a previous draft requires a fresh approval even for automatic recipes",
    );
    assert.equal(j.approved, false);
    assert.equal(j.plan.previous_draft.revision_id, target.revision_id);
    assert.equal(j.plan.previous_draft.input_characters, target.body.length);
    assert.equal(j.plan.output, "proposal_without_overwrite");
    await f.runtime.tick();
    assert.equal(calls, 0);
    await f.api(a, "POST", `/api/w/${a.wid}/jobs/${j.id}/approve`, {});
    await f.runtime.tick();
    assert.equal(calls, 1);
    assert.equal(outbound.PREVIOUS_DRAFT.body, target.body);
    assert.equal(outbound.PREVIOUS_DRAFT.revision_id, target.revision_id);
    assert.equal(
      outbound.PREVIOUS_DRAFT.role,
      "untrusted_previous_draft_not_new_source",
    );
    assert.equal(outbound.SOURCES[0].text, "新增来源证据正文");
    const finished = f.store.get("job", j.id);
    assert.equal(finished.state, "completed");
    assert.equal(finished.proposal_ids.length, 1);
    assert.equal(finished.artifact_ids.length, 1);
    const unchanged = f.store.get("artifact", target.id);
    assert.equal(unchanged.body, target.body);
    assert.equal(unchanged.revision_id, target.revision_id);
    assert.equal(unchanged.revision, 1);
    const proposals = await f.api(
        a,
        "GET",
        `/api/w/${a.wid}/artifacts/${target.id}/proposals`,
      ),
      proposal = proposals[0];
    assert.equal(proposal.status, "pending");
    assert.equal(proposal.base_body, target.body);
    assert.equal(proposal.citations[0].revision_id, latest.revision_id);
    assert.equal(proposal.draft_artifact_id, finished.artifact_ids[0]);
    const adopted = await f.api(
      a,
      "POST",
      `/api/w/${a.wid}/artifacts/${target.id}/adopt`,
      { base_revision: 1, proposal_id: proposal.id },
    );
    assert.equal(adopted.revision, 2);
    assert.equal(adopted.body, proposal.body);
    assert.equal(adopted.stale, false);
    assert.equal(adopted.revisions[0].body, target.body);
  } finally {
    await f.close();
  }
});

test("editing the target during an in-flight model call preserves a conflict proposal and the newer manual revision", async () => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((r) => {
      entered = r;
    }),
    released = new Promise<void>((r) => {
      release = r;
    });
  const f = await fixture({
    request: async () => {
      entered();
      await released;
      return modelResponse();
    },
  });
  try {
    const a = await f.register(),
      m = await f.material(a),
      p = await f.provider(a),
      r = await f.recipe(a, p.id, m.id);
    const target = await f.api(a, "POST", `/api/w/${a.wid}/artifacts`, {
      title: "原稿",
      body: "生成前固定基线",
      citations: [],
    });
    const j = await f.api(a, "POST", `/api/w/${a.wid}/jobs`, {
      kind: "process",
      recipe_id: r.id,
      target_artifact_id: target.id,
      base_revision: 1,
    });
    await f.api(a, "POST", `/api/w/${a.wid}/jobs/${j.id}/approve`, {});
    const running = f.runtime.tick();
    await started;
    await f.api(a, "PATCH", `/api/w/${a.wid}/artifacts/${target.id}`, {
      base_revision: 1,
      title: "人工第二版标题",
      body: "等待期间人工修改内容",
    });
    release();
    await running;
    const final = f.store.get("job", j.id);
    assert.equal(final.state, "completed");
    const proposal = (
      await f.api(a, "GET", `/api/w/${a.wid}/artifacts/${target.id}/proposals`)
    )[0];
    assert.equal(proposal.status, "conflict");
    assert.equal(proposal.base_body, "生成前固定基线");
    assert.equal(proposal.base_revision, target.revision_id);
    const denied = await f.send(
      a,
      "POST",
      `/api/w/${a.wid}/artifacts/${target.id}/adopt`,
      { base_revision: 2, proposal_id: proposal.id },
    );
    assert.equal(denied.statusCode, 409);
    assert.equal(denied.json().error.code, "REVISION_CONFLICT");
    assert.equal(
      f.store.get("artifact", target.id).body,
      "等待期间人工修改内容",
    );
    assert.equal(f.store.get("artifact", target.id).revision, 2);
    await f.api(
      a,
      "DELETE",
      `/api/w/${a.wid}/artifacts/${target.id}/proposals/${proposal.id}`,
    );
    assert.equal(f.store.get("proposal", proposal.id).status, "rejected");
    assert.equal(f.store.get("artifact", target.id).title, "人工第二版标题");
  } finally {
    release();
    await f.close();
  }
});

test("previous drafts count toward outbound budgets and process tokens cannot add unapproved target drafts", async () => {
  let calls = 0;
  const f = await fixture({
    request: async () => {
      calls++;
      return modelResponse();
    },
  });
  try {
    const a = await f.register(),
      m = await f.material(a),
      p = await f.provider(a),
      r = await f.recipe(a, p.id, m.id, { input_limit: 1000 });
    const target = await f.api(a, "POST", `/api/w/${a.wid}/artifacts`, {
      title: "纳入预算的稿件",
      body: "X".repeat(1100),
      citations: [],
    });
    const j = await f.api(a, "POST", `/api/w/${a.wid}/jobs`, {
      kind: "process",
      recipe_id: r.id,
      target_artifact_id: target.id,
      base_revision: 1,
    });
    await f.api(a, "POST", `/api/w/${a.wid}/jobs/${j.id}/approve`, {});
    await f.runtime.tick();
    assert.equal(f.store.get("job", j.id).state, "budget_paused");
    assert.equal(calls, 0);
    assert.equal(f.store.list("proposal").length, 0);
    const token = await f.api(a, "POST", `/api/w/${a.wid}/tools-tokens`, {
      label: "bounded-process",
      scopes: ["process"],
    });
    const denied = await f.app.inject({
      method: "POST",
      url: `/api/w/${a.wid}/jobs`,
      headers: { authorization: `Bearer ${token.token}` },
      payload: {
        kind: "process",
        recipe_id: r.id,
        target_artifact_id: target.id,
        base_revision: 1,
      },
    });
    assert.equal(denied.statusCode, 403);
    assert.equal(f.store.list("job").length, 1);
    await f.api(a, "PATCH", `/api/w/${a.wid}/artifacts/${target.id}`, {
      base_revision: 1,
      body: "新稿",
    });
    const oldBase = await f.send(a, "POST", `/api/w/${a.wid}/jobs`, {
      kind: "process",
      recipe_id: r.id,
      target_artifact_id: target.id,
      base_revision: 1,
    });
    assert.equal(oldBase.statusCode, 409);
    assert.equal(f.store.list("job").length, 1);
  } finally {
    await f.close();
  }
});
