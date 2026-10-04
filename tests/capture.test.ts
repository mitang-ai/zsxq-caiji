import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../server/index.js";
import { sourcePaths } from "../shared/zsxq.js";
import { sha256 } from "../shared/transfer.js";
import { ingestRecord } from "../server/core.js";
import { normalizeTopic } from "../shared/zsxq.js";

const topic = (id: string) => ({
  topic_id: id,
  group: { group_id: "89" },
  create_time: "2026-10-02T12:00:00+0800",
  comments_count: 0,
  talk: { owner: { user_id: "7", name: "隔离作者" }, text: "隔离主题 " + id },
});
async function fixture(
  run: (f: any) => Promise<void>,
  request: any,
  download?: any,
) {
  const dir = mkdtempSync(join(tmpdir(), "xj-capture-fixture-"));
  const source: any = {
    request,
    verify: async () => ({
      source_account_id: "fixture-source-user",
      groups: [{ id: "89", name: "隔离星球" }],
    }),
    setBusy() {},
    async close() {},
  };
  const f = await createApp({
    dataDir: dir,
    worker: false,
    runtime: { sources: source, download },
  });
  try {
    const r = await f.app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: "capture@example.test",
        name: "隔离",
        password: "Isolated-capture-password-42!",
      },
    });
    assert.equal(r.statusCode, 201);
    const auth = r.json(),
      wid = auth.workspaces[0].id,
      headers = {
        cookie: r.cookies.map((c) => `${c.name}=${c.value}`).join("; "),
        "x-csrf-token": auth.csrf,
      };
    f.store.put(
      "connection",
      {
        id: "fixture-connection",
        user_id: auth.user.id,
        state: "ready",
        channel: "browser",
        policy: "browser_only",
        groups: [{ id: "89" }],
        source_account_id: "fixture-source-user",
      },
      auth.user.id,
    );
    const api = async (
      path: string,
      payload?: any,
      method: any = payload ? "POST" : "GET",
    ) => {
      const r = await f.app.inject({ method, url: path, headers, payload });
      assert(r.statusCode < 400, r.body);
      return r.json();
    };
    await run({
      ...f,
      dir,
      wid,
      headers,
      api,
      job: async (scope = {}) =>
        api(`/api/w/${wid}/jobs`, {
          kind: "capture",
          connection_id: "fixture-connection",
          scope: { group_id: "89", max_pages: 1, ...scope },
        }),
    });
  } finally {
    await f.app.close();
    const root = resolve(dir);
    assert(
      root.startsWith(resolve(tmpdir()) + "\\") ||
        root.startsWith(resolve(tmpdir()) + "/"),
    );
    rmSync(root, { recursive: true, force: true });
  }
}
test("known failed detail retry refetches only failed ID, does not rescan successful topics or inflate processed", async () => {
  let failDetail = true;
  const reads: any[] = [];
  await fixture(
    async ({ job, runtime, store, api, wid }) => {
      const j = await job();
      await runtime.tick();
      const partial = store.get("job", j.id);
      assert.equal(partial.state, "partial");
      assert.equal(partial.coverage.range, "complete");
      assert.deepEqual(
        partial.checkpoint.failures.map((x: any) => x.topic_id),
        ["102"],
      );
      assert.equal(partial.processed, 2);
      const before = reads.length;
      failDetail = false;
      await api(`/api/w/${wid}/jobs/${j.id}/retry_failed`, {});
      await runtime.tick();
      const after = store.get("job", j.id);
      assert.equal(after.state, "completed");
      assert.equal(after.processed, 2);
      assert.equal(after.checkpoint.failures.length, 0);
      assert.equal(after.checkpoint.page, 1);
      const saved = after.checkpoint.saved_records[0],
        material = store.get("material", saved.material_id);
      const newer = normalizeTopic(
        {
          ...topic(material.source_key.entity_id),
          talk: {
            ...topic(material.source_key.entity_id).talk,
            text: "后来另一次采集更新，不应替换任务固定导出",
          },
        },
        "89",
      );
      ingestRecord(store, wid, after.user_id, newer);
      const exported = await api(
        `/api/w/${wid}/jobs/${j.id}/export?offset=0&limit=1`,
      );
      assert.equal(exported.records.length, 1);
      assert(!exported.records[0].text.includes("后来另一次"));
      assert.equal(exported.coverage.total, 2);
      assert.equal(exported.coverage.next_offset, 1);
      assert.equal(exported.attachments.length, 0);
      const retried = reads.slice(before);
      assert.equal(
        retried.filter((r) => r.path === sourcePaths.detail("101")).length,
        0,
      );
      assert.equal(
        retried.filter((r) => r.path === sourcePaths.detail("102")).length,
        1,
      );
      assert(
        !retried.some(
          (r) => r.path === sourcePaths.topics("89") && r.query.count === 20,
        ),
      );
    },
    async (_c: any, path: string, query: any = {}) => {
      reads.push({ path, query });
      if (path === sourcePaths.groups)
        return { groups: [{ group_id: "89", name: "隔离星球" }] };
      if (path === sourcePaths.topics("89"))
        return {
          topics:
            query.count === 1 ? [topic("101")] : [topic("101"), topic("102")],
        };
      if (path === sourcePaths.detail("102") && failDetail)
        throw new Error("fixture-detail-missing");
      if (
        path === sourcePaths.detail("101") ||
        path === sourcePaths.detail("102")
      )
        return { topic: topic(path.includes("102") ? "102" : "101") };
      throw new Error("unexpected fixed route " + path);
    },
  );
});
test("actual returned numeric image ID reaches download and binds verified blob; client cannot supply arbitrary URL", async () => {
  const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  let requested = "";
  const t = {
    ...topic("201"),
    talk: {
      ...topic("201").talk,
      images: [
        {
          image_id: "900719925474099312",
          original: { url: "https://images.zsxq.com/test.png" },
        },
      ],
    },
  };
  await fixture(
    async ({ job, runtime, store, api, wid }) => {
      const j = await job({ include_attachments: true });
      await runtime.tick();
      assert.equal(store.get("job", j.id).state, "completed");
      assert.equal(requested, "https://images.zsxq.com/test.png");
      const a = store.list("attachment", { workspaceId: wid })[0];
      assert.equal(a.hash, sha256(image));
      assert.equal(a.record_source_key.entity_id, "201");
      assert.equal(a.parse_state, "unsupported");
      assert.deepEqual(readFileSync(join(store.blobDir, a.hash)), image);
      const material = await api(
        `/api/w/${wid}/materials/${store.get("job", j.id).checkpoint.material_ids[0]}`,
      );
      assert.equal(material.coverage.attachments, "complete");
    },
    async (_c: any, path: string) =>
      path === sourcePaths.groups
        ? { groups: [{ group_id: "89" }] }
        : path === sourcePaths.detail("201")
          ? { topic: t }
          : { topics: [t] },
    async (url: string) => {
      requested = url;
      return {
        status: 200,
        headers: new Headers({ "content-type": "image/png" }),
        bytes: image,
        text: "",
      };
    },
  );
});
test("selected member owns only their records; other authors remain explicitly contextual comments", async () => {
  const t = { ...topic("301"), comments_count: 2 };
  await fixture(
    async ({ job, runtime, store, api, wid }) => {
      const j = await job({
        author_id: "7",
        types: ["topic", "comment"],
        include_comments: true,
      });
      await runtime.tick();
      const all = store.materialSummaries(wid),
        own = await api(`/api/w/${wid}/materials?group_id=89&author_id=7`);
      assert.equal(all.length, 3);
      assert.equal(own.length, 2);
      assert(own.every((m: any) => m.author_id === "7"));
      assert.equal(
        store.get("job", j.id).checkpoint.context_material_ids.length,
        1,
      );
      assert.equal(
        all.find((m: any) => m.author_id === "8")!.entity_type,
        "comment",
      );
    },
    async (_c: any, path: string) =>
      path === sourcePaths.groups
        ? { groups: [{ group_id: "89" }] }
        : path === sourcePaths.detail("301")
          ? { topic: t }
          : path === sourcePaths.comments("301")
            ? {
                comments: [
                  {
                    comment_id: "401",
                    owner: { user_id: "7", name: "隔离作者" },
                    text: "作者自己的回复",
                    create_time: t.create_time,
                  },
                  {
                    comment_id: "402",
                    owner: { user_id: "8", name: "其他成员" },
                    text: "别人提供的上下文",
                    create_time: t.create_time,
                  },
                ],
              }
            : { topics: [t] },
  );
});
