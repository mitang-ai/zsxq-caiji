import { zipSync, strToU8, strFromU8 } from "fflate";
import { readArchive, assertNoCredentials } from "./archive";
import {
  SOURCE_ORIGIN,
  currentTopic,
  groups,
  members,
  createCapture,
  runCapture,
  sourceContext,
  requestSource,
} from "./source";
import {
  presets,
  grantOrigin,
  providerModels,
  generate,
  planAnalysis,
  runAnalysis,
  recoverInterruptedJobs,
} from "./ai";
import { pair, unpair, syncBundle } from "./sync";
import {
  secret,
  setSecret,
  deleteSecret,
  unlock,
  lock,
  eraseVault,
} from "./vault";
import {
  list,
  get,
  put,
  remove,
  meta,
  setMeta,
  ingest,
  datasetMaterials,
  updateArtifact,
  localBackup,
  restoreLocal,
  importBundleLocal,
  controlJob,
  appendEvent,
} from "./database";
import {
  uid,
  now,
  sha256,
  canonical,
  recordOf,
  revisionRecord,
  makeBundle,
  validateBundle,
  materialsCsv,
  markdownMaterial,
  safeFileName,
  baseUrl,
  sourceIdentity,
} from "./browser-core";
import type {
  Annotation,
  Artifact,
  Attachment,
  Dataset,
  Job,
  Material,
  Provider,
  Scope,
  SourceKey,
  SyncTarget,
} from "./types";
import type { TransferBundle } from "../shared/transfer";

const compact = location.pathname.endsWith("sidepanel.html");
type Page =
  | "capture"
  | "library"
  | "datasets"
  | "process"
  | "artifacts"
  | "jobs"
  | "settings"
  | "sync";
let page: Page = compact ? "capture" : "library",
  materials: Material[] = [],
  annotations: Annotation[] = [],
  datasets: Dataset[] = [],
  artifacts: Artifact[] = [],
  jobs: Job[] = [],
  providers: Provider[] = [],
  attachments: Attachment[] = [],
  target: SyncTarget | null = null;
let selected = new Set<string>(),
  artifactSelected = new Set<string>(),
  openedMaterial = "",
  openedArtifact = "",
  query = "",
  statusFilter = "",
  groupFilter = "",
  authorFilter = "",
  datasetFilter = "",
  editingProvider = "",
  planId = "",
  notice = "",
  busy = false;
const root = document.getElementById("app")!;
const nav: [Page, string, string][] = [
  ["capture", "采集", "◫"],
  ["library", "本地资料", "▤"],
  ["datasets", "专题", "⌑"],
  ["process", "AI 加工", "≡"],
  ["artifacts", "本地成果", "▧"],
  ["jobs", "任务", "↻"],
  ["sync", "同步", "⇅"],
  ["settings", "设置", "⚙"],
];
function e<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Record<string, any> = {},
  ...children: (Node | string | number | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attributes)) {
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on") && typeof v === "function")
      n.addEventListener(k.slice(2), v);
    else if (
      k in n &&
      (typeof v === "boolean" ||
        ["value", "checked", "disabled", "type"].includes(k))
    )
      (n as any)[k] = v;
    else if (v !== undefined && v !== false) n.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return n;
}
function b(
  label: string,
  action: () => void | Promise<unknown>,
  kind = "",
): HTMLButtonElement {
  return e(
    "button",
    { type: "button", class: kind, onclick: () => void act(action) },
    label,
  );
}
function field(
  label: string,
  type = "text",
  value = "",
  name = "",
): HTMLLabelElement {
  const control = e("input", {
    type,
    value,
    name,
    autocomplete: type === "password" ? "off" : undefined,
    "aria-label": label,
  });
  return e("label", { class: "field" }, e("span", {}, label), control);
}
function area(label: string, value = "", name = ""): HTMLLabelElement {
  return e(
    "label",
    { class: "field" },
    e("span", {}, label),
    e("textarea", { value, name, "aria-label": label }),
  );
}
function select(
  label: string,
  options: { value: string; label: string }[],
  value = "",
  name = "",
): HTMLLabelElement {
  const n = e("select", { name, "aria-label": label });
  for (const o of options) n.append(e("option", { value: o.value }, o.label));
  n.value = value;
  return e("label", { class: "field" }, e("span", {}, label), n);
}
function check(label: string, checked = false, name = ""): HTMLLabelElement {
  return e(
    "label",
    { class: "check" },
    e("input", { type: "checkbox", checked, name, "aria-label": label }),
    e("span", {}, label),
  );
}
function val(form: HTMLElement, name: string): string {
  return (
    (form.querySelector(`[name="${name}"]`) as HTMLInputElement)?.value ?? ""
  );
}
function checked(form: HTMLElement, name: string): boolean {
  return !!(form.querySelector(`[name="${name}"]`) as HTMLInputElement)
    ?.checked;
}
function num(form: HTMLElement, name: string, fallback: number): number {
  return Number(val(form, name)) || fallback;
}
function small(text: string): HTMLElement {
  return e("p", { class: "muted" }, text);
}
function line(...nodes: (Node | string)[]): HTMLElement {
  return e("div", { class: "actions" }, ...nodes);
}
function heading(
  title: string,
  description: string,
  ...actions: Node[]
): HTMLElement {
  return e(
    "header",
    { class: "page-heading" },
    e("div", {}, e("h1", {}, title), small(description)),
    e("div", { class: "actions" }, ...actions),
  );
}
function badge(label: string, kind = ""): HTMLElement {
  return e("span", { class: "badge " + kind }, label);
}
function empty(title: string, description: string, button?: Node): HTMLElement {
  return e(
    "section",
    { class: "empty" },
    e("h2", {}, title),
    small(description),
    button,
  );
}
function navigate(next: Page): void {
  page = next;
  openedMaterial = "";
  openedArtifact = "";
  render();
}
async function reload(): Promise<void> {
  [materials, annotations, datasets, artifacts, jobs, providers, attachments] =
    await Promise.all([
      list<Material>("materials"),
      list<Annotation>("annotations"),
      list<Dataset>("datasets"),
      list<Artifact>("artifacts"),
      list<Job>("jobs"),
      list<Provider>("providers"),
      list<Attachment>("attachments"),
    ]);
  target = await meta("sync-target", null);
}
async function refresh(): Promise<void> {
  await reload();
  render();
}
async function act(action: () => void | Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (err) {
    notice = err instanceof Error ? err.message : "操作未完成。";
    renderNotice();
  }
}
function renderNotice(): void {
  let n = document.getElementById("notice");
  if (!n) {
    n = e("div", {
      id: "notice",
      role: "status",
      "aria-live": "polite",
      class: "notice",
    });
    root.append(n);
  }
  n.textContent = notice;
  n.hidden = !notice;
}
function msg(text: string): void {
  notice = text;
  renderNotice();
}
function openFull(hash = ""): void {
  void chrome.tabs.create({
    url: chrome.runtime.getURL("workbench.html") + hash,
  });
}
function download(name: string, blob: Blob): void {
  const u = URL.createObjectURL(blob),
    a = e("a", { href: u, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(u), 30000);
}
function selectedMaterials(): Material[] {
  return materials.filter((m) => selected.has(m.id) && !m.archived);
}
function selectedArtifacts(): Artifact[] {
  return artifacts.filter((a) => artifactSelected.has(a.id));
}
function contentSelection(): Material[] {
  return datasetFilter
    ? datasetMaterials(datasets.find((d) => d.id === datasetFilter)!, materials)
    : selectedMaterials();
}
function timestamp(raw: string): string {
  try {
    return new Date(raw).toLocaleString("zh-CN", {
      timeZone: "America/Los_Angeles",
      hour12: false,
    });
  } catch {
    return raw;
  }
}
function coverage(m: Material): HTMLElement {
  return line(
    badge("正文 " + m.coverage.body),
    badge("讨论 " + m.coverage.comments),
    badge("附件 " + m.coverage.attachments),
  );
}
function render(): void {
  root.replaceChildren();
  root.className = compact ? "app compact" : "app";
  const sidebar = e(
    "aside",
    { class: "sidebar" },
    e(
      "div",
      { class: "brand" },
      e("img", {
        class: "brand-mark",
        src: "icons/mark.svg",
        alt: "",
        width: "32",
        height: "32",
      }),
      e("strong", {}, "集见"),
      badge("本机"),
    ),
  );
  sidebar.append(
    e(
      "div",
      { class: "workspace-label" },
      "本地独立空间",
      small("不需要工作台账号"),
    ),
  );
  const menu = e("nav", { "aria-label": "本地导航" });
  for (const [id, label, icon] of nav) {
    if (
      compact &&
      !["capture", "library", "process", "sync", "settings"].includes(id)
    )
      continue;
    menu.append(
      b(
        icon + " " + label,
        () => navigate(id),
        page === id ? "nav active" : "nav",
      ),
    );
  }
  sidebar.append(
    menu,
    b("打开完整工作台", () => openFull()),
    small(target ? "已配对 · 资料不会自动上传" : "仅本机保存 · 未连接工作台"),
  );
  root.append(sidebar);
  const shell = e("section", { class: "shell" });
  const top = e(
    "div",
    { class: "topbar" },
    e("span", {}, "扩展 / " + nav.find((n) => n[0] === page)?.[1]),
    line(
      b("搜索资料", () => {
        navigate("library");
        document.getElementById("library-query")?.focus();
      }),
      b("外观", () => navigate("settings")),
    ),
  );
  shell.append(top);
  const main = e("main", { id: "main" });
  shell.append(main);
  root.append(shell);
  if (page === "capture") renderCapture(main);
  if (page === "library")
    openedMaterial ? renderReader(main) : renderLibrary(main);
  if (page === "datasets") renderDatasets(main);
  if (page === "process") renderProcess(main);
  if (page === "artifacts")
    openedArtifact ? renderArtifact(main) : renderArtifacts(main);
  if (page === "jobs") renderJobs(main);
  if (page === "settings") renderSettings(main);
  if (page === "sync") renderSync(main);
  renderNotice();
}
async function sourceGrant(): Promise<void> {
  const origins = ["https://wx.zsxq.com/*", "https://api.zsxq.com/*"];
  if (
    !(await chrome.permissions.contains({ origins })) &&
    !(await chrome.permissions.request({ origins }))
  )
    throw new Error("未授权知识星球精确域名；普通浏览器登录不受影响。");
}
function renderCapture(main: HTMLElement): void {
  main.append(
    heading(
      "从当前星球留下材料",
      "源站会话留在源站。原文、他人讨论和你的加工分别保存。",
      b("打开知识星球", () => {
        void chrome.tabs.create({ url: SOURCE_ORIGIN + "/" });
      }),
    ),
  );
  const scopeNotice = e(
    "div",
    { class: "scope-bar" },
    badge("执行位置：本机浏览器"),
    badge("保存位置：IndexedDB"),
    small("仅操作 wx.zsxq.com 已登录页面；不会导出 Cookie。"),
  );
  main.append(scopeNotice);
  if (!materials.length)
    main.append(
      e(
        "section",
        { class: "first-use", "aria-label": "首次使用" },
        e("strong", {}, "先收一小批，模型稍后再配。"),
        e(
          "p",
          {},
          "① 登录知识星球 → ② 选范围并采集 → ③ 阅读、整理或导出。材料保存在当前浏览器。",
        ),
        line(
          b("查看本地资料", () => navigate("library")),
          b("配置模型（可跳过）", () => navigate("settings")),
        ),
      ),
    );
  const form = e("form", { class: "form", id: "capture-form" });
  form.append(
    field("星球 ID", "text", groupFilter, "group_id"),
    field(
      "成员 ID（留空为当前星球全部作者）",
      "text",
      authorFilter,
      "author_id",
    ),
    field("开始时间（可选）", "datetime-local", "", "from"),
    field("结束时间（可选）", "datetime-local", "", "to"),
    field("本次最多主题页数", "number", "5", "max_pages"),
    field("每帖本批评论页数预算（1–100）", "number", "5", "max_comments_pages"),
    check("主帖", true, "topic"),
    check("回答", true, "answer"),
    check("评论（按真实作者单独保存）", false, "comment"),
    check(
      "串行分页评论；回复树未核验仍标记 partial",
      false,
      "include_comments",
    ),
    check(
      "下载文件/原图附件（不可访问或缺失仍标记 partial）",
      true,
      "include_attachments",
    ),
  );
  const sourceInfo = e("div", { class: "source-info" });
  main.append(
    line(
      b("识别当前页面", async () => {
        await sourceGrant();
        const c = await sourceContext();
        if (c.group_id) {
          groupFilter = c.group_id;
          (form.querySelector('[name="group_id"]') as HTMLInputElement).value =
            c.group_id;
        }
        const d = await requestSource({ operation: "self" });
        sourceInfo.replaceChildren(
          small(
            "当前源站账号：" +
              String(d.user?.name ?? d.name ?? "已验证") +
              " · " +
              String(d.user?.user_id ?? d.user_id ?? ""),
          ),
          small(c.url),
        );
      }),
      b("读取已加入星球", async () => {
        await sourceGrant();
        const gs = await groups();
        const picker = select(
          "选择已加入星球",
          [
            { value: "", label: "请选择" },
            ...gs.map((g) => ({ value: g.id, label: g.name + " · " + g.id })),
          ],
          "",
          "source_group",
        );
        picker.querySelector("select")!.addEventListener("change", (ev) => {
          groupFilter = (ev.target as HTMLSelectElement).value;
          (form.querySelector('[name="group_id"]') as HTMLInputElement).value =
            groupFilter;
        });
        sourceInfo.replaceChildren(
          picker,
          small("列表来自本次源站返回，不代表永久访问权限。"),
        );
      }),
      b("保存当前帖", async () => {
        await sourceGrant();
        const r = await currentTopic(val(form, "group_id") || undefined);
        msg("已保存 " + r.saved + " 条。" + r.reason);
        await refresh();
      }),
    ),
  );
  main.append(sourceInfo, form);
  const memberSearch = e(
    "form",
    { class: "form inline-form" },
    field("成员关键词（只搜索所填星球）", "text", "", "q"),
    e("button", { type: "submit" }, "查找成员"),
  );
  memberSearch.addEventListener("submit", (ev) => {
    ev.preventDefault();
    void act(async () => {
      await sourceGrant();
      const rows = await members(val(form, "group_id"), val(memberSearch, "q"));
      sourceInfo.replaceChildren(
        ...rows.map((m) =>
          b(m.name + " · " + m.id, () => {
            (
              form.querySelector('[name="author_id"]') as HTMLInputElement
            ).value = m.id;
            authorFilter = m.id;
          }),
        ),
        small("仅展示源站本次返回的成员候选；可使用准确成员 ID。"),
      );
    });
  });
  main.append(memberSearch);
  form.append(
    e(
      "button",
      { type: "submit", class: "primary" },
      compact ? "确认范围，创建任务并打开完整页" : "预览并创建采集任务",
    ),
  );
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    void act(async () => {
      await sourceGrant();
      const scope: Scope = {
        group_id: val(form, "group_id").trim(),
        author_id: val(form, "author_id").trim() || undefined,
        from: val(form, "from")
          ? new Date(val(form, "from")).toISOString()
          : undefined,
        to: val(form, "to")
          ? new Date(val(form, "to")).toISOString()
          : undefined,
        types: ["topic", "answer", "comment"].filter((t) => checked(form, t)),
        max_pages: num(form, "max_pages", 5),
        max_comments_pages: num(form, "max_comments_pages", 5),
        include_comments: checked(form, "include_comments"),
        include_attachments: checked(form, "include_attachments"),
      };
      if (!scope.types.length) throw new Error("至少选择一种来源类型。");
      if (scope.from && scope.to && scope.from > scope.to)
        throw new Error("开始时间不能晚于结束时间。");
      if (
        !confirm(
          `采集星球 ${scope.group_id}${scope.author_id ? " 中成员 " + scope.author_id : " 中可见内容"}，最多 ${scope.max_pages} 页。保存于本机，不会上传。确认创建？`,
        )
      )
        return;
      const job = await createCapture(scope);
      await reload();
      if (compact) {
        openFull("#jobs");
        msg("任务已保存，请在完整工作台点击开始。");
      } else {
        page = "jobs";
        render();
        await runJob(job);
      }
    });
  });
  main.append(
    small(
      "评论和长文存在独立分页/权限。取不到的内容保持 partial/inaccessible，不用“采集完成”冒称全文归档。任务逐页保存断点，完整页关闭后等待恢复。",
    ),
  );
}
function filteredMaterials(): Material[] {
  return materials.filter(
    (m) =>
      !m.archived &&
      (!query ||
        (m.title + " " + m.text + " " + m.author_name + " " + m.tags.join(" "))
          .toLowerCase()
          .includes(query.toLowerCase())) &&
      (!statusFilter || statusFilter === "starred"
        ? !statusFilter || m.starred
        : m.status === statusFilter) &&
      (!groupFilter || m.group_id === groupFilter) &&
      (!authorFilter || m.author_id === authorFilter),
  );
}
function materialRow(m: Material): HTMLElement {
  const checkbox = e("input", {
    type: "checkbox",
    checked: selected.has(m.id),
    "aria-label": "选择 " + m.title,
    onchange: (ev: Event) => {
      (ev.target as HTMLInputElement).checked
        ? selected.add(m.id)
        : selected.delete(m.id);
      render();
    },
  });
  return e(
    "article",
    { class: "material-row" },
    checkbox,
    e(
      "div",
      { class: "row-content" },
      b(
        m.title || "无标题材料",
        () => {
          openedMaterial = m.id;
          render();
        },
        "title-link",
      ),
      e("p", { class: "excerpt" }, m.text.slice(0, 180)),
      line(
        small(
          m.author_name +
            " · 星球 " +
            m.group_id +
            " · " +
            m.source_key.entity_type,
        ),
        badge(
          m.status === "unread"
            ? "未读"
            : m.status === "read"
              ? "已读"
              : m.status === "ignored"
                ? "已忽略"
                : "已采纳",
        ),
        m.coverage.body !== "complete"
          ? badge("正文待补齐", "warning")
          : badge("正文已读到"),
      ),
      small(m.tags.map((t) => "#" + t).join(" ")),
    ),
    b(m.starred ? "★" : "☆", async () => {
      await put("materials", { ...m, starred: !m.starred });
      await refresh();
    }),
  );
}
function renderLibrary(main: HTMLElement): void {
  main.append(
    heading(
      "本地资料",
      "原文只读，选中的资料才参与加工、导出或同步。",
      b("新建采集", () => navigate("capture"), "primary"),
      b("导入资料包", () => importFile()),
    ),
  );
  const filters = e("div", { class: "filters" }),
    q = e("input", {
      id: "library-query",
      value: query,
      type: "search",
      placeholder: "搜索标题、正文、作者、标签",
      "aria-label": "搜索本地资料",
    });
  q.addEventListener("input", () => {
    query = q.value;
    renderMaterialList(main);
  });
  const status = select(
    "处理状态",
    [
      { value: "", label: "全部" },
      { value: "unread", label: "未读" },
      { value: "read", label: "已读" },
      { value: "adopted", label: "已采纳" },
      { value: "ignored", label: "忽略" },
      { value: "starred", label: "收藏" },
    ],
    statusFilter,
  );
  status.querySelector("select")!.addEventListener("change", (ev) => {
    statusFilter = (ev.target as HTMLSelectElement).value;
    renderMaterialList(main);
  });
  filters.append(
    q,
    status,
    field("星球筛选", "text", groupFilter, "group_filter"),
    field("作者 ID 筛选", "text", authorFilter, "author_filter"),
    b("应用范围", () => {
      groupFilter = val(filters, "group_filter").trim();
      authorFilter = val(filters, "author_filter").trim();
      renderMaterialList(main);
    }),
    b("清除筛选", () => {
      query = "";
      groupFilter = "";
      authorFilter = "";
      statusFilter = "";
      render();
    }),
  );
  main.append(filters);
  main.append(
    line(
      b("选择本页", () => {
        for (const m of filteredMaterials()) selected.add(m.id);
        render();
      }),
      b("清空选择", () => {
        selected.clear();
        render();
      }),
      b("保存视图", async () => {
        await setMeta("saved-view", {
          query,
          statusFilter,
          groupFilter,
          authorFilter,
        });
        msg("当前筛选已保存。");
      }),
      b("读取视图", async () => {
        const view = await meta<any>("saved-view", null);
        if (!view) throw new Error("尚未保存视图。");
        ({ query, statusFilter, groupFilter, authorFilter } = view);
        render();
      }),
    ),
  );
  if (selected.size)
    main.append(
      e(
        "div",
        { class: "selection-bar" },
        e("strong", {}, "已选 " + selectedMaterials().length + " 条"),
        b("加工", () => {
          datasetFilter = "";
          navigate("process");
        }),
        b("加入专题", () => navigate("datasets")),
        b("标签", async () => {
          const tags = prompt("批量标签，以逗号分隔；留空清空标签。");
          if (tags === null) return;
          for (const m of selectedMaterials())
            await put("materials", {
              ...m,
              tags: tags
                .split(/[,，]/)
                .map((t) => t.trim())
                .filter(Boolean),
            });
          await refresh();
        }),
        b("标为已读", async () => {
          for (const m of selectedMaterials())
            await put("materials", { ...m, status: "read" });
          await refresh();
        }),
        b("忽略", async () => {
          for (const m of selectedMaterials())
            await put("materials", { ...m, status: "ignored" });
          await refresh();
        }),
        b("导出", () => exportPanel()),
        b("同步预览", () => navigate("sync")),
      ),
    );
  renderMaterialList(main);
}
function renderMaterialList(main: HTMLElement): void {
  let host = document.getElementById("material-list");
  if (!host) {
    host = e("section", { id: "material-list", class: "material-list" });
    main.append(host);
  }
  host.replaceChildren();
  const rows = filteredMaterials().sort((a, b) =>
    b.captured_at.localeCompare(a.captured_at),
  );
  if (!rows.length)
    host.append(
      empty(
        materials.length ? "没有匹配的资料" : "还没有本地资料",
        materials.length
          ? "更改筛选，不会删除既有资料。"
          : "登录知识星球后保存当前帖，或导入自己的 TransferBundle。",
        b("去采集", () => navigate("capture")),
      ),
    );
  else
    host.append(small(rows.length + " 条可见资料"), ...rows.map(materialRow));
}
function renderReader(main: HTMLElement): void {
  const m = materials.find((m) => m.id === openedMaterial);
  if (!m) {
    main.append(
      empty(
        "资料不存在",
        "可能已归档或当前列表已变化。",
        b("返回资料库", () => {
          openedMaterial = "";
          render();
        }),
      ),
    );
    return;
  }
  main.append(
    heading(
      m.title,
      "作者 " +
        m.author_name +
        " · 当前星球 " +
        m.group_id +
        " · " +
        m.source_key.entity_type,
      b("返回资料库", () => {
        openedMaterial = "";
        render();
      }),
      b(m.starred ? "取消收藏" : "收藏", async () => {
        await put("materials", { ...m, starred: !m.starred });
        await refresh();
      }),
      b("标为已读", async () => {
        await put("materials", { ...m, status: "read" });
        await refresh();
      }),
    ),
  );
  main.append(
    coverage(m),
    small("客户端资料，未独立验证来源真实性。" + m.coverage.reasons.join("；")),
  );
  const source = e(
    "a",
    { href: m.source_url, target: "_blank", rel: "noopener noreferrer" },
    "回到原帖 ↗",
  );
  main.append(source);
  const layout = e("div", { class: "reader-layout" }),
    body = e("pre", { class: "reader-body", tabindex: 0 });
  const marks = annotations
    .filter(
      (a) =>
        a.material_id === m.id &&
        a.revision_id === m.revision_id &&
        m.text.slice(a.start, a.end) === a.quote,
    )
    .sort((a, b) => a.start - b.start);
  let textOffset = 0;
  for (const a of marks) {
    if (a.start < textOffset) continue;
    body.append(
      document.createTextNode(m.text.slice(textOffset, a.start)),
      e(
        "mark",
        { "data-annotation": a.id, title: a.note || "个人高亮" },
        a.quote,
      ),
    );
    textOffset = a.end;
  }
  body.append(document.createTextNode(m.text.slice(textOffset)));
  const note = area("我的批注（与原文分开）", "", "note"),
    annotationPane = e("aside", { class: "inspector" });
  const selectedQuote = e(
    "p",
    { class: "muted" },
    "先选中原文，再点击引用选区。",
  );
  let range = { start: 0, end: 0, quote: "" };
  const saveAnnotation = async (kind: "note" | "highlight") => {
    if (!range.quote) throw new Error("请先选中原文并点击引用选区。");
    const a: Annotation = {
      id: uid(),
      material_id: m.id,
      revision_id: m.revision_id,
      version_hash: m.version_hash,
      ...range,
      note: val(note, "note"),
      kind,
      created_at: now(),
    };
    await put("annotations", a);
    await refresh();
  };
  annotationPane.append(
    e("h2", {}, "我的理解"),
    selectedQuote,
    b("引用选区", () => {
      const s = window.getSelection();
      if (
        !s?.rangeCount ||
        !body.contains(s.anchorNode) ||
        !body.contains(s.focusNode)
      )
        throw new Error("请在当前原文中选择文字。");
      const quote = s.toString();
      if (!quote.trim() || quote.length > 10000)
        throw new Error("选区需 1–10,000 字符。");
      const r = s.getRangeAt(0),
        before = document.createRange();
      before.selectNodeContents(body);
      before.setEnd(r.startContainer, r.startOffset);
      const start = before.toString().length;
      if (m.text.slice(start, start + quote.length) !== quote)
        throw new Error("选区与原文偏移不一致，请重新选择。");
      range = { start, end: start + quote.length, quote };
      selectedQuote.textContent = "引用：" + quote;
    }),
    note,
    line(
      b("保存批注", () => saveAnnotation("note"), "primary"),
      b("仅高亮", () => saveAnnotation("highlight")),
    ),
  );
  for (const a of annotations.filter((a) => a.material_id === m.id))
    annotationPane.append(
      e(
        "section",
        { class: "annotation" },
        badge(a.revision_id === m.revision_id ? "当前版本" : "旧版批注", ""),
        e("blockquote", {}, a.quote),
        e("p", {}, a.note || "高亮"),
        line(
          b("定位原文", () => {
            if (
              a.revision_id !== m.revision_id ||
              m.text.slice(a.start, a.end) !== a.quote
            )
              throw new Error(
                "这是旧版批注，请在来源版本查看固定原文；不会自动改绑同文新位置。",
              );
            body.focus();
            const r = textRange(body, a.start, a.end),
              s = window.getSelection();
            s?.removeAllRanges();
            s?.addRange(r);
            body
              .querySelector(
                `[data-annotation="${a.id.replace(/[^\w-]/g, "")}"]`,
              )
              ?.scrollIntoView({ block: "center" });
          }),
          b("编辑批注", async () => {
            const value = prompt("修改自己的批注：", a.note);
            if (value !== null) {
              await put("annotations", { ...a, note: value });
              await refresh();
            }
          }),
          b("删除批注", async () => {
            if (confirm("只删除这条个人批注，原文不变。")) {
              await remove("annotations", a.id);
              await refresh();
            }
          }),
        ),
      ),
    );
  layout.append(body, annotationPane);
  main.append(layout);
  const versions = e(
    "details",
    {},
    e("summary", {}, "来源版本 · " + m.revisions.length),
  );
  for (const r of [...m.revisions].reverse())
    versions.append(
      e(
        "section",
        { class: "version" },
        small(timestamp(r.captured_at) + " · " + r.id),
        e("pre", {}, r.text),
      ),
    );
  main.append(versions);
  main.append(
    line(
      b("将此帖加入选择", () => {
        selected.add(m.id);
        msg("已选择这条资料，可进入专题、加工或导出。");
      }),
      b("记住阅读位置", async () => {
        await put("materials", { ...m, reading_position: window.scrollY });
        msg("已记住当前阅读页位置。");
      }),
      b("回到上次位置", () =>
        window.scrollTo({ top: m.reading_position ?? 0, behavior: "auto" }),
      ),
      b("导出此帖 Markdown", () =>
        download(
          safeFileName(m.title),
          new Blob([markdownMaterial(m)], {
            type: "text/markdown;charset=utf-8",
          }),
        ),
      ),
      b("添加本机附件", () => attachFile(m)),
      b("归档本地资料", async () => {
        if (
          !confirm("归档只影响本机资料列表，不删除源站内容；仍保留原文版本。")
        )
          return;
        await put("materials", { ...m, archived: true });
        openedMaterial = "";
        await refresh();
      }),
    ),
  );
  const localFiles = attachments.filter(
    (a) =>
      a.source_key &&
      sourceIdentity(a.source_key) === sourceIdentity(m.source_key),
  );
  if (localFiles.length) {
    main.append(e("h2", {}, "本机附件"));
    for (const a of localFiles)
      main.append(
        line(
          e("span", {}, a.name + " · " + a.size + " bytes · " + a.status),
          b("下载本机原件", () => {
            if (!a.blob) throw new Error("原件不在本机。");
            download(a.name, a.blob);
          }),
        ),
      );
  }
}
function textRange(container: HTMLElement, start: number, end: number): Range {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode(),
    offset = 0;
  const range = document.createRange();
  let started = false,
    ended = false;
  while (node) {
    const length = node.textContent?.length ?? 0;
    if (!started && start <= offset + length) {
      range.setStart(node, start - offset);
      started = true;
    }
    if (started && end <= offset + length) {
      range.setEnd(node, end - offset);
      ended = true;
      break;
    }
    offset += length;
    node = walker.nextNode();
  }
  if (!started || !ended) throw new Error("选区偏移已失效。");
  return range;
}
async function attachFile(m: Material): Promise<void> {
  const input = e("input", { type: "file" });
  input.addEventListener(
    "change",
    () =>
      void act(async () => {
        const file = input.files?.[0];
        if (!file) return;
        if (file.size > 50 * 1024 * 1024)
          throw new Error("单附件上限 50 MiB。");
        const hash = await sha256(await file.arrayBuffer()),
          a: Attachment = {
            id:
              "a-" +
              hash.slice(0, 20) +
              "-" +
              (await sha256(sourceIdentity(m.source_key))).slice(0, 12),
            name: file.name,
            mime: file.type || "application/octet-stream",
            size: file.size,
            hash,
            blob: file,
            source_key: m.source_key,
            status: "available",
          };
        await put("attachments", a);
        await refresh();
        msg("本机文件已保存，不因此声明它等于源站附件；正文覆盖度不升级。");
      }),
  );
  input.click();
}
function renderDatasets(main: HTMLElement): void {
  main.append(
    heading("专题", "手工选材与动态筛选分开，每次加工固定来源快照。"),
  );
  const form = e(
    "form",
    { class: "form" },
    field("专题名称", "text", "", "name"),
    select(
      "选材方式",
      [
        { value: "manual", label: "当前已选资料" },
        { value: "dynamic", label: "动态筛选规则" },
      ],
      "manual",
      "mode",
    ),
    field("规则：关键词", "text", query, "q"),
    field("规则：星球 ID", "text", groupFilter, "group_id"),
    field("规则：作者 ID", "text", authorFilter, "author_id"),
    field("规则：标签（逗号分隔）", "text", "", "tags"),
    e("button", { type: "submit", class: "primary" }, "新建专题"),
  );
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    void act(async () => {
      if (!val(form, "name").trim()) throw new Error("填写专题名称。");
      const mode = val(form, "mode") as Dataset["mode"];
      if (mode === "manual" && !selectedMaterials().length)
        throw new Error("先在资料库选择材料。");
      await put("datasets", {
        id: uid(),
        name: val(form, "name").trim(),
        mode,
        material_ids: selectedMaterials().map((m) => m.id),
        rule: {
          q: val(form, "q") || undefined,
          group_id: val(form, "group_id") || undefined,
          author_id: val(form, "author_id") || undefined,
          tags: val(form, "tags")
            .split(/[,，]/)
            .map((s) => s.trim())
            .filter(Boolean),
        },
        updated_at: now(),
      });
      await refresh();
    });
  });
  main.append(form);
  for (const d of datasets) {
    const rows = datasetMaterials(d, materials);
    main.append(
      e(
        "section",
        { class: "dataset" },
        line(
          e("h2", {}, d.name),
          badge(d.mode === "manual" ? "手工选材" : "动态规则"),
        ),
        small(
          rows.length +
            " 条当前资料" +
            (d.snapshot
              ? " · 已冻结 " + d.snapshot.length + " 条来源修订"
              : ""),
        ),
        line(
          b("查看材料", () => {
            selected = new Set(rows.map((m) => m.id));
            datasetFilter = d.id;
            page = "library";
            render();
          }),
          b("加入当前已选", async () => {
            if (d.mode !== "manual")
              throw new Error("动态专题使用规则；请编辑规则或另建手工专题。");
            await put("datasets", {
              ...d,
              material_ids: [
                ...new Set([
                  ...d.material_ids,
                  ...selectedMaterials().map((m) => m.id),
                ]),
              ],
              snapshot: undefined,
              updated_at: now(),
            });
            await refresh();
          }),
          b("冻结快照", async () => {
            if (!rows.length) throw new Error("没有可冻结的材料。");
            await put("datasets", {
              ...d,
              snapshot: rows.map((m) => ({
                material_id: m.id,
                revision_id: m.revision_id,
              })),
              updated_at: now(),
            });
            await refresh();
          }),
          b("加工此专题", () => {
            datasetFilter = d.id;
            page = "process";
            render();
          }),
          b(
            d.mode === "dynamic" ? "编辑动态规则" : "移出当前所选",
            async () => {
              if (d.mode === "dynamic") {
                editDatasetRules(d);
                return;
              }
              const ids = new Set(selectedMaterials().map((m) => m.id));
              if (!ids.size)
                throw new Error("先在资料库选择需要从专题移出的材料。");
              await put("datasets", {
                ...d,
                material_ids: d.material_ids.filter((id) => !ids.has(id)),
                snapshot: undefined,
                updated_at: now(),
              });
              await refresh();
            },
          ),
          b("取消冻结", async () => {
            if (!d.snapshot) throw new Error("这个专题没有冻结快照。");
            await put("datasets", {
              ...d,
              snapshot: undefined,
              updated_at: now(),
            });
            await refresh();
          }),
          b("改名", async () => {
            const name = prompt("专题名称：", d.name);
            if (name?.trim()) {
              await put("datasets", {
                ...d,
                name: name.trim(),
                updated_at: now(),
              });
              await refresh();
            }
          }),
          b("删除专题", async () => {
            if (confirm("只删除专题，不删除材料与成果。")) {
              await remove("datasets", d.id);
              await refresh();
            }
          }),
        ),
      ),
    );
  }
  if (!datasets.length)
    main.append(
      empty(
        "先圈定你要研究的材料",
        "专题不是文件夹副本，也不会自动把全库交给模型。",
      ),
    );
}
function analysisSelection(): Material[] {
  if (!datasetFilter) return selectedMaterials();
  const d = datasets.find((d) => d.id === datasetFilter);
  if (!d) return [];
  if (d.snapshot)
    return d.snapshot
      .map((s) => {
        const m = materials.find((m) => m.id === s.material_id),
          r = m?.revisions.find((r) => r.id === s.revision_id);
        return m && r
          ? {
              ...m,
              title: r.title,
              text: r.text,
              hash: r.hash,
              version_hash: revisionRecord(m, r).version_hash,
              revision_id: r.id,
              fragments: r.fragments,
              coverage: r.coverage,
            }
          : null;
      })
      .filter(Boolean) as Material[];
  return datasetMaterials(d, materials);
}
function editDatasetRules(d: Dataset): void {
  const dialog = e("dialog", {}, e("h2", {}, "修改 " + d.name + " 的动态规则"));
  const form = e(
    "form",
    { class: "form" },
    field("关键词", "text", d.rule?.q ?? "", "q"),
    field("星球 ID", "text", d.rule?.group_id ?? "", "group_id"),
    field("作者 ID", "text", d.rule?.author_id ?? "", "author_id"),
    field(
      "全部匹配标签（逗号分隔）",
      "text",
      d.rule?.tags?.join(",") ?? "",
      "tags",
    ),
    small("保存清除冻结快照，但不会改变已有加工计划或成果。"),
    e("button", { type: "submit", class: "primary" }, "保存规则"),
  );
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    void act(async () => {
      await put("datasets", {
        ...d,
        rule: {
          q: val(form, "q") || undefined,
          group_id: val(form, "group_id") || undefined,
          author_id: val(form, "author_id") || undefined,
          tags: val(form, "tags")
            .split(/[,，]/)
            .map((t) => t.trim())
            .filter(Boolean),
        },
        snapshot: undefined,
        updated_at: now(),
      });
      dialog.close();
      await refresh();
    });
  });
  dialog.append(
    form,
    b("关闭", () => dialog.close()),
  );
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove());
  dialog.showModal();
}
function renderProcess(main: HTMLElement): void {
  main.append(
    heading(
      "AI 加工",
      "选择实际材料 → 检查计划 → 明确外发 → 保存待核对成果。模型费用由你的服务商收取。",
    ),
  );
  if (!providers.length) {
    main.append(
      empty(
        "先配置自己的模型服务",
        "支持 Chat Completions、Responses 与 Anthropic；不把 Key 发给工作台。",
        b("配置模型", () => navigate("settings"), "primary"),
      ),
    );
    return;
  }
  const form = e(
    "form",
    { class: "form" },
    select(
      "材料范围",
      [
        {
          value: "",
          label: "资料库中已选 " + selectedMaterials().length + " 条",
        },
        ...datasets.map((d) => ({
          value: d.id,
          label: d.name + (d.snapshot ? "（冻结快照）" : "（本次固定）"),
        })),
      ],
      datasetFilter,
      "dataset_id",
    ),
    select(
      "加工模板",
      presets.map((p) => ({ value: p.id, label: p.label })),
      "deep-read",
      "preset_id",
    ),
    area("你的目标", "", "goal"),
    select(
      "模型服务",
      providers.map((p) => ({ value: p.id, label: p.label + " / " + p.model })),
      providers[0]?.id,
      "provider_id",
    ),
    field("每批材料字符上限", "number", "12000", "input_limit"),
    field("最多计费尝试（含综合、未知与显式重试）", "number", "6", "max_calls"),
    field("单次输出 token 上限", "number", "4096", "max_tokens"),
    e("button", { type: "submit", class: "primary" }, "检查执行计划"),
  );
  form
    .querySelector('[name="dataset_id"]')!
    .addEventListener("change", (ev) => {
      datasetFilter = (ev.target as HTMLSelectElement).value;
    });
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    void act(async () => {
      datasetFilter = val(form, "dataset_id");
      const p = providers.find((p) => p.id === val(form, "provider_id"))!;
      const job = await planAnalysis(
        analysisSelection(),
        p,
        val(form, "preset_id"),
        val(form, "goal"),
        num(form, "input_limit", 12000),
        num(form, "max_calls", 6),
        num(form, "max_tokens", 4096),
      );
      planId = job.id;
      await reload();
      render();
    });
  });
  main.append(form);
  const plan = jobs.find((j) => j.id === planId);
  if (plan) {
    const p = plan.checkpoint.provider as Provider;
    const panel = e(
      "section",
      { class: "plan" },
      e("h2", {}, "本次固定执行计划"),
      small(
        plan.material_ids?.length +
          " 条来源，" +
          plan.checkpoint.characters +
          " 字符；预计 " +
          plan.checkpoint.calls +
          " 次请求；计费尝试上限 " +
          plan.checkpoint.max_calls +
          "（未知与重试同计）。",
      ),
      small(
        "外发目的地：" +
          new URL(p.base_url).origin +
          " · 协议 " +
          p.protocol +
          " · 模型 " +
          p.model,
      ),
      small(
        "1. 固定来源修订  2. 分批阅读  3. 有需要才综合  4. 保存草稿与引用  5. 人工编辑/采纳",
      ),
      small("结果未知不会自动重试；来源文本是材料，不是调用指令。"),
    );
    for (const source of (plan.checkpoint.sources as any[]).slice(0, 40))
      panel.append(
        e(
          "details",
          {},
          e(
            "summary",
            {},
            "[" +
              source.label +
              "] " +
              source.title +
              " · " +
              source.author +
              " · " +
              source.type,
          ),
          e("pre", {}, source.text),
        ),
      );
    panel.append(
      line(
        b(
          compact ? "在完整页确认执行" : "确认外发并开始",
          async () => {
            if (compact) {
              openFull("#jobs");
              return;
            }
            if (
              !confirm(
                "所选材料将从扩展直接发送到 " +
                  new URL(p.base_url).origin +
                  "。共预计 " +
                  plan.checkpoint.calls +
                  " 次请求，费用由服务商计收。确认执行？",
              )
            )
              return;
            await runJob(plan);
          },
          "primary",
        ),
        b("取消计划", async () => {
          await put("jobs", { ...plan, status: "cancelled" });
          planId = "";
          await refresh();
        }),
      ),
    );
    main.append(panel);
  }
}
function renderArtifacts(main: HTMLElement): void {
  main.append(
    heading(
      "本地成果",
      "AI 草稿、人工修改与来源版本分别保留。",
      b(
        "新建人工稿",
        async () => {
          const at = now(),
            a: Artifact = {
              id: uid(),
              title: "未命名人工稿",
              body: "",
              citations: [],
              revision: 1,
              revisions: [],
              status: "draft",
              created_at: at,
              updated_at: at,
            };
          await put("artifacts", a);
          openedArtifact = a.id;
          await refresh();
        },
        "primary",
      ),
    ),
  );
  if (!artifacts.length)
    main.append(
      empty(
        "留下你确认过的结论",
        "先选择资料加工，或直接新建人工稿。",
        b("去加工", () => navigate("process")),
      ),
    );
  for (const a of artifacts)
    main.append(
      e(
        "article",
        { class: "material-row" },
        e("input", {
          type: "checkbox",
          checked: artifactSelected.has(a.id),
          "aria-label": "选择成果 " + a.title,
          onchange: (ev: Event) => {
            (ev.target as HTMLInputElement).checked
              ? artifactSelected.add(a.id)
              : artifactSelected.delete(a.id);
            render();
          },
        }),
        e(
          "div",
          { class: "row-content" },
          b(
            a.title,
            () => {
              openedArtifact = a.id;
              render();
            },
            "title-link",
          ),
          small(a.body.slice(0, 180)),
          line(
            badge(a.status === "adopted" ? "已采纳" : "待核对草稿"),
            a.stale ? badge("来源变化", "warning") : (null as any),
            badge("修订 " + a.revision),
          ),
        ),
        b("导出 Markdown", () =>
          download(
            safeFileName(a.title),
            new Blob([artifactMarkdown(a)], {
              type: "text/markdown;charset=utf-8",
            }),
          ),
        ),
      ),
    );
  if (artifactSelected.size)
    main.append(
      line(
        b("导出所选成果", () => exportPanel()),
        b("同步所选成果", () => navigate("sync")),
        b("清空成果选择", () => {
          artifactSelected.clear();
          render();
        }),
      ),
    );
}
function artifactMarkdown(a: Artifact): string {
  return (
    "# " +
    a.title +
    "\n\n" +
    a.body +
    "\n\n## 来源索引\n\n" +
    a.citations
      .map(
        (c) =>
          `- [${c.citation_id ?? "来源"}] ${c.source_url ?? ""} · 版本 ${c.revision_id} · ${c.source_key?.group_id ?? ""}`,
      )
      .join("\n") +
    "\n\n" +
    (a.model_attribution
      ? "模型归属：" + JSON.stringify(a.model_attribution)
      : "人工稿") +
    "\n"
  );
}
function renderArtifact(main: HTMLElement): void {
  const a = artifacts.find((a) => a.id === openedArtifact);
  if (!a) return;
  main.append(
    heading(
      a.title,
      "修订 " +
        a.revision +
        " · " +
        (a.status === "adopted" ? "人工采纳" : "草稿"),
      b("返回成果", () => {
        openedArtifact = "";
        render();
      }),
    ),
  );
  const form = e(
    "form",
    { class: "form artifact-form" },
    field("成果标题", "text", a.title, "title"),
    area("成果正文（Markdown）", a.body, "body"),
    e("button", { type: "submit", class: "primary" }, "保存我的修改"),
  );
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    void act(async () => {
      try {
        await updateArtifact(a.id, a.revision, {
          title: val(form, "title"),
          body: val(form, "body"),
          status: "draft",
        });
        await refresh();
        msg("已保存人工修改，旧版本保留。");
      } catch (err) {
        msg((err as Error).message);
        const copy = b("将冲突输入另存为草稿", async () => {
          const at = now();
          await put("artifacts", {
            ...a,
            id: uid(),
            title: val(form, "title") + "（冲突副本）",
            body: val(form, "body"),
            revision: 1,
            revisions: [],
            status: "draft",
            created_at: at,
            updated_at: at,
          });
          await refresh();
        });
        form.append(copy);
      }
    });
  });
  main.append(form);
  main.append(
    line(
      b("确认采纳当前保存稿", async () => {
        if (
          !confirm("已核对结论与引用，采纳当前保存稿？未保存输入不会自动采纳。")
        )
          return;
        await updateArtifact(a.id, a.revision, { status: "adopted" });
        await refresh();
      }),
      b("导出 Markdown", () =>
        download(
          safeFileName(a.title),
          new Blob([artifactMarkdown(a)], {
            type: "text/markdown;charset=utf-8",
          }),
        ),
      ),
      b("加入同步选择", () => {
        artifactSelected.add(a.id);
        navigate("sync");
      }),
    ),
  );
  if (a.stale)
    main.append(
      small(
        "来源已更新，此成果仍引用旧修订。先比较资料，再决定是否重新加工；不会覆盖人工稿。",
      ),
    );
  const index = e(
    "aside",
    { class: "citation-index" },
    e("h2", {}, "回到来源"),
  );
  if (!a.citations.length)
    index.append(small("没有可回查引用，请手动核对；不能视为经过证据验证。"));
  for (const c of a.citations)
    index.append(
      e(
        "details",
        {},
        e("summary", {}, "[" + c.citation_id + "] 来源版本 " + c.revision_id),
        e("blockquote", {}, c.quote),
        b("打开固定来源", () => {
          const m = materials.find((m) => m.id === c.material_id);
          if (!m) throw new Error("来源不在本机。");
          const r = m.revisions.find((r) => r.id === c.revision_id);
          if (!r) throw new Error("引用的历史来源修订缺失。");
          const dialog: HTMLDialogElement = e(
            "dialog",
            {},
            e("h2", {}, r.title),
            small("这是引用时的固定修订，不是最新原文。"),
            e("pre", { class: "reader-body" }, r.text),
            b("关闭", () => dialog.close()),
          );
          document.body.append(dialog);
          dialog.addEventListener("close", () => dialog.remove());
          dialog.showModal();
        }),
      ),
    );
  main.append(index);
  const history = e(
    "details",
    {},
    e("summary", {}, "人工编辑历史 · " + a.revisions.length),
  );
  for (const r of [...a.revisions].reverse())
    history.append(
      e(
        "section",
        {},
        e("h3", {}, "修订 " + r.revision + " · " + r.title),
        e("pre", {}, r.body),
        b("以此版本新建人工草稿", async () => {
          const at = now();
          await put("artifacts", {
            ...a,
            id: uid(),
            title: r.title + "（历史副本）",
            body: r.body,
            revision: 1,
            revisions: [],
            status: "draft",
            created_at: at,
            updated_at: at,
          });
          openedArtifact = "";
          await refresh();
        }),
      ),
    );
  main.append(
    history,
    small(
      a.model_attribution
        ? "模型归属：" + JSON.stringify(a.model_attribution)
        : "人工创建稿件。",
    ),
  );
}
async function runJob(job: Job, retryUnknown = false): Promise<void> {
  if (compact) {
    openFull("#jobs");
    return;
  }
  await navigator.locks.request(
    "xingjian-task-runner",
    { ifAvailable: true },
    async (lock) => {
      if (!lock)
        throw new Error("另一完整扩展页正在执行任务，请等待或在那一页暂停。");
      if (job.kind === "capture") {
        if (job.status === "partial" && job.scope)
          await put("jobs", {
            ...job,
            scope: {
              ...job.scope,
              max_pages:
                Number(job.checkpoint.page) +
                Math.min(100, Math.max(1, job.scope.max_pages)),
            },
          });
        await runCapture(job.id, () => void refresh());
      } else if (job.kind === "process") {
        await runAnalysis(job.id, () => void refresh(), retryUnknown);
      } else {
        await syncBundle(
          job.checkpoint.bundle,
          attachments.filter((a) =>
            job.checkpoint.bundle.attachments.some((v: any) => v.id === a.id),
          ),
          job.id,
          () => void refresh(),
        );
      }
      await refresh();
    },
  );
}
function renderJobs(main: HTMLElement): void {
  main.append(
    heading(
      "本地任务",
      "实际阶段、最后活动与断点；浏览器关闭不会继续执行。",
      b("刷新状态", () => refresh()),
    ),
  );
  if (!jobs.length)
    main.append(
      empty("没有任务", "创建范围采集或确认 AI 计划后，任务记录会保留在本机。"),
    );
  const labels: Record<string, string> = {
    queued: "待开始",
    running: "运行中",
    paused: "已暂停 / 等待恢复",
    unknown: "计费结果未知",
    partial: "部分完成",
    complete: "已完成",
    failed: "失败",
    cancelled: "取消",
  };
  for (const job of [...jobs].sort((a, b) =>
    b.created_at.localeCompare(a.created_at),
  )) {
    const detail = e(
      "details",
      {
        open: ["running", "unknown", "paused"].includes(job.status),
        class: "job",
      },
      e("summary", {}, job.title + " · " + labels[job.status]),
      small(timestamp(job.updated_at)),
      job.reason ? small(job.reason) : null,
      small(
        job.kind === "capture"
          ? "已读 " +
              (job.checkpoint.page ?? 0) +
              " 页 / 保存 " +
              (job.checkpoint.saved ?? 0) +
              " 条"
          : "已保存响应 " +
              (job.checkpoint.outputs?.length ?? 0) +
              " / 计费尝试 " +
              (job.checkpoint.attempts_used ?? 0) +
              "/" +
              (job.checkpoint.max_calls ?? "—"),
      ),
    );
    const actions = line();
    if (
      ["queued", "paused", "partial", "failed", "unknown"].includes(job.status)
    ) {
      actions.append(
        b(
          job.status === "unknown" ||
            job.checkpoint.unresolved_attempt ||
            job.checkpoint.inflight
            ? "核对后显式重试未知请求"
            : job.kind === "capture" && job.status === "partial"
              ? "继续下一批（保留断点）"
              : "确认并继续",
          async () => {
            if (
              (job.status === "unknown" ||
                job.checkpoint.unresolved_attempt ||
                job.checkpoint.inflight) &&
              !confirm(
                "此请求结果未知，重新调用可能重复计费。你已核对服务商账单/日志并决定重试吗？",
              )
            )
              return;
            if (
              job.kind === "process" &&
              job.status !== "unknown" &&
              !confirm(
                "确认向 " +
                  new URL(job.checkpoint.provider.base_url).origin +
                  " 发送固定计划中的材料？",
              )
            )
              return;
            await runJob(
              job,
              job.status === "unknown" ||
                !!job.checkpoint.unresolved_attempt ||
                !!job.checkpoint.inflight,
            );
          },
          "primary",
        ),
      );
    }
    if (job.status === "running")
      actions.append(
        b("暂停（当前请求完成后停止）", async () => {
          await controlJob(job.id, "paused");
          await refresh();
        }),
      );
    if (!["complete", "cancelled"].includes(job.status))
      actions.append(
        b("取消后续步骤", async () => {
          if (!confirm("停止后续动作，已完成资料与可能已计费调用不能回滚。"))
            return;
          await controlJob(job.id, "cancelled");
          await refresh();
        }),
      );
    if (job.artifact_id)
      actions.append(
        b("查看成果", () => {
          page = "artifacts";
          openedArtifact = job.artifact_id!;
          render();
        }),
      );
    detail.append(
      actions,
      e(
        "ol",
        { class: "timeline" },
        ...job.events.map((v) =>
          e("li", {}, small(timestamp(v.at)), e("span", {}, v.message)),
        ),
      ),
    );
    main.append(detail);
  }
}
function renderSettings(main: HTMLElement): void {
  main.append(
    heading(
      "设置",
      "模型 Key 默认只在浏览器会话；明确记住后以口令 AES-GCM 加密。不会使用 storage.sync。",
    ),
  );
  const appearances = e(
    "section",
    { class: "settings-section" },
    e("h2", {}, "外观与阅读"),
  );
  for (const [id, label] of [
    ["paper", "纸白"],
    ["warm", "暖纸"],
    ["graphite", "石墨黑"],
    ["mist", "雾蓝"],
  ])
    appearances.append(
      b(label, async () => {
        document.documentElement.dataset.theme = id;
        await setMeta("theme", id);
      }),
    );
  appearances.append(
    b("随系统", async () => {
      await setMeta("theme", "system");
      document.documentElement.dataset.theme = matchMedia(
        "(prefers-color-scheme: dark)",
      ).matches
        ? "graphite"
        : "paper";
    }),
  );
  const reading = field(
    "阅读字号（16–22 px）",
    "number",
    String(
      parseInt(
        getComputedStyle(document.documentElement).getPropertyValue(
          "--reader-size",
        ),
      ) || 17,
    ),
    "reader_size",
  );
  appearances.append(
    reading,
    b("保存阅读字号", async () => {
      const size = Math.max(16, Math.min(22, num(reading, "reader_size", 17)));
      document.documentElement.style.setProperty("--reader-size", size + "px");
      await setMeta("reader-size", size);
    }),
  );
  main.append(appearances);
  const editing = providers.find((p) => p.id === editingProvider);
  const form = e(
    "form",
    { class: "form", id: "provider-form" },
    e("h2", {}, editing ? "编辑模型服务" : "添加自己的模型服务"),
    field("服务名称", "text", editing?.label ?? "", "label"),
    select(
      "协议",
      [
        { value: "chat", label: "OpenAI Chat Completions" },
        { value: "responses", label: "OpenAI Responses" },
        { value: "anthropic", label: "Anthropic Messages" },
      ],
      editing?.protocol ?? "chat",
      "protocol",
    ),
    field(
      "API Base URL（包含 /v1 等服务路径）",
      "url",
      editing?.base_url ?? "",
      "base_url",
    ),
    field("API Key（留空保留会话密钥）", "password", "", "api_key"),
    field(
      "准确的模型 ID（支持手动填写）",
      "text",
      editing?.model ?? "",
      "model",
    ),
    check(
      "明确记住 API Key（口令加密，重启需解锁）",
      editing?.remember ?? false,
      "remember",
    ),
    field(
      "保险箱口令（记住/取消记住时必填，至少 8 位）",
      "password",
      "",
      "passphrase",
    ),
    e(
      "button",
      { type: "submit", class: "primary" },
      "保存并授权精确 API origin",
    ),
  );
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    void act(async () => {
      const base = await grantOrigin(val(form, "base_url"));
      if (!val(form, "model").trim()) throw new Error("填写准确的模型 ID。");
      const id = editing?.id ?? uid(),
        key = val(form, "api_key"),
        remember = checked(form, "remember");
      if (
        editing &&
        new URL(editing.base_url).origin !== new URL(base).origin &&
        !key
      )
        throw new Error(
          "API origin 已改变；必须明确填写用于新服务的 Key，不会把旧服务密钥自动发到新域名。",
        );
      if (!key && !(await secret("provider:" + id)))
        throw new Error("填写 API Key，或先解锁已有 Key。");
      if (editing?.remember && !remember) {
        const current = key || (await secret("provider:" + id));
        await deleteSecret("provider:" + id, val(form, "passphrase"));
        await setSecret("provider:" + id, current);
      } else if (key || remember)
        await setSecret(
          "provider:" + id,
          key || (await secret("provider:" + id)),
          remember,
          val(form, "passphrase"),
        );
      const p: Provider = {
        id,
        label: val(form, "label").trim() || new URL(base).hostname,
        protocol: val(form, "protocol") as Provider["protocol"],
        base_url: base,
        model: val(form, "model").trim(),
        models: editing?.models ?? [],
        remember,
      };
      await put("providers", p);
      (form.querySelector('[name="api_key"]') as HTMLInputElement).value = "";
      (form.querySelector('[name="passphrase"]') as HTMLInputElement).value =
        "";
      editingProvider = "";
      await refresh();
      msg("模型配置已保存，尚未证明实际模型调用可用。");
    });
  });
  main.append(form);
  for (const p of providers)
    main.append(
      e(
        "section",
        { class: "provider" },
        e("h3", {}, p.label + " / " + p.model),
        small(p.protocol + " · " + p.base_url),
        p.tested_at
          ? small(
              "实际调用验证：" +
                timestamp(p.tested_at) +
                " / " +
                p.tested_model,
            )
          : small("未完成实际调用测试"),
        line(
          b("编辑", () => {
            editingProvider = p.id;
            render();
          }),
          b("读取模型目录", async () => {
            const models = await providerModels(p);
            await put("providers", { ...p, models });
            await refresh();
            msg("读取到 " + models.length + " 个模型；可手动填写未列出的 ID。");
          }),
          b("测试实际调用（可能计费）", async () => {
            if (
              !confirm(
                "向 " +
                  new URL(p.base_url).origin +
                  " 的 " +
                  p.model +
                  " 发送一次简短调用，可能计费。确认？",
              )
            )
              return;
            const response = await generate(p, "仅回复 OK。", 64);
            if (!response.complete || response.truncated)
              throw new Error("服务返回文本但未完整结束，未标为验证成功。");
            await put("providers", {
              ...p,
              tested_at: now(),
              tested_model: response.model ?? p.model,
            });
            await refresh();
            msg("实际调用已返回文本并正常结束。");
          }),
          b("删除配置", async () => {
            if (
              !confirm(
                "删除模型配置；不删除已保存的成果。加密保险箱内密钥通过下方“移除保险箱”单独处理。",
              )
            )
              return;
            await setSecret("provider:" + p.id, "");
            await remove("providers", p.id);
            await refresh();
          }),
        ),
        p.models.length
          ? e(
              "details",
              {},
              e("summary", {}, "目录 " + p.models.length + " 个模型"),
              ...p.models.map((id) =>
                b(id, async () => {
                  await put("providers", {
                    ...p,
                    model: id,
                    tested_at: undefined,
                    tested_model: undefined,
                  });
                  await refresh();
                }),
              ),
            )
          : null,
      ),
    );
  const vault = e(
    "section",
    { class: "settings-section" },
    e("h2", {}, "会话与保险箱"),
    field("解锁口令", "password", "", "password"),
  );
  vault.append(
    line(
      b("解锁记住的 Key", async () => {
        const count = await unlock(val(vault, "password"));
        (vault.querySelector("input") as HTMLInputElement).value = "";
        msg("已在当前浏览器会话解锁 " + count + " 项凭据。");
      }),
      b("锁定全部会话凭据", async () => {
        await lock();
        msg("API Key 与工作台设备令牌已从会话清除；模型任务将等待重新授权。");
      }),
      b("移除加密保险箱", async () => {
        if (
          !confirm(
            "删除本机持久密钥保险箱并锁定当前会话。资料与成果保留；下次要重新输入 Key。",
          )
        )
          return;
        await eraseVault();
        msg("加密保险箱已移除。");
      }),
    ),
  );
  main.append(vault);
  main.append(
    e(
      "section",
      { class: "settings-section" },
      e("h2", {}, "本地资料与备份"),
      small(
        "IndexedDB 是浏览器本地资料，不是永久保险柜。卸载扩展或清除站点数据前先导出备份。",
      ),
      line(
        b("完整本机备份 ZIP（不含 Key）", () => backupZip()),
        b("恢复本机备份/资料包", () => importFile()),
        b("恢复归档资料", async () => {
          for (const m of materials.filter((m) => m.archived))
            await put("materials", { ...m, archived: false });
          await refresh();
          msg("本机归档资料已恢复。");
        }),
      ),
      b("查看本机存储估计", async () => {
        const value = await navigator.storage.estimate();
        msg(
          "当前使用约 " +
            Math.round((value.usage ?? 0) / 1024) +
            " KiB，可用配额约 " +
            Math.round((value.quota ?? 0) / 1024 / 1024) +
            " MiB；不是永久保存承诺。",
        );
      }),
    ),
  );
}
async function bundleFor(
  raw: boolean,
  results: boolean,
  withAttachments: boolean,
): Promise<{ bundle: TransferBundle; files: Attachment[] }> {
  const ms = selectedMaterials(),
    as = selectedArtifacts();
  if (!raw && !results) throw new Error("至少选择原文或成果。");
  if (raw && !ms.length) throw new Error("先在本地资料库勾选要发送的原文。");
  if (results && !as.length) throw new Error("先在成果页勾选要发送的成果。");
  const ids = new Set(ms.map((m) => m.id)),
    keys = Object.fromEntries(ms.map((m) => [m.id, m.source_key]));
  const files = withAttachments
    ? attachments.filter(
        (a) =>
          a.source_key &&
          ms.some(
            (m) =>
              sourceIdentity(m.source_key) === sourceIdentity(a.source_key!),
          ),
      )
    : [];
  if (withAttachments && !raw)
    throw new Error("附件必须随所选原文，不能作为无归属文件上传。");
  const safeFiles = files.map(({ blob: _, ...a }) => a);
  const bundle = await makeBundle(
    raw ? ms.map(recordOf) : [],
    raw ? annotations.filter((a) => ids.has(a.material_id)) : [],
    results ? as : [],
    safeFiles,
    keys,
    materials,
  );
  return { bundle, files };
}
function renderSync(main: HTMLElement): void {
  main.append(
    heading(
      "显式同步",
      "配对不上传。每次指定包含项与目标空间；源站会话、模型 Key 和设备令牌不进入资料包。",
    ),
  );
  if (!target) {
    const form = e(
      "form",
      { class: "form" },
      field("工作台 origin（不含路径）", "url", "", "origin"),
      field("工作台设备页配对码", "text", "", "code"),
      field(
        "本机设备名称",
        "text",
        navigator.userAgent.includes("Edg/")
          ? "Edge 集见插件"
          : "Chrome 集见插件",
        "label",
      ),
      e("button", { type: "submit", class: "primary" }, "配对指定工作台"),
    );
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      void act(async () => {
        await pair(val(form, "origin"), val(form, "code"), val(form, "label"));
        await refresh();
        msg("已配对指定空间，没有上传任何本地资料。");
      });
    });
    main.append(form);
  } else
    main.append(
      e(
        "div",
        { class: "scope-bar" },
        e("strong", {}, "目的地：" + target.origin),
        small("设备绑定空间：" + target.workspace_id + " · " + target.label),
        b("解除本机配对", async () => {
          if (
            !confirm(
              "只解除本机配对并清除本机会话令牌，不删除已上传内容。远程撤销在工作台设备页完成。",
            )
          )
            return;
          await unpair();
          await refresh();
        }),
      ),
    );
  const form = e(
    "form",
    { class: "form" },
    check(
      "发送已选原文（" + selectedMaterials().length + " 条）",
      selectedMaterials().length > 0,
      "raw",
    ),
    check(
      "发送已选成果及其固定引用原文版本（" +
        selectedArtifacts().length +
        " 条）",
      selectedArtifacts().length > 0,
      "results",
    ),
    check("发送已选原文的本机附件（只含有原件项）", false, "attachments"),
    e("button", { type: "submit" }, "检查本次资料包与目标"),
  );
  const preview = e("section", { class: "plan" });
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    void act(async () => {
      const { bundle, files } = await bundleFor(
        checked(form, "raw"),
        checked(form, "results"),
        checked(form, "attachments"),
      );
      preview.replaceChildren(
        e("h2", {}, "本次固定传输预览"),
        small(
          "原文 " +
            bundle.records.length +
            " 条 / 成果 " +
            bundle.artifacts.length +
            " 个 / 附件 " +
            files.length +
            " 个",
        ),
        small(
          target
            ? "上传目标：" + target.origin + " / 空间 " + target.workspace_id
            : "未配对：可先导出本地包，不会上传",
        ),
        small(
          "固定引用原文附带 " +
            String(bundle.coverage.reference_records_included ?? 0) +
            " 个版本；仅含所选成果/批注实际引用，不扩大到全库。",
        ),
        small("传输摘要：" + bundle.digest),
        small("资料真实性：client_reported。哈希校验不代表已经核验源站。"),
        b("导出此包 ZIP", () => portableZip(bundle, files), "primary"),
      );
      for (const r of bundle.records)
        preview.append(
          small(
            r.title + " · " + r.author_name + " · " + r.source_key.group_id,
          ),
        );
      if (target)
        preview.append(
          b(
            "确认上传到绑定空间",
            async () => {
              if (
                !confirm(
                  "上传仅限当前预览的原文、所选成果及其固定历史引用原文、附件；目标 " +
                    target!.origin +
                    " / " +
                    target!.workspace_id +
                    "。确认发送？",
                )
              )
                return;
              busy = true;
              try {
                const receipt = await navigator.locks.request(
                  "xingjian-task-runner",
                  { ifAvailable: true },
                  async (lock) => {
                    if (!lock)
                      throw new Error(
                        "另一完整扩展页正在执行任务，请先暂停或等待。",
                      );
                    return syncBundle(
                      bundle,
                      files,
                      undefined,
                      () => void reload(),
                    );
                  },
                );
                await reload();
                msg("导入回执已保存：" + canonical(receipt));
                preview.append(
                  e(
                    "pre",
                    { class: "receipt" },
                    JSON.stringify(receipt, null, 2),
                  ),
                );
              } finally {
                busy = false;
              }
            },
            "primary",
          ),
        );
    });
  });
  main.append(
    form,
    preview,
    small(
      "设备令牌只保存在当前浏览器会话，重启需重新配对。需要换目标空间时，在目标工作台创建绑定该空间的新配对码；不使用正文中的 workspace_id。",
    ),
  );
  const syncs = jobs.filter((j) => j.kind === "sync" && j.checkpoint.receipt);
  if (syncs.length) {
    main.append(e("h2", {}, "最近导入回执"));
    for (const j of syncs)
      main.append(
        e(
          "details",
          {},
          e("summary", {}, j.title + " · " + timestamp(j.updated_at)),
          e("pre", {}, JSON.stringify(j.checkpoint.receipt, null, 2)),
        ),
      );
  }
}
async function exportPanel(): Promise<void> {
  const dialog = e(
    "dialog",
    {},
    e("h2", {}, "导出所选资料"),
    small(
      "原文 " +
        selectedMaterials().length +
        " 条 / 成果 " +
        selectedArtifacts().length +
        " 个；可移植包会附成果/批注固定引用原文。纯成果 Markdown 不含引用正文，不称完整归档包。资料包不含凭据。",
    ),
  );
  dialog.append(
    line(
      b("原文 Markdown", () => {
        const ms = selectedMaterials();
        if (!ms.length) throw new Error("没有所选原文。");
        download(
          "集见原文.md",
          new Blob([ms.map(markdownMaterial).join("\n\n---\n\n")], {
            type: "text/markdown;charset=utf-8",
          }),
        );
      }),
      b("原文 CSV", () => {
        const ms = selectedMaterials();
        if (!ms.length) throw new Error("没有所选原文。");
        download(
          "集见资料.csv",
          new Blob([materialsCsv(ms)], { type: "text/csv;charset=utf-8" }),
        );
      }),
      b("仅成果 Markdown（不含引用正文）", () => {
        const rows = selectedArtifacts();
        if (!rows.length) throw new Error("没有所选成果。");
        download(
          "集见成果.md",
          new Blob([rows.map(artifactMarkdown).join("\n\n---\n\n")], {
            type: "text/markdown;charset=utf-8",
          }),
        );
      }),
      b("可移植 ZIP（含所选本机附件）", async () => {
        const { bundle, files } = await bundleFor(
          !!selectedMaterials().length,
          !!selectedArtifacts().length,
          !!selectedMaterials().length,
        );
        await portableZip(bundle, files);
      }),
    ),
    b("关闭", () => dialog.close()),
  );
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove());
  dialog.showModal();
}
async function portableZip(
  bundle: TransferBundle,
  files: Attachment[],
): Promise<void> {
  const zip: Record<string, Uint8Array> = {
    "bundle.json": strToU8(JSON.stringify(bundle, null, 2)),
  };
  for (const a of files)
    if (a.blob) {
      const bytes = new Uint8Array(await a.blob.arrayBuffer());
      if ((await sha256(bytes)) !== a.hash)
        throw new Error("附件摘要不匹配，停止导出。");
      zip["attachments/" + a.hash] = bytes;
    }
  const result = zipSync(zip, { level: 6 });
  download(
    "集见资料-" + bundle.bundle_id + ".zip",
    new Blob([new Uint8Array(result)], { type: "application/zip" }),
  );
  msg("可移植 ZIP 已生成；仅包含本次所选项。");
}
async function backupZip(): Promise<void> {
  const data = await localBackup(),
    visible = materials.filter((m) => !m.archived);
  const bundle = await makeBundle(
    visible.map(recordOf),
    annotations,
    artifacts,
    attachments.map(({ blob: _, ...a }) => a),
    Object.fromEntries(materials.map((m) => [m.id, m.source_key])),
    materials,
  );
  const zip: Record<string, Uint8Array> = {
    "local-state.json": strToU8(JSON.stringify(data, null, 2)),
    "bundle.json": strToU8(JSON.stringify(bundle, null, 2)),
  };
  for (const a of attachments)
    if (a.blob) {
      const bytes = new Uint8Array(await a.blob.arrayBuffer());
      if ((await sha256(bytes)) !== a.hash)
        throw new Error("附件哈希校验失败。");
      zip["attachments/" + a.hash] = bytes;
    }
  download(
    "集见本机备份-" + now().slice(0, 10) + ".zip",
    new Blob([new Uint8Array(zipSync(zip, { level: 6 }))], {
      type: "application/zip",
    }),
  );
  msg("本机备份已导出，不包含 API Key、设备令牌或源站登录态。");
}
function importFile(): void {
  const input = e("input", { type: "file", accept: ".json,.zip" });
  input.addEventListener(
    "change",
    () =>
      void act(async () => {
        const file = input.files?.[0];
        if (!file) return;
        if (file.size > 200 * 1024 * 1024)
          throw new Error("本次文件上限 200 MiB。");
        let raw: any,
          state: any,
          archive: Record<string, Uint8Array> = {};
        if (file.name.toLowerCase().endsWith(".zip")) {
          archive = readArchive(new Uint8Array(await file.arrayBuffer()));
          let total = 0;
          for (const bytes of Object.values(archive)) {
            total += bytes.length;
            if (total > 500 * 1024 * 1024)
              throw new Error("解包体积超过 500 MiB，拒绝恢复。");
          }
          if (!archive["bundle.json"])
            throw new Error("ZIP 缺少 bundle.json。");
          raw = JSON.parse(strFromU8(archive["bundle.json"]));
          state = archive["local-state.json"]
            ? JSON.parse(strFromU8(archive["local-state.json"]))
            : null;
        } else raw = JSON.parse(await file.text());
        const bundle = await validateBundle(raw);
        if (state) {
          assertNoCredentials(state);
          if (!Array.isArray(state.materials))
            throw new Error("本机备份缺少材料数组。");
          await validateBundle(await makeBundle(state.materials));
        }
        for (const a of bundle.attachments) {
          const bytes = archive["attachments/" + a.hash];
          if (
            bytes &&
            (bytes.length !== a.size || (await sha256(bytes)) !== a.hash)
          )
            throw new Error("附件 " + a.name + " 校验失败，未写入任何资料。");
        }
        if (
          !confirm(
            `校验通过：${bundle.records.length} 条材料、${bundle.artifacts.length} 个成果。${state ? "包含本机状态；成果冲突另存副本。" : "现有原文保留旧版本。"}确认导入？`,
          )
        )
          return;
        const files: Attachment[] = bundle.attachments.map((a) => {
          const bytes = archive["attachments/" + a.hash];
          return {
            ...a,
            source_key: a.record_source_key,
            status: bytes ? "available" : "missing",
            blob: bytes
              ? new Blob([new Uint8Array(bytes)], { type: a.mime })
              : undefined,
          };
        });
        await importBundleLocal(bundle, files);
        if (state) await restoreLocal(state);
        await refresh();
        msg("导入完成。内容真实性仍为客户端提供，不因文件哈希正确而升级。");
      }),
  );
  input.click();
}
function parseModelAttribution(raw?: string): Artifact["model_attribution"] {
  if (!raw) return undefined;
  try {
    const a = JSON.parse(raw);
    return a &&
      typeof a.requested_model === "string" &&
      typeof a.generated_at === "string" &&
      typeof a.protocol === "string"
      ? {
          requested_model: a.requested_model,
          response_model:
            typeof a.response_model === "string" ? a.response_model : undefined,
          generated_at: a.generated_at,
          protocol: a.protocol,
          complete: a.complete === true,
          truncated: a.truncated === true,
        }
      : undefined;
  } catch {
    return undefined;
  }
}
document.addEventListener("keydown", (ev) => {
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "k") {
    ev.preventDefault();
    navigate("library");
    document.getElementById("library-query")?.focus();
  }
});
void (async () => {
  try {
    await navigator.locks.request(
      "xingjian-task-runner",
      { ifAvailable: true },
      async (lock) => {
        if (lock) await recoverInterruptedJobs();
      },
    );
    const theme = await meta("theme", "system");
    document.documentElement.dataset.theme =
      theme === "system"
        ? matchMedia("(prefers-color-scheme: dark)").matches
          ? "graphite"
          : "paper"
        : theme;
    document.documentElement.style.setProperty(
      "--reader-size",
      (await meta("reader-size", 17)) + "px",
    );
    if (location.hash === "#jobs") page = "jobs";
    await reload();
    render();
  } catch (err) {
    root.replaceChildren(
      empty(
        "扩展初始化未完成",
        err instanceof Error ? err.message : "请检查本机浏览器存储。",
      ),
    );
  }
})();
