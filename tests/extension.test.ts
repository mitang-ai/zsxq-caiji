import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { build } from "esbuild";
import { chromium } from "playwright";
import { zipSync, strToU8 } from "fflate";
import {
  canonical,
  sha256,
  sourceIdentity,
  baseUrl,
  originUrl,
  providerEndpoint,
  fragmentsFor,
  makeBundle,
  validateBundle,
  csvCell,
  cleanUrl,
  bytesBase64,
  base64Bytes,
  recordOf,
  resolveReference,
  revisionRecord,
} from "../extension/browser-core";
import {
  sha256 as portableHash,
  canonical as portableCanonical,
  fragmentsFor as portableFragments,
  createBundle,
  recordVersionHash,
} from "../shared/transfer";
import { nextMaterial, mergeJobEvents } from "../extension/database";
import {
  parseSourceJson,
  sourceHeaders,
  normalizeTopic,
  answerRecord,
  commentRecord,
} from "../shared/zsxq";
import {
  sourcePath,
  pageIdentity,
  withinScope,
  returnedComments,
} from "../extension/source";
import {
  encryptSecrets,
  decryptSecrets,
  secret,
  setSecret,
  lock,
  unlock,
  eraseVault,
} from "../extension/vault";
import {
  grantOrigin,
  generate,
  modelText,
  readArtifactOutput,
  inspectArtifactOutput,
  reserveBillableAttempt,
  preserveEditedDraft,
  presets,
} from "../extension/ai";
import { readArchive, assertNoCredentials } from "../extension/archive";
import type {
  Material,
  Provider,
  Scope,
  SourceRecord,
  Artifact,
} from "../extension/types";

const runtime: Record<string, any> = {},
  persistent: Record<string, any> = {};
let permissions = new Set<string>(),
  requested: string[][] = [];
const area = (values: Record<string, any>) => ({
  get: async (key: string) => ({ [key]: values[key] }),
  set: async (data: any) => {
    Object.assign(values, structuredClone(data));
  },
  remove: async (key: string) => {
    delete values[key];
  },
});
(globalThis as any).chrome = {
  storage: { session: area(runtime), local: area(persistent) },
  permissions: {
    contains: async ({ origins }: any) =>
      origins.every((s: string) => permissions.has(s)),
    request: async ({ origins }: any) => {
      requested.push(origins);
      origins.forEach((s: string) => permissions.add(s));
      return true;
    },
  },
};
const provider: Provider = {
  id: "test-provider",
  label: "Offline test",
  protocol: "chat",
  base_url: "https://models.example.test/v1",
  model: "exact-model",
  models: [],
  remember: false,
};
const rawTopic = {
  topic_id: "12345678901234567890",
  group: { group_id: "666" },
  create_time: "2026-10-01T10:00:00Z",
  talk: {
    owner: { user_id: "111", name: "林舟" },
    text: "内容产品先留下来源，再形成理解。\n\n讨论不能都归属主帖作者。",
  },
  counts: { comments: 2 },
};
const record = (): SourceRecord => normalizeTopic(rawTopic, "666");
const material = async (): Promise<Material> => {
  const r = record();
  return {
    ...r,
    id: "m-synthetic",
    revision_id: "rev1",
    revisions: [],
    tags: [],
    status: "unread",
    starred: false,
  };
};

test("extension crypto and canonical format match TransferBundle v1", async () => {
  for (const s of ["", "abc", "中文与📝", "x".repeat(4097)])
    assert.equal(await sha256(s), portableHash(s));
  const value = {
    z: undefined,
    b: [undefined, null, { b: 2, a: 1 }],
    a: "原文",
  };
  assert.equal(canonical(value), portableCanonical(value));
  assert.deepEqual(
    await fragmentsFor(record().text),
    portableFragments(record().text),
  );
});
test("stable identity includes planet and entity type, never display name", () => {
  const a = record().source_key;
  assert.notEqual(sourceIdentity(a), sourceIdentity({ ...a, group_id: "777" }));
  assert.notEqual(
    sourceIdentity(a),
    sourceIdentity({ ...a, entity_type: "comment" }),
  );
});
test("provider endpoints preserve user model protocol and exact origin", async () => {
  permissions.clear();
  requested = [];
  await grantOrigin("https://models.example.test/v1/");
  assert.deepEqual(requested, [["https://models.example.test/*"]]);
  assert.equal(
    providerEndpoint(provider.base_url, "chat"),
    "https://models.example.test/v1/chat/completions",
  );
  assert.equal(
    providerEndpoint(provider.base_url, "responses"),
    "https://models.example.test/v1/responses",
  );
  assert.equal(
    providerEndpoint(provider.base_url, "anthropic"),
    "https://models.example.test/v1/messages",
  );
  assert.equal(baseUrl("http://127.0.0.1:1234/v1"), "http://127.0.0.1:1234/v1");
  for (const url of [
    "http://remote.test/v1",
    "https://user:pass@host/v1",
    "https://host/v1?key=abc",
    "file:///etc",
  ])
    assert.throws(() => baseUrl(url));
  assert.throws(() => originUrl("https://work.test/path"));
});
test("source business routes reject injected IDs and pagination fields are bounded", () => {
  assert.throws(() =>
    sourcePath({ operation: "topics", group_id: "666/../../users" }),
  );
  assert.throws(() =>
    sourcePath({
      operation: "article",
      article_id: "id?url=https://evil.test",
    }),
  );
  assert.throws(() =>
    sourcePath({ operation: "fileDownload", file_id: "12?other=1" }),
  );
  const u = new URL(
    sourcePath({
      operation: "comments",
      topic_id: "123",
      index: "next value",
      count: 999,
    }),
    "https://api.zsxq.com",
  );
  assert.equal(u.searchParams.get("count"), "30");
  assert.equal(u.searchParams.get("sort_type"), "by_interactions_count");
  assert.equal(u.searchParams.get("with_sticky"), "false");
  assert.equal(u.searchParams.get("index"), "next value");
  assert.equal(
    sourcePath({ operation: "article", article_id: "a-b" }),
    "/v2/articles/a-b",
  );
});
test("page identity only trusts the intended source origin", () => {
  assert.deepEqual(pageIdentity("https://wx.zsxq.com/group/666"), {
    group_id: "666",
    topic_id: undefined,
  });
  assert.equal(
    pageIdentity("https://wx.zsxq.com/topic/12345678901234567890").topic_id,
    "12345678901234567890",
  );
  assert.throws(() => pageIdentity("https://evil.test/group/666"));
  assert.throws(() => pageIdentity("https://wx.zsxq.com.evil.test/topic/123"));
});
test("active source JSON retains 16+ digit IDs without altering text or numeric measurements", () => {
  const a = parseSourceJson(
    '{"id":12345678901234567890,"message":"id 12345678901234567890 \\\"quoted\\\"","size":42,"decimal":1.25,"exponent":1e17}',
  );
  assert.equal(a.id, "12345678901234567890");
  assert.equal(a.message, 'id 12345678901234567890 "quoted"');
  assert.equal(a.size, 42);
  assert.equal(a.decimal, 1.25);
  assert.equal(a.exponent, 1e17);
});
test("source signature matches live served canonical SHA1 scheme", async () => {
  const url = "https://api.zsxq.com/v2/groups/666/topics?keyword='quote'";
  const h = await sourceHeaders(url);
  const input = new TextEncoder().encode(
    `${url.replace(/'/g, "%27")} ${h["X-Timestamp"]} ${h["X-Request-Id"]}`,
  );
  const expected = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-1", input)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  assert.equal(h["X-Signature"], expected);
  assert.equal(h["X-Version"], "2.96.0");
  assert.match(h["X-Timestamp"], /^\d{10}$/);
});
test("answers and comments preserve real author and parent topic independently", () => {
  const a = answerRecord(
    {
      ...rawTopic,
      answer: { owner: { user_id: "222", name: "周澄" }, text: "回答原文" },
    },
    "666",
  )!;
  const c = commentRecord(
    {
      comment_id: "900",
      owner: { user_id: "333", name: "李宁" },
      text: "讨论内容",
      create_time: "2026-10-02T00:00:00Z",
    },
    rawTopic.topic_id,
    "666",
  );
  assert.equal(a.author_id, "222");
  assert.equal(a.source_key.entity_type, "answer");
  assert.equal(a.parent_entity_id, rawTopic.topic_id);
  assert.equal(c.author_id, "333");
  assert.equal(c.parent_entity_id, rawTopic.topic_id);
  assert.equal(c.coverage.comments, "partial");
  assert.equal(a.source_url, "https://wx.zsxq.com/topic/" + rawTopic.topic_id);
  assert.throws(() => normalizeTopic(rawTopic, "777"));
});
test("author scope only accepts current planet stable author ID with exact time bounds", () => {
  const scope: Scope = {
    group_id: "666",
    author_id: "111",
    from: "2026-10-01T09:00:00+00:00",
    to: "2026-10-01T11:00:00Z",
    types: ["topic"],
    max_pages: 2,
    include_comments: false,
    include_attachments: false,
  };
  assert.equal(withinScope(record(), scope), true);
  assert.equal(withinScope({ ...record(), author_id: "222" }, scope), false);
  assert.equal(withinScope({ ...record(), group_id: "777" }, scope), false);
  assert.equal(
    withinScope({ ...record(), created_at: "not-a-date" }, scope),
    false,
  );
});
test("bundle strips private fields, preserves citation labels and reports client provenance", async () => {
  const m = await material();
  const a: Artifact = {
    id: "artifact",
    title: "可执行要点",
    body: "先固定来源 [S3]",
    citations: [
      {
        citation_id: "S3",
        material_id: m.id,
        revision_id: m.revision_id,
        fragment_id: m.fragments[0].id,
        source_key: m.source_key,
        quote: m.fragments[0].text,
        source_url: m.source_url,
      },
    ],
    revision: 1,
    revisions: [],
    status: "draft",
    created_at: "2026-10-03T00:00:00Z",
    updated_at: "2026-10-03T00:00:00Z",
  };
  const bundle = await makeBundle(
    [{ ...record(), api_key: "synthetic-never-export" } as SourceRecord],
    [],
    [a],
  );
  assert.equal(
    JSON.stringify(bundle).includes("synthetic-never-export"),
    false,
  );
  assert.equal(bundle.artifacts[0].citations[0].citation_id, "S3");
  assert.equal(bundle.coverage.provenance_verification, "client_reported");
  assert.deepEqual(await validateBundle(bundle), bundle);
  const tampered = structuredClone(bundle);
  tampered.records[0].text += "changed";
  await assert.rejects(() => validateBundle(tampered));
});
test("portable records preserve file metadata and parent identity, not signed URL", async () => {
  const m = await material();
  m.parent_entity_id = "123";
  m.files = [{ id: "90", name: "清单.pdf", size: 42 }];
  assert.deepEqual(recordOf(m).files, m.files);
  assert.equal(recordOf(m).parent_entity_id, "123");
  const b = createBundle({
    records: [
      { ...record(), source_url: record().source_url + "?token=secret" },
    ],
  });
  await assert.rejects(() => validateBundle(b));
});
test("CSV and exported source links cannot inject spreadsheet formulas or credentials", () => {
  assert.equal(csvCell('=HYPERLINK("a")'), '"\'=HYPERLINK(""a"")"');
  assert.equal(csvCell("  @SUM(1)"), '"\'  @SUM(1)"');
  assert.equal(
    cleanUrl("https://wx.zsxq.com/topic/1?token=x#private"),
    "https://wx.zsxq.com/topic/1",
  );
  assert.equal(cleanUrl("javascript:alert(1)"), "");
  const bytes = Uint8Array.from([0, 1, 255, 128]);
  assert.deepEqual(base64Bytes(bytesBase64(bytes)), bytes);
});
test("AES-GCM remembered credentials encrypt at rest and fail closed with wrong passphrase", async () => {
  const cipher = await encryptSecrets(
    { "provider:test": "synthetic-secret" },
    "offline-passphrase",
  );
  assert.equal(JSON.stringify(cipher).includes("synthetic-secret"), false);
  assert.deepEqual(await decryptSecrets(cipher, "offline-passphrase"), {
    "provider:test": "synthetic-secret",
  });
  await assert.rejects(() => decryptSecrets(cipher, "wrong-passphrase"));
  await assert.rejects(() => encryptSecrets({}, "short"));
});
test("session default and remembered vault require explicit unlock after restart", async () => {
  await eraseVault();
  await setSecret("provider:test", "session-only");
  assert.equal(await secret("provider:test"), "session-only");
  assert.deepEqual(persistent, {});
  await lock();
  assert.equal(await secret("provider:test"), "");
  await setSecret("provider:test", "remembered", true, "offline-passphrase");
  assert.equal(JSON.stringify(persistent).includes("remembered"), false);
  await lock();
  assert.equal(await secret("provider:test"), "");
  assert.equal(await unlock("offline-passphrase"), 1);
  assert.equal(await secret("provider:test"), "remembered");
  await eraseVault();
});
test("three model protocols distinguish normal completion from truncation", () => {
  assert.equal(
    modelText(
      {
        choices: [{ message: { content: "answer" }, finish_reason: "length" }],
      },
      "chat",
    ).complete,
    false,
  );
  assert.equal(
    modelText(
      {
        choices: [{ message: { content: "answer" }, finish_reason: "length" }],
      },
      "chat",
    ).truncated,
    true,
  );
  assert.equal(
    modelText(
      {
        status: "completed",
        output: [{ content: [{ type: "output_text", text: "answer" }] }],
      },
      "responses",
    ).complete,
    true,
  );
  assert.equal(
    modelText(
      {
        content: [{ type: "text", text: "answer" }],
        stop_reason: "max_tokens",
      },
      "anthropic",
    ).truncated,
    true,
  );
  assert.deepEqual(
    readArtifactOutput(
      '```json\n{"title":"结论","body":"内容 [S2]","citations":["S2"]}\n```',
    ),
    { title: "结论", body: "内容 [S2]", citations: ["S2"] },
  );
  assert.equal(presets.length, 12);
});
test("billable unknown network outcome makes one call and never retries or changes provider", async () => {
  permissions.add("https://models.example.test/*");
  await setSecret("provider:" + provider.id, "synthetic-model-key");
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("lost connection");
  };
  try {
    await assert.rejects(
      () => generate(provider, "test", 64),
      (error: any) => error.unknown === true,
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
    await lock();
  }
});
test("direct model transport sends no cookies and honours exact model and host", async () => {
  await setSecret("provider:" + provider.id, "synthetic-model-key");
  const original = globalThis.fetch;
  let request: any;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response(
      JSON.stringify({
        model: "server-model",
        choices: [{ message: { content: "OK" }, finish_reason: "stop" }],
      }),
      { status: 200 },
    );
  };
  try {
    const out = await generate(provider, "test", 64);
    assert.equal(
      request.url,
      "https://models.example.test/v1/chat/completions",
    );
    assert.equal(request.options.credentials, "omit");
    assert.equal(request.options.redirect, "error");
    assert.equal(JSON.parse(request.options.body).model, "exact-model");
    assert.equal(out.complete, true);
  } finally {
    globalThis.fetch = original;
    await lock();
  }
});
test("archive extraction refuses oversized inflated entries and unknown paths", () => {
  const zip = zipSync({
    "bundle.json": strToU8("{}"),
    "../../escape": strToU8("bad"),
  });
  assert.deepEqual(Object.keys(readArchive(zip)), ["bundle.json"]);
  const large = zipSync(
    { "local-state.json": new Uint8Array(51 * 1024 * 1024) },
    { level: 1 },
  );
  assert.throws(() => readArchive(large), /上限/);
  assert.throws(
    () => assertNoCredentials({ providers: [{ api_key: "do-not-import" }] }),
    /凭据/,
  );
  assert.doesNotThrow(() =>
    assertNoCredentials({ text: "API Key 写在这段资料里", max_tokens: 100 }),
  );
});
test("actual Chrome and Edge release manifests are identical and do not grant silent hosts", () => {
  execFileSync(process.execPath, ["extension/build.mjs"], {
    cwd: process.cwd(),
    stdio: "pipe",
  });
  const read = (browser: string) =>
    JSON.parse(
      readFileSync("extension/dist/" + browser + "/manifest.json", "utf8"),
    );
  const chrome = read("chrome"),
    edge = read("edge");
  assert.deepEqual(chrome, edge);
  assert.equal(chrome.manifest_version, 3);
  assert.deepEqual(chrome.permissions, [
    "storage",
    "sidePanel",
    "activeTab",
    "scripting",
  ]);
  assert.equal(chrome.host_permissions, undefined);
  assert.equal(chrome.externally_connectable, undefined);
  assert.equal(chrome.content_scripts, undefined);
  for (const browser of ["chrome", "edge"]) {
    const worker = readFileSync(
      "extension/dist/" + browser + "/background.js",
      "utf8",
    );
    assert.equal(worker.includes("chrome.cookies"), false);
    assert.equal(worker.includes("chrome.debugger"), false);
    assert.equal(worker.includes("chrome.storage.sync"), false);
    assert.match(worker, /source_origin_changed/);
    assert.match(worker, /source_binary_route_rejected/);
    assert.equal(worker.includes("onMessageExternal"), false);
  }
});
test("coverage-only and title-only changes append immutable full source revisions", async () => {
  const first = await nextMaterial(record());
  const second = await nextMaterial(
    {
      ...record(),
      coverage: {
        ...record().coverage,
        body: "partial",
        reasons: ["详情缺失"],
      },
    },
    first,
  );
  const third = await nextMaterial({ ...record(), title: "新标题" }, second);
  assert.equal(second.revisions.length, 2);
  assert.equal(third.revisions.length, 3);
  assert.notEqual(first.version_hash, second.version_hash);
  assert.notEqual(second.version_hash, third.version_hash);
  assert.equal(third.revisions[0].record?.coverage.body, "complete");
  assert.equal(third.revisions[1].record?.coverage.body, "partial");
  assert.equal(third.revisions[0].hash, third.revisions[2].hash);
  const again = await nextMaterial(
    { ...record(), captured_at: "2030-01-01T00:00:00Z" },
    third,
  );
  assert.equal(again.revisions.length, 3);
  assert.equal(again.revision_id, first.revision_id);
});
test("self-contained portable references carry exact historical records and text-hash compatibility", async () => {
  const first = await nextMaterial(record()),
    head = await nextMaterial(
      {
        ...record(),
        title: "已更新标题",
        coverage: {
          ...record().coverage,
          body: "partial",
          reasons: ["更新中"],
        },
      },
      first,
    );
  const annotation = {
    id: "note",
    material_id: first.id,
    revision_id: first.revision_id,
    start: 0,
    end: 2,
    quote: first.text.slice(0, 2),
    note: "理解",
    kind: "note" as const,
    created_at: "2026-10-03T00:00:00Z",
  };
  const art: Artifact = {
    id: "historic-artifact",
    title: "原始结论",
    body: "固定引用 [S8]",
    citations: [
      {
        citation_id: "S8",
        material_id: first.id,
        revision_id: first.revision_id,
        source_key: first.source_key,
        quote: first.text,
        source_url: first.source_url,
      },
    ],
    revision: 1,
    revisions: [],
    status: "draft",
    created_at: first.captured_at,
    updated_at: first.captured_at,
  };
  const bundle = await makeBundle(
    [recordOf(head)],
    [annotation],
    [art],
    [],
    { [head.id]: head.source_key },
    [head],
  );
  assert.equal(bundle.records.length, 2);
  assert.equal(bundle.records[0].title, first.title);
  assert.equal(bundle.records.at(-1)?.title, head.title);
  assert.equal(bundle.artifacts[0].citations[0].revision_id, first.hash);
  assert.equal(
    bundle.artifacts[0].citations[0].version_hash,
    first.version_hash,
  );
  assert.equal(bundle.annotations[0].version_hash, first.version_hash);
  await validateBundle(bundle);
  let imported: Material | undefined;
  for (const r of bundle.records) imported = await nextMaterial(r, imported);
  const fixed = resolveReference(bundle.artifacts[0].citations[0], [imported!]);
  assert.notEqual(fixed.revision.id, first.revision_id);
  assert.notEqual(fixed.revision.id, imported!.revision_id);
  assert.equal(fixed.record.version_hash, first.version_hash);
  assert.equal(fixed.record.title, first.title);
});
test("legacy text hashes reject same-body metadata ambiguity, while full hashes resolve exactly", async () => {
  const first = await nextMaterial(record()),
    head = await nextMaterial({ ...record(), title: "另一个标题" }, first);
  const ref = {
    material_id: head.id,
    revision_id: first.hash!,
    source_key: head.source_key,
    quote: head.text,
  };
  assert.throws(() => resolveReference(ref, [head]), /歧义/);
  assert.equal(
    resolveReference({ ...ref, version_hash: first.version_hash }, [head])
      .revision.id,
    first.revision_id,
  );
  assert.equal(
    resolveReference({ ...ref, revision_id: first.version_hash! }, [head])
      .revision.id,
    first.revision_id,
  );
  assert.equal(
    resolveReference({ ...ref, revision_id: first.revision_id }, [head])
      .revision.id,
    first.revision_id,
  );
  assert.throws(
    () => resolveReference({ ...ref, version_hash: "f".repeat(64) }, [head]),
    /未找到/,
  );
});
test("full version integrity includes author, fragments and attachments but excludes capture timestamps", async () => {
  const r = record();
  assert.equal(
    recordVersionHash(r),
    recordVersionHash({ ...r, captured_at: "future", hash: "a".repeat(64) }),
  );
  assert.notEqual(
    recordVersionHash(r),
    recordVersionHash({ ...r, author_name: "作者新名" }),
  );
  assert.notEqual(
    recordVersionHash(r),
    recordVersionHash({ ...r, files: [{ id: "1", name: "新增.pdf" }] }),
  );
  const imported = await nextMaterial({
    ...r,
    fragments: r.fragments.map((f) => ({ ...f, id: "legacy-" + f.id })),
  });
  assert.equal(
    imported.version_hash,
    recordVersionHash({
      ...r,
      fragments: r.fragments.map((f) => ({ ...f, id: "legacy-" + f.id })),
    }),
  );
  const b = createBundle({ records: [{ ...r, version_hash: "f".repeat(64) }] });
  await assert.rejects(() => validateBundle(b), /version_hash/);
});
test("returned child comments are archived only from actual recognizable nodes, deduplicated with real authors", () => {
  const child = {
      comment_id: "11",
      owner: { user_id: "222", name: "回复作者" },
      text: "真实返回的子回复",
    },
    rows = returnedComments([
      {
        comment_id: "10",
        owner: { user_id: "111", name: "父评论作者", unrelated: [child] },
        text: "父评论",
        observed_child_array: [child],
        some_count: 10,
      },
      child,
      { comment_id: "12", owner: { user_id: "333" }, not_text: "未识别结构" },
    ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].comment.owner.user_id, "222");
  assert.equal(rows[1].parent_comment_id, "10");
  assert.equal(rows[1].depth, 1);
  assert.match(rows[1].path, /observed_child_array/);
  assert.equal(
    rows.some((r) => r.comment.comment_id === "12"),
    false,
  );
});
test("self-contained records do not claim attachment completeness when originals are omitted", async () => {
  const r = {
    ...record(),
    files: [{ id: "file", name: "原文附件.pdf" }],
    coverage: { ...record().coverage, attachments: "complete" as const },
  };
  const bundle = await makeBundle([r]);
  assert.equal(bundle.coverage.attachments, "partial");
  assert.equal(bundle.coverage.attachments_omitted, true);
});
test("trusted background image route derives original URL from a fixed topic and preserves big image IDs", async () => {
  const savedChrome = (globalThis as any).chrome,
    savedLocation = (globalThis as any).location,
    savedFetch = globalThis.fetch;
  let listener: any;
  const fetched: string[] = [];
  const imageId = "12345678901234567890";
  (globalThis as any).location = { origin: "https://wx.zsxq.com" };
  (globalThis as any).chrome = {
    runtime: {
      id: "offline-extension",
      getURL: (s: string) => "chrome-extension://offline-extension/" + s,
      onInstalled: { addListener: () => {} },
      onMessage: {
        addListener: (fn: any) => {
          listener = fn;
        },
      },
    },
    sidePanel: { setPanelBehavior: async () => {} },
    tabs: {
      query: async () => [
        { id: 1, url: "https://wx.zsxq.com/topic/123", active: true },
      ],
    },
    scripting: {
      executeScript: async (options: any) => [
        { result: await options.func(...options.args) },
      ],
    },
  };
  globalThis.fetch = async (url, options) => {
    fetched.push(String(url));
    if (String(url).startsWith("https://api.zsxq.com/v2/topics/123/info")) {
      assert.equal(options?.credentials, "include");
      return new Response(
        '{"succeeded":true,"resp_data":{"topic":{"talk":{"images":[{"image_id":' +
          imageId +
          ',"original":{"url":"https://images.zsxq.com/original.png?signature=synthetic"}}]}}}}',
      );
    }
    assert.equal(
      String(url),
      "https://images.zsxq.com/original.png?signature=synthetic",
    );
    assert.equal(options?.credentials, "omit");
    return new Response(Uint8Array.from([1, 2, 3]), {
      headers: { "content-type": "image/png" },
    });
  };
  try {
    await import("../extension/background");
    const send = (
      message: any,
      sender: any = {
        id: "offline-extension",
        url: "chrome-extension://offline-extension/workbench.html",
      },
    ) => new Promise<any>((resolve) => listener(message, sender, resolve));
    const rejected = await send(
      {
        type: "source-image",
        request: { operation: "detail", topic_id: "123", image_id: imageId },
      },
      { id: "offline-extension", url: "https://evil.test" },
    );
    assert.equal(rejected.ok, false);
    assert.equal(fetched.length, 0);
    const result = await send({
      type: "source-image",
      request: {
        operation: "detail",
        topic_id: "123",
        image_id: imageId,
        url: "https://evil.test/steal",
      },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(
      base64Bytes(result.binary.data),
      Uint8Array.from([1, 2, 3]),
    );
    assert.equal(JSON.stringify(result).includes("signature="), false);
    assert.equal(fetched.length, 2);
    const bad = await send({
      type: "source-image",
      request: {
        operation: "detail",
        topic_id: "123/../other",
        image_id: imageId,
      },
    });
    assert.equal(bad.ok, false);
    assert.equal(fetched.length, 2);
  } finally {
    (globalThis as any).chrome = savedChrome;
    (globalThis as any).location = savedLocation;
    globalThis.fetch = savedFetch;
  }
});
test("billable reservation counts unknown attempts and synthesis without exceeding budget", () => {
  const c = { max_calls: 2, attempts_used: 0, attempt_log: [] } as any;
  assert.equal(reserveBillableAttempt(c, "batch:1"), 1);
  c.inflight = false;
  c.attempt_log[0].state = "unknown";
  assert.equal(reserveBillableAttempt(c, "synthesis"), 2);
  assert.throws(
    () => reserveBillableAttempt(c, "explicit-retry"),
    /预算已耗尽/,
  );
  assert.equal(c.attempts_used, 2);
  assert.equal(c.attempt_log.length, 2);
});
test("unsupported paid output cannot be treated as complete and manual draft histories remain untouched", () => {
  for (const text of [
    "null",
    '{"title":"","body":"内容 [S1]","citations":["S1"]}',
    '{"title":"报告","body":"内容 [S1]","citations":[{"id":"S1"}]}',
  ])
    assert.ok(inspectArtifactOutput(text).issues.length);
  const edited: Artifact = {
    id: "edited",
    title: "人工标题",
    body: "人工内容",
    revision: 2,
    revisions: [{ revision: 1, title: "旧稿", body: "旧内容", at: "old" }],
    status: "draft",
    citations: [],
    created_at: "old",
    updated_at: "new",
  };
  const snapshot = structuredClone(edited),
    proposal = preserveEditedDraft({ ...edited, body: "模型后续结果" }, edited);
  assert.notEqual(proposal.id, edited.id);
  assert.deepEqual(edited, snapshot);
  assert.equal(edited.revisions.length, 1);
  assert.equal(proposal.revision, 1);
  assert.deepEqual(
    mergeJobEvents(
      [{ at: "a", message: "旧事件" }],
      [{ at: "b", message: "暂停事件" }],
      [
        { at: "a", message: "旧事件" },
        { at: "c", message: "settle事件" },
      ],
    ).map((e) => e.message),
    ["旧事件", "暂停事件", "settle事件"],
  );
});
test(
  "isolated Chrome real IndexedDB settles paused calls, guards budgets, and preserves edited paid drafts",
  { timeout: 60000 },
  async () => {
    const compiled = await build({
        stdin: {
          contents:
            "import * as ai from './extension/ai';import * as db from './extension/database';import * as vault from './extension/vault';import * as transfer from './shared/transfer';globalThis.fixture={ai,db,vault,transfer};",
          resolveDir: process.cwd(),
          sourcefile: "synthetic-indexeddb-fixture.ts",
        },
        bundle: true,
        write: false,
        format: "iife",
        platform: "browser",
        target: "chrome120",
      }),
      js = compiled.outputFiles[0].text;
    const server = createServer((req, res) => {
      res.setHeader(
        "Content-Type",
        req.url === "/fixture.js" ? "application/javascript" : "text/html",
      );
      res.end(
        req.url === "/fixture.js"
          ? js
          : '<!doctype html><script src="/fixture.js"></script>',
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      browser = await chromium.launch({ channel: "chrome", headless: true });
      const page = await browser.newPage();
      await page.addInitScript("globalThis.__name=(fn)=>fn;");
      await page.goto("http://127.0.0.1:" + (server.address() as any).port);
      await page.waitForFunction(() => !!(globalThis as any).fixture);
      const result = await page.evaluate(async () => {
        const { ai, db, vault, transfer } = (globalThis as any).fixture,
          storage: Record<string, any> = {};
        (globalThis as any).chrome = {
          permissions: { contains: async () => true },
          storage: {
            session: {
              get: async (k: string) => ({ [k]: storage[k] }),
              set: async (v: any) => Object.assign(storage, structuredClone(v)),
              remove: async (k: string) => {
                delete storage[k];
              },
            },
          },
        };
        const provider = {
          id: "isolated-provider",
          label: "Fixture",
          protocol: "chat",
          base_url: "https://models.example.test/v1",
          model: "fixture-model",
          models: [],
          remember: false,
        };
        let calls = 0;
        const clear = async () => {
          const database = await db.openDatabase();
          await new Promise<void>((resolve, reject) => {
            const transaction = database.transaction(db.STORES, "readwrite");
            for (const name of db.STORES) transaction.objectStore(name).clear();
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
          });
          await db.put("providers", provider);
          await vault.setSecret("provider:" + provider.id, "synthetic-only");
          calls = 0;
        };
        const plan = async (maxCalls: number, text = "材料原文") => {
          const r = {
            source_key: {
              platform: "zsxq",
              group_id: "666",
              entity_type: "topic",
              entity_id: "123",
            },
            group_id: "666",
            author_id: "111",
            author_name: "测试作者",
            title: "隔离测试",
            text,
            created_at: "2026-10-03T00:00:00Z",
            source_url: "https://wx.zsxq.com/topic/123",
            coverage: {
              body: "complete",
              comments: "complete",
              attachments: "complete",
              reasons: [],
            },
            captured_at: "2026-10-03T00:00:00Z",
            fragments: transfer.fragmentsFor(text),
          };
          const material = await db.ingest(r);
          return ai.planAnalysis(
            [material],
            provider,
            "deep-read",
            "",
            2000,
            maxCalls,
            64,
          );
        };
        const response = (
          text = JSON.stringify({
            title: "测试结论",
            body: "结论 [S1]",
            citations: ["S1"],
          }),
          finish = "stop",
        ) =>
          new Response(
            JSON.stringify({
              model: "fixture-model",
              choices: [{ message: { content: text }, finish_reason: finish }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        await clear();
        let job = await plan(1);
        globalThis.fetch = async () => {
          calls++;
          return new Response("unknown", { status: 500 });
        };
        await ai.runAnalysis(job.id);
        const unknown = await db.get("jobs", job.id);
        await ai.runAnalysis(job.id, () => {}, true);
        const exhausted = await db.get("jobs", job.id);
        const first = {
          calls,
          status: unknown.status,
          unresolved: unknown.checkpoint.unresolved_attempt,
          attempts: exhausted.checkpoint.attempts_used,
          reason: exhausted.reason,
        };
        await clear();
        job = await plan(3, "a".repeat(2000));
        globalThis.fetch = async () => {
          calls++;
          return calls === 3
            ? new Response("unknown", { status: 503 })
            : response();
        };
        await ai.runAnalysis(job.id);
        const synthesis = await db.get("jobs", job.id);
        await ai.runAnalysis(job.id, () => {}, true);
        const second = {
          calls,
          status: synthesis.status,
          attempts: synthesis.checkpoint.attempts_used,
          stages: synthesis.checkpoint.attempt_log.map((a: any) => a.stage),
        };
        await clear();
        job = await plan(3, "b".repeat(2000));
        globalThis.fetch = async () => {
          calls++;
          return response(undefined, calls === 1 ? "length" : "stop");
        };
        await ai.runAnalysis(job.id);
        const partial = await db.get("jobs", job.id),
          old = await db.get("artifacts", partial.artifact_id);
        await db.updateArtifact(old.id, old.revision, {
          body: "不可覆盖的人工稿",
        });
        await ai.runAnalysis(job.id);
        const resumed = await db.get("jobs", job.id),
          preserved = await db.get("artifacts", old.id),
          proposal = await db.get("artifacts", resumed.artifact_id);
        const third = {
          calls,
          old_id: old.id,
          new_id: proposal.id,
          body: preserved.body,
          revision: preserved.revision,
          history: preserved.revisions.length,
          status: resumed.status,
        };
        await clear();
        job = await plan(1);
        let release: (() => void) | undefined;
        globalThis.fetch = () => {
          calls++;
          return new Promise<Response>((resolve) => {
            release = () => resolve(response());
          });
        };
        const running = ai.runAnalysis(job.id);
        for (let n = 0; n < 200 && !release; n++)
          await new Promise((r) => setTimeout(r, 5));
        if (!release) throw new Error("fixture request did not start");
        await db.controlJob(job.id, "paused");
        let blocked = false;
        try {
          await ai.runAnalysis(job.id);
        } catch {
          blocked = true;
        }
        await db.appendEvent(await db.get("jobs", job.id), "另一页面事件");
        release();
        await running;
        const settled = await db.get("jobs", job.id);
        await ai.runAnalysis(job.id);
        const finished = await db.get("jobs", job.id);
        const fourth = {
          calls,
          blocked,
          paused: settled.status,
          next: settled.checkpoint.next_batch,
          final: finished.status,
          attempts: finished.checkpoint.attempts_used,
          events: finished.events.map((e: any) => e.message),
        };
        await clear();
        job = await plan(2);
        release = undefined;
        globalThis.fetch = () => {
          calls++;
          return new Promise<Response>((resolve) => {
            release = () => resolve(new Response("unknown", { status: 500 }));
          });
        };
        const pausedUnknownRun = ai.runAnalysis(job.id);
        for (let n = 0; n < 200 && !release; n++)
          await new Promise((r) => setTimeout(r, 5));
        if (!release) throw new Error("unknown fixture did not start");
        await db.controlJob(job.id, "paused");
        (release as unknown as () => void)();
        await pausedUnknownRun;
        const pausedUnknown = await db.get("jobs", job.id);
        let requiredConsent = false;
        try {
          await ai.runAnalysis(job.id);
        } catch {
          requiredConsent = true;
        }
        globalThis.fetch = async () => {
          calls++;
          return response();
        };
        await ai.runAnalysis(job.id, () => {}, true);
        const accepted = await db.get("jobs", job.id);
        const fifth = {
          paused: pausedUnknown.status,
          unknown: pausedUnknown.checkpoint.unresolved_attempt,
          requiredConsent,
          calls,
          attempts: accepted.checkpoint.attempts_used,
        };
        await clear();
        job = await plan(2);
        ai.reserveBillableAttempt(job.checkpoint, "batch:1");
        await db.put("jobs", job);
        await db.controlJob(job.id, "paused");
        await ai.recoverInterruptedJobs();
        const recovered = await db.get("jobs", job.id);
        let recoveryConsent = false;
        try {
          await ai.runAnalysis(job.id);
        } catch {
          recoveryConsent = true;
        }
        const sixth = {
          unknown: recovered.checkpoint.unresolved_attempt,
          recoveryConsent,
          calls,
        };
        await clear();
        job = await plan(1);
        delete job.checkpoint.attempts_used;
        delete job.checkpoint.attempt_log;
        job.status = "unknown";
        job.events = [
          {
            at: "2026-10-03T00:00:00Z",
            message:
              "发送第 1/1 批到 https://models.example.test / fixture-model。",
          },
        ];
        await db.put("jobs", job);
        globalThis.fetch = async () => {
          calls++;
          return response();
        };
        await ai.runAnalysis(job.id, () => {}, true);
        const legacy = await db.get("jobs", job.id);
        const seventh = {
          calls,
          attempts: legacy.checkpoint.attempts_used,
          reason: legacy.reason,
        };
        await clear();
        const malformed = [];
        for (const text of [
          "null",
          '{"title":"","body":"内容 [S1]","citations":["S1"]}',
          '{"title":"报告","body":"内容 [S1]","citations":[{"id":"S1"}]}',
        ]) {
          job = await plan(1);
          globalThis.fetch = async () => {
            calls++;
            return response(text);
          };
          await ai.runAnalysis(job.id);
          const saved = await db.get("jobs", job.id),
            artifact = await db.get("artifacts", saved.artifact_id);
          malformed.push({
            status: saved.status,
            complete: artifact.model_attribution.complete,
            retained: artifact.body.includes(text),
          });
        }
        return {
          first,
          second,
          third,
          fourth,
          fifth,
          sixth,
          seventh,
          malformed,
        };
      });
      assert.deepEqual(result.first.calls, 1);
      assert.equal(result.first.status, "unknown");
      assert.equal(result.first.unresolved, true);
      assert.equal(result.first.attempts, 1);
      assert.match(result.first.reason, /预算已耗尽/);
      assert.equal(result.second.calls, 3);
      assert.equal(result.second.status, "unknown");
      assert.equal(result.second.attempts, 3);
      assert.equal(result.second.stages.at(-1), "synthesis");
      assert.equal(result.third.calls, 2);
      assert.notEqual(result.third.old_id, result.third.new_id);
      assert.equal(result.third.body, "不可覆盖的人工稿");
      assert.equal(result.third.revision, 2);
      assert.equal(result.third.history, 1);
      assert.equal(result.third.status, "partial");
      assert.equal(result.fourth.calls, 1);
      assert.equal(result.fourth.blocked, true);
      assert.equal(result.fourth.paused, "paused");
      assert.equal(result.fourth.next, 1);
      assert.equal(result.fourth.final, "complete");
      assert.equal(result.fourth.attempts, 1);
      assert.ok(result.fourth.events.includes("另一页面事件"));
      assert.ok(
        result.fourth.events.some((e: string) => e.includes("用户暂停")),
      );
      assert.ok(
        result.fourth.events.some((e: string) => e.includes("响应已保存")),
      );
      assert.equal(result.fifth.paused, "paused");
      assert.equal(result.fifth.unknown, true);
      assert.equal(result.fifth.requiredConsent, true);
      assert.equal(result.fifth.calls, 2);
      assert.equal(result.fifth.attempts, 2);
      assert.equal(result.sixth.unknown, true);
      assert.equal(result.sixth.recoveryConsent, true);
      assert.equal(result.sixth.calls, 0);
      assert.equal(result.seventh.calls, 0);
      assert.equal(result.seventh.attempts, 1);
      assert.match(result.seventh.reason, /预算已耗尽/);
      for (const value of result.malformed) {
        assert.equal(value.status, "partial");
        assert.equal(value.complete, false);
        assert.equal(value.retained, true);
      }
    } finally {
      if (browser) await browser.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
