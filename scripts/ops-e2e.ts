import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import assert from "node:assert/strict";
import { controlRequest } from "../server/local-control.js";
import { createBundle, fragmentsFor, sha256 } from "../shared/transfer.js";
const dir = mkdtempSync(join(tmpdir(), "xingjian-ops-e2e-")),
  data = join(dir, "data"),
  backup = join(dir, "backup"),
  restored = join(dir, "restored");
mkdirSync(data);
const reservation = createServer();
await new Promise<void>((resolve) =>
  reservation.listen(0, "127.0.0.1", resolve),
);
const port = (reservation.address() as any).port;
await new Promise<void>((resolve) => reservation.close(() => resolve()));
const origin = `http://127.0.0.1:${port}`,
  checks: string[] = [];
let child: ChildProcess | undefined,
  output = "";
async function start(folder: string) {
  output = "";
  child = spawn(process.execPath, [resolve("dist/server/index.mjs")], {
    cwd: resolve("."),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      XINGJIAN_PUBLIC_URL: origin,
      XINGJIAN_DATA_DIR: folder,
      XINGJIAN_LOCAL_CONTROL: "1",
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (x) => (output += x));
  child.stderr?.on("data", (x) => (output += x));
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw new Error("Service exited: " + output);
    try {
      if (
        (await fetch(origin + "/api/health")).ok &&
        existsSync(join(folder, "local-control.json"))
      )
        return;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("Service timeout: " + output);
}
async function stop(folder: string) {
  const p = child!;
  const exit = new Promise((resolve) => p.once("exit", resolve));
  assert.equal((await controlRequest(folder, "stop")).ok, true);
  await exit;
  child = undefined;
  assert(!existsSync(join(folder, "runtime.lock")));
}
function command(exe: string, args: string[]) {
  const r = spawnSync(exe, args, {
    cwd: resolve("."),
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return r.stdout;
}
try {
  await start(data);
  checks.push("built bundle starts with single-process lock + private IPC");
  const r = await fetch(origin + "/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "ops@example.test",
      name: "隔离运维",
      password: "Operations-fixture-password-42!",
    }),
  });
  assert.equal(r.status, 201);
  const registration: any = await r.json(),
    wid = registration.workspaces[0].id,
    cookie = r.headers.get("set-cookie")!.split(";")[0];
  const text = "运维备份验收，仅隔离fixture。";
  const bundle = createBundle({
    records: [
      {
        source_key: {
          platform: "zsxq",
          group_id: "89",
          entity_type: "topic",
          entity_id: "98",
        },
        group_id: "89",
        author_id: "7",
        author_name: "隔离",
        title: "备份资料",
        text,
        created_at: "2026-10-02",
        source_url: "https://wx.zsxq.com/topic/98",
        coverage: {
          body: "complete",
          comments: "complete",
          attachments: "complete",
          reasons: [],
        },
        fragments: fragmentsFor(text),
        hash: sha256(text),
        captured_at: new Date().toISOString(),
      },
    ],
  });
  const imported = await fetch(origin + `/api/w/${wid}/import`, {
    method: "POST",
    headers: {
      cookie,
      "x-csrf-token": registration.csrf,
      "content-type": "application/json",
      "x-idempotency-key": "ops-import",
    },
    body: JSON.stringify({ bundle }),
  });
  assert.equal(imported.status, 200);
  const mid = ((await imported.json()) as any).records[0].id;
  await stop(data);
  checks.push("graceful IPC shutdown closes database and removes lock");
  const pwsh = "powershell.exe";
  command(pwsh, [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    resolve("scripts/backup-local.ps1"),
    "-Destination",
    backup,
    "-DataDirectory",
    data,
  ]);
  command(pwsh, [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    resolve("scripts/restore-local.ps1"),
    "-Backup",
    backup,
    "-Destination",
    restored,
  ]);
  const verified = JSON.parse(
    command(process.execPath, [
      resolve("dist/server/admin.mjs"),
      "verify",
      "--data-dir",
      restored,
    ]),
  );
  assert.equal(verified.integrity, "ok");
  checks.push(
    "cold backup manifest + clean-directory restore + offline integrity check",
  );
  const tokenFile = join(dir, "recovery-token.json");
  command(process.execPath, [
    resolve("dist/server/admin.mjs"),
    "recovery",
    "--data-dir",
    restored,
    "--email",
    "ops@example.test",
    "--output",
    tokenFile,
  ]);
  const recovery = JSON.parse(readFileSync(tokenFile, "utf8")).token;
  await start(restored);
  const before = await fetch(origin + `/api/w/${wid}/materials/${mid}`, {
    headers: { cookie },
  });
  assert.equal(before.status, 200);
  assert.equal(((await before.json()) as any).text, text);
  checks.push("restored account/session and full source text read back");
  const changed = await fetch(origin + "/api/auth/recovery/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: recovery,
      password: "Operations-changed-password-73!",
    }),
  });
  assert.equal(changed.status, 200);
  assert.equal(
    (await fetch(origin + "/api/me", { headers: { cookie } })).status,
    401,
  );
  const login = await fetch(origin + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "ops@example.test",
      password: "Operations-changed-password-73!",
    }),
  });
  assert.equal(login.status, 200);
  checks.push(
    "offline one-time recovery + real HTTP password rotation + old session revoked",
  );
  await stop(restored);
  const first = JSON.parse(
    readFileSync(join(backup, "backup-manifest.json"), "utf8"),
  ).files[0];
  writeFileSync(join(backup, first.path), Buffer.from("tampered backup"));
  const invalid = spawnSync(
    pwsh,
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolve("scripts/restore-local.ps1"),
      "-Backup",
      backup,
      "-Destination",
      join(dir, "must-not-exist"),
    ],
    { encoding: "utf8", windowsHide: true },
  );
  assert.notEqual(invalid.status, 0);
  assert(!existsSync(join(dir, "must-not-exist")));
  checks.push(
    "tampered backup rejected before any restored data directory is created",
  );
  mkdirSync("test-output", { recursive: true });
  writeFileSync(
    "test-output/ops-e2e.json",
    JSON.stringify(
      {
        at: new Date().toISOString(),
        checks,
        result: "passed",
        external_source: false,
        external_model: false,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ checks, result: "passed" }, null, 2));
} finally {
  if (child)
    await stop(
      existsSync(join(restored, "local-control.json")) ? restored : data,
    );
  const root = resolve(dir);
  assert(
    root.startsWith(resolve(tmpdir()) + "\\") ||
      root.startsWith(resolve(tmpdir()) + "/"),
  );
  rmSync(root, { recursive: true, force: true });
}
