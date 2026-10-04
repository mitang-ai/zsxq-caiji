import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { SourceManager, type Connection } from "../server/source.js";
import { sourcePaths } from "../shared/zsxq.js";

// Live, anonymous, read-only smoke. No existing profile or login is imported.
const dir = mkdtempSync(join(tmpdir(), "xingjian-anonymous-source-"));
const source = new SourceManager(dir);
const connection: Connection = {
  id: crypto.randomUUID(),
  user_id: "isolated-anonymous-check",
  label: "anonymous verification",
  channel: "browser",
  policy: "browser_only",
  state: "awaiting_login",
  created_at: new Date().toISOString(),
};
const report: any = {
  at: new Date().toISOString(),
  kind: "live_anonymous",
  authenticated_capture_verified: false,
};
try {
  const page = await source.open(connection);
  report.title = await page.title();
  report.url = new URL(page.url()).origin;
  try {
    await source.request(connection, sourcePaths.self);
    report.self = "unexpected anonymous success";
    process.exitCode = 1;
  } catch (e: any) {
    report.self_error = {
      code: e.code ?? "transport_error",
      message: e.message,
    };
    if (e.code !== "login_required") process.exitCode = 1;
  }
  const screen = await source.screen(connection);
  report.screen = {
    width: screen.width,
    height: screen.height,
    has_image: screen.image.startsWith("data:image/jpeg"),
  };
} catch (e: any) {
  report.error = e.message;
  process.exitCode = 1;
} finally {
  await source.close();
  const target = resolve(dir);
  if (
    !target.startsWith(resolve(tmpdir()) + "\\") &&
    !target.startsWith(resolve(tmpdir()) + "/")
  )
    throw new Error("cleanup path outside isolated temp");
  rmSync(target, { recursive: true, force: true });
}
mkdirSync("test-output", { recursive: true });
writeFileSync("test-output/source-smoke.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
