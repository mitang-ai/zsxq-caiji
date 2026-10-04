import { chromium, type BrowserContext, type Page } from "playwright";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve, relative } from "node:path";
import assert from "node:assert/strict";
import { zipSync, strToU8 } from "fflate";
import { createApp } from "../server/index.js";
import {
  createBundle,
  fragmentsFor,
  recordVersionHash,
  sha256,
  validateBundle,
  type SourceRecord,
} from "../shared/transfer.js";

// Real installed browser + real MV3 permissions + real HTTP. Only the imported
// source records and bytes are fixtures. Never use a user profile or port 4318.
// Native phase: no pregrants or permission mocks. Transport phase: a separately
// cloned fixture manifest adds one explicit test host grant; identical product
// JS then runs real HTTP. This is NOT native optional-permission acceptance.
// --headed-native permits a tester to confirm the native prompt in an isolated
// visible window; no native desktop automation is performed by this script.
const output = resolve("test-output");
mkdirSync(output, { recursive: true });
const selectedCase = process.argv
  .find((arg) => arg.startsWith("--case="))
  ?.slice(7);
const cases = ["native-permission", "transport-automation-pregrant"].flatMap(
  (mode) => ["chrome", "msedge"].map((browser) => `${browser}:${mode}`),
);
if (selectedCase && !cases.includes(selectedCase))
  throw new Error("Unknown isolated test case");
const reportPath = join(
  output,
  selectedCase
    ? `extension-sync-${selectedCase.replace(":", "-")}.json`
    : "extension-sync-e2e.json",
);
const report: any = {
  at: new Date().toISOString(),
  script: "scripts/extension-sync-e2e.ts",
  isolation:
    "fresh OS-temp data directory and browser profile per browser; random loopback port; worker disabled",
  live_authenticated_source_verified: false,
  live_provider_verified: false,
  native_permission_prompt_visual_verified: false,
  browsers: [],
  transport_method:
    "automation-pregrant/not-native-confirmed: separate fresh profile; temp manifest clone with only fixture loopback host grant; product JS unchanged",
  process_isolation: "one case per Node child process",
};
if (existsSync(join(output, "extension-sync-native-crash-run.log")))
  report.unresolved_native_crash = {
    exit_code: -1073740791,
    windows_status: "0xC0000409",
    observed_stage:
      "third case startup after two native-permission cases; exact native failing component not established",
    command:
      "npx.cmd tsx scripts/extension-sync-e2e.ts (initial same-process case loop)",
    evidence: [
      "test-output/extension-sync-native-crash-run.log",
      "test-output/extension-sync-native-crash-prior.json",
    ],
    minimum_reproduction:
      "node --input-type=module -e \"import {cpSync,mkdtempSync} from 'node:fs';import {join,resolve} from 'node:path';import {tmpdir} from 'node:os';const d=mkdtempSync(join(tmpdir(),'xingjian-extension-sync-copyrepro-'));cpSync(resolve('extension/dist/chrome'),join(d,'clone'),{recursive:true});\"",
    minimum_reproduction_evidence:
      "test-output/extension-sync-copy-crash-repro.log",
    narrowing:
      "pure fs.cpSync directory clone reproduces 0xC0000409 without importing server or Playwright; fixture clone now uses bounded read/write of fixed resources",
    cause:
      "underlying native filesystem fail-fast unresolved; not attributed to SQLite, Chrome/Edge or product logic",
  };
const text =
  "隔离同步验收原文：本地资料与云端身份必须分开。\n\n同正文的标题、覆盖范围变更也必须留下不可变版本。";
const bytes = Uint8Array.from(
  { length: 2 * 1024 * 1024 + 137 },
  (_, i) => (i * 37 + (i >>> 8)) % 256,
);
const attachmentHash = sha256(bytes);
const old: SourceRecord = {
  source_key: {
    platform: "zsxq",
    group_id: "89",
    entity_type: "topic",
    entity_id: "900719925474099312",
  },
  group_id: "89",
  author_id: "7",
  author_name: "隔离同步验收作者",
  title: "隔离同步验收原文·旧标题",
  text,
  created_at: "2026-10-02T12:00:00+0800",
  source_url: "https://wx.zsxq.com/topic/900719925474099312",
  coverage: {
    body: "complete",
    comments: "partial",
    attachments: "partial",
    reasons: ["isolated fixture; source access not verified"],
  },
  fragments: fragmentsFor(text),
  hash: sha256(text),
  captured_at: "2026-10-03T00:00:00Z",
  files: [
    {
      id: "59",
      name: "isolated-sync-2MiB.bin",
      size: bytes.length,
      mime: "application/octet-stream",
    },
  ],
};
old.version_hash = recordVersionHash(old);
const current: SourceRecord = {
  ...structuredClone(old),
  title: "隔离同步验收原文·新标题",
  coverage: {
    ...old.coverage,
    attachments: "complete",
    reasons: ["isolated imported binary; not a claim of source authenticity"],
  },
  captured_at: "2026-10-03T00:01:00Z",
  version_hash: undefined,
};
current.version_hash = recordVersionHash(current);
assert.notEqual(old.version_hash, current.version_hash);
const artifactTitle = "隔离同步验收成果·固定旧版引用";
const artifactBody =
  "## 本地整理\n此成果明确引用旧标题版本 [S1]，不能暗绑同正文的新标题版本。";
const bundle = createBundle({
  records: [old, current],
  annotations: [
    {
      id: "fixture-annotation",
      material_id: "foreign-material-id",
      revision_id: old.hash!,
      version_hash: old.version_hash,
      source_key: old.source_key,
      start: 0,
      end: 11,
      quote: text.slice(0, 11),
      note: "隔离验收固定版本批注",
    },
  ],
  artifacts: [
    {
      id: "fixture-artifact",
      title: artifactTitle,
      body: artifactBody,
      status: "draft",
      citations: [
        {
          material_id: "foreign-material-id",
          revision_id: old.hash!,
          version_hash: old.version_hash,
          source_key: old.source_key,
          citation_id: "S1",
          fragment_id: old.fragments[0].id,
          quote: old.fragments[0].text,
        },
      ],
    },
  ],
  attachments: [
    {
      id: "fixture-attachment",
      name: "isolated-sync-2MiB.bin",
      mime: "application/octet-stream",
      size: bytes.length,
      hash: attachmentHash,
      record_source_key: old.source_key,
      status: "available",
    },
  ],
  coverage: {
    authenticity: "client_reported",
    reference_records_included: 1,
    fixture: true,
  },
});
const archive = zipSync({
  "bundle.json": strToU8(JSON.stringify(bundle)),
  ["attachments/" + attachmentHash]: bytes,
});

function cleanup(temp: string): void {
  const absolute = resolve(temp),
    inside = relative(resolve(tmpdir()), absolute);
  if (!inside || inside.startsWith("..") || resolve(tmpdir()) === absolute)
    throw new Error("isolated cleanup path violation");
  rmSync(absolute, { recursive: true, force: true });
}

async function permissionState(page: Page, origin: string): Promise<boolean> {
  return page.evaluate(
    async (pattern) => chrome.permissions.contains({ origins: [pattern] }),
    origin + "/*",
  );
}

if (!selectedCase)
  for (const testCase of cases) {
    const childExit = await new Promise<number | null>(
      (resolveExit, reject) => {
        const child = spawn(
          process.execPath,
          [
            "--import",
            "tsx",
            resolve("scripts/extension-sync-e2e.ts"),
            "--case=" + testCase,
            ...(process.argv.includes("--headed-native")
              ? ["--headed-native"]
              : []),
          ],
          { stdio: "inherit", windowsHide: true },
        );
        child.once("error", reject);
        child.once("exit", (code) => resolveExit(code));
      },
    );
    const childReportPath = join(
      output,
      `extension-sync-${testCase.replace(":", "-")}.json`,
    );
    const childReport = existsSync(childReportPath)
      ? JSON.parse(readFileSync(childReportPath, "utf8"))
      : { browsers: [] };
    const row = childReport.browsers[0] ?? {
      browser: testCase.split(":")[0],
      mode: testCase.split(":")[1],
      result: "failed",
      error: "Child produced no report",
    };
    row.child_exit_code = childExit;
    if (childExit !== 0) {
      row.result = "failed";
      row.error ??= "Isolated child exited abnormally";
    }
    if (row.isolation_dir) {
      cleanup(row.isolation_dir);
      delete row.isolation_dir;
    }
    report.browsers.push(row);
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
  }

for (const mode of [
  "native-permission",
  "transport-automation-pregrant",
] as const)
  for (const channel of ["chrome", "msedge"] as const) {
    if (selectedCase !== `${channel}:${mode}`) continue;
    const temp = mkdtempSync(join(tmpdir(), "xingjian-extension-sync-"));
    const nativePhase = mode === "native-permission";
    const evidence: any = {
      browser: channel,
      mode,
      method: nativePhase
        ? "native-UI-gesture-request/no-pregrant"
        : "automation-pregrant/not-native-confirmed",
      result: "running",
      checks: [],
      http: [],
      page_errors: [],
      permission: {
        pregranted: !nativePhase,
        native_prompt_visual_verified: false,
      },
    };
    evidence.isolation_dir = temp;
    report.browsers.push(evidence);
    console.log(`[${channel}/${mode}] starting isolated browser/server`);
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    const checkpoint = (message: string) => {
      evidence.checks.push(message);
      writeFileSync(reportPath, JSON.stringify(report, null, 2));
      console.log(`[${channel}/${mode}] ${message}`);
    };
    let context: BrowserContext | undefined,
      app: Awaited<ReturnType<typeof createApp>>["app"] | undefined,
      page: Page | undefined;
    try {
      const created = await createApp({
        dataDir: join(temp, "data"),
        worker: false,
        staticRoot: resolve("dist/web"),
      });
      app = created.app;
      app.addHook("onResponse", async (request, reply) => {
        const path = request.url.split("?")[0];
        if (!path.startsWith("/api/")) return;
        const body = request.body as any;
        const row: any = {
          method: request.method,
          path,
          status: reply.statusCode,
          extension: /^chrome-extension:\/\/[a-p]{32}$/.test(
            String(request.headers.origin ?? ""),
          ),
          bearer: /^Bearer /.test(String(request.headers.authorization ?? "")),
          cookie: !!request.headers.cookie,
        };
        if (path.endsWith("/chunks") && body)
          Object.assign(row, {
            offset: body.offset,
            bytes: Buffer.from(body.data_base64, "base64").length,
          });
        if (path.endsWith("/import") && body?.bundle)
          Object.assign(row, {
            digest: body.bundle.digest,
            records: body.bundle.records.length,
            artifacts: body.bundle.artifacts.length,
            attachments: body.bundle.attachments.length,
            idempotency_key_present: !!request.headers["x-idempotency-key"],
          });
        evidence.http.push(row); // Do not log tokens, Cookie, pairing codes or request bodies.
      });
      await app.listen({ host: "127.0.0.1", port: 0 });
      evidence.stage = "server-listening";
      writeFileSync(reportPath, JSON.stringify(report, null, 2));
      const address = app.server.address();
      assert(address && typeof address !== "string");
      const origin = `http://127.0.0.1:${address.port}`;
      evidence.origin = origin;
      const extensionBuild = resolve(
        "extension/dist/" + (channel === "chrome" ? "chrome" : "edge"),
      );
      let extensionPath = extensionBuild;
      if (!nativePhase) {
        extensionPath = join(temp, "transport-extension");
        mkdirSync(extensionPath);
        for (const name of [
          "manifest.json",
          "ui.js",
          "background.js",
          "style.css",
          "workbench.html",
          "sidepanel.html",
        ]) {
          writeFileSync(
            join(extensionPath, name),
            readFileSync(join(extensionBuild, name)),
          );
        }
        const manifestPath = join(extensionPath, "manifest.json");
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        manifest.host_permissions = [origin + "/*"];
        writeFileSync(manifestPath, JSON.stringify(manifest));
        evidence.product_code_hashes = Object.fromEntries(
          [
            "ui.js",
            "background.js",
            "style.css",
            "workbench.html",
            "sidepanel.html",
          ].map((name) => {
            const original = readFileSync(join(extensionBuild, name)),
              clone = readFileSync(join(extensionPath, name));
            assert(original.equals(clone));
            return [name, sha256(new Uint8Array(clone))];
          }),
        );
        evidence.fixture_manifest_host_grant = manifest.host_permissions;
      }
      evidence.stage = "before-browser-launch";
      writeFileSync(reportPath, JSON.stringify(report, null, 2));
      context = await chromium.launchPersistentContext(join(temp, "profile"), {
        channel,
        headless: !(nativePhase && process.argv.includes("--headed-native")),
        ignoreDefaultArgs: ["--disable-extensions"],
        args: ["--enable-unsafe-extension-debugging"],
        viewport: { width: 1440, height: 960 },
        acceptDownloads: true,
      });
      // tsx's function-name helper can appear in serialized evaluate callbacks.
      // This does not replace any browser, permission or application API.
      await context.addInitScript("globalThis.__name = (fn) => fn;");
      context.setDefaultTimeout(12000);
      const browser = context.browser()!;
      evidence.version = browser.version();
      const cdp = await browser.newBrowserCDPSession();
      const extension = await cdp.send("Extensions.loadUnpacked", {
        path: extensionPath,
      });
      evidence.stage = "extension-loaded";
      evidence.extension_id = extension.id;
      const web = await context.newPage();
      web.on("pageerror", (error) =>
        evidence.page_errors.push("web: " + error.message),
      );
      await web.goto(origin + "/register");
      await web.getByLabel(/称呼/).fill("隔离同步验收用户");
      await web.getByLabel(/邮箱/).fill(channel + "-sync@example.test");
      await web.getByLabel(/密码/).fill("Isolated-sync-password-2026!");
      await web.getByRole("button", { name: "创建账号", exact: true }).click();
      await web.getByRole("heading", { name: "收件箱", exact: true }).waitFor();
      const meResponse = await context.request.get(origin + "/api/me");
      assert(meResponse.ok());
      const me = await meResponse.json(),
        wid: string = me.workspaces[0].id;
      const api = async (path: string) => {
        const response = await context!.request.get(origin + path);
        assert(response.ok(), `${path}: HTTP ${response.status()}`);
        return response.json();
      };
      assert.equal((await api(`/api/w/${wid}/materials`)).length, 0);
      await web.goto(origin + "/settings/devices");
      await web.getByLabel(/设备名称/).fill(channel + " 隔离同步验收");
      await web
        .getByRole("button", { name: "生成一次性配对码", exact: true })
        .click();
      await web.locator(".pair-code strong").waitFor();
      const code = await web.locator(".pair-code strong").innerText();
      checkpoint(
        "real Web UI register + empty isolated workspace + one-time pairing code",
      );

      page = await context.newPage();
      page.on("pageerror", (error) =>
        evidence.page_errors.push("extension: " + error.message),
      );
      const dialogs: string[] = [];
      page.on("dialog", (dialog) => {
        dialogs.push(dialog.message());
        void dialog.accept();
      });
      await page.goto(`chrome-extension://${extension.id}/workbench.html`);
      await page
        .getByRole("heading", { name: "本地资料", exact: true })
        .waitFor();
      assert.match(await page.locator("main").innerText(), /还没有本地资料/);
      const fixtureFile = join(temp, "fixture.zip");
      writeFileSync(fixtureFile, archive);
      const chooser = page.waitForEvent("filechooser");
      await page
        .getByRole("button", { name: "导入资料包", exact: true })
        .click();
      await (await chooser).setFiles(fixtureFile);
      await page
        .getByRole("button", { name: current.title, exact: true })
        .waitFor();
      await page
        .getByRole("checkbox", { name: "选择 " + current.title, exact: true })
        .check();
      await page
        .getByRole("button", { name: /本地成果/ })
        .first()
        .click();
      await page
        .getByRole("checkbox", {
          name: "选择成果 " + artifactTitle,
          exact: true,
        })
        .check();
      await page.getByRole("button", { name: /同步/ }).first().click();
      await page
        .getByRole("heading", { name: "显式同步", exact: true })
        .waitFor();
      const before = await permissionState(page, origin);
      evidence.permission.before = before;
      assert.equal(
        before,
        !nativePhase,
        "host grant must match the declared native/controlled transport verification layer",
      );
      // Observational wrapper only. Every request invokes the original native API.
      // Captures whether the actual product submit handler retained user activation.
      await page.evaluate(() => {
        const root = globalThis as any;
        root.__permissionObservations = [];
        const nativeRequest = chrome.permissions.request.bind(
          chrome.permissions,
        );
        chrome.permissions.request = ((
          permissions: chrome.permissions.Permissions,
        ) => {
          const observation = {
            origins: permissions.origins,
            user_activation: navigator.userActivation.isActive,
            granted: null as boolean | null,
            error: "",
          };
          root.__permissionObservations.push(observation);
          return nativeRequest(permissions).then(
            (granted) => {
              observation.granted = granted;
              return granted;
            },
            (error) => {
              observation.error = String(error);
              throw error;
            },
          );
        }) as typeof chrome.permissions.request;
      });
      await page
        .getByLabel("工作台 origin（不含路径）", { exact: true })
        .fill(origin);
      await page.getByLabel("工作台设备页配对码", { exact: true }).fill(code);
      await page
        .getByLabel("本机设备名称", { exact: true })
        .fill(channel + " 隔离同步验收");
      await page
        .getByRole("button", { name: "配对指定工作台", exact: true })
        .click();
      try {
        await page
          .getByRole("button", { name: "解除本机配对", exact: true })
          .waitFor({
            timeout:
              nativePhase && process.argv.includes("--headed-native")
                ? 90000
                : 12000,
          });
      } catch {
        evidence.permission.calls = await page.evaluate(
          () => (globalThis as any).__permissionObservations,
        );
        evidence.permission.after = await permissionState(page, origin);
        if (!nativePhase || evidence.permission.after)
          throw new Error(
            "Host grant exists but real product pairing did not complete.",
          );
        evidence.result = "blocked-native-optional-permission";
        evidence.reason =
          "真实 UI 点击已调用原生 permissions.request，但 headless 权限授予或配对未完成；未预授权、未模拟授予、未继续上传。";
        await page.screenshot({
          path: join(output, `extension-sync-${channel}-permission.png`),
          fullPage: true,
        });
        checkpoint(
          "native optional permission remained pending; no fake acceptance and no upload",
        );
        continue;
      }
      evidence.permission.calls = await page.evaluate(
        () => (globalThis as any).__permissionObservations,
      );
      evidence.permission.after = await permissionState(page, origin);
      assert.equal(evidence.permission.calls.length, nativePhase ? 1 : 0);
      if (nativePhase) {
        assert.equal(evidence.permission.calls[0].user_activation, true);
        assert.equal(evidence.permission.calls[0].granted, true);
      }
      assert.equal(evidence.permission.after, true);
      // Headless cannot prove a human-visible native prompt. It can prove a real
      // ungranted->granted transition from the product UI user gesture/native API.
      evidence.permission.verification = nativePhase
        ? "real native API + active UI user gesture + before/after origin grant; prompt pixels not verified"
        : "automation-pregrant/not-native-confirmed; required host grant only in isolated fixture manifest";
      assert.equal(
        (await api(`/api/w/${wid}/materials`)).length,
        0,
        "pairing must not upload",
      );
      assert.equal(
        evidence.http.filter(
          (r: any) => r.path.endsWith("/import") || r.path.endsWith("/uploads"),
        ).length,
        0,
      );
      const devices = await api("/api/devices");
      assert.equal(devices.length, 1);
      assert.equal(devices[0].workspace_id, wid);
      assert.deepEqual(devices[0].scopes, [
        "read",
        "import",
        "upload",
        "export",
      ]);
      checkpoint(
        (nativePhase
          ? "native optional host grant through UI gesture"
          : "controlled fixture host pregrant (NOT native prompt accepted)") +
          "; actual one-time HTTP claim; pair never uploads",
      );
      await page
        .getByRole("checkbox", {
          name: "发送已选原文的本机附件（只含有原件项）",
          exact: true,
        })
        .check();
      await page
        .getByRole("button", { name: "检查本次资料包与目标", exact: true })
        .click();
      await page
        .getByRole("heading", { name: "本次固定传输预览", exact: true })
        .waitFor();
      const preview = await page.locator(".plan").innerText();
      assert.match(preview, /原文 2 条 \/ 成果 1 个 \/ 附件 1 个/);
      assert.match(preview, /client_reported/);
      assert.match(preview, /旧标题/);
      assert.match(preview, /新标题/);
      assert.match(preview, new RegExp(wid));
      assert.equal(
        evidence.http.filter(
          (r: any) => r.path.endsWith("/import") || r.path.endsWith("/uploads"),
        ).length,
        0,
      );
      await page.screenshot({
        path: join(output, `extension-sync-${channel}-${mode}-preview.png`),
        fullPage: true,
      });
      await page
        .getByRole("button", { name: "确认上传到绑定空间", exact: true })
        .click();
      await page.locator("pre.receipt").waitFor({ timeout: 45000 });
      const receipt = JSON.parse(await page.locator("pre.receipt").innerText());
      assert.equal(receipt.records.length, 2);
      assert.equal(receipt.artifacts.length, 1);
      assert.equal(receipt.attachments.length, 1);
      assert.equal(receipt.source_truth, "client_reported");
      assert(
        dialogs.some(
          (value) => value.includes("固定历史引用原文") && value.includes(wid),
        ),
      );
      const claim = evidence.http.find(
        (r: any) => r.path === "/api/devices/claim",
      );
      assert(claim?.extension && !claim.cookie);
      const chunks = evidence.http.filter((r: any) =>
        r.path.endsWith("/chunks"),
      );
      assert.deepEqual(
        chunks.map((r: any) => [r.offset, r.bytes, r.status]),
        [
          [0, 1024 * 1024, 200],
          [1024 * 1024, 1024 * 1024, 200],
          [2 * 1024 * 1024, 137, 200],
        ],
      );
      const syncHttp = evidence.http.filter(
        (r: any) => r.method !== "GET" && /^\/api\/w\//.test(r.path),
      );
      assert(
        syncHttp.every(
          (r: any) => r.extension && r.bearer && !r.cookie && r.status === 200,
        ),
      );
      const imports = evidence.http.filter((r: any) =>
        r.path.endsWith("/import"),
      );
      assert.equal(imports.length, 1);
      assert(imports[0].idempotency_key_present);
      checkpoint(
        "explicit raw/results/history/attachment preview + final consent; real bearer HTTP; 3 chunks + server import receipt",
      );

      const materials = await api(`/api/w/${wid}/materials`);
      assert.equal(materials.length, 1);
      const material = await api(`/api/w/${wid}/materials/${materials[0].id}`);
      assert.equal(material.text, text);
      assert.equal(material.title, current.title);
      assert.equal(material.author_id, "7");
      assert.equal(material.source_key.entity_id, "900719925474099312");
      assert.equal(material.revisions.length, 2);
      assert.equal(
        material.revisions.find((r: any) => r.id === material.revision_id)
          ?.version_hash,
        current.version_hash,
      );
      assert(
        material.revisions.every(
          (r: any) => r.source_truth === "client_reported",
        ),
      );
      const oldRevision = material.revisions.find(
        (r: any) => r.version_hash === old.version_hash,
      );
      assert(oldRevision);
      const artifacts = await api(`/api/w/${wid}/artifacts`);
      assert.equal(artifacts.length, 1);
      assert.equal(artifacts[0].body, artifactBody);
      assert.equal(artifacts[0].citations[0].material_id, material.id);
      assert.equal(artifacts[0].citations[0].revision_id, oldRevision.id);
      assert.equal(artifacts[0].citations[0].version_hash, old.version_hash);
      assert.notEqual(
        artifacts[0].citations[0].revision_id,
        material.revision_id,
      );
      const annotations = await api(
        `/api/w/${wid}/annotations?material_id=${encodeURIComponent(material.id)}`,
      );
      assert.equal(annotations.length, 1);
      assert.equal(annotations[0].revision_id, oldRevision.id);
      const binaryResponse = await context.request.get(
        origin + `/api/w/${wid}/attachments/${receipt.attachments[0].id}`,
      );
      assert(binaryResponse.ok());
      const downloaded = new Uint8Array(await binaryResponse.body());
      assert.equal(downloaded.length, bytes.length);
      assert.equal(sha256(downloaded), attachmentHash);
      const exported = validateBundle(
        await api(
          `/api/w/${wid}/export?material_ids=${encodeURIComponent(material.id)}&artifact_ids=${encodeURIComponent(artifacts[0].id)}&annotations=true&attachments=true`,
        ),
      );
      assert.equal(exported.attachments.length, 1);
      assert.equal(exported.attachments[0].hash, attachmentHash);
      assert.equal(exported.attachments[0].status, "available");
      assert.equal(
        exported.artifacts[0].citations[0].version_hash,
        old.version_hash,
      );
      assert(exported.records.some((r) => r.version_hash === old.version_hash));
      assert(
        exported.records.some((r) => r.version_hash === current.version_hash),
      );
      evidence.authoritative = {
        workspace_id: wid,
        material_id: material.id,
        versions: material.revisions.length,
        current_version_hash: current.version_hash,
        fixed_citation_version_hash: old.version_hash,
        artifact_id: artifacts[0].id,
        attachment_id: receipt.attachments[0].id,
        attachment_bytes: downloaded.length,
        attachment_hash: sha256(downloaded),
        authenticity: "client_reported",
      };
      checkpoint(
        "authoritative HTTP readback: long source ID; same-text immutable metadata versions; fixed old citation/annotation; available binary hash/download; portable re-export",
      );
      // Clicking the same frozen preview again must use the local receipt, with
      // neither another import request nor another upload session or chunk.
      const writesBefore = syncHttp.length;
      await page
        .getByRole("button", { name: "确认上传到绑定空间", exact: true })
        .click();
      await page.waitForFunction(
        () => document.querySelectorAll("pre.receipt").length >= 2,
      );
      assert.equal(
        evidence.http.filter(
          (r: any) => r.method !== "GET" && /^\/api\/w\//.test(r.path),
        ).length,
        writesBefore,
      );
      assert.equal((await api(`/api/w/${wid}/materials`)).length, 1);
      assert.equal((await api(`/api/w/${wid}/artifacts`)).length, 1);
      checkpoint(
        "repeat confirmation reuses local idempotent receipt; no duplicate upload/import",
      );
      await page.screenshot({
        path: join(output, `extension-sync-${channel}-${mode}-receipt.png`),
        fullPage: true,
      });
      await web.goto(origin + "/settings/devices");
      await web.getByRole("button", { name: "刷新", exact: true }).click();
      await web.getByText(channel + " 隔离同步验收", { exact: true }).waitFor();
      assert.deepEqual(evidence.page_errors, []);
      evidence.result = "passed";
    } catch (error) {
      evidence.result = "failed";
      evidence.error = error instanceof Error ? error.message : String(error);
      console.error(`[${channel}/${mode}] ${evidence.error}`);
      if (page)
        await page
          .screenshot({
            path: join(output, `extension-sync-${channel}-${mode}-failure.png`),
            fullPage: true,
          })
          .catch(() => {});
    } finally {
      for (const stop of [
        async () => context?.close(),
        async () => app?.close(),
        async () => cleanup(temp),
      ])
        try {
          await stop();
        } catch (error) {
          evidence.result = "failed";
          evidence.cleanup_errors ??= [];
          evidence.cleanup_errors.push(
            error instanceof Error ? error.message : String(error),
          );
          console.error(
            `[${channel}/${mode}] cleanup: ${evidence.cleanup_errors.at(-1)}`,
          );
        }
      if (!evidence.cleanup_errors) delete evidence.isolation_dir;
      writeFileSync(reportPath, JSON.stringify(report, null, 2));
    }
  }
const nativeRows = report.browsers.filter(
  (row: any) => row.mode === "native-permission",
);
const transportRows = report.browsers.filter(
  (row: any) => row.mode === "transport-automation-pregrant",
);
report.native_optional_permission_result = !nativeRows.length
  ? "not-run"
  : nativeRows.every((row: any) => row.result === "passed")
    ? "passed-native-api-not-prompt-pixels"
    : "blocked";
report.transport_result = !transportRows.length
  ? "not-run"
  : transportRows.every((row: any) => row.result === "passed")
    ? "passed-controlled-host-grant"
    : "failed";
report.result = selectedCase
  ? report.browsers[0].result
  : report.transport_result === "passed-controlled-host-grant" &&
      nativeRows.length === 2 &&
      nativeRows.every((row: any) =>
        ["passed", "blocked-native-optional-permission"].includes(row.result),
      )
    ? report.native_optional_permission_result === "blocked"
      ? "transport-passed-native-permission-blocked"
      : "passed-native-api-not-prompt-pixels"
    : "not-passed";
writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(
  JSON.stringify(
    {
      result: report.result,
      native_optional_permission_result:
        report.native_optional_permission_result,
      transport_result: report.transport_result,
      browsers: report.browsers.map((row: any) => ({
        browser: row.browser,
        mode: row.mode,
        result: row.result,
        error: row.error,
      })),
    },
    null,
    2,
  ),
);
if (["not-passed", "failed"].includes(report.result)) process.exitCode = 1;
