import { chromium } from "playwright";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const { createApp } = await import(
  pathToFileURL(resolve("dist/server/index.mjs")).href
);
const temp = mkdtempSync(join(tmpdir(), "jijian-quick-account-"));
const { app, store } = await createApp({ dataDir: temp, worker: false });
await app.listen({ host: "127.0.0.1", port: 0 });
const url = `http://127.0.0.1:${(app.server.address() as any).port}`;
const browser = await chromium.launch({ headless: true });
const checks: string[] = [],
  errors: string[] = [];
mkdirSync("test-output/auth", { recursive: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 960 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url + "/login");
  assert(
    await page.getByText("请妥善保管账号和密码。", { exact: true }).isVisible(),
  );
  let registers = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/api/auth/register")) registers++;
  });
  await page
    .getByRole("button", { name: "一键创建账号密码", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "账号已创建，请先保存账密", exact: true })
    .waitFor();
  assert.equal(registers, 1);
  assert.equal(
    await page.getByRole("button", { name: "登录", exact: true }).count(),
    0,
  );
  const email = await page
    .getByLabel("生成的账号", { exact: true })
    .inputValue();
  const password = await page
    .getByLabel("生成的密码", { exact: true })
    .inputValue();
  assert.match(email, /^jj-[0-9a-f]{32}@id\.jijian\.invalid$/);
  assert.equal(
    await page.getByLabel("生成的密码", { exact: true }).getAttribute("type"),
    "password",
  );
  const user = store.list("user").find((u: any) => u.email === email);
  assert(user);
  assert(!JSON.stringify(user).includes(password));
  assert(
    await page
      .getByRole("button", { name: "进入工作台", exact: true })
      .isDisabled(),
  );
  assert(
    await page.evaluate(() => {
      const e = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    }),
  );
  checks.push(
    "real registration, private workspace, server-side password hashing, masked one-time credentials and leave warning",
  );
  await page.getByRole("button", { name: "复制账号密码", exact: true }).click();
  await page
    .getByRole("status")
    .getByText(/账密已复制/)
    .waitFor();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  assert(copied.includes(email) && copied.includes(password));
  await page.evaluate(() => {
    navigator.clipboard.writeText = async () => {
      throw new Error("fixture denied clipboard");
    };
  });
  await page.getByRole("button", { name: "复制账号密码", exact: true }).click();
  await page
    .getByRole("status")
    .getByText(/复制未成功/)
    .waitFor();
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载账密文件", exact: true }).click();
  const file = await downloading;
  const text = readFileSync((await file.path())!, "utf8");
  assert(text.includes(email) && text.includes(password));
  assert.match(text, /包含明文密码/);
  assert.match(text, /不是邮箱/);
  assert(
    !(await page
      .getByRole("checkbox", { name: "我已妥善保存账号和密码" })
      .isChecked()),
  );
  await page.getByRole("button", { name: "显示密码", exact: true }).click();
  assert.equal(
    await page.getByLabel("生成的密码", { exact: true }).getAttribute("type"),
    "text",
  );
  await page.getByRole("button", { name: "隐藏密码", exact: true }).click();
  checks.push(
    "actual clipboard copy, denied-copy fallback, real downloaded credential file and explicit reveal control",
  );
  for (const theme of ["paper", "graphite"]) {
    await page.getByLabel("外观", { exact: true }).selectOption(theme);
    await page.waitForFunction(
      (t) => document.documentElement.dataset.theme === t,
      theme,
    );
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        `${width} ${theme}`,
      );
    }
    await page.screenshot({
      path: `test-output/auth/save-${theme}-mobile.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1280, height: 960 });
  await page.screenshot({
    path: "test-output/auth/save-dark.png",
    fullPage: true,
  });
  checks.push(
    "credential panel renders at 320/390px in both modes without overflow",
  );
  await page.getByRole("checkbox", { name: "我已妥善保存账号和密码" }).check();
  await page.getByRole("button", { name: "进入工作台", exact: true }).click();
  await page.getByRole("heading", { name: "收件箱", exact: true }).waitFor();
  const me = await (await context.request.get(url + "/api/me")).json();
  assert.equal(me.user.id, user.id);
  assert.equal(me.workspaces.length, 1);
  assert.equal(me.workspaces[0].kind, "personal");
  assert(
    !(await page.evaluate(
      (p) =>
        JSON.stringify({ ...localStorage }).includes(p) ||
        JSON.stringify({ ...sessionStorage }).includes(p),
      password,
    )),
  );
  await page.getByRole("button", { name: "退出", exact: true }).click();
  await page
    .getByRole("heading", { name: "回到你的知识工作台", exact: true })
    .waitFor();
  assert.equal(await page.getByLabel("生成的密码", { exact: true }).count(), 0);
  await page.getByLabel(/邮箱或系统账号/).fill(email);
  await page.getByLabel("密码", { exact: false }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("heading", { name: "收件箱", exact: true }).waitFor();
  assert.equal(
    (await (await context.request.get(url + "/api/me")).json()).user.id,
    user.id,
  );
  checks.push(
    "saved credentials enter the real app, do not persist plaintext, and log back into the same account",
  );
  await context.close();

  for (const committed of [true, false]) {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(url + "/register");
    let requests = 0;
    await p.route("**/api/auth/register", async (route) => {
      requests++;
      if (requests === 1) {
        if (committed) {
          const response = await route.fetch();
          assert.equal(response.status(), 201);
        }
        await route.abort("failed");
      } else await route.continue();
    });
    await p
      .getByRole("button", { name: "一键创建账号密码", exact: true })
      .click();
    await p
      .getByRole("heading", { name: "创建结果需要确认", exact: true })
      .waitFor();
    const id = await p.getByLabel("生成的账号", { exact: true }).inputValue();
    const secret = await p
      .getByLabel("生成的密码", { exact: true })
      .inputValue();
    assert(
      await p
        .getByRole("button", { name: "重试创建或登录", exact: true })
        .isVisible(),
    );
    await p
      .getByRole("button", { name: "重试创建或登录", exact: true })
      .click();
    await p
      .getByRole("heading", { name: "账号已创建，请先保存账密", exact: true })
      .waitFor();
    assert.equal(
      await p.getByLabel("生成的账号", { exact: true }).inputValue(),
      id,
    );
    assert.equal(
      await p.getByLabel("生成的密码", { exact: true }).inputValue(),
      secret,
    );
    assert.equal(requests, committed ? 1 : 2);
    assert.equal(
      store.list("user").filter((u: any) => u.email === id).length,
      1,
    );
    await ctx.close();
    checks.push(
      committed
        ? "lost committed response reconciles the same login without another registration"
        : "pre-commit network failure retries the same credentials with one final account",
    );
  }
  assert.deepEqual(errors, []);
  writeFileSync(
    "test-output/auth/report.json",
    JSON.stringify(
      { checks, errors, isolated: true, credentialsLogged: false },
      null,
      2,
    ),
  );
  console.log(checks.map((c) => `PASS ${c}`).join("\n"));
} finally {
  await browser.close();
  await app.close();
  const target = resolve(temp);
  assert(
    target.startsWith(resolve(tmpdir()) + "\\") ||
      target.startsWith(resolve(tmpdir()) + "/"),
  );
  rmSync(target, { recursive: true, force: true });
}
