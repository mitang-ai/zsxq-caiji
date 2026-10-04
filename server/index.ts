import Fastify from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import cors from "@fastify/cors";
import staticFiles from "@fastify/static";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "./store.js";
import { registerCore } from "./core.js";
import { registerRuntime, type RuntimeOptions } from "./runtime.js";
import { startControl, controlRequest } from "./local-control.js";
export async function createApp(
  options: {
    dataDir?: string;
    worker?: boolean;
    staticRoot?: string;
    runtime?: RuntimeOptions;
  } = {},
) {
  const dataDir = resolve(
    options.dataDir ?? process.env.XINGJIAN_DATA_DIR ?? "data",
  );
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const lockPath = join(dataDir, "runtime.lock"),
    nonce = randomUUID();
  if (existsSync(lockPath)) {
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    let alive = false;
    try {
      process.kill(lock.pid, 0);
      alive = true;
    } catch {
      /* stale process */
    }
    if (alive)
      throw new Error("此数据目录已有进程在运行，不能启动第二个任务执行器");
    unlinkSync(lockPath);
  }
  writeFileSync(
    lockPath,
    JSON.stringify({
      pid: process.pid,
      nonce,
      started_at: new Date().toISOString(),
    }),
    { flag: "wx", mode: 0o600 },
  );
  const app = Fastify({
    bodyLimit: 20 * 1024 * 1024,
    logger: false,
    trustProxy: process.env.XINGJIAN_TRUST_PROXY === "1",
  });
  const store = createStore(dataDir);
  await app.register(cookie);
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });
  await app.register(cors, {
    origin: (origin, cb) =>
      cb(
        null,
        !origin ||
          /^chrome-extension:\/\/[a-p]{32}$/.test(origin) ||
          origin === process.env.XINGJIAN_PUBLIC_URL ||
          /^http:\/\/(localhost|127\.0\.0\.1):431[789]$/.test(origin),
      ),
    credentials: true,
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-CSRF-Token",
      "X-Idempotency-Key",
    ],
    exposedHeaders: ["Content-Disposition"],
  });
  app.addHook("onSend", async (req, reply, payload) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header("X-Frame-Options", "DENY");
    if (req.url.startsWith("/api") || req.url === "/mcp")
      reply.header("Cache-Control", "no-store");
    else
      reply.header(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'",
      );
    return payload;
  });
  app.setErrorHandler((e: any, _req, reply) => {
    const status = Number(e.statusCode ?? e.status ?? 500);
    const message =
      status >= 500 ? "服务暂时无法完成请求，请查看任务事实记录" : e.message;
    reply.code(status >= 400 && status < 600 ? status : 500).send({
      error: {
        code: e.code ?? "request_failed",
        message,
        ...(e.details ? { details: e.details } : {}),
      },
    });
  });
  app.get("/api/health", () => ({
    status: "ok",
    service: "xingjian",
    version: "1.2.0",
    product: "集见",
    execution: "serial",
    database: "sqlite-wal",
  }));
  await registerCore(app, store);
  const runtime = await registerRuntime(app, store, {
    ...options.runtime,
    startWorker: options.worker !== false,
  });
  const root = options.staticRoot ?? resolve("dist/web");
  if (existsSync(join(root, "index.html"))) {
    await app.register(staticFiles, { root, decorateReply: true });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/") || req.url === "/mcp")
        return reply
          .code(404)
          .send({ error: { code: "not_found", message: "接口不存在" } });
      return reply.sendFile("index.html");
    });
  }
  app.addHook("onClose", async () => {
    try {
      await runtime.close();
    } finally {
      store.close();
      if (
        existsSync(lockPath) &&
        JSON.parse(readFileSync(lockPath, "utf8")).nonce === nonce
      )
        unlinkSync(lockPath);
    }
  });
  return { app, store, runtime };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv[2] === "control") {
    const data = resolve(process.env.XINGJIAN_DATA_DIR ?? "data");
    const action = process.argv[3] === "stop" ? "stop" : "status";
    const result = await controlRequest(
      data,
      action,
      process.argv.includes("--cancel-running"),
    );
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exit(result.ok ? 0 : 1);
  }
  const port = Number(process.env.PORT ?? 4318),
    host = process.env.HOST ?? "127.0.0.1";
  if (
    process.env.NODE_ENV === "production" &&
    (!process.env.XINGJIAN_PUBLIC_URL?.startsWith("https://") ||
      host !== "127.0.0.1")
  )
    throw new Error(
      "生产需配置 HTTPS XINGJIAN_PUBLIC_URL 并绑定 loopback，由 Nginx 反代",
    );
  const { app, store, runtime } = await createApp();
  await app.listen({ host, port });
  process.stdout.write(`集见 listening http://${host}:${port}\n`);
  let stopControl: (() => void) | undefined,
    closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    try {
      await app.close();
    } finally {
      stopControl?.();
      process.exit(0);
    }
  };
  if (process.env.XINGJIAN_LOCAL_CONTROL === "1")
    stopControl = await startControl(
      store.dataDir,
      () => runtime.status(),
      stop,
    );
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => {
      void stop();
    });
}
