import { useEffect, useRef, useState, type FormEvent } from "react";
import ReactMarkdown from "react-markdown";
import { Link, useNavigate, useParams } from "react-router-dom";
import remarkGfm from "remark-gfm";
import {
  api,
  ApiError,
  date,
  download,
  endpoint,
  query,
  useApi,
  useOperation,
} from "../api";
import type {
  Artifact,
  Citation,
  Material,
  Proposal,
  TransferBundle,
} from "../types";
import {
  Badge,
  Button,
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

export function ArtifactsPage() {
  const { wid, notify } = useWorkbench();
  const navigate = useNavigate();
  const resource = useApi<Artifact[]>(endpoint(wid, "/artifacts"));
  const [creating, setCreating] = useState(false),
    [title, setTitle] = useState("");
  const op = useOperation();
  return (
    <>
      <PageHeader
        eyebrow="草稿与人工沉淀"
        title="成果"
        description="保留固定证据和人工修改。来源更新只会标记待复核，不覆盖你的稿件。"
        actions={
          <Button primary onClick={() => setCreating(true)}>
            <Icon name="plus" />
            写一份成果
          </Button>
        }
      />
      <OperationNotice op={op} />
      <LoadState {...resource} retry={resource.reload}>
        {resource.data?.length ? (
          <div className="artifact-list">
            {resource.data.map((a) => (
              <Link to={`/artifacts/${a.id}`} key={a.id}>
                <div className="artifact-icon">
                  <Icon name="artifacts" size={24} />
                </div>
                <div>
                  <h2>{a.title || "未命名成果"}</h2>
                  <p>{a.body?.slice(0, 150) || "尚无正文"}</p>
                  <span className="muted">
                    {a.citations?.length ?? 0} 条引用 ·{" "}
                    {date(a.updated_at ?? a.created_at)}
                  </span>
                </div>
                <Badge value={a.status} />
                {a.stale && <Badge value="partial">来源有变化</Badge>}
                <Icon name="arrow" />
              </Link>
            ))}
          </div>
        ) : (
          <Empty
            icon="artifacts"
            title="把阅读留下的理解写下来"
            description="从加工台生成有引用的草稿，或写一份自己的成果；之后可编辑、保存版本并导出。"
            action={
              <>
                <Link className="button primary" to="/process">
                  从材料加工
                </Link>
                <Button onClick={() => setCreating(true)}>新建人工稿</Button>
              </>
            }
          />
        )}
      </LoadState>
      {creating && (
        <Dialog title="新建人工成果" onClose={() => setCreating(false)}>
          <form
            className="form-stack"
            onSubmit={(e) => {
              e.preventDefault();
              void op.run(async () => {
                const a = await api<Artifact>(endpoint(wid, "/artifacts"), {
                  method: "POST",
                  body: { title, body: "", citations: [] },
                });
                notify("人工草稿已建立。");
                navigate(`/artifacts/${a.id}`);
              });
            }}
          >
            <Field label="标题" required>
              <input
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </Field>
            <OperationNotice op={op} />
            <Button primary type="submit" busy={op.busy}>
              创建草稿
            </Button>
          </form>
        </Dialog>
      )}
    </>
  );
}

export function ArtifactPage() {
  const { id = "" } = useParams();
  const { wid, session, notify } = useWorkbench();
  const resource = useApi<Artifact>(endpoint(wid, `/artifacts/${id}`));
  const materials = useApi<Material[]>(endpoint(wid, "/materials"));
  const [title, setTitle] = useState(""),
    [body, setBody] = useState(""),
    [citations, setCitations] = useState<Citation[]>([]),
    [base, setBase] = useState<string | number>(""),
    [status, setStatus] = useState("draft"),
    [dirty, setDirty] = useState(false),
    [conflict, setConflict] = useState<unknown>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [savedAt, setSavedAt] = useState("");
  const [compare, setCompare] = useState(false);
  const [compareId, setCompareId] = useState("");
  const [preview, setPreview] = useState(false),
    [citationOpen, setCitationOpen] = useState(false),
    [citationId, setCitationId] = useState(""),
    [quote, setQuote] = useState(""),
    [share, setShare] = useState(false),
    [historical, setHistorical] = useState("");
  const editor = useRef<HTMLTextAreaElement>(null);
  const initialized = useRef("");
  const op = useOperation();
  const draftKey = `xingjian.draft.${session.user.id}.${wid}.${id}`;
  const currentRevision = (a: Artifact) =>
    a.revision ??
    a.revision_id ??
    a.current_revision ??
    a.revisions?.at(-1)?.id ??
    "";
  useEffect(() => {
    const a = resource.data;
    if (!a || initialized.current === `${wid}:${id}`) return;
    initialized.current = `${wid}:${id}`;
    const r = currentRevision(a);
    setTitle(a.title);
    setBody(a.body);
    setCitations(a.citations ?? []);
    setBase(r);
    setStatus(a.status ?? "draft");
    setDirty(false);
    setConflict(undefined);
    try {
      const draft = JSON.parse(sessionStorage.getItem(draftKey) ?? "null");
      if (draft) {
        setTitle(draft.title);
        setBody(draft.body);
        setCitations(draft.citations);
        setBase(draft.base);
        setDirty(true);
        if (draft.base !== r)
          setConflict({
            message:
              "恢复的浏览器草稿基于旧版本，原稿已更新。请比较后另存或合并。",
            current: a,
          });
        notify("已恢复此浏览器中的未保存草稿。");
      }
    } catch {
      setError("本地草稿无法恢复；服务端原稿仍然保留。");
    }
  }, [resource.data, id, wid]);
  useEffect(() => {
    if (dirty)
      try {
        sessionStorage.setItem(
          draftKey,
          JSON.stringify({ title, body, citations, base }),
        );
      } catch {
        setError(
          "浏览器草稿存储不可用。请尽快保存到服务端，或导出当前 Markdown；页面不会自动丢弃你的编辑。",
        );
      }
  }, [title, body, citations, base, dirty, draftKey]);
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);
  async function save() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<Artifact>(endpoint(wid, `/artifacts/${id}`), {
        method: "PATCH",
        body: { base_revision: base, title, body, citations, status },
      });
      setBase(currentRevision(result));
      setDirty(false);
      setConflict(undefined);
      setSavedAt(new Date().toISOString());
      sessionStorage.removeItem(draftKey);
      resource.setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存未完成");
      if (err instanceof ApiError && err.status === 409)
        setConflict(err.details ?? { message: err.message });
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (!historical && !conflict) void save();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  });
  function insert(value: string) {
    const el = editor.current;
    const start = el?.selectionStart ?? body.length,
      end = el?.selectionEnd ?? start;
    setBody(body.slice(0, start) + value + body.slice(end));
    setDirty(true);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + value.length, start + value.length);
    });
  }
  const a = resource.data,
    history = a?.revisions?.find((r) => r.id === historical);
  const shownBody = historical ? (history?.body ?? history?.text ?? "") : body;
  const shownCitations = historical ? (history?.citations ?? []) : citations;
  async function exportJson() {
    await op.run(async () => {
      const bundle = await api<TransferBundle>(
        endpoint(wid, "/export") +
          query({ artifact_ids: id, annotations: "true" }),
      );
      download(`集见-成果-${id}.json`, JSON.stringify(bundle, null, 2));
    });
  }
  async function saveCopy() {
    await op.run(async () => {
      const copy = await api<Artifact>(endpoint(wid, "/artifacts"), {
        method: "POST",
        body: { title: `${title} · 保留副本`, body, citations },
      });
      sessionStorage.removeItem(draftKey);
      notify("冲突稿已另存，不覆盖其他修改。");
      window.location.assign(`/artifacts/${copy.id}`);
    });
  }
  async function addCitation(e: FormEvent) {
    e.preventDefault();
    await op.run(async () => {
      const m = await api<Material>(
        endpoint(wid, `/materials/${encodeURIComponent(citationId)}`),
      );
      const start = quote ? m.text.indexOf(quote) : 0;
      if (quote && start < 0)
        throw new Error(
          "引文必须来自完整原文，不能用列表摘要或凭空文字作为证据。",
        );
      setCitations([
        ...citations,
        {
          material_id: m.id,
          revision_id: m.revision_id,
          quote: quote || undefined,
          start,
          end: quote ? start + quote.length : undefined,
        },
      ]);
      setDirty(true);
      setCitationOpen(false);
      setQuote("");
    });
  }
  return (
    <LoadState {...resource} retry={resource.reload}>
      {a && (
        <>
          <div className="reader-toolbar">
            <Link className="button" to="/artifacts">
              <Icon name="back" />
              全部成果
            </Link>
            <div className="reader-toolbar-actions">
              <span className="muted small" role="status">
                {busy
                  ? "正在保存…"
                  : dirty
                    ? "有未保存修改 · 浏览器草稿已保留"
                    : savedAt
                      ? `已保存 ${date(savedAt)}`
                      : "服务端版本已载入"}
              </span>
              <Button
                onClick={() => {
                  download(
                    `${title || "成果"}.md`,
                    `# ${historical ? (history?.title ?? title) : title}\n\n${shownBody}\n\n## 来源引用\n${shownCitations.map((c, i) => `${i + 1}. 材料 ${c.material_id} · 快照 ${c.revision_id}${c.quote ? `\n   > ${c.quote}` : ""}`).join("\n")}`,
                    "text/markdown;charset=utf-8",
                  );
                }}
              >
                Markdown
              </Button>
              <Button onClick={() => void exportJson()} busy={op.busy}>
                材料包
              </Button>
              <Button
                onClick={() => setCompare(true)}
                disabled={!a.revisions?.length}
              >
                版本对照
              </Button>
              <Button onClick={() => setShare(true)} disabled={dirty}>
                分享已保存稿
              </Button>
              <Link
                className={`button ${dirty ? "disabled-link" : ""}`}
                aria-disabled={dirty}
                onClick={(e) => {
                  if (dirty) e.preventDefault();
                }}
                to={`/process?target_artifact=${encodeURIComponent(id)}&base_revision=${encodeURIComponent(String(a.revision_id || a.current_revision || base))}`}
              >
                生成新提案
              </Link>
              <Button
                primary
                busy={busy}
                disabled={!dirty || Boolean(conflict) || Boolean(historical)}
                onClick={() => void save()}
              >
                保存修改
              </Button>
            </div>
          </div>
          {error && (
            <Notice
              tone="error"
              action={
                !conflict ? (
                  <Button onClick={() => void save()}>重试保存</Button>
                ) : undefined
              }
            >
              {error}
            </Notice>
          )}
          <OperationNotice op={op} />
          {a.stale && (
            <Notice tone="warning">
              引用来源已有新快照。当前成果没有被自动覆盖，请逐项查看原文差异后决定是否更新。
            </Notice>
          )}
          {conflict !== undefined && (
            <Notice tone="warning">
              <p>
                保存冲突：服务端存在其他修改。你的本地稿仍然保留；不要直接覆盖最新版本。
              </p>
              <div className="header-actions">
                <Button onClick={() => void saveCopy()} busy={op.busy}>
                  把当前稿另存为副本
                </Button>
                <Button
                  onClick={() => {
                    if (
                      window.confirm(
                        "载入服务端版本？当前草稿仍可另存，但此操作会替换编辑区。",
                      )
                    ) {
                      sessionStorage.removeItem(draftKey);
                      initialized.current = "";
                      resource.reload();
                      setConflict(undefined);
                    }
                  }}
                >
                  重新载入服务端稿
                </Button>
              </div>
              <details>
                <summary>冲突回执</summary>
                <pre className="json-view">
                  {JSON.stringify(conflict, null, 2)}
                </pre>
              </details>
            </Notice>
          )}
          <div className="artifact-editor-layout">
            <article className="artifact-editor">
              <input
                className="document-title"
                aria-label="成果标题"
                disabled={Boolean(historical)}
                value={historical ? (history?.title ?? title) : title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  setDirty(true);
                }}
              />
              <div className="document-meta">
                <Field label="稿件状态">
                  <select
                    value={status}
                    disabled={Boolean(historical)}
                    onChange={(e) => {
                      setStatus(e.target.value);
                      setDirty(true);
                    }}
                  >
                    <option value="draft">草稿</option>
                    <option value="adopted">已采纳</option>
                  </select>
                </Field>
                <Field label="历史版本">
                  <select
                    value={historical}
                    onChange={(e) => setHistorical(e.target.value)}
                  >
                    <option value="">当前可编辑版本</option>
                    {a.revisions?.map((r, i) => (
                      <option key={r.id} value={r.id}>
                        版本 {i + 1} · {date(r.created_at ?? r.captured_at)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Button onClick={() => setPreview(!preview)}>
                  {preview ? "返回编辑" : "阅读预览"}
                </Button>
              </div>
              {historical && (
                <Notice>
                  正在只读查看历史成果版本。返回当前版本后再编辑；不会覆盖旧版本。
                </Notice>
              )}
              <div className="editor-tools">
                <Button
                  disabled={Boolean(historical)}
                  onClick={() => insert("\n## 小标题\n")}
                >
                  标题
                </Button>
                <Button
                  disabled={Boolean(historical)}
                  onClick={() => insert("\n- ")}
                >
                  列表
                </Button>
                <Button
                  disabled={Boolean(historical)}
                  onClick={() => insert("\n> ")}
                >
                  引用
                </Button>
                <Button
                  disabled={Boolean(historical)}
                  onClick={() =>
                    insert("\n| 项目 | 证据 |\n| --- | --- |\n|  |  |\n")
                  }
                >
                  表格
                </Button>
                <Button
                  disabled={Boolean(historical)}
                  onClick={() => insert("\n```\n\n```\n")}
                >
                  代码
                </Button>
                <Button
                  disabled={Boolean(historical)}
                  onClick={() => setCitationOpen(true)}
                >
                  添加来源引用
                </Button>
              </div>
              {preview || historical ? (
                <MarkdownPreview text={shownBody} />
              ) : (
                <textarea
                  ref={editor}
                  className="document-body"
                  aria-label="成果正文 Markdown"
                  value={body}
                  onChange={(e) => {
                    setBody(e.target.value);
                    setDirty(true);
                  }}
                  placeholder="写下你的理解，引用具体原文。支持 Markdown 标题、列表、引用、表格与代码。"
                />
              )}
            </article>
            <aside className="citation-panel">
              <h3>固定来源引用</h3>
              <p className="muted">
                {shownCitations.length} 条引用；指向采集时保存的原文版本。
              </p>
              {shownCitations.length ? (
                shownCitations.map((c, index) => (
                  <section key={`${c.material_id}:${c.revision_id}:${index}`}>
                    <Link
                      to={`/materials/${c.material_id}?revision=${encodeURIComponent(c.revision_id)}`}
                    >
                      <strong>
                        [{index + 1}]{" "}
                        {materials.data?.find((m) => m.id === c.material_id)
                          ?.title || c.material_id}
                      </strong>
                    </Link>
                    <code>{c.revision_id}</code>
                    {c.quote && <blockquote>{c.quote}</blockquote>}
                    <Button
                      className="text-button danger"
                      disabled={Boolean(historical)}
                      onClick={() => {
                        setCitations(citations.filter((_, i) => i !== index));
                        setDirty(true);
                      }}
                    >
                      移除引用
                    </Button>
                  </section>
                ))
              ) : (
                <p className="muted">
                  尚无证据引用。人工稿可从已保存材料添加。
                </p>
              )}
              <div className="inspector-note">
                <strong>原文不随编辑改变</strong>
                <p>编辑的是自己的成果，源站原文和历史快照始终独立。</p>
              </div>
            </aside>
          </div>
          <ProposalPanel
            artifact={a}
            dirty={dirty}
            onChanged={() => {
              sessionStorage.removeItem(draftKey);
              initialized.current = "";
              setDirty(false);
              resource.reload();
            }}
          />
          {compare && (
            <Dialog
              title="已保存版本对照"
              description="只读比较固定历史版本与当前已保存稿；不改变人工编辑。"
              onClose={() => setCompare(false)}
              wide
            >
              <div className="form-stack">
                <Field label="对照历史版本">
                  <select
                    value={compareId}
                    onChange={(e) => setCompareId(e.target.value)}
                  >
                    <option value="">选择历史版本</option>
                    {a.revisions?.map((r, i) => (
                      <option key={r.id} value={r.id}>
                        版本 {i + 1} · {date(r.created_at)}
                      </option>
                    ))}
                  </select>
                </Field>
                <div className="version-compare">
                  <section>
                    <h3>
                      历史 ·{" "}
                      {a.revisions?.find((r) => r.id === compareId)?.title ||
                        "未选择"}
                    </h3>
                    <div className="prewrap">
                      {a.revisions?.find((r) => r.id === compareId)?.body ??
                        "选择版本后显示原文"}
                    </div>
                  </section>
                  <section>
                    <h3>当前已保存 · {a.title}</h3>
                    <div className="prewrap">{a.body}</div>
                  </section>
                </div>
              </div>
            </Dialog>
          )}
          {share && (
            <ShareDialog artifactIds={[id]} onClose={() => setShare(false)} />
          )}{" "}
          {citationOpen && (
            <Dialog
              title="添加固定来源引用"
              onClose={() => setCitationOpen(false)}
            >
              <form
                className="form-stack"
                onSubmit={(e) => void addCitation(e)}
              >
                <Field label="材料">
                  <select
                    required
                    value={citationId}
                    onChange={(e) => {
                      setCitationId(e.target.value);
                      setQuote("");
                    }}
                  >
                    <option value="">选择已保存材料</option>
                    {materials.data?.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.title || m.id}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field
                  label="原文引句 · 可选"
                  hint="保存时读取完整原文验证，不以列表摘要为证据；不填写则固定引用整个版本。"
                >
                  <textarea
                    rows={4}
                    value={quote}
                    onChange={(e) => setQuote(e.target.value)}
                  />
                </Field>
                {error && <Notice tone="error">{error}</Notice>}
                <OperationNotice op={op} />
                <Button
                  primary
                  type="submit"
                  busy={op.busy}
                  disabled={!citationId}
                >
                  添加引用
                </Button>
              </form>
            </Dialog>
          )}
        </>
      )}
    </LoadState>
  );
}
function ProposalPanel({
  artifact,
  dirty,
  onChanged,
}: {
  artifact: Artifact;
  dirty: boolean;
  onChanged: () => void;
}) {
  const { wid, notify } = useWorkbench();
  const proposals = useApi<Proposal[]>(
    endpoint(wid, `/artifacts/${artifact.id}/proposals`),
  );
  const [selected, setSelected] = useState<Proposal>();
  const op = useOperation();
  async function adopt(p: Proposal) {
    if (
      dirty ||
      !confirm(
        "采纳此提案为新的人工稿版本？原版本继续保留；若前稿已变化，服务端将拒绝覆盖。",
      )
    )
      return;
    const result = await op.run(() =>
      api<Artifact>(endpoint(wid, `/artifacts/${artifact.id}/adopt`), {
        method: "POST",
        body: {
          proposal_id: p.id,
          base_revision:
            artifact.revision_id ||
            artifact.current_revision ||
            artifact.revision,
        },
      }),
    );
    if (result) {
      setSelected(undefined);
      proposals.reload();
      onChanged();
      notify("提案已采纳为新版本，旧稿保持独立。");
    }
  }
  async function reject(p: Proposal) {
    if (!confirm("拒绝此提案？不改变当前人工稿。")) return;
    await op.run(async () => {
      await api(endpoint(wid, `/artifacts/${artifact.id}/proposals/${p.id}`), {
        method: "DELETE",
      });
      setSelected(undefined);
      proposals.reload();
    }, "提案已拒绝，当前稿未改变。");
  }
  return (
    <section className="proposal-list">
      <div className="section-heading">
        <div>
          <h2>新提案</h2>
          <p className="muted">来源变化只形成提案；模型不直接覆盖人工沉淀。</p>
        </div>
        <Button onClick={proposals.reload}>刷新</Button>
      </div>
      <OperationNotice op={op} />
      <LoadState {...proposals} retry={proposals.reload}>
        {proposals.data?.length ? (
          proposals.data.map((p) => (
            <article className="proposal-row" key={p.id}>
              <h3>{p.title}</h3>
              <div className="row-meta">
                <Badge value={p.status || "pending"} />
                <span>
                  {date(p.created_at)} · 前稿{" "}
                  {p.base_revision_number ?? p.base_revision}
                </span>
                {p.conflict && <Badge value="partial">前稿已变化</Badge>}
              </div>
              <div className="card-actions">
                <Button onClick={() => setSelected(p)}>查看版本对照</Button>
                {p.job_id && (
                  <Link className="button" to={`/tasks/${p.job_id}`}>
                    执行依据
                  </Link>
                )}
                {!p.adopted_at &&
                  !p.rejected_at &&
                  !["adopted", "rejected"].includes(p.status || "") && (
                    <>
                      <Button
                        primary
                        disabled={dirty || p.conflict}
                        busy={op.busy}
                        onClick={() => void adopt(p)}
                      >
                        人工采纳
                      </Button>
                      <Button
                        danger
                        busy={op.busy}
                        onClick={() => void reject(p)}
                      >
                        拒绝
                      </Button>
                    </>
                  )}
              </div>
            </article>
          ))
        ) : (
          <p className="muted">
            还没有新提案。可从上方为已保存稿建立有预算的加工计划。
          </p>
        )}
      </LoadState>
      {dirty && (
        <p className="field-hint">先保存或另存当前修改，才能采纳提案。</p>
      )}
      {selected && (
        <Dialog
          title="提案与固定前稿对照"
          description="这是保存的产物，不是模型思考过程。正文与证据都需要人工复核。"
          onClose={() => setSelected(undefined)}
          wide
        >
          <div className="version-compare">
            <section>
              <h3>固定前稿 · {selected.base_title || artifact.title}</h3>
              <div className="prewrap">
                {selected.base_body ?? "前稿正文未提供"}
              </div>
            </section>
            <section>
              <h3>新提案 · {selected.title}</h3>
              <MarkdownPreview text={selected.body} />
              <p className="muted">{selected.citations.length} 条固定引用</p>
            </section>
          </div>
          {selected.conflict && (
            <Notice tone="warning">
              当前人工稿已变化，不能直接采纳此提案覆盖。请回到最新稿重新生成提案。
            </Notice>
          )}
          <OperationNotice op={op} />
          <div className="form-actions">
            <Button onClick={() => setSelected(undefined)}>关闭</Button>
            {!selected.conflict &&
              !dirty &&
              !["adopted", "rejected"].includes(selected.status || "") && (
                <Button
                  primary
                  busy={op.busy}
                  onClick={() => void adopt(selected)}
                >
                  人工采纳
                </Button>
              )}
          </div>
        </Dialog>
      )}
    </section>
  );
}
function MarkdownPreview({ text }: { text: string }) {
  return (
    <div className="markdown-preview">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children} ↗
            </a>
          ),
          img: ({ alt }) => (
            <span className="blocked-image">
              [外部图片默认未加载：{alt || "未提供说明"}]
            </span>
          ),
          table: ({ children }) => (
            <div className="table-wrap">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
