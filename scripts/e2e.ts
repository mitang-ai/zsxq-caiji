import { chromium } from "playwright";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import {
  createBundle,
  fragmentsFor,
  sha256,
  validateBundle,
} from "../shared/transfer.js";

// Final built artifacts, isolated data, explicit imported fixture file.
// Provider is a controlled transport response, not a live model acceptance.
const { createApp } = await import(
  pathToFileURL(resolve("dist/server/index.mjs")).href
);
const temp = mkdtempSync(join(tmpdir(), "xingjian-web-e2e-"));
mkdirSync("test-output", { recursive: true });
let modelCalls = 0;
const report: any = {
  at: new Date().toISOString(),
  artifact: "dist/server/index.mjs + dist/web",
  live_model_verified: false,
  live_authenticated_source_verified: false,
  checks: [],
  screens: [],
};
const { app, store } = await createApp({
  dataDir: join(temp, "data"),
  worker: true,
  staticRoot: resolve("dist/web"),
  runtime: {
    request: async () => {
      modelCalls++;
      const text = JSON.stringify({
        title: "隔离验收加工输出",
        body: "## 整理\n固定版本证据 [S1]\n\n| 条件 | 结论 |\n| --- | --- |\n| 验收 | 仅测试 |",
        citations: ["S1"],
      });
      const json = JSON.stringify({
        model: "fixture-model",
        choices: [{ finish_reason: "stop", message: { content: text } }],
        usage: { prompt_tokens: 120, completion_tokens: 80 },
      });
      return {
        status: 200,
        text: json,
        bytes: Buffer.from(json),
        headers: new Headers(),
      };
    },
  },
});
await app.listen({ host: "127.0.0.1", port: 0 });
const address = app.server.address() as any,
  url = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 960 },
  acceptDownloads: true,
});
const page = await context.newPage();
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", (d) => void d.accept());
try {
  await page.goto(url + "/register");
  await page.getByLabel(/称呼/).fill("隔离验收用户");
  await page.getByLabel(/邮箱/).fill("web-e2e@example.test");
  await page.getByLabel(/密码/).fill("Isolated-test-password-2026!");
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  await page.getByRole("heading", { name: "收件箱", exact: true }).waitFor();
  assert.match(await page.locator("main").innerText(), /还没有待整理资料/);
  report.checks.push("register + genuine empty workspace");
  const me = await (await context.request.get(url + "/api/me")).json(),
    wid = me.workspaces[0].id;
  const api = async (path: string, data?: any, method = "POST") => {
    const res = await context.request.fetch(url + path, {
      method,
      data,
      headers: { "x-csrf-token": me.csrf, origin: url },
    });
    assert(res.ok(), `${method} ${path} ${res.status()} ${await res.text()}`);
    return res.json();
  };
  const text =
    "隔离验收文件，不是应用中的示例内容。\n\n出处与人工加工必须分开。";
  const bundle = createBundle({
    records: [
      {
        source_key: {
          platform: "zsxq",
          group_id: "89",
          entity_type: "topic",
          entity_id: "900719925474099312",
        },
        group_id: "89",
        author_id: "7",
        author_name: "隔离测试作者",
        title: "验收原文",
        text,
        created_at: "2026-10-02T12:00:00+0800",
        source_url: "https://wx.zsxq.com/topic/900719925474099312",
        coverage: {
          body: "complete",
          comments: "partial",
          attachments: "complete",
          reasons: ["isolated fixture"],
        },
        fragments: fragmentsFor(text),
        captured_at: "2026-10-03T00:00:00Z",
        hash: sha256(text),
      },
    ],
  });
  const file = join(temp, "fixture.json");
  writeFileSync(file, JSON.stringify(bundle));
  await page.goto(url + "/settings/data");
  await page.getByLabel("选择迁移包", { exact: true }).setInputFiles(file);
  await page.getByRole("button", { name: /确认导入/ }).click();
  await page
    .getByRole("heading", { name: "服务端导入回执", exact: true })
    .waitFor();
  await page.getByRole("link", { name: "查看资料库", exact: true }).click();
  await page.getByRole("heading", { name: "验收原文", exact: true }).waitFor();
  report.checks.push("UI import preview + authoritative receipt");
  const materials = await api(`/api/w/${wid}/materials`, undefined, "GET");
  assert.equal(materials.length, 1);
  const mid = materials[0].id;
  await page
    .getByRole("link")
    .filter({
      has: page.getByRole("heading", { name: "验收原文", exact: true }),
    })
    .click();
  await page.getByRole("heading", { name: "验收原文", exact: true }).waitFor();
  assert.match(
    await page.locator(".reader-body").innerText(),
    /出处与人工加工/,
  );
  await page.getByRole("button", { name: "标为已读", exact: true }).click();
  await page.getByRole("button", { name: "标为未读", exact: true }).waitFor();
  assert.equal(
    (await api(`/api/w/${wid}/materials/${mid}`, undefined, "GET")).status,
    "read",
  );
  report.checks.push("reader + personal read-state persistence");
  await page.goto(url + "/settings/models");
  await page.getByRole("button", { name: "添加服务", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/名称/).fill("隔离验收 Provider");
  await dialog
    .getByLabel(/Base URL/)
    .fill("https://fixture-provider.example/v1");
  await dialog.getByLabel(/默认模型 ID/).fill("fixture-model");
  await dialog.getByLabel(/API Key/).fill("isolated-fixture-not-a-real-key");
  await dialog.getByRole("button", { name: "保存配置", exact: true }).click();
  await page
    .getByRole("heading", { name: "隔离验收 Provider", exact: true })
    .waitFor();
  assert.equal(modelCalls, 0, "saving a provider never calls it");
  report.checks.push("personal Provider UI + no unintended call");
  await page.goto(url + "/process");
  await page.getByRole("button", { name: /单帖深读/ }).click();
  await page.getByLabel(/这次希望解决的问题/).fill("检查固定证据和人工采纳链");
  await page.getByRole("checkbox").filter({ visible: true }).first().check();
  await page
    .getByLabel(/模型连接/)
    .selectOption({ label: "隔离验收 Provider" });
  await page.getByRole("button", { name: "检查执行计划", exact: true }).click();
  await page
    .getByRole("button", { name: "建立待批准计划", exact: true })
    .click();
  await page.getByRole("heading", { name: "加工任务", exact: true }).waitFor();
  assert.equal(modelCalls, 0);
  await page.getByRole("button", { name: "批准执行", exact: true }).click();
  await page
    .getByText("流程完成，成果保留为草稿", { exact: true })
    .waitFor({ timeout: 15000 });
  assert.equal(modelCalls, 1);
  const jobs = await api(`/api/w/${wid}/jobs`, undefined, "GET");
  const job = jobs[0];
  assert.equal(job.state, "completed");
  const aid = job.artifact_ids[0];
  const artifact = await api(
    `/api/w/${wid}/artifacts/${aid}`,
    undefined,
    "GET",
  );
  assert.equal(artifact.citations[0].revision_id, materials[0].revision_id);
  report.checks.push(
    "manual outbound approval + durable job + exact-version draft",
  );
  await page.goto(url + "/artifacts/" + aid);
  await page
    .getByLabel("成果正文 Markdown", { exact: true })
    .fill(artifact.body + "\n\n人工补充：此处仅验证编辑。");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await page
    .getByText(/已保存/)
    .first()
    .waitFor();
  const saved = await api(`/api/w/${wid}/artifacts/${aid}`, undefined, "GET");
  assert.match(saved.body, /人工补充/);
  assert.equal(saved.revisions.length, 2);
  report.checks.push("manual editor + append-only revisions");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  const md = await download;
  assert.match(readFileSync((await md.path())!, "utf8"), /人工补充/);
  report.checks.push("artifact Markdown download readback");
  await page.getByRole("button", { name: "阅读预览", exact: true }).click();
  await page.screenshot({
    path: resolve("test-output/web-artifact.png"),
    fullPage: true,
  });
  report.screens.push("web-artifact.png");
  await page.goto(url + "/settings/appearance");
  for (const [theme, label] of [
    ["paper", "浅色"],
    ["graphite", "深色"],
  ]) {
    await page.getByRole("button", { name: label, exact: true }).click();
    assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
    await page.screenshot({
      path: resolve(`test-output/web-theme-${theme}.png`),
    });
    report.screens.push(`web-theme-${theme}.png`);
  }
  await page.reload();
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "graphite",
  );
  assert.equal(
    await page.locator("html").getAttribute("data-theme"),
    "graphite",
  );
  report.checks.push(
    "neutral light/dark switches + reload preference persistence",
  );
  for (const path of [
    "/inbox",
    "/library",
    "/projects",
    "/members",
    "/process",
    "/tasks",
    "/artifacts",
    "/connections",
    "/settings/team",
    "/settings/devices",
    "/settings/agents",
    "/settings/data",
  ]) {
    await page.goto(url + path);
    await page.locator("main h1").first().waitFor();
    assert(
      !/服务暂时无法完成|没有已登录的工作空间/.test(
        await page.locator("main").innerText(),
      ),
      path,
    );
    report.checks.push(`route render ${path}`);
  }
  for (const width of [320, 390, 768, 1024, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(url + "/library");
    await page.getByRole("heading", { name: "资料库", exact: true }).waitFor();
    const metrics = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    assert(
      metrics.scroll <= metrics.client + 1,
      `horizontal overflow width=${width} ${JSON.stringify(metrics)}`,
    );
    if (width === 390 || width === 1440) {
      await page.screenshot({
        path: resolve(`test-output/web-library-${width}.png`),
      });
      report.screens.push(`web-library-${width}.png`);
    }
    report.checks.push(`responsive ${width}px no page overflow`);
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(url + "/settings/data");
  const jsonDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出 JSON", exact: true }).click();
  const out = await jsonDownload;
  const exported = validateBundle(
    JSON.parse(readFileSync((await out.path())!, "utf8")),
  );
  assert.equal(exported.records[0].text, text);
  assert.equal(exported.artifacts.length, 1);
  report.checks.push("whole workspace export digest + fixed citation readback");
  await page.getByRole("button", { name: "退出", exact: true }).click();
  await page
    .getByRole("heading", { name: "回到你的知识工作台", exact: true })
    .waitFor();
  assert.equal((await context.request.get(url + "/api/me")).status(), 401);
  report.checks.push("logout + server session invalidation");
  assert.deepEqual(errors, []);
  report.page_errors = errors;
  report.result = "passed";
  console.log(JSON.stringify(report, null, 2));
} catch (e: any) {
  report.result = "failed";
  report.error = e.message;
  await page.screenshot({
    path: resolve("test-output/web-failure.png"),
    fullPage: true,
  });
  throw e;
} finally {
  writeFileSync("test-output/web-e2e.json", JSON.stringify(report, null, 2));
  await context.close();
  await browser.close();
  await app.close();
  const target = resolve(temp);
  if (
    !target.startsWith(resolve(tmpdir()) + "\\") &&
    !target.startsWith(resolve(tmpdir()) + "/")
  )
    throw new Error("isolated cleanup path violation");
  rmSync(target, { recursive: true, force: true });
}
