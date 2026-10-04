import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../server/store.js";

test("job worker selects only the first approved queued job through its index", () => {
  const dir = mkdtempSync(join(tmpdir(), "xj-queue-")),
    store = createStore(dir);
  try {
    store.put(
      "job",
      {
        id: "history",
        state: "completed",
        approved: true,
        inputs: [{ body: "large historical body" }],
      },
      "u",
      "w",
    );
    store.put(
      "job",
      { id: "unapproved", state: "queued", approved: false },
      "u",
      "w",
    );
    store.put(
      "job",
      { id: "first", state: "queued", approved: true },
      "u",
      "w",
    );
    store.put(
      "job",
      { id: "second", state: "queued", approved: true },
      "u",
      "w",
    );
    store.list = () => {
      throw new Error("full history list must not be read");
    };
    assert.equal(store.nextQueuedJob()?.id, "first");
    const plan = store.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT json FROM records WHERE kind='job' AND json_extract(json,'$.state')='queued' AND json_extract(json,'$.approved')=1 ORDER BY rowid LIMIT 1",
      )
      .all();
    assert.match(JSON.stringify(plan), /job_queue/);
    store.put("job", { id: "first", state: "running", approved: true });
    assert.equal(store.nextQueuedJob()?.id, "second");
    assert.deepEqual(
      store.recoverableJobs().map((j) => j.id),
      ["unapproved", "first", "second"],
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("job summaries omit frozen bodies and paid output while keeping exact artifact ids", () => {
  const dir = mkdtempSync(join(tmpdir(), "xj-summary-")),
    store = createStore(dir);
  try {
    store.put(
      "job",
      {
        id: "j",
        kind: "process",
        state: "completed",
        processed: 1,
        artifact_ids: ["fixed-artifact"],
        inputs: [{ text: "PRIVATE_SOURCE" }],
        checkpoint: { unparsed_response: "PAID_OUTPUT" },
        events: [{ body: "HISTORY" }],
        plan: { previous_draft: "PRIOR_DRAFT" },
      },
      "u",
      "w",
    );
    store.put(
      "job",
      { id: "other", state: "completed" },
      "u",
      "another-workspace",
    );
    const rows = store.jobSummaries("w");
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].artifact_ids, ["fixed-artifact"]);
    assert.equal(rows[0].projection, "summary");
    assert.doesNotMatch(
      JSON.stringify(rows),
      /PRIVATE_SOURCE|PAID_OUTPUT|HISTORY|PRIOR_DRAFT/,
    );
    assert.equal(
      store.get("job", "j").checkpoint.unparsed_response,
      "PAID_OUTPUT",
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("busy source connection matches owner and active fallback without historical payloads", () => {
  const dir = mkdtempSync(join(tmpdir(), "xj-busy-")),
    store = createStore(dir);
  try {
    store.put(
      "job",
      {
        id: "j",
        state: "running",
        connection_id: "official",
        actual_connection_id: "browser",
      },
      "u",
      "w",
    );
    assert.equal(store.connectionBusy("u", "official"), true);
    assert.equal(store.connectionBusy("u", "browser"), true);
    assert.equal(store.connectionBusy("other", "browser"), false);
    store.put("job", {
      id: "j",
      state: "paused",
      connection_id: "official",
      actual_connection_id: "browser",
    });
    assert.equal(store.connectionBusy("u", "browser"), false);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
