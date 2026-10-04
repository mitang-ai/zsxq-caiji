import { chromium } from "playwright";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import {
  createBundle,
  fragmentsFor,
  sha256,
  validateBundle,
} from "../shared/transfer.js";
import { readArchive } from "../extension/archive.js";
import { strFromU8, unzipSync } from "fflate";
import { brand } from "../shared/brand.js";

// Isolated browser profiles and explicit fixture files only; never user profiles.
mkdirSync("test-output", { recursive: true });
const text =
  "隔离验收材料。这不是产品中的示例数据。\n\n第二段：原文、批注和人工稿分开。";
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
      title: "浏览器验收专用材料",
      text,
      created_at: "2026-10-02T12:00:00+0800",
      source_url: "https://wx.zsxq.com/topic/900719925474099312",
      coverage: {
        body: "complete",
        comments: "partial",
        attachments: "complete",
        reasons: ["isolated test fixture"],
      },
      fragments: fragmentsFor(text),
      hash: sha256(text),
      captured_at: new Date().toISOString(),
    },
  ],
});
const report: any[] = [];
for (const channel of ["chrome", "msedge"] as const) {
  const temp = mkdtempSync(join(tmpdir(), "xingjian-extension-e2e-"));
  let context;
  try {
    context = await chromium.launchPersistentContext(join(temp, "profile"), {
      channel,
      headless: true,
      ignoreDefaultArgs: ["--disable-extensions"],
      args: ["--enable-unsafe-extension-debugging"],
      viewport: { width: 1440, height: 960 },
    });
    const unpacked = join(temp, "release-extension");
    const entries = unzipSync(
      readFileSync(
        resolve(
          "release",
          "jijian-" +
            (channel === "chrome" ? "chrome" : "edge") +
            "-v" +
            brand.version +
            ".zip",
        ),
      ),
    );
    for (const [name, bytes] of Object.entries(entries)) {
      assert(
        !name.startsWith("/") && !name.includes("..") && !name.includes("\\"),
        "unsafe archive path",
      );
      const file = join(unpacked, name);
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, bytes);
    }
    const cdp = await context.browser()!.newBrowserCDPSession();
    const result = await cdp.send("Extensions.loadUnpacked", {
      path: unpacked,
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("dialog", (d) => void d.accept());
    await page.goto(`chrome-extension://${result.id}/workbench.html`);
    await page
      .getByRole("heading", { name: "本地资料", exact: true })
      .waitFor();
    assert.match(await page.locator("body").innerText(), /还没有本地资料/);
    const file = join(temp, "bundle.json");
    writeFileSync(file, JSON.stringify(bundle));
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "导入资料包", exact: true }).click();
    await (await chooser).setFiles(file);
    await page.getByText("浏览器验收专用材料", { exact: true }).waitFor();
    await page.getByText("浏览器验收专用材料", { exact: true }).click();
    await page
      .getByRole("heading", { name: "浏览器验收专用材料", exact: true })
      .waitFor();
    assert.match(await page.locator("body").innerText(), /第二段/);
    const download = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "导出此帖 Markdown", exact: true })
      .click();
    const md = await download;
    const mdPath = await md.path();
    assert.match(readFileSync(mdPath!, "utf8"), /隔离验收材料/);
    await page.reload();
    await page.getByText("浏览器验收专用材料", { exact: true }).waitFor();
    await page.getByRole("checkbox").first().check();
    await page.getByRole("button", { name: /同步/ }).first().click();
    await page
      .getByRole("heading", { name: "显式同步", exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "检查本次资料包与目标", exact: true })
      .click();
    const zipDownload = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "导出此包 ZIP", exact: true })
      .click();
    const z = await zipDownload;
    const zipPath = await z.path();
    const archive = readArchive(new Uint8Array(readFileSync(zipPath!)));
    const exported = validateBundle(
      JSON.parse(strFromU8(archive["bundle.json"])),
    );
    assert.equal(exported.records[0].text, text);
    assert.equal(exported.records.length, 1);
    await page.screenshot({
      path: resolve(`test-output/extension-${channel}.png`),
      fullPage: true,
    });
    const side = await context.newPage();
    await side.goto(`chrome-extension://${result.id}/sidepanel.html`);
    await side
      .getByRole("heading", { name: "从当前星球留下材料", exact: true })
      .first()
      .waitFor();
    assert.equal(errors.length, 0, errors.join("\n"));
    report.push({
      browser: channel,
      version: context.browser()!.version(),
      extension_id: result.id,
      loaded: "native-installed",
      independent_import: true,
      reader: true,
      markdown_readback: true,
      zip_digest_readback: true,
      persistence_reload: true,
      sidepanel_render: true,
      page_errors: errors,
    });
  } catch (e: any) {
    report.push({ browser: channel, error: e.message });
    writeFileSync(
      "test-output/extension-e2e.json",
      JSON.stringify(report, null, 2),
    );
    throw e;
  } finally {
    await context?.close();
    rmSync(temp, { recursive: true, force: true });
  }
}
writeFileSync(
  "test-output/extension-e2e.json",
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
