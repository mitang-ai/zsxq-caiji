import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import {
  api,
  date,
  download,
  endpoint,
  query,
  safeUrl,
  useApi,
  useOperation,
} from "../api";
import { createArchive } from "../transfer";
import {
  materialListKey,
  readMaterialListState,
  saveMaterialListState,
} from "../listState";
import type {
  Annotation,
  FileMeta,
  ImageMeta,
  Job,
  Material,
  TransferBundle,
} from "../types";
import {
  Badge,
  Button,
  CaptureDialog,
  CoverageView,
  Dialog,
  Empty,
  Field,
  Icon,
  LoadState,
  Notice,
  OperationNotice,
  PageHeader,
  ShareDialog,
  useWorkbench,
} from "../ui";

type SavedView = {
  id: string;
  name: string;
  q: string;
  status: string;
  group: string;
  author: string;
};

export function MaterialsPage({ inbox = false }: { inbox?: boolean }) {
  const { wid, session, notify } = useWorkbench();
  const listKey = materialListKey(session.user.id, wid, inbox);
  const cached = useRef(readMaterialListState(listKey, inbox));
  const [q, setQ] = useState(cached.current.q),
    [debounced, setDebounced] = useState(cached.current.q),
    [status, setStatus] = useState(cached.current.status),
    [group, setGroup] = useState(cached.current.group),
    [author, setAuthor] = useState(cached.current.author);
  const viewKey = `xingjian.views.${session.user.id}.${wid}`;
  const [views, setViews] = useState<SavedView[]>([]),
    [saveView, setSaveView] = useState(false),
    [viewName, setViewName] = useState("");
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(viewKey) || "[]");
      setViews(
        Array.isArray(saved)
          ? saved
              .filter(
                (v) =>
                  v && typeof v.id === "string" && typeof v.name === "string",
              )
              .slice(0, 30)
          : [],
      );
    } catch {
      setViews([]);
    }
  }, [viewKey]);
  function persistViews(next: SavedView[]) {
    try {
      localStorage.setItem(viewKey, JSON.stringify(next));
      setViews(next);
    } catch {
      notify("本机存储不可用，未保存筛选视图。");
    }
  }
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  const resource = useApi<Material[]>(
    endpoint(wid, "/materials") +
      query({ q: debounced, status, group_id: group, author_id: author }),
  );
  const [selected, setSelected] = useState<string[]>(cached.current.selected),
    [limit, setLimit] = useState(cached.current.limit);
  const [capture, setCapture] = useState(false),
    [share, setShare] = useState(false),
    [dataset, setDataset] = useState(false),
    [tagging, setTagging] = useState(false);
  const [name, setName] = useState(""),
    [tags, setTags] = useState("");
  const op = useOperation();
  const materials = resource.data ?? [];
  const visible = materials.slice(0, limit);
  const groups = [...new Set(materials.map((m) => m.group_id))];
  const lastFilter = useRef(JSON.stringify([debounced, status, group, author]));
  useEffect(() => {
    const next = JSON.stringify([debounced, status, group, author]);
    if (lastFilter.current !== next) {
      setSelected([]);
      setLimit(100);
      lastFilter.current = next;
    }
  }, [debounced, status, group, author]);
  const listState = useRef(cached.current);
  listState.current = {
    q,
    status,
    group,
    author,
    selected,
    limit,
    scroll: listState.current.scroll,
  };
  useEffect(() => {
    saveMaterialListState(listKey, listState.current);
  }, [q, status, group, author, selected, limit, listKey]);
  const restoredScroll = useRef(false);
  useEffect(() => {
    if (resource.loading || !resource.data || restoredScroll.current) return;
    const frame = requestAnimationFrame(() => {
      document
        .getElementById("main-content")
        ?.scrollTo({ top: cached.current.scroll, behavior: "instant" });
      restoredScroll.current = true;
    });
    return () => cancelAnimationFrame(frame);
  }, [resource.loading, resource.data]);
  function rememberList() {
    listState.current.scroll =
      document.getElementById("main-content")?.scrollTop ?? 0;
    saveMaterialListState(listKey, listState.current);
  }
  async function bulk(body: Record<string, unknown>) {
    await op.run(async () => {
      for (const id of selected)
        await api(endpoint(wid, `/materials/${encodeURIComponent(id)}`), {
          method: "PATCH",
          body,
        });
      notify(`已更新 ${selected.length} 条材料。`);
      setSelected([]);
      resource.reload();
    });
  }
  async function archive() {
    if (
      !window.confirm(
        `归档选中的 ${selected.length} 条材料？不会修改或删除知识星球原帖。`,
      )
    )
      return;
    await op.run(async () => {
      for (const id of selected)
        await api(endpoint(wid, `/materials/${encodeURIComponent(id)}`), {
          method: "DELETE",
        });
      setSelected([]);
      resource.reload();
      notify("所选本地材料已归档。");
    });
  }
  async function exportSelected(format: "json" | "zip") {
    await op.run(async () => {
      const bundle = await api<TransferBundle>(
        endpoint(wid, "/export") +
          query({
            material_ids: selected.join(","),
            annotations: "true",
            attachments: "true",
          }),
      );
      if (format === "json")
        download(
          `集见-材料-${bundle.bundle_id}.json`,
          JSON.stringify(bundle, null, 2),
        );
      else {
        const bytes = await createArchive(wid, bundle);
        download(
          `集见-材料-${bundle.bundle_id}.zip`,
          bytes.slice().buffer,
          "application/zip",
        );
      }
      notify(
        format === "zip"
          ? "材料与已保存附件原件已导出；缺失范围见包内 coverage。"
          : "JSON 证据包已导出，附件为元信息，不含原件。",
      );
    });
  }
  async function createDataset(e: FormEvent) {
    e.preventDefault();
    const result = await op.run(() =>
      api(endpoint(wid, "/datasets"), {
        method: "POST",
        body: { name, mode: "manual", material_ids: selected, rule: {} },
      }),
    );
    if (result !== undefined) {
      setDataset(false);
      setName("");
      notify("已建立手动专题。");
    }
  }
  return (
    <>
      <PageHeader
        eyebrow={inbox ? "待整理" : "原文与讨论"}
        title={inbox ? "收件箱" : "资料库"}
        description={
          inbox
            ? "先阅读，再整理。采集完成不等于已经理解。"
            : "原文版本独立保存，个人标记不会改变来源。"
        }
        actions={
          <>
            <Link className="button" to="/settings/data">
              导入资料
            </Link>
            <Button primary onClick={() => setCapture(true)}>
              <Icon name="plus" />
              新建采集
            </Button>
          </>
        }
      />
      {inbox && <InboxActivity />}
      <div className="saved-views">
        <span className="muted">我的视图</span>
        {views.map((v) => (
          <span className="saved-view" key={v.id}>
            <Button
              onClick={() => {
                setQ(v.q || "");
                setStatus(v.status || "");
                setGroup(v.group || "");
                setAuthor(v.author || "");
              }}
            >
              {v.name}
            </Button>
            <Button
              className="icon-button"
              aria-label={`移除视图 ${v.name}`}
              onClick={() =>
                persistViews(views.filter((item) => item.id !== v.id))
              }
            >
              <Icon name="close" size={12} />
            </Button>
          </span>
        ))}
        <Button className="text-button" onClick={() => setSaveView(true)}>
          保存当前筛选
        </Button>
      </div>
      <div className="filter-bar">
        <div className="search-field">
          <Icon name="search" />
          <input
            aria-label="搜索资料"
            placeholder="搜索标题、原文或作者"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <select
          aria-label="阅读状态"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">全部状态</option>
          <option value="unread">未读</option>
          <option value="read">已读</option>
          <option value="adopted">已采纳</option>
          <option value="ignored">已忽略</option>
        </select>
        <select
          aria-label="星球筛选"
          value={group}
          onChange={(e) => setGroup(e.target.value)}
        >
          <option value="">所有星球</option>
          {groups.map((g) => (
            <option value={g} key={g}>
              星球 {g}
            </option>
          ))}
          {group && !groups.includes(group) && (
            <option value={group}>星球 {group}</option>
          )}
        </select>
        <input
          className="author-filter"
          aria-label="成员 ID 筛选"
          placeholder="成员 ID"
          value={author}
          onChange={(e) => setAuthor(e.target.value)}
        />
        <Button aria-label="刷新材料" onClick={resource.reload}>
          <Icon name="refresh" />
        </Button>
      </div>
      <OperationNotice op={op} />
      {selected.length > 0 && (
        <div className="selection-bar">
          <strong>已选 {selected.length} 条</strong>
          <Button
            onClick={() => void bulk({ status: "read" })}
            disabled={op.busy}
          >
            标为已读
          </Button>
          <Button onClick={() => setTagging(true)}>标签</Button>
          <Button onClick={() => setDataset(true)}>加入新专题</Button>
          <Button onClick={() => void exportSelected("zip")} busy={op.busy}>
            导出 ZIP
          </Button>
          <Button
            onClick={() => void exportSelected("json")}
            disabled={op.busy}
          >
            JSON
          </Button>
          <Button onClick={() => setShare(true)}>分享</Button>
          <Button danger onClick={() => void archive()} disabled={op.busy}>
            归档
          </Button>
          <Button
            className="icon-button"
            aria-label="取消选择"
            onClick={() => setSelected([])}
          >
            <Icon name="close" />
          </Button>
        </div>
      )}
      <LoadState {...resource} retry={resource.reload}>
        {materials.length ? (
          <section className="material-list">
            <div className="list-heading">
              <label className="check">
                <input
                  type="checkbox"
                  aria-label="选择当前显示的所有材料"
                  checked={
                    visible.length > 0 &&
                    visible.every((m) => selected.includes(m.id))
                  }
                  onChange={(e) =>
                    setSelected(
                      e.target.checked
                        ? [
                            ...new Set([
                              ...selected,
                              ...visible.map((m) => m.id),
                            ]),
                          ]
                        : selected.filter(
                            (id) => !visible.some((m) => m.id === id),
                          ),
                    )
                  }
                />
                <span>
                  {materials.length} 条{q ? "匹配资料" : "资料"}
                </span>
              </label>
              <span>原文 · 个人状态</span>
            </div>
            {visible.map((m) => (
              <article
                className={`material-row ${selected.includes(m.id) ? "selected" : ""}`}
                key={m.id}
              >
                <input
                  type="checkbox"
                  aria-label={`选择 ${m.title || "材料"}`}
                  checked={selected.includes(m.id)}
                  onChange={(e) =>
                    setSelected(
                      e.target.checked
                        ? [...selected, m.id]
                        : selected.filter((id) => id !== m.id),
                    )
                  }
                />
                <Link
                  to={`/materials/${encodeURIComponent(m.id)}`}
                  state={{ listPath: inbox ? "/inbox" : "/library" }}
                  onClick={rememberList}
                  className="material-row-main"
                >
                  <h3>{m.title || "无标题材料"}</h3>
                  <p className="material-excerpt">{m.text}</p>
                  <div className="row-meta">
                    <span>{m.author_name || "作者未提供"}</span>
                    <span>星球 {m.group_id}</span>
                    <span>{date(m.created_at)}</span>
                    <span>
                      {m.entity_type === "answer"
                        ? "回答"
                        : m.entity_type === "comment"
                          ? "评论"
                          : "发布"}
                    </span>
                    {m.tags?.map((t) => (
                      <span className="tag" key={t}>
                        {t}
                      </span>
                    ))}
                  </div>
                </Link>
                <div className="row-status">
                  <Badge value={m.status} />
                  {m.coverage?.body !== "complete" && (
                    <span className="muted small">
                      正文
                      {m.coverage?.body === "partial"
                        ? "待补齐"
                        : "完整度未确认"}
                    </span>
                  )}
                </div>
                <Button
                  className={`icon-button ${m.starred ? "starred" : ""}`}
                  aria-label={m.starred ? "取消收藏" : "收藏材料"}
                  onClick={() =>
                    void op.run(async () => {
                      await api(endpoint(wid, `/materials/${m.id}`), {
                        method: "PATCH",
                        body: { starred: !m.starred },
                      });
                      resource.reload();
                    })
                  }
                >
                  <Icon name="star" />
                </Button>
              </article>
            ))}
            {materials.length > limit && (
              <div className="load-more">
                <Button onClick={() => setLimit((n) => n + 100)}>
                  再显示 100 条 · 剩余 {materials.length - limit}
                </Button>
              </div>
            )}
          </section>
        ) : (
          <Empty
            icon="inbox"
            title={
              q || group || author
                ? "没有匹配的资料"
                : inbox
                  ? "还没有待整理资料"
                  : "还没收进材料"
            }
            description={
              q || group || author
                ? "尝试更换关键词、成员或星球范围。"
                : "连接一个星球，先收一小批原文；也可以导入已有材料包。阅读和导出不需要配置模型。"
            }
            action={
              <>
                <Link className="button primary" to="/connections">
                  连接来源
                </Link>
                <Link className="button" to="/settings/data">
                  导入材料包
                </Link>
              </>
            }
          />
        )}
      </LoadState>
      {saveView && (
        <Dialog
          title="保存个人资料视图"
          description="仅在本机、当前用户和当前空间保存筛选，不扩大采集或分享范围。"
          onClose={() => setSaveView(false)}
        >
          <form
            className="form-stack"
            onSubmit={(e) => {
              e.preventDefault();
              persistViews(
                [
                  ...views,
                  {
                    id: crypto.randomUUID(),
                    name: viewName.trim(),
                    q,
                    status,
                    group,
                    author,
                  },
                ].slice(-30),
              );
              setSaveView(false);
              setViewName("");
            }}
          >
            <Field label="视图名称" required>
              <input
                required
                maxLength={60}
                value={viewName}
                onChange={(e) => setViewName(e.target.value)}
              />
            </Field>
            <Button primary type="submit" disabled={!viewName.trim()}>
              保存视图
            </Button>
          </form>
        </Dialog>
      )}
      {capture && <CaptureDialog onClose={() => setCapture(false)} />}{" "}
      {share && (
        <ShareDialog materialIds={selected} onClose={() => setShare(false)} />
      )}{" "}
      {dataset && (
        <Dialog title="从选中材料建立专题" onClose={() => setDataset(false)}>
          <form onSubmit={createDataset} className="form-stack">
            <Field label="专题名称" required>
              <input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <p className="muted">
              本专题包含 {selected.length} 条材料；可稍后冻结分析快照。
            </p>
            <OperationNotice op={op} />
            <Button primary type="submit" busy={op.busy}>
              创建专题
            </Button>
          </form>
        </Dialog>
      )}{" "}
      {tagging && (
        <Dialog
          title="批量设置标签"
          description="本次标签将替换所选材料的个人标签，不修改源站。"
          onClose={() => setTagging(false)}
        >
          <Field label="标签 · 用逗号分隔">
            <input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="Agent 实践, 待验证"
            />
          </Field>
          <OperationNotice op={op} />
          <Button
            primary
            busy={op.busy}
            onClick={() =>
              void op.run(async () => {
                for (const id of selected)
                  await api(endpoint(wid, `/materials/${id}`), {
                    method: "PATCH",
                    body: {
                      tags: [
                        ...new Set(
                          tags
                            .split(/[,，]/)
                            .map((s) => s.trim())
                            .filter(Boolean),
                        ),
                      ],
                    },
                  });
                resource.reload();
                setTagging(false);
                setSelected([]);
                notify("个人标签已更新。");
              })
            }
          >
            设置标签
          </Button>
        </Dialog>
      )}
    </>
  );
}

function InboxActivity() {
  const { wid } = useWorkbench();
  const reads = useApi<Material[]>(
    endpoint(wid, "/materials") + query({ status: "read" }),
  );
  const jobs = useApi<Job[]>(endpoint(wid, "/jobs"));
  const positions = (reads.data ?? [])
    .filter((m) => Boolean(m.reading_position))
    .slice(0, 3);
  const attention = (jobs.data ?? [])
    .filter((j) =>
      /approval|login|expired|unknown|failed|paused|challenge|identity/.test(
        j.state || j.status || "",
      ),
    )
    .slice(-3)
    .reverse();
  return (
    <div className="inbox-context">
      <section>
        <div className="section-heading">
          <h3>继续阅读</h3>
          <Link className="quiet-link" to="/library">
            资料库
          </Link>
        </div>
        <LoadState {...reads} retry={reads.reload}>
          {positions.length ? (
            positions.map((m) => (
              <Link
                className="context-link"
                key={m.id}
                to={`/materials/${m.id}?revision=${encodeURIComponent(typeof m.reading_position === "object" ? m.reading_position?.revision_id || m.revision_id : m.revision_id)}`}
              >
                {m.title || "无标题材料"}
                <Icon name="arrow" size={14} />
              </Link>
            ))
          ) : (
            <p className="muted small">阅读时保存位置，之后可从这里继续。</p>
          )}
        </LoadState>
      </section>
      <section>
        <div className="section-heading">
          <h3>需要你处理</h3>
          <Link className="quiet-link" to="/tasks">
            全部任务
          </Link>
        </div>
        <LoadState {...jobs} retry={jobs.reload}>
          {attention.length ? (
            attention.map((j) => (
              <Link className="context-link" key={j.id} to={`/tasks/${j.id}`}>
                <span>{j.kind === "capture" ? "来源采集" : "模型加工"}</span>
                <Badge value={j.state || j.status} />
                <Icon name="arrow" size={14} />
              </Link>
            ))
          ) : (
            <p className="muted small">当前没有待审批或需要恢复的任务。</p>
          )}
        </LoadState>
      </section>
    </div>
  );
}

function SourceAssetInfo({
  images,
  files,
}: {
  images: ImageMeta[];
  files: FileMeta[];
}) {
  if (!images.length && !files.length) return null;
  return (
    <section className="source-assets">
      <h3>来源图片与文件信息</h3>
      <p className="muted small">
        信息不等于原件。图片不会自动请求，源站权限或临时链接失效不会被标成完整备份。
      </p>
      {images.map((i) => (
        <div className="source-asset-row" key={i.id}>
          <Icon name="mark" />
          <div className="grow">
            <strong>{i.name || `图片 ${i.id}`}</strong>
            <span className="muted small">来源图片元信息</span>
          </div>
          {safeUrl(i.url) && (
            <a
              className="button"
              href={safeUrl(i.url)}
              target="_blank"
              rel="noreferrer"
            >
              自行查看源图
            </a>
          )}
        </div>
      ))}
      {files.map((f) => (
        <div className="source-asset-row" key={f.id}>
          <Icon name="mark" />
          <div className="grow">
            <strong>{f.name}</strong>
            <span className="muted small">
              {f.mime || "类型未提供"} ·{" "}
              {f.size === undefined
                ? "大小未提供"
                : `${(f.size / 1024).toFixed(1)} KB`}{" "}
              · 来源文件元信息
            </span>
          </div>
        </div>
      ))}
    </section>
  );
}

export function ReaderPage() {
  const { id = "" } = useParams();
  const { wid, notify } = useWorkbench();
  const navigate = useNavigate();
  const resource = useApi<Material>(
    endpoint(wid, `/materials/${encodeURIComponent(id)}`),
  );
  const annotations = useApi<Annotation[]>(
    endpoint(wid, "/annotations") + query({ material_id: id }),
  );
  const [revisionId, setRevisionId] = useState(""),
    [tab, setTab] = useState("original");
  const [selection, setSelection] = useState<{
      quote: string;
      start: number;
      end: number;
    }>(),
    [note, setNote] = useState(""),
    [editing, setEditing] = useState<Annotation | null>(null),
    [editNote, setEditNote] = useState("");
  const [share, setShare] = useState(false),
    [addProject, setAddProject] = useState(false),
    [projectName, setProjectName] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);
  const op = useOperation();
  const [params, setParams] = useSearchParams();
  const requestedRevision = params.get("revision") || "";
  useEffect(() => {
    if (resource.data)
      setRevisionId(requestedRevision || resource.data.revision_id);
    setSelection(undefined);
  }, [resource.data?.revision_id, id, requestedRevision]);
  const material = resource.data;
  const revision = material?.revisions?.find((r) => r.id === revisionId);
  const current = revisionId === material?.revision_id;
  const text = revision?.text ?? (current ? material?.text : "") ?? "";
  const meta = revision?.record_meta;
  const missingRevision = Boolean(
    material && revisionId && !current && !revision,
  );
  function captureSelection() {
    const s = window.getSelection();
    if (!s?.rangeCount || !bodyRef.current || !s.toString().trim()) return;
    const range = s.getRangeAt(0);
    if (
      !bodyRef.current.contains(range.startContainer) ||
      !bodyRef.current.contains(range.endContainer)
    )
      return;
    const before = range.cloneRange();
    before.selectNodeContents(bodyRef.current);
    before.setEnd(range.startContainer, range.startOffset);
    const start = before.toString().length;
    setSelection({
      start,
      end: start + s.toString().length,
      quote: s.toString(),
    });
  }
  async function saveAnnotation(e: FormEvent) {
    e.preventDefault();
    if (!selection) return;
    await op.run(async () => {
      await api(endpoint(wid, "/annotations"), {
        method: "POST",
        body: { material_id: id, revision_id: revisionId, ...selection, note },
      });
      setSelection(undefined);
      setNote("");
      annotations.reload();
      notify("批注已保存到固定原文版本。");
    });
  }
  async function mark(status: string) {
    await op.run(async () => {
      await api(endpoint(wid, `/materials/${id}`), {
        method: "PATCH",
        body: { status },
      });
      resource.reload();
    });
  }
  async function exportMaterial() {
    await op.run(async () => {
      const bundle = await api<TransferBundle>(
        endpoint(wid, "/export") +
          query({ material_ids: id, annotations: "true" }),
      );
      download(`集见-${id}.json`, JSON.stringify(bundle, null, 2));
    });
  }
  const comments = material?.comments ?? [];
  return (
    <LoadState {...resource} retry={resource.reload}>
      {material && (
        <>
          <div className="reader-toolbar">
            <Button onClick={() => navigate(-1)}>
              <Icon name="back" />
              返回资料
            </Button>
            <div className="reader-toolbar-actions">
              <Button
                onClick={() =>
                  void mark(material.status === "read" ? "unread" : "read")
                }
              >
                {material.status === "read" ? "标为未读" : "标为已读"}
              </Button>
              <Button onClick={() => setAddProject(true)}>加入专题</Button>
              <Button onClick={() => void exportMaterial()} busy={op.busy}>
                <Icon name="export" />
                导出
              </Button>
              <Button onClick={() => setShare(true)}>分享</Button>
            </div>
          </div>
          <div className="reader-layout">
            <article className="reader">
              <header className="reader-head">
                <div className="row-meta">
                  <span>星球 {material.group_id}</span>
                  <span>
                    {(meta?.author_name ?? material.author_name) ||
                      "作者未提供"}
                  </span>
                  <span>{date(meta?.created_at ?? material.created_at)}</span>
                </div>
                <h1>{(meta?.title ?? material.title) || "无标题材料"}</h1>
                <div className="reader-source">
                  <Badge value={material.status} />
                  {safeUrl(meta?.source_url ?? material.source_url) && (
                    <a
                      href={safeUrl(meta?.source_url ?? material.source_url)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      查看原帖 ↗
                    </a>
                  )}
                  <select
                    aria-label="查看原文版本"
                    value={revisionId}
                    onChange={(e) => {
                      setParams(
                        e.target.value === material.revision_id
                          ? {}
                          : { revision: e.target.value },
                      );
                      setSelection(undefined);
                    }}
                  >
                    <option value={material.revision_id}>当前原文快照</option>
                    {material.revisions
                      ?.filter((r) => r.id !== material.revision_id)
                      .map((r, i) => (
                        <option key={r.id} value={r.id}>
                          历史快照 {date(r.captured_at) || i + 1}
                        </option>
                      ))}
                  </select>
                </div>
                <CoverageView
                  coverage={revision?.coverage ?? material.coverage}
                />
                {missingRevision ? (
                  <Notice tone="error">
                    指定原文版本不存在或不可访问，未替换为当前版本。请核对引用或重新导入完整证据包。
                  </Notice>
                ) : (
                  !current && (
                    <Notice tone="warning">
                      正在查看历史快照。批注关联此版本；讨论与附件列表是最近采集状态，不声称历史完整。
                    </Notice>
                  )
                )}
              </header>
              <div className="tabs" role="tablist" aria-label="阅读分区">
                {[
                  ["original", "原文"],
                  ["discussion", "讨论"],
                  ["attachments", "附件"],
                  ["notes", `批注 ${annotations.data?.length ?? 0}`],
                ].map(([key, label]) => (
                  <button
                    role="tab"
                    aria-selected={tab === key}
                    id={`read-tab-${key}`}
                    aria-controls={`read-panel-${key}`}
                    key={key}
                    onClick={() => setTab(key)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <OperationNotice op={op} />
              <div
                id={`read-panel-${tab}`}
                role="tabpanel"
                aria-labelledby={`read-tab-${tab}`}
              >
                {tab === "original" && (
                  <>
                    <div
                      ref={bodyRef}
                      className="reader-body"
                      tabIndex={0}
                      onMouseUp={captureSelection}
                      onKeyUp={captureSelection}
                    >
                      {text || "当前快照没有正文。请检查来源权限或重新采集。"}
                    </div>
                    <div className="reader-actions">
                      <Button
                        disabled={missingRevision}
                        onClick={captureSelection}
                      >
                        <Icon name="edit" />
                        为选中原文添加批注
                      </Button>
                      <Button
                        onClick={() =>
                          void op.run(async () => {
                            const offset =
                              document.getElementById("main-content")
                                ?.scrollTop ?? 0;
                            await api(endpoint(wid, `/materials/${id}`), {
                              method: "PATCH",
                              body: {
                                reading_position: {
                                  revision_id: revisionId,
                                  offset,
                                },
                              },
                            });
                            notify("阅读位置已保存。");
                          })
                        }
                      >
                        记住当前位置
                      </Button>
                      {material.reading_position && (
                        <Button
                          onClick={() => {
                            const p = material.reading_position;
                            document.getElementById("main-content")?.scrollTo({
                              top: typeof p === "number" ? p : (p?.offset ?? 0),
                              behavior: "instant",
                            });
                          }}
                        >
                          回到已保存位置
                        </Button>
                      )}
                    </div>
                  </>
                )}
                {tab === "discussion" && (
                  <>
                    {comments.length ? (
                      <div className="discussion-list">
                        {comments.map((raw, index) => {
                          const c = raw as {
                            id?: string;
                            text?: string;
                            author_name?: string;
                            created_at?: string;
                            user?: { name?: string };
                          };
                          return (
                            <section key={c.id ?? index}>
                              <div className="row-meta">
                                <strong>
                                  {c.author_name ??
                                    c.user?.name ??
                                    "讨论参与者"}
                                </strong>
                                <span>{date(c.created_at)}</span>
                              </div>
                              <p className="prewrap">
                                {c.text ?? "该评论未返回可阅读正文。"}
                              </p>
                            </section>
                          );
                        })}
                      </div>
                    ) : (
                      <Empty
                        title="当前材料未提供独立讨论记录"
                        description="原文覆盖状态是实际采集结果；未获取讨论不能视为评论区为空。若讨论已合并入正文，请查看原文与来源。"
                      />
                    )}
                    <CoverageView
                      coverage={revision?.coverage ?? material.coverage}
                    />
                  </>
                )}
                {tab === "attachments" && (
                  <>
                    <SourceAssetInfo
                      images={revision?.images || material.images || []}
                      files={revision?.files || material.files || []}
                    />
                    {material.attachments?.length ? (
                      <div className="attachment-list">
                        {material.attachments.map((a) => (
                          <div key={a.id}>
                            <Icon name="mark" />
                            <div>
                              <strong>{a.name ?? a.filename ?? a.id}</strong>
                              <span className="muted">
                                {a.mime ?? "类型未提供"} ·{" "}
                                {a.size
                                  ? `${(a.size / 1024).toFixed(1)} KB`
                                  : "大小未提供"}
                              </span>
                            </div>
                            {a.status === "available" ? (
                              <a
                                className="button"
                                href={endpoint(wid, `/attachments/${a.id}`)}
                                download
                              >
                                下载已保存文件
                              </a>
                            ) : (
                              <Badge value={a.status || "missing"}>
                                原件未保存
                              </Badge>
                            )}
                            {(a.parse_state ||
                              a.extracted_text ||
                              a.parse_reason) && (
                              <details className="attachment-extraction">
                                <summary>
                                  解析结果 · <Badge value={a.parse_state} />
                                </summary>
                                {a.parse_reason && (
                                  <p className="muted">{a.parse_reason}</p>
                                )}
                                {a.extracted_text && (
                                  <div className="prewrap">
                                    {a.extracted_text}
                                  </div>
                                )}
                              </details>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <Empty
                        title="没有已保存的附件原件"
                        description="附件信息与原文件分开。未下载或不可访问的文件不会被标成已解析。"
                      />
                    )}
                    <CoverageView
                      coverage={revision?.coverage ?? material.coverage}
                    />
                  </>
                )}
                {tab === "notes" && (
                  <LoadState {...annotations} retry={annotations.reload}>
                    {annotations.data?.length ? (
                      <div className="annotation-list">
                        {annotations.data.map((a) => (
                          <section key={a.id}>
                            <blockquote>{a.quote}</blockquote>
                            <p className="prewrap">{a.note}</p>
                            <div className="row-meta">
                              <span>
                                {a.revision_id === revisionId
                                  ? "当前查看版本"
                                  : "其他原文版本"}
                              </span>
                              <span>{date(a.created_at)}</span>
                              <Button
                                onClick={() => {
                                  setParams({ revision: a.revision_id });
                                  setTab("original");
                                }}
                              >
                                查看对应原文
                              </Button>
                              <Button
                                onClick={() => {
                                  setEditing(a);
                                  setEditNote(a.note);
                                }}
                              >
                                编辑
                              </Button>
                              <Button
                                danger
                                onClick={() => {
                                  if (
                                    window.confirm(
                                      "删除这条个人批注？原文不会改变。",
                                    )
                                  )
                                    void op.run(async () => {
                                      await api(
                                        endpoint(wid, `/annotations/${a.id}`),
                                        { method: "DELETE" },
                                      );
                                      annotations.reload();
                                    });
                                }}
                              >
                                删除
                              </Button>
                            </div>
                          </section>
                        ))}
                      </div>
                    ) : (
                      <Empty
                        title="还没有个人批注"
                        description="回到原文选中一段内容，然后添加自己的理解。批注会固定关联原文版本。"
                      />
                    )}
                  </LoadState>
                )}
              </div>
            </article>
          </div>
          {selection && (
            <Dialog
              title="添加原文批注"
              onClose={() => setSelection(undefined)}
            >
              <form className="form-stack" onSubmit={saveAnnotation}>
                <blockquote className="selected-quote">
                  {selection.quote}
                </blockquote>
                <p className="field-hint">
                  固定版本 {revisionId} · 字符 {selection.start}–{selection.end}
                </p>
                <Field label="我的理解" required>
                  <textarea
                    autoFocus
                    required
                    rows={6}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="记录理解、疑问或待验证的部分…"
                  />
                </Field>
                <OperationNotice op={op} />
                <Button primary type="submit" busy={op.busy}>
                  保存批注
                </Button>
              </form>
            </Dialog>
          )}
          {editing && (
            <Dialog title="编辑个人批注" onClose={() => setEditing(null)}>
              <blockquote>{editing.quote}</blockquote>
              <Field label="批注正文">
                <textarea
                  rows={6}
                  value={editNote}
                  onChange={(e) => setEditNote(e.target.value)}
                />
              </Field>
              <OperationNotice op={op} />
              <Button
                primary
                busy={op.busy}
                onClick={() =>
                  void op.run(async () => {
                    await api(endpoint(wid, `/annotations/${editing.id}`), {
                      method: "PATCH",
                      body: { note: editNote },
                    });
                    annotations.reload();
                    setEditing(null);
                  })
                }
              >
                保存修改
              </Button>
            </Dialog>
          )}
          {share && (
            <ShareDialog materialIds={[id]} onClose={() => setShare(false)} />
          )}{" "}
          {addProject && (
            <Dialog
              title="建立阅读专题"
              description="从这条材料创建专题；现有专题可在专题页编辑选材。"
              onClose={() => setAddProject(false)}
            >
              <Field label="专题名称">
                <input
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                />
              </Field>
              <OperationNotice op={op} />
              <Button
                primary
                busy={op.busy}
                disabled={!projectName.trim()}
                onClick={() =>
                  void op.run(async () => {
                    await api(endpoint(wid, "/datasets"), {
                      method: "POST",
                      body: {
                        name: projectName,
                        mode: "manual",
                        material_ids: [id],
                        rule: {},
                      },
                    });
                    setAddProject(false);
                    notify("材料已加入新专题。");
                  })
                }
              >
                创建专题
              </Button>
            </Dialog>
          )}
        </>
      )}
    </LoadState>
  );
}
