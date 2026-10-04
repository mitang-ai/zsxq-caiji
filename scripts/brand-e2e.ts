import { chromium } from "playwright";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { brand } from "../shared/brand.js";
const { createApp } = await import(
  pathToFileURL(resolve("dist/server/index.mjs")).href
);
const temp = mkdtempSync(join(tmpdir(), "jijian-brand-e2e-"));
const { app } = await createApp({ dataDir: temp, worker: false });
await app.listen({ host: "127.0.0.1", port: 0 });
const url = `http://127.0.0.1:${(app.server.address() as any).port}`;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 960 },
});
const page = await context.newPage(),
  errors: string[] = [],
  checks: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
mkdirSync("test-output/brand", { recursive: true });
try {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto(url);
  await page.getByRole("heading", { name: "把讨论整理成自己的资料" }).waitFor();
  assert.equal(await page.title(), "集见知识工作台");
  const html = await (await context.request.get(url)).text();
  const og = html.match(/property="og:image" content="([^"]+)"/)![1];
  assert.match(og, /^https:\/\/zsxq\.51wanai\.com\/assets\/social-card-/);
  const card = await context.request.get(url + new URL(og).pathname);
  assert.equal(card.status(), 200);
  assert.match(card.headers()["content-type"], /image\/png/);
  assert.equal(await page.locator(".hero-mark").count(), 0);
  assert.equal(
    await page.locator("h1").evaluate((e) => getComputedStyle(e).fontSize),
    "28px",
  );
  assert.equal(
    await page
      .locator(".public-shell")
      .evaluate((e) => getComputedStyle(e).backgroundColor),
    "rgb(255, 255, 255)",
  );
  assert(!/[·•]/.test(await page.locator(".public-shell").innerText()));
  checks.push(
    "neutral white homepage, restrained title, no decorative separators, actual OG asset",
  );
  for (const [theme, color] of [
    ["paper", "rgb(255, 255, 255)"],
    ["graphite", "rgb(24, 24, 24)"],
  ] as const) {
    await page.getByLabel("外观", { exact: true }).selectOption(theme);
    await page.waitForFunction(
      (t) => document.documentElement.dataset.theme === t,
      theme,
    );
    assert.equal(
      await page
        .locator(".public-shell")
        .evaluate((e) => getComputedStyle(e).backgroundColor),
      color,
    );
    await page.screenshot({
      path: `test-output/brand/home-${theme}.png`,
      fullPage: true,
    });
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        `Homepage overflows at ${width} ${theme}`,
      );
      assert.equal(
        await page.locator("h1").evaluate((e) => getComputedStyle(e).fontSize),
        "24px",
      );
    }
    await page.screenshot({
      path: `test-output/brand/home-mobile-${theme}.png`,
      fullPage: true,
    });
    await page.setViewportSize({ width: 1440, height: 960 });
  }
  await page.reload();
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "graphite",
  );
  await page.getByLabel("外观", { exact: true }).selectOption("system");
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "paper",
  );
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "graphite",
  );
  await page.getByLabel("外观", { exact: true }).selectOption("paper");
  await page.emulateMedia({ colorScheme: "light" });
  await page.emulateMedia({ colorScheme: "dark" });
  assert.equal(await page.locator("html").getAttribute("data-theme"), "paper");
  checks.push(
    "light/dark, OS changes, explicit override and anonymous reload persistence; 320/390px layout",
  );
  await page.getByRole("link", { name: "安装本地插件", exact: true }).click();
  await page.getByRole("heading", { name: "安装集见浏览器插件" }).waitFor();
  for (const b of ["Chrome", "Edge"]) {
    assert.equal(
      await page
        .getByRole("link", { name: `下载 ${b} 插件`, exact: true })
        .getAttribute("href"),
      `${brand.repository}/releases/download/v${brand.version}/jijian-${b.toLowerCase()}-v${brand.version}.zip`,
    );
  }
  for (const theme of ["paper", "graphite"]) {
    await page.getByLabel("外观", { exact: true }).selectOption(theme);
    await page.setViewportSize({ width: 320, height: 844 });
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    );
    await page.screenshot({
      path: `test-output/brand/plugins-mobile-${theme}.png`,
      fullPage: true,
    });
  }
  checks.push(
    "both version-pinned downloads and mobile installation page in both modes",
  );
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(url + "/login");
  await page.getByLabel("外观", { exact: true }).selectOption("paper");
  await page.goto(url + "/recovery");
  assert.equal(await page.locator("html").getAttribute("data-theme"), "paper");
  await page.getByLabel("外观", { exact: true }).selectOption("graphite");
  await page.goto(url + "/register");
  await page.getByLabel(/称呼/).fill("外观隔离验收");
  await page.getByLabel(/邮箱/).fill("brand-check@example.test");
  await page.getByLabel(/密码/).fill("Brand-isolated-test-2026!");
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  await page.getByRole("heading", { name: "收件箱", exact: true }).waitFor();
  const me = await (await context.request.get(url + "/api/me")).json();
  for (const theme of ["warm", "mist", "graphite"]) {
    await page.evaluate(
      ({ id, wid, theme }) => {
        localStorage.setItem(
          `xingjian.preferences.${id}`,
          JSON.stringify({
            theme,
            density: "compact",
            reader: 19,
            contrast: false,
          }),
        );
        localStorage.setItem(`xingjian.workspace.${id}`, wid);
      },
      { id: me.user.id, wid: me.workspaces[0].id, theme },
    );
    await page.goto(url);
    await page.getByRole("heading", { name: "收件箱", exact: true }).waitFor();
    await page.waitForFunction(
      (t) => document.documentElement.dataset.theme === t,
      theme === "graphite" ? "graphite" : "paper",
    );
    assert.equal(
      await page.locator("html").getAttribute("data-density"),
      "compact",
    );
    assert.equal(
      await page
        .locator("html")
        .evaluate((e) => e.style.getPropertyValue("--reader-size")),
      "19px",
    );
  }
  assert.match(await page.locator(".sidebar .brand").innerText(), /集见/);
  assert.equal(await page.locator(".public-shell").count(), 0);
  await page.screenshot({
    path: "test-output/brand/workbench-graphite.png",
    fullPage: true,
  });
  await page.getByLabel("外观", { exact: true }).selectOption("paper");
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "paper",
  );
  await page.locator(".button").evaluateAll(async (elements) => {
    await Promise.all(
      elements.flatMap((e) => e.getAnimations().map((a) => a.finished)),
    );
  });
  assert.equal(
    await page
      .locator(".button.primary")
      .first()
      .evaluate((e) => getComputedStyle(e).color),
    "rgb(255, 255, 255)",
  );
  assert.equal(
    await page
      .locator(".header-actions .button:not(.primary)")
      .first()
      .evaluate((e) => getComputedStyle(e).backgroundColor),
    "rgb(255, 255, 255)",
  );
  await page.screenshot({
    path: "test-output/brand/workbench-paper.png",
    fullPage: true,
  });
  checks.push(
    "authenticated app, header switch, legacy warm/mist migration and reader/density preservation",
  );
  await page.goto(url + "/welcome");
  await page.getByRole("heading", { name: "把讨论整理成自己的资料" }).waitFor();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "paper");
  await page.getByLabel("外观", { exact: true }).selectOption("graphite");
  await page.goto(url + "/plugins");
  await page.getByRole("heading", { name: "安装集见浏览器插件" }).waitFor();
  assert.equal(
    await page.locator("html").getAttribute("data-theme"),
    "graphite",
  );
  assert.equal((await context.request.get(url + "/api/me")).status(), 200);
  checks.push(
    "public routes share user appearance without losing login; account pages support both modes",
  );
  for (const b of ["chrome", "edge"]) {
    const m = JSON.parse(
      readFileSync(`extension/dist/${b}/manifest.json`, "utf8"),
    );
    assert.equal(m.version, brand.version);
    assert.match(m.name, /^集见/);
    for (const size of [16, 32, 48, 128]) {
      const png = readFileSync(`extension/dist/${b}/${m.icons[size]}`);
      assert.equal(png.readUInt32BE(16), size);
      assert.equal(png.readUInt32BE(20), size);
    }
  }
  checks.push("both final extension manifests and real PNG dimensions");
  assert.deepEqual(errors, []);
  const health = await (await context.request.get(url + "/api/health")).json();
  assert.equal(health.version, brand.version);
  assert.equal(health.service, "xingjian");
  checks.push(
    "release health version, stable service identifier, no browser exceptions",
  );
  writeFileSync(
    "test-output/brand/report.json",
    JSON.stringify({ checks, errors, fixturesOnly: true }, null, 2),
  );
  console.log(checks.map((c) => `PASS ${c}`).join("\n"));
} finally {
  await browser.close();
  await app.close();
  rmSync(temp, { recursive: true, force: true });
}
