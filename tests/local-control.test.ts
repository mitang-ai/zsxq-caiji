import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startControl, controlRequest } from "../server/local-control.js";
test("local IPC returns status and refuses cancelling running work without explicit flag", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xingjian-ipc-"));
  let stopped = 0;
  const state = {
    running_job_ids: ["isolated-job"],
    closing: false,
    source_browser_open: true,
  };
  let cleanup: (() => void) | undefined;
  try {
    cleanup = await startControl(
      dir,
      () => state,
      async () => {
        stopped++;
      },
    );
    assert.equal(
      (await controlRequest(dir, "status")).source_browser_open,
      true,
    );
    const refused = await controlRequest(dir, "stop");
    assert.equal(refused.ok, false);
    assert.equal(refused.code, "TASKS_RUNNING");
    assert.equal(stopped, 0);
    assert.equal((await controlRequest(dir, "stop", true)).ok, true);
    assert.equal(stopped, 1);
  } finally {
    cleanup?.();
    const target = resolve(dir);
    assert(
      target.startsWith(resolve(tmpdir()) + "\\") ||
        target.startsWith(resolve(tmpdir()) + "/"),
    );
    rmSync(target, { recursive: true, force: true });
  }
});
