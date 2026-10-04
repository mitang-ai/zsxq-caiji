import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { createStore } from "./store.js";
import { createRecoveryToken } from "./core.js";
import { sha256 } from "../shared/transfer.js";

const args = process.argv.slice(2),
  command = args[0];
function argument(name: string) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const directory = argument("--data-dir");
if (!directory || !["verify", "recovery"].includes(command))
  throw new Error(
    "Usage: admin.mjs verify|recovery --data-dir <absolute> [--email <email> --output <new-token-file>]",
  );
const dataDir = resolve(directory),
  lock = join(dataDir, "runtime.lock");
if (!existsSync(join(dataDir, "workbench.sqlite")))
  throw new Error(
    "Existing database not found; no new data directory was created.",
  );
if (existsSync(lock)) {
  const record = JSON.parse(readFileSync(lock, "utf8"));
  try {
    process.kill(record.pid, 0);
    throw new Error("Stop the service gracefully before offline maintenance.");
  } catch (error: any) {
    if (error.code !== "ESRCH") throw error;
  }
}
const store = createStore(dataDir);
try {
  if (command === "verify") {
    const integrity = store.db.prepare("PRAGMA integrity_check").all();
    if (integrity.some((row) => Object.values(row)[0] !== "ok"))
      throw new Error("SQLite integrity check failed.");
    let attachments = 0;
    for (const a of store.list("attachment")) {
      if (a.status !== "available") continue;
      const bytes = readFileSync(join(store.blobDir, a.hash));
      if (bytes.length !== a.size || sha256(bytes) !== a.hash)
        throw new Error("Attachment hash/size mismatch: " + a.id);
      attachments++;
    }
    process.stdout.write(
      JSON.stringify({
        ok: true,
        integrity: "ok",
        attachments_verified: attachments,
      }) + "\n",
    );
  } else {
    const email = argument("--email")?.trim().toLowerCase(),
      output = argument("--output");
    if (!email || !output)
      throw new Error(
        "Recovery needs --email and --output; tokens are not printed to console.",
      );
    const user = store.list("user").find((user) => user.email === email);
    if (!user) throw new Error("Account not found.");
    const path = resolve(output);
    if (existsSync(path))
      throw new Error("Output already exists; nothing was overwritten.");
    const token = createRecoveryToken(store, user.id);
    writeFileSync(path, JSON.stringify({ token, expires_in_minutes: 30 }), {
      flag: "wx",
      mode: 0o600,
    });
    process.stdout.write(
      "Recovery token saved in the specified private file. Remove it after use.\n",
    );
  }
} finally {
  store.close();
}
