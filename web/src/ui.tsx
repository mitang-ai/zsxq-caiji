import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Link } from "react-router-dom";
import { BrandMark } from "./Brand";
import { api, date, endpoint, useApi, useOperation } from "./api";
import type {
  Artifact,
  Connection,
  Coverage,
  Material,
  Session,
  SourceGroup,
  Workspace,
} from "./types";

export type Preferences = {
  theme: "system" | "paper" | "warm" | "graphite" | "mist";
  density: "comfortable" | "compact";
  reader: number;
  contrast: boolean;
};
export const defaults: Preferences = {
  theme: "system",
  density: "comfortable",
  reader: 17,
  contrast: false,
};
export const WorkbenchContext = createContext<{
  session: Session;
  workspace: Workspace;
  wid: string;
  refreshSession: () => Promise<void>;
  preferences: Preferences;
  setPreferences: (p: Preferences) => void;
  notify: (text: string) => void;
} | null>(null);
export function useWorkbench() {
  const ctx = useContext(WorkbenchContext);
  if (!ctx) throw new Error("没有已登录的工作空间");
  return ctx;
}
export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  if (name === "mark") return <BrandMark size={size} />;
  const paths: Record<string, ReactNode> = {
    inbox: (
      <>
        <path d="M4 4h16v15H4zM4 13h5l2 3h2l2-3h5" />
      </>
    ),
    library: (
      <>
        <path d="M4 4h4v16H4zM10 4h4v16h-4zM17 4l4 15-4 1-4-15" />
      </>
    ),
    projects: (
      <>
        <path d="M3 6h7l2 3h9v11H3z" />
      </>
    ),
    members: (
      <>
        <circle cx="9" cy="8" r="3" />
        <path d="M3 20v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 6" />
      </>
    ),
    process: (
      <>
        <path d="M4 5h16M4 12h16M4 19h16" />
        <circle cx="8" cy="5" r="2" />
        <circle cx="16" cy="12" r="2" />
        <circle cx="10" cy="19" r="2" />
      </>
    ),
    tasks: (
      <>
        <path d="M9 5h11M9 12h11M9 19h11M3 5l1 1 2-2M3 12l1 1 2-2M3 19h3" />
      </>
    ),
    artifacts: (
      <>
        <path d="M5 3h14v18H5zM8 8h8M8 12h8M8 16h5" />
      </>
    ),
    connections: (
      <>
        <path d="M9 15l6-6M7 13l-2 2a4 4 0 0 0 6 6l2-2M11 5l2-2a4 4 0 0 1 6 6l-2 2" />
      </>
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M10 3h4l1 3 3 1 3 3v4l-3 1-1 3-3 3h-4l-1-3-3-1-3-3v-4l3-1 1-3z" />
      </>
    ),
    search: (
      <>
        <circle cx="10" cy="10" r="6" />
        <path d="M15 15l6 6" />
      </>
    ),
    plus: <path d="M12 4v16M4 12h16" />,
    close: <path d="M5 5l14 14M19 5L5 19" />,
    arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
    menu: <path d="M4 6h16M4 12h16M4 18h16" />,
    back: <path d="M19 12H5M11 6l-6 6 6 6" />,
    check: <path d="M4 12l5 5L20 6" />,
    star: <path d="M12 3l3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z" />,
    export: (
      <>
        <path d="M12 3v12M7 8l5-5 5 5M4 15v6h16v-6" />
      </>
    ),
    pause: <path d="M8 4v16M16 4v16" />,
    play: <path d="M6 3l15 9-15 9z" />,
    info: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v6M12 7v1" />
      </>
    ),
    warning: (
      <>
        <path d="M12 3l10 18H2zM12 9v5M12 17v1" />
      </>
    ),
    edit: (
      <>
        <path d="M4 20l1-5L17 3l4 4L9 19zM14 6l4 4" />
      </>
    ),
    trash: (
      <>
        <path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7" />
      </>
    ),
    refresh: (
      <>
        <path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] ?? paths.mark}
    </svg>
  );
}
export function Button({
  children,
  primary,
  danger,
  busy,
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  primary?: boolean;
  danger?: boolean;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      {...props}
      className={`button ${primary ? "primary" : ""} ${danger ? "danger" : ""} ${className}`}
      disabled={busy || props.disabled}
    >
      {busy && <span className="spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        {description && <p className="muted">{description}</p>}
      </div>
      <div className="header-actions">{actions}</div>
    </header>
  );
}
export function Empty({
  title,
  description,
  action,
  icon = "mark",
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: string;
}) {
  return (
    <section className="empty">
      <div className="empty-icon">
        <Icon name={icon} size={28} />
      </div>
      <h2>{title}</h2>
      {description && <p>{description}</p>}
      {action && <div className="empty-action">{action}</div>}
    </section>
  );
}
export function Notice({
  children,
  tone = "info",
  action,
}: {
  children: ReactNode;
  tone?: "info" | "error" | "success" | "warning";
  action?: ReactNode;
}) {
  return (
    <div
      className={`notice ${tone}`}
      role={tone === "error" ? "alert" : "status"}
    >
      <Icon
        name={tone === "error" || tone === "warning" ? "warning" : "info"}
      />
      <div>{children}</div>
      {action && <div className="notice-action">{action}</div>}
    </div>
  );
}
export function OperationNotice({
  op,
}: {
  op: ReturnType<typeof useOperation>;
}) {
  return (
    <>
      {op.error && <Notice tone="error">{op.error}</Notice>}
      {op.message && <Notice tone="success">{op.message}</Notice>}
    </>
  );
}
export function LoadState({
  loading,
  error,
  retry,
  children,
}: {
  loading: boolean;
  error?: Error;
  retry: () => void;
  children: ReactNode;
}) {
  if (loading)
    return (
      <div className="loading" role="status">
        <span className="spinner" />
        正在读取…
      </div>
    );
  if (error)
    return (
      <Notice tone="error" action={<Button onClick={retry}>重试</Button>}>
        {error.message}
      </Notice>
    );
  return <>{children}</>;
}
export function Field({
  label,
  hint,
  children,
  required,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  required?: boolean;
}) {
  return (
    <label className="field">
      <span className="field-label">
        {label}
        {required && <span className="muted"> · 必填</span>}
      </span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}
export function Dialog({
  title,
  description,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(true, ref, onClose);
  return (
    <div
      className="dialog-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className={`dialog ${wide ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
      >
        <div className="dialog-head">
          <div>
            <h2 id="dialog-title">{title}</h2>
            {description && <p className="muted">{description}</p>}
          </div>
          <Button
            className="icon-button"
            aria-label="关闭对话框"
            onClick={onClose}
          >
            <Icon name="close" />
          </Button>
        </div>
        <div className="dialog-body">{children}</div>
      </div>
    </div>
  );
}
export function useFocusTrap(
  active: boolean,
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!active || !ref.current) return;
    const last = document.activeElement as HTMLElement | null;
    const nodes = () =>
      [
        ...(ref.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]',
        ) ?? []),
      ].filter((n) => n.offsetParent !== null);
    if (!ref.current?.contains(document.activeElement))
      (
        nodes().find((n) =>
          ["INPUT", "TEXTAREA", "SELECT"].includes(n.tagName),
        ) ?? nodes()[0]
      )?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeRef.current();
      }
      if (e.key === "Tab") {
        const items = nodes(),
          first = items[0],
          lastNode = items.at(-1);
        if (!first) {
          e.preventDefault();
          return;
        }
        if (
          e.shiftKey &&
          (document.activeElement === first ||
            !ref.current?.contains(document.activeElement))
        ) {
          e.preventDefault();
          lastNode?.focus();
        } else if (!e.shiftKey && document.activeElement === lastNode) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", handler);
    const old = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handler);
      document.body.style.overflow = old;
      if (last?.isConnected && !last.closest("[inert]"))
        last.focus({ preventScroll: true });
      else
        document.getElementById("main-content")?.focus({ preventScroll: true });
    };
  }, [active, ref]);
}
const statusNames: Record<string, string> = {
  unread: "未读",
  read: "已读",
  adopted: "已采纳",
  ignored: "已忽略",
  ready: "可用",
  connected: "已连接",
  disconnected: "未连接",
  awaiting_login: "等待登录",
  verifying: "验证中",
  expired: "会话过期",
  challenge_required: "需要验证",
  identity_mismatch: "账号不一致",
  revoked: "已撤销",
  pending: "待开始",
  queued: "排队中",
  running: "运行中",
  paused: "已暂停",
  awaiting_approval: "待审批",
  approval_required: "待审批",
  waiting_device: "等待设备",
  needs_login: "需要登录",
  login_required: "来源需要登录",
  policy_denied: "来源权限不支持",
  conflict: "版本冲突",
  rejected: "已拒绝",
  rate_limited: "限速等待",
  budget_paused: "预算暂停",
  outcome_unknown: "计费结果未知",
  unknown: "结果未知",
  partial: "部分完成",
  complete: "完整",
  completed: "已完成",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
  canceled: "已取消",
  inaccessible: "不可访问",
  missing: "原件未保存",
  available: "原件已保存",
  unsupported: "尚不支持解析",
  draft: "草稿",
  manual: "手动专题",
  dynamic: "动态专题",
  frozen: "冻结快照",
  snapshot: "冻结快照",
};
export function statusLabel(value?: string) {
  return value ? (statusNames[value] ?? value) : "未检查";
}
export function Badge({
  value,
  children,
}: {
  value?: string;
  children?: ReactNode;
}) {
  const warning =
      /partial|paused|waiting|approval|expired|unknown|challenge|inaccessible/.test(
        value ?? "",
      ),
    error = /fail|mismatch/.test(value ?? ""),
    success = /complete|succeeded|ready|connected|adopted/.test(value ?? "");
  return (
    <span
      className={`badge ${error ? "error" : warning ? "warning" : success ? "success" : ""}`}
    >
      {children ?? statusLabel(value)}
    </span>
  );
}
export function CoverageView({ coverage }: { coverage?: Coverage }) {
  return (
    <div className="coverage">
      <span>
        正文 <Badge value={coverage?.body} />
      </span>
      <span>
        讨论 <Badge value={coverage?.comments} />
      </span>
      <span>
        附件 <Badge value={coverage?.attachments} />
      </span>
      {coverage?.reasons?.length ? (
        <details>
          <summary>查看缺失原因</summary>
          <ul>
            {coverage.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
export function MaterialPicker({
  materials,
  selected,
  onChange,
}: {
  materials: Material[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const [q, setQ] = useState("");
  const visible = materials.filter((m) =>
    `${m.title} ${m.author_name ?? ""}`.toLowerCase().includes(q.toLowerCase()),
  );
  return (
    <div className="material-picker">
      <input
        aria-label="筛选待选材料"
        placeholder="查找标题或作者"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="picker-summary">
        <span>已选 {selected.length} 条</span>
        <Button
          onClick={() =>
            onChange([...new Set([...selected, ...visible.map((m) => m.id)])])
          }
          disabled={!visible.length}
        >
          选中筛选结果
        </Button>
        <Button onClick={() => onChange([])} disabled={!selected.length}>
          清空
        </Button>
      </div>
      <div className="picker-list">
        {visible.length ? (
          visible.map((m) => (
            <label className="picker-row" key={m.id}>
              <input
                type="checkbox"
                checked={selected.includes(m.id)}
                onChange={(e) =>
                  onChange(
                    e.target.checked
                      ? [...selected, m.id]
                      : selected.filter((id) => id !== m.id),
                  )
                }
              />
              <div>
                <strong>{m.title || "无标题材料"}</strong>
                <span className="muted">
                  {m.author_name || "作者未提供"} · {date(m.created_at)}
                </span>
              </div>
            </label>
          ))
        ) : (
          <p className="muted">没有可选择的材料。请先采集或导入。</p>
        )}
      </div>
    </div>
  );
}
export function ShareDialog({
  materialIds = [],
  artifactIds = [],
  onClose,
}: {
  materialIds?: string[];
  artifactIds?: string[];
  onClose: () => void;
}) {
  const { wid, session, notify } = useWorkbench();
  const [target, setTarget] = useState("");
  const [raw, setRaw] = useState(false);
  const [attachments, setAttachments] = useState(false);
  const [receipt, setReceipt] = useState<unknown>();
  const op = useOperation();
  const rawMaterials = useApi<Material[]>(
    raw ? endpoint(wid, "/materials") : null,
  );
  const rawArtifacts = useApi<Artifact[]>(
    raw && artifactIds.length ? endpoint(wid, "/artifacts") : null,
  );
  const [selectedRaw, setSelectedRaw] = useState(materialIds);
  const cited = [
    ...new Set(
      (rawArtifacts.data ?? [])
        .filter((a) => artifactIds.includes(a.id))
        .flatMap((a) => a.citations.map((c) => c.material_id)),
    ),
  ];
  const available = (rawMaterials.data ?? []).filter(
    (m) => materialIds.includes(m.id) || cited.includes(m.id),
  );
  const incompleteRaw =
    raw &&
    (rawMaterials.loading ||
      Boolean(rawMaterials.error) ||
      rawArtifacts.loading ||
      Boolean(rawArtifacts.error) ||
      cited.some((id) => !selectedRaw.includes(id)));
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!target || incompleteRaw || (!raw && !artifactIds.length)) return;
    const result = await op.run(() =>
      api(endpoint(wid, "/share"), {
        method: "POST",
        body: {
          target_workspace_id: target,
          material_ids: raw ? selectedRaw : materialIds,
          artifact_ids: artifactIds,
          include_raw: raw,
          include_attachments: raw && attachments,
        },
      }),
    );
    if (result !== undefined) {
      setReceipt(result);
      notify("分享请求已完成，请核对实际回执。");
    }
  }
  return (
    <Dialog
      title="分享指定材料"
      description="这是一次明确的材料分享。源站会话和模型 Key 不会共享。"
      onClose={onClose}
    >
      {receipt !== undefined ? (
        <div className="form-stack">
          <h3>实际分享回执</h3>
          <pre className="json-view">{JSON.stringify(receipt, null, 2)}</pre>
          <Notice>
            只确认回执中成功复制的项。未勾选原文会跳过材料；成果可只共享去标识的来源说明。撤销请到团队与分享记录。
          </Notice>
          <Button primary onClick={onClose}>
            完成
          </Button>
        </div>
      ) : (
        <form onSubmit={submit} className="form-stack">
          <Field label="目标空间" required>
            <select
              required
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            >
              <option value="">选择目标团队空间</option>
              {session.workspaces
                .filter(
                  (w) =>
                    w.id !== wid && w.kind === "team" && w.role !== "viewer",
                )
                .map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
            </select>
          </Field>
          <p>
            本次包含 {materialIds.length} 条材料、{artifactIds.length} 份成果。
          </p>
          {!session.workspaces.some(
            (w) => w.id !== wid && w.kind === "team" && w.role !== "viewer",
          ) && (
            <Notice
              action={
                <Link to="/settings/team" onClick={onClose}>
                  创建团队
                </Link>
              }
            >
              尚无可写入的目标团队。个人与旧版私有空间不会成为共享目的地。
            </Notice>
          )}
          <label className="check">
            <input
              type="checkbox"
              checked={raw}
              onChange={(e) => setRaw(e.target.checked)}
            />
            同时分享原文快照
          </label>
          <label className="check">
            <input
              type="checkbox"
              disabled={!raw}
              checked={attachments}
              onChange={(e) => setAttachments(e.target.checked)}
            />
            同时分享已保存的附件
          </label>
          {raw && (
            <LoadState
              loading={rawMaterials.loading || rawArtifacts.loading}
              error={rawMaterials.error || rawArtifacts.error}
              retry={() => {
                rawMaterials.reload();
                rawArtifacts.reload();
              }}
            >
              <fieldset>
                <legend>明确批准以下原文材料</legend>
                <MaterialPicker
                  materials={available}
                  selected={selectedRaw}
                  onChange={setSelectedRaw}
                />
              </fieldset>
              {cited.some((id) => !selectedRaw.includes(id)) && (
                <Notice tone="warning">
                  成果引用的原文尚未全部获准。明确选择所列证据，或取消原文分享，仅分享去标识的成果说明。
                </Notice>
              )}
            </LoadState>
          )}
          {materialIds.length > 0 && !raw && (
            <Notice>
              原文未勾选，所选材料不会复制，仅分享明确所选成果；请核对实际分享回执。
            </Notice>
          )}
          <OperationNotice op={op} />
          <div className="form-actions">
            <Button onClick={onClose}>取消</Button>
            <Button
              primary
              type="submit"
              busy={op.busy}
              disabled={
                !target || incompleteRaw || (!raw && !artifactIds.length)
              }
            >
              确认分享
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
export function CaptureDialog({
  initialConnection = "",
  initialGroup = "",
  initialAuthor = "",
  onClose,
}: {
  initialConnection?: string;
  initialGroup?: string;
  initialAuthor?: string;
  onClose: () => void;
}) {
  const { wid, notify } = useWorkbench();
  const conns = useApi<Connection[]>("/api/connections");
  const [conn, setConn] = useState(initialConnection);
  const groups = useApi<SourceGroup[]>(
    conn ? `/api/connections/${encodeURIComponent(conn)}/groups` : null,
  );
  const [group, setGroup] = useState(initialGroup),
    [author, setAuthor] = useState(initialAuthor);
  const [from, setFrom] = useState(""),
    [to, setTo] = useState("");
  const [pages, setPages] = useState(10);
  const [comments, setComments] = useState(true),
    [attachments, setAttachments] = useState(false);
  const [types, setTypes] = useState(["topic", "answer", "comment"]);
  const op = useOperation();
  async function submit(e: FormEvent) {
    e.preventDefault();
    const result = await op.run(() =>
      api<{ id: string }>(endpoint(wid, "/jobs"), {
        method: "POST",
        body: {
          kind: "capture",
          connection_id: conn,
          scope: {
            group_id: group,
            author_id: author || undefined,
            from: from || undefined,
            to: to || undefined,
            types,
            max_pages: pages,
            include_comments: comments,
            include_attachments: attachments,
          },
          approved: false,
        },
      }),
    );
    if (result) {
      notify("采集任务已创建，可在任务页查看实际进展。");
      onClose();
    }
  }
  return (
    <Dialog
      title="新建采集"
      description="在选定源站账号有权访问的范围内读取；不会发帖或修改源站。"
      onClose={onClose}
      wide
    >
      <form className="form-stack" onSubmit={submit}>
        <LoadState {...conns} retry={conns.reload}>
          {!conns.data?.length ? (
            <Notice
              action={
                <Link to="/connections" onClick={onClose}>
                  连接来源
                </Link>
              }
            >
              先建立独立的网页登录或官方连接。
            </Notice>
          ) : (
            <Field label="来源连接 · 工作台托管浏览器或官方通道" required>
              <select
                required
                value={conn}
                onChange={(e) => {
                  setConn(e.target.value);
                  setGroup(initialGroup);
                }}
              >
                <option value="">请选择连接</option>
                {conns.data.map((c) => (
                  <option
                    key={c.id}
                    value={c.id}
                    disabled={(c.state ?? c.status) !== "ready"}
                  >
                    {c.label} ·{" "}
                    {c.channel === "browser" ? "工作台浏览器" : "官方"} ·{" "}
                    {statusLabel(c.status ?? c.state)}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </LoadState>
        <div className="form-grid">
          <Field label="当前星球" required>
            <select
              required
              value={group}
              onChange={(e) => setGroup(e.target.value)}
              disabled={!conn || groups.loading}
            >
              <option value="">
                {groups.loading ? "正在读取星球…" : "选择星球"}
              </option>
              {(groups.data ?? []).map((g) => (
                <option key={g.id ?? g.group_id} value={g.id ?? g.group_id}>
                  {g.name ?? g.title ?? g.id ?? g.group_id}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="成员 ID · 可选"
            hint="仅筛选其在当前星球中的发布、回答和评论。"
          >
            <input
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
              placeholder="不填写则读取整个星球"
            />
          </Field>
        </div>
        {groups.error && (
          <Notice
            tone="error"
            action={<Button onClick={groups.reload}>重试</Button>}
          >
            {groups.error.message}
          </Notice>
        )}
        <div className="form-grid">
          <Field label="起始日期">
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </Field>
          <Field label="结束日期">
            <input
              type="date"
              value={to}
              min={from}
              onChange={(e) => setTo(e.target.value)}
            />
          </Field>
        </div>
        <Field
          label="最大分页数"
          hint="控制本次范围；达到上限会如实标记部分完成。"
        >
          <input
            type="number"
            required
            min={1}
            max={1000}
            value={pages}
            onChange={(e) => setPages(Number(e.target.value))}
          />
        </Field>
        <fieldset>
          <legend>内容归属</legend>
          <div className="checks">
            {[
              ["topic", "发布"],
              ["answer", "回答"],
              ["comment", "评论"],
            ].map(([id, name]) => (
              <label className="check" key={id}>
                <input
                  type="checkbox"
                  checked={types.includes(id)}
                  onChange={(e) =>
                    setTypes(
                      e.target.checked
                        ? [...types, id]
                        : types.filter((t) => t !== id),
                    )
                  }
                />
                {name}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="checks">
          <label className="check">
            <input
              type="checkbox"
              checked={comments}
              onChange={(e) => setComments(e.target.checked)}
            />
            读取讨论上下文
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={attachments}
              onChange={(e) => setAttachments(e.target.checked)}
            />
            按来源能力读取附件
          </label>
        </div>
        <Notice>
          执行位置：
          {conns.data?.find((c) => c.id === conn)?.channel === "official"
            ? "服务端官方连接"
            : "工作台托管浏览器"}
          。采集内容保存在当前空间；本次不向模型发送内容。
        </Notice>
        <OperationNotice op={op} />
        <div className="form-actions">
          <Button onClick={onClose}>取消</Button>
          <Button
            primary
            type="submit"
            busy={op.busy}
            disabled={!conn || !group || !types.length}
          >
            开始采集
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
