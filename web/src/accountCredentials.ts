import { api, ApiError } from "./api";
import type { Session } from "./types";

export type QuickCredentials = {
  email: string;
  password: string;
  name: string;
};
const alphabet =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
export function createQuickCredentials(): QuickCredentials {
  if (!globalThis.crypto?.getRandomValues)
    throw new Error(
      "无法安全生成密码，请使用 HTTPS 或本机地址访问，或手动注册。",
    );
  const bytes = crypto.getRandomValues(new Uint8Array(40));
  const id = Array.from(bytes.slice(0, 16), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  return {
    email: `jj-${id}@id.jijian.invalid`,
    password:
      "Aa7-" + Array.from(bytes.slice(16), (b) => alphabet[b & 63]).join(""),
    name: `集见用户 ${id.slice(0, 6)}`,
  };
}
export function credentialsText(c: QuickCredentials, origin: string): string {
  return `集见工作台账号\n登录地址：${origin}/login\n账号：${c.email}\n密码：${c.password}\n\n请妥善保管账号和密码，不要分享或上传到公开位置。\n此文件包含明文密码，请存入密码管理器或加密位置。\n自动生成的账号不是邮箱，不会收到邮件。遗失账密需联系实例管理员按恢复流程处理。\n`;
}
// Unknown results never generate another identity. An explicit retry tries the
// same login first, reconciling a committed registration whose response was lost.
export async function registerQuickAccount(
  c: QuickCredentials,
  retry = false,
  request = api,
): Promise<Session> {
  const login = () =>
    request<Session>("/api/auth/login", {
      method: "POST",
      body: { email: c.email, password: c.password },
    });
  if (retry) {
    try {
      return await login();
    } catch (error) {
      if (!(error instanceof ApiError && error.code === "LOGIN_INVALID"))
        throw error;
    }
  }
  try {
    return await request<Session>("/api/auth/register", {
      method: "POST",
      body: c,
    });
  } catch (error) {
    if (error instanceof ApiError && error.code === "EMAIL_EXISTS")
      return login();
    throw error;
  }
}
