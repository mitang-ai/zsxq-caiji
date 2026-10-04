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
  await page.goto(url);
  await page.getByRole("heading", { name: /好内容，\s*别只收藏。/ }).waitFor();
  assert.equal(await page.title(), "集见 · 好内容，别只收藏。");
  const html = await (await context.request.get(url)).text();
  const og = html.match(/property="og:image" content="([^"]+)"/)![1];
  assert.match(og, /^https:\/\/zsxq\.51wanai\.com\/assets\/social-card-/);
  const card = await context.request.get(url + new URL(og).pathname);
  assert.equal(card.status(), 200);
  assert.match(card.headers()["content-type"], /image\/png/);
  await page.locator(".hero-mark .brand-page").evaluate(async (e) => {
    await Promise.all(e.getAnimations().map((a) => a.finished));
  });
  await page.screenshot({
    path: "test-output/brand/home-desktop.png",
    fullPage: true,
  });
  checks.push("public homepage, built title and actual same-origin OG asset");
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      `Homepage overflows at ${width}`,
    );
  }
  await page.screenshot({
    path: "test-output/brand/home-mobile.png",
    fullPage: true,
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(
    await page
      .locator(".hero-mark .brand-page")
      .evaluate((e) => getComputedStyle(e).animationName),
    "none",
  );
  checks.push("320/390px layout and reduced-motion fallback");
  await page.getByRole("link", { name: "安装本地插件" }).click();
  await page
    .getByRole("heading", { name: /自己的内容，\s*先留在自己这里。/ })
    .waitFor();
  for (const b of ["Chrome", "Edge"]) {
    const href = await page
      .getByRole("link", { name: `下载 ${b} 插件 ↓` })
      .getAttribute("href");
    assert.equal(
      href,
      `${brand.repository}/releases/download/v${brand.version}/jijian-${b.toLowerCase()}-v${brand.version}.zip`,
    );
  }
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  await page.screenshot({
    path: "test-output/brand/plugins-mobile.png",
    fullPage: true,
  });
  checks.push(
    "version-pinned Chrome/Edge download paths and actual install instructions",
  );
  await page.goto(url + "/register");
  await page.getByLabel(/称呼/).fill("品牌隔离验收");
  await page.getByLabel(/邮箱/).fill("brand-check@example.test");
  await page.getByLabel(/密码/).fill("Brand-isolated-test-2026!");
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  await page.getByRole("heading", { name: "收件箱", exact: true }).waitFor();
  const me = await (await context.request.get(url + "/api/me")).json();
  await page.evaluate(
    ({ id, wid }) => {
      localStorage.setItem(
        `xingjian.preferences.${id}`,
        JSON.stringify({
          theme: "graphite",
          density: "comfortable",
          reader: 17,
          contrast: false,
        }),
      );
      localStorage.setItem(`xingjian.workspace.${id}`, wid);
    },
    { id: me.user.id, wid: me.workspaces[0].id },
  );
  await page.goto(url);
  await page.getByRole("heading", { name: "收件箱", exact: true }).waitFor();
  assert.equal(
    await page.locator("html").getAttribute("data-theme"),
    "graphite",
  );
  assert.match(await page.locator(".sidebar .brand").innerText(), /集见/);
  assert.equal(await page.locator(".landing-hero").count(), 0);
  checks.push(
    "existing xingjian preferences restored; authenticated root skips marketing",
  );
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.screenshot({
    path: "test-output/brand/workbench-graphite.png",
    fullPage: true,
  });
  await page.goto(url + "/welcome");
  await page.getByRole("heading", { name: /好内容，\s*别只收藏。/ }).waitFor();
  assert.equal(
    await page
      .locator(".public-shell")
      .evaluate((e) => getComputedStyle(e).backgroundColor),
    "rgb(250, 248, 244)",
  );
  await page.goto(url + "/plugins");
  await page
    .getByRole("heading", { name: /自己的内容，\s*先留在自己这里。/ })
    .waitFor();
  assert.equal((await context.request.get(url + "/api/me")).status(), 200);
  checks.push(
    "public routes preserve authenticated session and theme isolation",
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
