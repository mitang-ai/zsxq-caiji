import { existsSync } from "node:fs";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { extractText, type AttachmentText } from "./attachment-parser.js";

// Binary parsers run outside the HTTP/queue thread. Originals survive failures.
export async function extractAttachment(
  bytes: Buffer,
  name: string,
): Promise<AttachmentText> {
  if (bytes.length > 50 * 1024 * 1024)
    return { state: "partial", reason: "超过 50 MiB 解析上限，原件保留" };
  const ext = extname(name).toLowerCase();
  if (![".pdf", ".docx"].includes(ext)) return extractText(bytes, name);
  const built = new URL("./attachment-worker.mjs", import.meta.url);
  const script = existsSync(fileURLToPath(built))
    ? built
    : new URL("./attachment-worker.ts", import.meta.url);
  return new Promise((resolve) => {
    let settled = false;
    const worker = new Worker(script, {
      workerData: { bytes: new Uint8Array(bytes), name },
      resourceLimits: {
        maxOldGenerationSizeMb: 256,
        maxYoungGenerationSizeMb: 32,
      },
      ...(script.pathname.endsWith(".ts")
        ? { execArgv: ["--import", "tsx"] }
        : {}),
    });
    const finish = (result: AttachmentText) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(result);
    };
    const timer = setTimeout(
      () =>
        finish({
          state: "partial",
          reason: "解析超过 20 秒，已终止解析线程；原件保留",
        }),
      20000,
    );
    worker.once("message", (result) => finish(result));
    worker.once("error", (error) =>
      finish({
        state: "failed",
        reason:
          "解析线程失败或超过内存预算；原件保留：" +
          error.message.slice(0, 200),
      }),
    );
    worker.once("exit", () => {
      if (!settled)
        finish({ state: "failed", reason: "解析线程未返回结果；原件保留" });
    });
  });
}
