import { chromium, type BrowserContext, type Page } from "playwright";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join, resolve, relative } from "node:path";
import { zipSync, unzipSync } from "fflate";
import { vault } from "./secrets.js";
import { publicRequest } from "./net.js";
import {
  sourceHeaders,
  parseSourceJson,
  unwrapSource,
  sourcePaths,
} from "../shared/zsxq.js";
export type Connection = {
  id: string;
  user_id: string;
  label: string;
  channel: "browser" | "official";
  policy: string;
  state: string;
  secret?: string;
  source_account_id?: string;
  source_account_name?: string;
  groups?: any[];
  created_at: string;
};
export class SourceManager {
  private context?: BrowserContext;
  private page?: Page;
  private active?: Connection;
  private lock = false;
  private busy = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private requestConnection?: string;
  private requestCount = 0;
  private networkAbort = new AbortController();
  private v: ReturnType<typeof vault>;
  constructor(private dir: string) {
    this.v = vault(dir);
    mkdirSync(join(dir, "profiles"), { recursive: true, mode: 0o700 });
  }
  async open(c: Connection): Promise<Page> {
    if (this.requestCount && this.requestConnection !== c.id)
      throw Object.assign(
        new Error("另一连接正在读取来源，请等待本次请求结束"),
        { code: "browser_busy", statusCode: 409 },
      );
    if (this.active?.id === c.id && this.page && !this.page.isClosed()) {
      this.touch();
      return this.page;
    }
    if (this.lock || this.busy)
      throw Object.assign(new Error("浏览器正被另一采集占用；请先暂停任务"), {
        code: "browser_busy",
        statusCode: 409,
      });
    this.lock = true;
    try {
      await this.close();
      const path = join(this.dir, "profiles", c.id);
      const encrypted = `${path}.enc`;
      if (!/^[\w-]+$/.test(c.id)) throw new Error("invalid_connection_id");
      mkdirSync(path, { recursive: true, mode: 0o700 });
      if (existsSync(encrypted) && !readdirSync(path).length) {
        const files = unzipSync(
          this.v.decrypt(readFileSync(encrypted, "utf8")),
        );
        for (const [name, data] of Object.entries(files)) {
          const dest = resolve(path, name);
          if (
            !dest.startsWith(resolve(path) + "\\") &&
            !dest.startsWith(resolve(path) + "/")
          )
            throw new Error("profile_archive_traversal");
          mkdirSync(resolve(dest, ".."), { recursive: true, mode: 0o700 });
          writeFileSync(dest, data, { mode: 0o600 });
        }
      }
      this.context = await chromium.launchPersistentContext(path, {
        headless: true,
        viewport: { width: 960, height: 640 },
        channel: process.env.XINGJIAN_BROWSER_CHANNEL || undefined,
        args: ["--disable-dev-shm-usage", "--disable-background-networking"],
      });
      await this.context.route("**/*", (route) => {
        const u = new URL(route.request().url());
        const host = u.hostname;
        const allowed =
          u.protocol === "data:" ||
          u.protocol === "blob:" ||
          (u.protocol === "https:" &&
            [
              "zsxq.com",
              "zsxqapp.com",
              "qq.com",
              "qpic.cn",
              "qlogo.cn",
              "weixin.qq.com",
              "qiniup.com",
              "qhimg.com",
            ].some((d) => host === d || host.endsWith("." + d)));
        return allowed ? route.continue() : route.abort();
      });
      this.active = c;
      this.page = this.context.pages()[0] ?? (await this.context.newPage());
      await this.page.goto("https://wx.zsxq.com/", {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      this.touch();
      return this.page;
    } finally {
      this.lock = false;
    }
  }
  private touch() {
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        if (!this.busy) void this.close();
      },
      10 * 60 * 1000,
    );
    this.timer.unref();
  }
  setBusy(value: boolean) {
    this.busy = value;
    if (!value) this.touch();
  }
  isActive(id: string) {
    return this.active?.id === id;
  }
  hasOpenBrowser() {
    return !!this.context;
  }
  async close() {
    clearTimeout(this.timer);
    this.networkAbort.abort();
    this.networkAbort = new AbortController();
    if (!this.context) return;
    const c = this.active;
    await this.context.close();
    this.context = undefined;
    this.page = undefined;
    this.active = undefined;
    if (c) {
      const path = join(this.dir, "profiles", c.id),
        root = resolve(this.dir, "profiles");
      if (
        !resolve(path).startsWith(
          root + (process.platform === "win32" ? "\\" : "/"),
        )
      )
        throw new Error("profile_path_escape");
      const files: Record<string, Uint8Array> = {};
      let bytes = 0;
      const walk = (p: string) => {
        for (const n of readdirSync(p)) {
          const x = join(p, n),
            s = lstatSync(x);
          if (s.isSymbolicLink()) continue;
          if (s.isDirectory()) walk(x);
          else if (s.isFile()) {
            bytes += s.size;
            if (bytes > 250 * 1024 * 1024) throw new Error("profile_too_large");
            files[relative(path, x).replace(/\\/g, "/")] = readFileSync(x);
          }
        }
      };
      walk(path);
      writeFileSync(
        `${path}.enc`,
        this.v.encrypt(zipSync(files, { level: 1 })),
        { mode: 0o600 },
      );
      rmSync(path, { recursive: true, force: true });
    }
  }
  async screen(c: Connection) {
    const p = await this.open(c);
    return {
      image:
        "data:image/jpeg;base64," +
        (await p.screenshot({ type: "jpeg", quality: 80 })).toString("base64"),
      width: 960,
      height: 640,
      url: new URL(p.url()).origin + new URL(p.url()).pathname,
    };
  }
  async input(c: Connection, b: any) {
    const p = await this.open(c);
    if (this.busy)
      throw Object.assign(new Error("请暂停采集再操作登录浏览器"), {
        code: "browser_busy",
        statusCode: 409,
      });
    if (
      b.type === "click" &&
      Number.isFinite(b.x) &&
      Number.isFinite(b.y) &&
      b.x >= 0 &&
      b.x < 960 &&
      b.y >= 0 &&
      b.y < 640
    )
      await p.mouse.click(b.x, b.y);
    else if (
      b.type === "text" &&
      typeof b.text === "string" &&
      b.text.length < 2000
    )
      await p.keyboard.insertText(b.text);
    else if (
      b.type === "key" &&
      [
        "Enter",
        "Tab",
        "Escape",
        "Backspace",
        "Delete",
        "ArrowDown",
        "ArrowUp",
        "Control+A",
        "Meta+A",
      ].includes(b.key)
    )
      await p.keyboard.press(b.key);
    else if (b.type === "scroll" && Number.isFinite(b.delta))
      await p.mouse.wheel(0, Math.max(-1000, Math.min(1000, b.delta)));
    else
      throw Object.assign(new Error("无效浏览器操作"), {
        code: "invalid_browser_input",
        statusCode: 400,
      });
    return { ok: true };
  }
  async request(
    c: Connection,
    path: string,
    query: Record<string, unknown> = {},
  ) {
    if (this.requestCount && this.requestConnection !== c.id)
      throw Object.assign(
        new Error("另一连接正在读取来源，请等待本次请求结束"),
        { code: "source_busy", statusCode: 409 },
      );
    this.requestConnection = c.id;
    this.requestCount++;
    try {
      return await this.read(c, path, query);
    } finally {
      this.requestCount--;
      if (!this.requestCount) this.requestConnection = undefined;
    }
  }
  private async read(
    c: Connection,
    path: string,
    query: Record<string, unknown> = {},
  ) {
    if (
      !/^\/v2\/(users\/self|groups(?:\/\d+(?:\/(?:topics|members))?)?|search\/groups\/\d+\/members|topics\/\d+\/(?:info|comments)|articles\/[\w-]+|files\/\d+\/download_url)$/.test(
        path,
      )
    )
      throw new Error("source_route_denied");
    if (c.channel === "official") return this.mcp(c, path, query);
    const p = await this.open(c);
    const u = new URL(path, "https://api.zsxq.com");
    for (const [k, v] of Object.entries(query))
      if (v !== undefined && v !== null && v !== "")
        u.searchParams.set(k, String(v));
    const headers = await sourceHeaders(u.toString());
    const r = await p.evaluate(
      async ({ url, headers }) => {
        const response = await fetch(url, {
          headers,
          credentials: "include",
          redirect: "error",
          signal: AbortSignal.timeout(45000),
        });
        return { status: response.status, text: await response.text() };
      },
      { url: u.toString(), headers },
    );
    if (r.status === 401)
      throw Object.assign(new Error("知识星球登录已过期，请重新登录"), {
        code: "login_required",
        statusCode: 401,
      });
    if (r.status === 429)
      throw Object.assign(new Error("知识星球要求降低频率，请稍后恢复"), {
        code: "rate_limited",
        statusCode: 429,
      });
    if (r.status !== 200)
      throw Object.assign(new Error(`来源响应 HTTP ${r.status}`), {
        code: "source_failed",
        statusCode: 400,
      });
    const result = parseSourceJson(r.text);
    if (result.succeeded === false) {
      const code = String(result.code);
      throw Object.assign(
        new Error(
          ["401", "1059", "1099"].includes(code)
            ? "需要重新登录或在源站完成安全验证"
            : `来源拒绝请求 (${code})`,
        ),
        {
          code: ["401", "1059", "1099"].includes(code)
            ? "login_required"
            : "source_rejected",
          statusCode: 400,
        },
      );
    }
    return unwrapSource(result);
  }
  private async mcp(c: Connection, path: string, query: any) {
    if (!c.secret) throw new Error("official_credentials_missing");
    const url = this.v.decrypt(c.secret).toString();
    const u = new URL(url);
    if (
      u.protocol !== "https:" ||
      !(u.hostname === "zsxq.com" || u.hostname.endsWith(".zsxq.com"))
    )
      throw new Error("official_host_denied");
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    const parse = (t: string) => {
      if (t.trim().startsWith("{")) return parseSourceJson(t);
      for (const l of t.split("\n"))
        if (l.startsWith("data:")) {
          try {
            const j = parseSourceJson(l.slice(5).trim());
            if (j.result || j.error) return j;
          } catch {
            /* SSE heartbeat */
          }
        }
      throw new Error("invalid_mcp_response");
    };
    const send = async (body: any) => {
      const r = await publicRequest(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.any([
          this.networkAbort.signal,
          AbortSignal.timeout(60000),
        ]),
      });
      if (r.status !== 200 && r.status !== 202)
        throw Object.assign(new Error(`官方 MCP HTTP ${r.status}`), {
          code: r.status === 401 ? "login_required" : "official_denied",
          statusCode: 400,
        });
      if (r.headers.get("mcp-session-id"))
        headers["mcp-session-id"] = r.headers.get("mcp-session-id")!;
      return r.text ? parse(r.text) : {};
    };
    const initialized = await send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "xingjian", version: "1.0.0" },
      },
    });
    if (initialized.error) throw new Error("mcp_initialize_failed");
    headers["mcp-protocol-version"] =
      initialized.result?.protocolVersion ?? "2025-03-26";
    await send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const response = await send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "call_zsxq_api",
        arguments: { method: "GET", path, query },
      },
    });
    if (response.error || response.result?.isError)
      throw Object.assign(new Error("官方 MCP 拒绝此次调用，请检查权限开关"), {
        code: "official_denied",
        statusCode: 403,
      });
    const content =
      response.result?.structuredContent ??
      parseSourceJson(
        response.result?.content
          ?.filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("") ?? "{}",
      );
    return unwrapSource(content);
  }
  async verify(c: Connection) {
    const data = await this.request(c, sourcePaths.self);
    const user = data.user;
    if (!/^\d+$/.test(String(user?.user_id ?? "")))
      throw Object.assign(new Error("未能验证稳定源站账号"), {
        code: "login_required",
        statusCode: 400,
      });
    if (c.source_account_id && c.source_account_id !== String(user.user_id))
      throw Object.assign(
        new Error("当前登录账号与连接绑定账号不同，请创建新连接"),
        { code: "identity_mismatch", statusCode: 409 },
      );
    return {
      source_account_id: String(user.user_id),
      source_account_name: String(user.name ?? ""),
      state: "ready",
    };
  }
}
