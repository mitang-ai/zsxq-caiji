import { createServer, createConnection } from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
type Status = {
  running_job_ids: string[];
  closing: boolean;
  source_browser_open: boolean;
};
export async function startControl(
  dataDir: string,
  status: () => Status,
  stop: () => Promise<void>,
) {
  const token = randomBytes(32).toString("hex"),
    path =
      process.platform === "win32"
        ? `\\\\.\\pipe\\xingjian-${process.pid}-${randomBytes(8).toString("hex")}`
        : join(dataDir, "control.sock");
  const record = join(dataDir, "local-control.json");
  const server = createServer((socket) => {
    socket.setTimeout(3000, () => socket.destroy());
    socket.setEncoding("utf8");
    let input = "";
    socket.on("data", (data) => {
      input += data;
      if (input.length > 2048) return socket.destroy();
      if (!input.includes("\n")) return;
      let b: any;
      try {
        b = JSON.parse(input.split("\n")[0]);
      } catch {
        return socket.end(
          JSON.stringify({ ok: false, code: "INVALID_COMMAND" }) + "\n",
        );
      }
      const supplied = Buffer.from(String(b.token ?? ""));
      if (
        supplied.length !== token.length ||
        !timingSafeEqual(supplied, Buffer.from(token))
      )
        return socket.end(JSON.stringify({ ok: false, code: "DENIED" }) + "\n");
      const current = status();
      if (b.action === "status")
        return socket.end(JSON.stringify({ ok: true, ...current }) + "\n");
      if (b.action !== "stop")
        return socket.end(
          JSON.stringify({ ok: false, code: "INVALID_COMMAND" }) + "\n",
        );
      if (current.running_job_ids.length && !b.cancel_running)
        return socket.end(
          JSON.stringify({ ok: false, code: "TASKS_RUNNING", ...current }) +
            "\n",
        );
      socket.end(JSON.stringify({ ok: true, stopping: true }) + "\n");
      server.close();
      void stop();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  writeFileSync(record, JSON.stringify({ pid: process.pid, path, token }), {
    mode: 0o600,
  });
  return () => {
    server.close();
    if (
      existsSync(record) &&
      JSON.parse(readFileSync(record, "utf8")).token === token
    )
      unlinkSync(record);
    if (process.platform !== "win32" && existsSync(path)) unlinkSync(path);
  };
}
export async function controlRequest(
  dataDir: string,
  action: "status" | "stop",
  cancelRunning = false,
) {
  const record = JSON.parse(
    readFileSync(join(dataDir, "local-control.json"), "utf8"),
  );
  return new Promise<any>((resolve, reject) => {
    const socket = createConnection(record.path);
    let input = "";
    socket.setEncoding("utf8");
    socket.setTimeout(5000, () => {
      socket.destroy();
      reject(new Error("Local control timeout"));
    });
    socket.once("connect", () =>
      socket.write(
        JSON.stringify({
          token: record.token,
          action,
          cancel_running: cancelRunning,
        }) + "\n",
      ),
    );
    socket.on("data", (data) => {
      input += data;
      if (input.includes("\n")) {
        socket.destroy();
        try {
          resolve(JSON.parse(input.split("\n")[0]));
        } catch (error) {
          reject(error);
        }
      }
    });
    socket.once("error", reject);
  });
}
