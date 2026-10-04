import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError, api } from "../src/api.js";
import {
  createQuickCredentials,
  credentialsText,
  registerQuickAccount,
} from "../src/accountCredentials.js";
const c = {
  email: "jj-fixture@id.jijian.invalid",
  password: "fixture-password-not-a-user-secret",
  name: "隔离测试",
};
const session = {
  user: { id: "fixture", email: c.email, name: c.name },
  workspaces: [],
  csrf: "fixture",
};
const mock = (fn: (path: string, options: any) => Promise<unknown>) =>
  fn as typeof api;

test("quick credentials use secure random identifiers and strong bounded passwords", () => {
  const values = Array.from({ length: 12 }, () => createQuickCredentials());
  assert.equal(new Set(values.map((v) => v.email)).size, 12);
  assert.equal(new Set(values.map((v) => v.password)).size, 12);
  for (const v of values) {
    assert.match(v.email, /^jj-[0-9a-f]{32}@id\.jijian\.invalid$/);
    assert.match(v.password, /^Aa7-[A-Za-z0-9_-]{24}$/);
    assert.equal(v.password.length, 28);
  }
});
test("credential export states its plaintext and non-mail identity boundaries", () => {
  const text = credentialsText(c, "https://workbench.example.test");
  assert(text.includes(c.email) && text.includes(c.password));
  assert.match(text, /登录地址：https:\/\/workbench.example.test\/login/);
  assert.match(text, /妥善保管账号和密码/);
  assert.match(text, /包含明文密码/);
  assert.match(text, /不是邮箱/);
});
test("first quick registration uses the existing auth contract once", async () => {
  const calls: string[] = [];
  const result = await registerQuickAccount(
    c,
    false,
    mock(async (path, options) => {
      calls.push(path);
      assert.equal(options.method, "POST");
      assert.deepEqual(options.body, c);
      return session;
    }),
  );
  assert.deepEqual(calls, ["/api/auth/register"]);
  assert.deepEqual(result, session);
});
test("duplicate registration reconciles only with the same login credentials", async () => {
  const calls: string[] = [];
  await registerQuickAccount(
    c,
    false,
    mock(async (path, o) => {
      calls.push(path);
      if (path.endsWith("register"))
        throw new ApiError("EMAIL_EXISTS", "exists", 409);
      assert.deepEqual(o.body, { email: c.email, password: c.password });
      return session;
    }),
  );
  assert.deepEqual(calls, ["/api/auth/register", "/api/auth/login"]);
});
test("unknown registration failure is not retried automatically", async () => {
  const calls: string[] = [];
  await assert.rejects(
    registerQuickAccount(
      c,
      false,
      mock(async (path) => {
        calls.push(path);
        throw new ApiError("NETWORK", "network", 0);
      }),
    ),
    /network/,
  );
  assert.deepEqual(calls, ["/api/auth/register"]);
});
test("explicit retry resolves a committed registration via login without another registration", async () => {
  const calls: string[] = [];
  await registerQuickAccount(
    c,
    true,
    mock(async (path, o) => {
      calls.push(path);
      assert.deepEqual(o.body, { email: c.email, password: c.password });
      return session;
    }),
  );
  assert.deepEqual(calls, ["/api/auth/login"]);
});
test("explicit retry registers same identity only when login confirms it is not valid", async () => {
  const calls: string[] = [];
  await registerQuickAccount(
    c,
    true,
    mock(async (path, o) => {
      calls.push(path);
      if (path.endsWith("login"))
        throw new ApiError("LOGIN_INVALID", "invalid", 401);
      assert.deepEqual(o.body, c);
      return session;
    }),
  );
  assert.deepEqual(calls, ["/api/auth/login", "/api/auth/register"]);
});
test("retry network and server failures never fall through to registration", async () => {
  for (const code of ["NETWORK", "HTTP_503"]) {
    const calls: string[] = [];
    await assert.rejects(
      registerQuickAccount(
        c,
        true,
        mock(async (path) => {
          calls.push(path);
          throw new ApiError(code, "unavailable", 503);
        }),
      ),
      /unavailable/,
    );
    assert.deepEqual(calls, ["/api/auth/login"]);
  }
});
