import { useCallback, useEffect, useRef, useState } from "react";

let csrf = "";
export function setCsrf(value: string) {
  csrf = value;
}
export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
export async function api<T = unknown>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...options.headers,
  };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET" && method !== "HEAD" && csrf)
    headers["X-CSRF-Token"] = csrf;
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: "same-origin",
      cache: "no-store",
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new ApiError(
      "NETWORK",
      "无法连接工作台。请检查服务是否运行，然后重试。",
      0,
    );
  }
  const text = await response.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    throw new ApiError(
      "BAD_RESPONSE",
      `服务返回了非 JSON 响应（HTTP ${response.status}）。请检查后台日志。`,
      response.status,
    );
  }
  if (!response.ok) {
    if (
      response.status === 401 &&
      data?.error?.code === "UNAUTHENTICATED" &&
      path !== "/api/me" &&
      !path.startsWith("/api/auth/") &&
      typeof window !== "undefined"
    )
      window.dispatchEvent(new Event("xingjian:session-expired"));
    throw new ApiError(
      data?.error?.code ?? `HTTP_${response.status}`,
      data?.error?.message ?? `请求失败（HTTP ${response.status}）`,
      response.status,
      data?.error?.details,
    );
  }
  return data as T;
}
export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T>();
  const [loading, setLoading] = useState(Boolean(path));
  const [error, setError] = useState<Error>();
  const [nonce, setNonce] = useState(0);
  const previousPath = useRef<string | null>(null);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  useEffect(() => {
    const changed = previousPath.current !== path;
    previousPath.current = path;
    if (changed) setData(undefined);
    setError(undefined);
    if (!path) {
      setData(undefined);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(changed || data === undefined);
    api<T>(path, { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) {
          setData(value);
          setError(undefined);
        }
      })
      .catch((err) => {
        if (!controller.signal.aborted && err.name !== "AbortError")
          setError(err);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [path, nonce]);
  const matching = previousPath.current === path;
  return {
    data: path && matching ? data : undefined,
    loading: Boolean(path) && (!matching || loading),
    error: matching ? error : undefined,
    reload,
    setData,
  };
}
export function endpoint(wid: string, tail: string) {
  return `/api/w/${encodeURIComponent(wid)}${tail}`;
}
export function query(values: Record<string, string | undefined>) {
  const p = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    if (value) p.set(key, value);
  return p.size ? `?${p}` : "";
}
export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "操作未完成，请重试。";
}
export function useOperation() {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const locked = useRef(false);
  async function run<T>(
    fn: () => Promise<T>,
    success?: string,
  ): Promise<T | undefined> {
    if (locked.current) return undefined;
    locked.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const value = await fn();
      if (success) setMessage(success);
      return value;
    } catch (err) {
      setError(errorMessage(err));
      return undefined;
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  return {
    busy,
    error,
    message,
    run,
    clear: () => {
      setError("");
      setMessage("");
    },
  };
}
export function download(
  filename: string,
  data: BlobPart,
  type = "application/json;charset=utf-8",
) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function date(value?: string) {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.valueOf())
    ? value
    : d.toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
}
export function safeUrl(value?: string) {
  if (!value) return undefined;
  try {
    const u = new URL(value);
    return ["http:", "https:"].includes(u.protocol) ? u.href : undefined;
  } catch {
    return undefined;
  }
}
export function modelIds(models?: (string | { id?: string; name?: string })[]) {
  return [
    ...new Set(
      (models ?? [])
        .map((m) => (typeof m === "string" ? m : (m.id ?? m.name ?? "")))
        .filter(Boolean),
    ),
  ];
}
