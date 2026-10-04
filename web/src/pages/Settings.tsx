import { ModelSettings } from "./Models";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { api, date, download, endpoint, useApi, useOperation } from "../api";
import {
  createArchive,
  importKey,
  parseArchive,
  uploadArchiveAttachments,
  type LocalArchive,
  type UploadState,
} from "../transfer";
import type {
  Artifact,
  Connection,
  Device,
  Invite,
  Material,
  SourceGroup,
  TeamMember,
  ToolToken,
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
  useWorkbench,
} from "../ui";

export function ConnectionsPage() {
  const connections = useApi<Connection[]>("/api/connections");
  const { notify } = useWorkbench();
  const [creating, setCreating] = useState(false),
    [browser, setBrowser] = useState<Connection>();
  const op = useOperation();
  async function verify(c: Connection) {
    const result = await op.run(() =>
      api<Connection>(`/api/connections/${c.id}/verify`, { method: "POST" }),
    );
    connections.reload();
    if (result)
      notify(
        `已核验来源账号：${result.source_account_name || result.source_account_id || "身份已确认"}`,
      );
  }
  async function revoke(c: Connection) {
    if (
      !confirm(
        `撤销「${c.label}」？这会停止使用该来源会话，已保存的材料仍保留。`,
      )
    )
      return;
    await op.run(async () => {
      await api(`/api/connections/${c.id}`, { method: "DELETE" });
      connections.reload();
    }, "连接已撤销。");
  }
  return (
    <>
      <PageHeader
        eyebrow="个人连接，不随团队分享"
        title="来源与连接"
        description="网页登录与官方通道独立。选择可用通道，不把授权失败当成空内容。"
        actions={
          <Button primary onClick={() => setCreating(true)}>
            <Icon name="plus" />
            连接知识星球
          </Button>
        }
      />
      <OperationNotice op={op} />
      <div className="source-intro">
        <section>
          <Icon name="connections" />
          <h2>在这里登录</h2>
          <p>
            工作台浏览器单独保存你的登录态。二维码、验证挑战和账号核验由你完成。
          </p>
        </section>
        <section>
          <Icon name="mark" />
          <h2>使用官方能力</h2>
          <p>
            保留官方 MCP 通道；逐次核对其可用范围。官方开关不影响独立网页路线。
          </p>
        </section>
      </div>
      <LoadState {...connections} retry={connections.reload}>
        {connections.data?.length ? (
          <div className="card-grid">
            {connections.data.map((c) => (
              <section className="connection-card panel" key={c.id}>
                <div className="card-heading">
                  <div>
                    <p className="eyebrow">
                      {c.channel === "browser"
                        ? "工作台托管浏览器"
                        : "官方 MCP"}
                    </p>
                    <h2>{c.label}</h2>
                  </div>
                  <Badge value={c.state ?? c.status} />
                </div>
                <dl className="facts">
                  <div>
                    <dt>来源账号</dt>
                    <dd>{c.source_account_name || "尚未核验"}</dd>
                  </div>
                  <div>
                    <dt>稳定账号 ID</dt>
                    <dd>{c.source_account_id || "未提供"}</dd>
                  </div>
                  <div>
                    <dt>通道策略</dt>
                    <dd>
                      {c.policy === "auto"
                        ? "按能力选择"
                        : c.policy === "official_only"
                          ? "仅官方"
                          : "仅网页会话"}
                    </dd>
                  </div>
                </dl>
                {c.error && <Notice tone="error">{c.error}</Notice>}
                <div className="card-actions">
                  {c.state !== "revoked" && (
                    <>
                      {c.channel === "browser" && (
                        <Button onClick={() => setBrowser(c)}>
                          打开登录浏览器
                        </Button>
                      )}
                      <Button busy={op.busy} onClick={() => void verify(c)}>
                        {c.channel === "browser"
                          ? "核验登录与星球"
                          : "检测官方连接"}
                      </Button>
                      <Button danger onClick={() => void revoke(c)}>
                        撤销
                      </Button>
                    </>
                  )}
                </div>
                {c.state === "ready" && <ConnectionGroups connection={c} />}
              </section>
            ))}
          </div>
        ) : (
          <Empty
            title="先连接你的星球"
            description="这里还没有来源连接。新连接只建立个人会话，不会立即采集材料。"
            icon="connections"
            action={
              <Button primary onClick={() => setCreating(true)}>
                添加连接
              </Button>
            }
          />
        )}
      </LoadState>
      <Notice>
        本机 Chrome 和 Edge
        插件可独立登录、处理与导出。配对工作台只授予明确空间的业务能力，源站
        Cookie 不会上传。<Link to="/settings/devices">管理插件设备</Link>
      </Notice>
      {creating && (
        <ConnectionForm
          onClose={() => setCreating(false)}
          onSaved={(c) => {
            setCreating(false);
            connections.reload();
            if (c.channel === "browser") setBrowser(c);
          }}
        />
      )}{" "}
      {browser && (
        <HostedBrowser
          connection={browser}
          onClose={() => {
            setBrowser(undefined);
            connections.reload();
          }}
        />
      )}
    </>
  );
}
function ConnectionGroups({ connection }: { connection: Connection }) {
  const groups = useApi<SourceGroup[]>(
    `/api/connections/${connection.id}/groups`,
  );
  return (
    <details className="connection-groups">
      <summary>查看当前可访问星球</summary>
      <LoadState {...groups} retry={groups.reload}>
        {groups.data?.length ? (
          <ul>
            {groups.data.map((g) => (
              <li key={g.group_id ?? g.id}>
                {g.name || g.title || "未命名星球"}{" "}
                <span className="muted">{g.group_id ?? g.id}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">来源未返回星球，不代表已完成采集。</p>
        )}
      </LoadState>
    </details>
  );
}
function ConnectionForm({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (c: Connection) => void;
}) {
  const [label, setLabel] = useState("我的知识星球"),
    [channel, setChannel] = useState("browser"),
    [url, setUrl] = useState("");
  const op = useOperation();
  async function submit(e: FormEvent) {
    e.preventDefault();
    const c = await op.run(() =>
      api<Connection>("/api/connections", {
        method: "POST",
        body: {
          label,
          channel,
          policy: channel === "browser" ? "browser_only" : "official_only",
          ...(channel === "official" ? { mcp_url: url } : {}),
        },
      }),
    );
    if (c) {
      setUrl("");
      onSaved(c);
    }
  }
  return (
    <Dialog title="添加个人来源连接" onClose={onClose}>
      <form className="form-stack" onSubmit={submit}>
        <Field label="连接名称" required>
          <input
            required
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={100}
          />
        </Field>
        <fieldset>
          <legend>连接方式</legend>
          <label className="radio-card">
            <input
              type="radio"
              name="channel"
              checked={channel === "browser"}
              onChange={() => setChannel("browser")}
            />
            <div>
              <strong>工作台托管浏览器</strong>
              <span>在产品内自行登录，不依赖星主官方 AI 开关。</span>
            </div>
          </label>
          <label className="radio-card">
            <input
              type="radio"
              name="channel"
              checked={channel === "official"}
              onChange={() => setChannel("official")}
            />
            <div>
              <strong>官方 MCP</strong>
              <span>
                填写官方页面生成的地址；能力与授权范围以检测结果为准。
              </span>
            </div>
          </label>
        </fieldset>
        {channel === "official" && (
          <Field
            label="官方 MCP 地址"
            required
            hint="地址可能包含凭据，只用于加密连接，不展示在团队中。"
          >
            <input
              type="password"
              autoComplete="off"
              required
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://…zsxq.com/…"
            />
          </Field>
        )}
        <Notice>仅建立连接，不自动采集，不发帖、不修改源站内容。</Notice>
        <OperationNotice op={op} />
        <div className="form-actions">
          <Button onClick={onClose}>取消</Button>
          <Button primary type="submit" busy={op.busy}>
            建立连接
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
interface Screen {
  image: string;
  width: number;
  height: number;
  url: string;
}
function HostedBrowser({
  connection,
  onClose,
}: {
  connection: Connection;
  onClose: () => void;
}) {
  const base = `/api/connections/${connection.id}`;
  const [opened, setOpened] = useState(false),
    [screen, setScreen] = useState<Screen>(),
    [text, setText] = useState(""),
    [identity, setIdentity] = useState<Connection>();
  const op = useOperation();
  const [pollError, setPollError] = useState("");
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  async function snapshot() {
    const s = await api<Screen>(`${base}/screen`);
    if (live.current) {
      setScreen(s);
      setPollError("");
    }
  }
  useEffect(() => {
    if (!opened) return;
    const timer = setInterval(() => {
      if (!document.hidden && !op.busy)
        void snapshot().catch((e) => {
          if (live.current) setPollError(e.message);
        });
    }, 2500);
    return () => clearInterval(timer);
  }, [opened, op.busy]);
  async function open() {
    await op.run(async () => {
      await api(`${base}/open`, { method: "POST" });
      setOpened(true);
      await snapshot();
    });
  }
  async function input(payload: Record<string, unknown>) {
    await op.run(async () => {
      await api(`${base}/input`, { method: "POST", body: payload });
      if (payload.type === "text") setText("");
      await snapshot();
    });
  }
  async function verify() {
    const c = await op.run(() =>
      api<Connection>(`${base}/verify`, { method: "POST" }),
    );
    if (c) setIdentity(c);
  }
  return (
    <Dialog
      title={`登录浏览器，${connection.label}`}
      description="这是隔离的工作台浏览器画面，不是知识星球 iframe。点击画面操作，登录后核验来源身份。"
      onClose={onClose}
      wide
    >
      <div className="form-stack">
        <div className="toolbar">
          <Button primary busy={op.busy} onClick={() => void open()}>
            {opened ? "重新打开浏览器" : "启动登录浏览器"}
          </Button>
          <Button
            disabled={!opened}
            busy={op.busy}
            onClick={() => void op.run(snapshot)}
          >
            <Icon name="refresh" />
            刷新画面
          </Button>
          <Button
            disabled={!opened}
            busy={op.busy}
            onClick={() => void verify()}
          >
            我已登录，核验账号
          </Button>
        </div>
        <OperationNotice op={op} />
        {pollError && (
          <Notice
            tone="error"
            action={
              <Button onClick={() => void op.run(snapshot)}>重新读取</Button>
            }
          >
            {pollError}
          </Notice>
        )}
        {screen ? (
          <>
            <div className="browser-location">
              当前来源页面：<span>{screen.url.split("?")[0]}</span>
            </div>
            <div className="browser-screen">
              <button
                className="screen-hit"
                disabled={op.busy}
                aria-label="点击工作台浏览器画面；键盘用户使用下方输入和按键"
                onClick={(e) => {
                  if (e.detail === 0) return;
                  const box = e.currentTarget.getBoundingClientRect();
                  void input({
                    type: "click",
                    x: Math.round(
                      ((e.clientX - box.left) * screen.width) / box.width,
                    ),
                    y: Math.round(
                      ((e.clientY - box.top) * screen.height) / box.height,
                    ),
                  });
                }}
              >
                <img
                  src={screen.image}
                  width={screen.width}
                  height={screen.height}
                  alt="知识星球隔离浏览器当前截图"
                  draggable={false}
                />
              </button>
            </div>
            <form
              className="browser-input"
              onSubmit={(e) => {
                e.preventDefault();
                void input({ type: "text", text });
              }}
            >
              <Field
                label="向当前输入框填写内容"
                hint="先在画面中选择输入框。内容仅发送至自己的托管浏览器，提交后立即清空。"
              >
                <input
                  type="password"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  autoComplete="off"
                />
              </Field>
              <Button type="submit" busy={op.busy} disabled={!text}>
                填写
              </Button>
            </form>
            <div className="toolbar">
              {["Tab", "Enter", "Backspace", "Control+A", "Escape"].map(
                (key) => (
                  <Button
                    key={key}
                    busy={op.busy}
                    onClick={() => void input({ type: "key", key })}
                  >
                    {key}
                  </Button>
                ),
              )}
              <Button
                busy={op.busy}
                onClick={() => void input({ type: "scroll", delta: -480 })}
              >
                向上滚动
              </Button>
              <Button
                busy={op.busy}
                onClick={() => void input({ type: "scroll", delta: 480 })}
              >
                向下滚动
              </Button>
            </div>
          </>
        ) : (
          <div className="browser-placeholder">
            <Icon name="connections" size={32} />
            <p>启动后在这里显示登录画面</p>
            <span className="muted">不会读取本机浏览器的 Cookie 或密码。</span>
          </div>
        )}
        {identity && (
          <Notice tone="success">
            核验完成：{identity.source_account_name || "来源账号"}，ID{" "}
            {identity.source_account_id || "未提供"}。
            <Badge value={identity.state} />
          </Notice>
        )}
        <Notice>
          需要扫码或验证挑战时，请在画面中完成。账号不一致会停止任务；不自动绕过验证。关闭对话框不会把会话共享给团队。
        </Notice>
      </div>
    </Dialog>
  );
}

const settingTabs = [
  ["appearance", "外观与阅读"],
  ["models", "模型服务"],
  ["team", "团队与分享"],
  ["devices", "插件设备"],
  ["agents", "外部 Agent"],
  ["data", "数据迁移"],
];
export function SettingsPage() {
  const location = useLocation();
  const selected = location.pathname.split("/")[2] || "appearance";
  const { session } = useWorkbench();
  return (
    <>
      <PageHeader
        title="设置"
        description={`${session.user.name}，个人连接与凭据独立，材料权限随当前空间。`}
      />
      <nav className="settings-tabs" aria-label="设置分类">
        {settingTabs.map(([path, label]) => (
          <NavLink key={path} to={`/settings/${path}`}>
            {label}
          </NavLink>
        ))}
      </nav>
      <div className="settings-content">
        {selected === "models" ? (
          <ModelSettings />
        ) : selected === "team" ? (
          <TeamSettings />
        ) : selected === "devices" ? (
          <DeviceSettings />
        ) : selected === "agents" ? (
          <AgentSettings />
        ) : selected === "data" ? (
          <DataSettings />
        ) : (
          <AppearanceSettings />
        )}
      </div>
    </>
  );
}
function AppearanceSettings() {
  const { preferences, setPreferences } = useWorkbench();
  return (
    <div className="settings-stack">
      <section className="settings-section">
        <h2>颜色主题</h2>
        <p className="muted">清楚的层级、克制的颜色。主题只在本设备保存。</p>
        <div className="theme-grid">
          {[
            ["system", "跟随系统"],
            ["paper", "浅色"],
            ["graphite", "深色"],
          ].map(([id, label]) => (
            <button
              key={id}
              className={`theme-choice ${preferences.theme === id ? "selected" : ""}`}
              onClick={() =>
                setPreferences({
                  ...preferences,
                  theme: id as typeof preferences.theme,
                })
              }
              aria-pressed={preferences.theme === id}
            >
              <span className={`theme-sample ${id}`}>
                <span />
                <span />
                <span />
              </span>
              <strong>{label}</strong>
              {preferences.theme === id && <Icon name="check" />}
            </button>
          ))}
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={preferences.contrast}
            onChange={(e) =>
              setPreferences({ ...preferences, contrast: e.target.checked })
            }
          />
          增强边界对比
        </label>
      </section>
      <section className="settings-section">
        <h2>布局与阅读</h2>
        <div className="form-grid">
          <Field label="列表密度">
            <select
              value={preferences.density}
              onChange={(e) =>
                setPreferences({
                  ...preferences,
                  density: e.target.value as typeof preferences.density,
                })
              }
            >
              <option value="comfortable">舒适，72px 起</option>
              <option value="compact">紧凑，48px 起</option>
            </select>
          </Field>
          <Field label={`阅读字号，${preferences.reader}px`}>
            <input
              type="range"
              min={16}
              max={22}
              step={1}
              value={preferences.reader}
              onChange={(e) =>
                setPreferences({
                  ...preferences,
                  reader: Number(e.target.value),
                })
              }
            />
          </Field>
        </div>
        <div
          className="reading-sample"
          style={{ fontSize: preferences.reader }}
        >
          知识不止于收藏。读到值得保留的段落，为它留下出处、上下文，以及自己的判断。
        </div>
        <p className="muted">
          动效跟随系统“减少动态效果”设置；所有操作支持可见键盘焦点。
        </p>
      </section>
    </div>
  );
}
interface ShareReceipt {
  id: string;
  target_workspace_id: string;
  created_at?: string;
  revoked_at?: string;
  material_ids?: string[];
  artifact_ids?: string[];
  receipt?: unknown;
}
function TeamSettings() {
  const { wid, workspace, session, refreshSession } = useWorkbench();
  const team = useApi<TeamMember[]>(endpoint(wid, "/team")),
    shares = useApi<ShareReceipt[]>(endpoint(wid, "/shares"));
  const [newSpace, setNewSpace] = useState(""),
    [email, setEmail] = useState(""),
    [role, setRole] = useState("viewer"),
    [invite, setInvite] = useState<Invite>(),
    [receipt, setReceipt] = useState<unknown>();
  const op = useOperation();
  const admin =
    workspace.kind === "team" &&
    ["owner", "admin"].includes(workspace.role || "");
  async function create(e: FormEvent) {
    e.preventDefault();
    await op.run(async () => {
      await api("/api/workspaces", {
        method: "POST",
        body: { name: newSpace },
      });
      setNewSpace("");
      await refreshSession();
    }, "团队空间已建立。请在左上角切换后邀请成员。");
  }
  async function inviteUser(e: FormEvent) {
    e.preventDefault();
    const result = await op.run(() =>
      api<Invite>(endpoint(wid, "/invites"), {
        method: "POST",
        body: { email, role },
      }),
    );
    if (result) setInvite(result);
  }
  async function changeMember(m: TeamMember, newRole?: string) {
    const uid = m.user_id || m.user?.id;
    if (!uid) return;
    if (!newRole && !confirm("移除此成员？其个人凭据和个人空间不会删除。"))
      return;
    await op.run(async () => {
      await api(endpoint(wid, `/team/${uid}`), {
        method: newRole ? "PATCH" : "DELETE",
        ...(newRole ? { body: { role: newRole } } : {}),
      });
      team.reload();
      await refreshSession();
    });
  }
  async function revoke(s: ShareReceipt) {
    if (
      !confirm(
        "撤销这次分享？未被编辑或引用的分享副本会归档；已经派生的成果可能保留，具体以回执为准。",
      )
    )
      return;
    const result = await op.run(() =>
      api(endpoint(wid, `/shares/${s.id}`), { method: "DELETE" }),
    );
    if (result) {
      setReceipt(result);
      shares.reload();
    }
  }
  async function leave() {
    if (
      !confirm(
        `退出「${workspace.name}」？该空间设备和 Agent 授权会撤销；你的个人源站会话与个人空间仍保留。`,
      )
    )
      return;
    await op.run(async () => {
      await api(endpoint(wid, "/leave"), { method: "POST" });
      await refreshSession();
    }, "已退出空间。");
  }
  const inviteUrl =
    invite?.url ||
    (invite?.token
      ? `${location.origin}/invite/${encodeURIComponent(invite.token)}`
      : "");
  return (
    <div className="settings-stack">
      <section className="settings-section">
        <h2>
          {workspace.kind === "team" ? "团队空间" : "个人私有空间"} ，{" "}
          {workspace.name}
        </h2>
        <p className="muted">
          个人与团队统一切换；团队只看到明确导入或分享至该空间的材料。
        </p>
        <OperationNotice op={op} />
        <LoadState {...team} retry={team.reload}>
          <div className="team-list">
            {team.data?.map((m) => {
              const uid = m.user_id || m.user?.id;
              const protectedUser =
                m.role === "owner" || uid === session.user.id;
              return (
                <div className="team-row" key={uid || m.id}>
                  <div className="avatar">
                    {(m.name || m.user?.name || "成").slice(0, 1)}
                  </div>
                  <div className="grow">
                    <strong>{m.name || m.user?.name || "成员"}</strong>
                    <span className="muted">{m.email || m.user?.email}</span>
                  </div>
                  {admin && !protectedUser ? (
                    <>
                      <select
                        aria-label={`设置${m.name || m.user?.name}的权限`}
                        value={m.role}
                        disabled={op.busy}
                        onChange={(e) => void changeMember(m, e.target.value)}
                      >
                        <option value="viewer">只读</option>
                        <option value="editor">编辑</option>
                        {workspace.role === "owner" && (
                          <option value="admin">管理员</option>
                        )}
                      </select>
                      <Button danger onClick={() => void changeMember(m)}>
                        移除
                      </Button>
                    </>
                  ) : (
                    <Badge>
                      {(
                        {
                          owner: "拥有者",
                          admin: "管理员",
                          editor: "编辑",
                          viewer: "只读",
                        } as Record<string, string>
                      )[m.role] || m.role}
                    </Badge>
                  )}
                </div>
              );
            })}
          </div>
        </LoadState>
        {admin ? (
          <form className="form-stack" onSubmit={inviteUser}>
            <h3>邀请指定成员</h3>
            <div className="form-grid">
              <Field label="受邀邮箱" required>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </Field>
              <Field label="空间权限">
                <select value={role} onChange={(e) => setRole(e.target.value)}>
                  <option value="viewer">只读</option>
                  <option value="editor">编辑</option>
                  {workspace.role === "owner" && (
                    <option value="admin">管理员</option>
                  )}
                </select>
              </Field>
            </div>
            <Button type="submit" busy={op.busy}>
              生成邀请链接
            </Button>
          </form>
        ) : (
          <p className="muted">
            个人/旧版私有空间不邀请成员。先建立团队空间，再明确选择材料分享；团队邀请需要拥有者或管理员权限。
          </p>
        )}
        {invite && (
          <div className="panel">
            <h3>邀请已生成</h3>
            <p>
              此实例不模拟发送邮件，请把链接明确提供给 {invite.email || email}
              。仅匹配邮箱的工作台账号能接受。
            </p>
            <input readOnly aria-label="邀请链接" value={inviteUrl} />
            <p className="muted">有效期至 {date(invite.expires_at)}</p>
            <Button
              onClick={() =>
                void op.run(
                  () => navigator.clipboard.writeText(inviteUrl),
                  "邀请链接已复制。",
                )
              }
            >
              复制链接
            </Button>
          </div>
        )}
      </section>
      <section className="settings-section">
        <h2>分享记录</h2>
        <p className="muted">
          明确选择材料后，从资料库或成果页分享。撤销不承诺删除他人已派生的知识。
        </p>
        <LoadState {...shares} retry={shares.reload}>
          {shares.data?.length ? (
            <div className="stack-list">
              {shares.data.map((s) => (
                <div className="share-row" key={s.id}>
                  <div className="grow">
                    <strong>
                      分享至{" "}
                      {session.workspaces.find(
                        (w) => w.id === s.target_workspace_id,
                      )?.name || s.target_workspace_id}
                    </strong>
                    <span className="muted">
                      {date(s.created_at)}，{s.revoked_at ? "已撤销" : "有效"}
                    </span>
                  </div>
                  <Button onClick={() => setReceipt(s)}>查看回执</Button>
                  {!s.revoked_at && (
                    <Button
                      danger
                      busy={op.busy}
                      onClick={() => void revoke(s)}
                    >
                      撤销分享
                    </Button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="muted">还没有分享记录。</p>
          )}
        </LoadState>
        {receipt !== undefined && (
          <div className="panel">
            <h3>权威分享回执</h3>
            <pre className="json-view">{JSON.stringify(receipt, null, 2)}</pre>
            <Button onClick={() => setReceipt(undefined)}>收起</Button>
          </div>
        )}
      </section>
      <section className="settings-section">
        <h2>当前空间成员身份</h2>
        {workspace.kind !== "team" ? (
          <p className="muted">
            个人私有空间不会通过邀请转为团队，个人材料保持独立。
          </p>
        ) : workspace.role === "owner" ? (
          <p className="muted">
            拥有者不能直接退出。需先转交所有权并调整自己的角色；此操作由实例管理员协助完成。
          </p>
        ) : (
          <Button danger busy={op.busy} onClick={() => void leave()}>
            退出当前空间
          </Button>
        )}
      </section>
      <section className="settings-section">
        <h2>建立新的团队空间</h2>
        <form className="inline-input" onSubmit={create}>
          <input
            aria-label="团队空间名称"
            required
            maxLength={100}
            value={newSpace}
            onChange={(e) => setNewSpace(e.target.value)}
            placeholder="团队空间名称"
          />
          <Button type="submit" busy={op.busy}>
            创建空间
          </Button>
        </form>
        <p className="field-hint">不会自动复制个人材料或个人连接。</p>
      </section>
    </div>
  );
}
function DeviceSettings() {
  const { wid, workspace } = useWorkbench();
  const devices = useApi<Device[]>("/api/devices");
  const [label, setLabel] = useState("我的浏览器插件"),
    [pair, setPair] = useState<{ code: string; expires_at: string }>();
  const op = useOperation();
  async function create(e: FormEvent) {
    e.preventDefault();
    const r = await op.run(() =>
      api<{ code: string; expires_at: string }>("/api/devices/pair", {
        method: "POST",
        body: { label, workspace_id: wid },
      }),
    );
    if (r) setPair(r);
  }
  async function revoke(d: Device) {
    if (
      !confirm(
        `撤销「${d.label}」的工作台设备身份？插件本机来源登录和本地资料仍由你管理。`,
      )
    )
      return;
    await op.run(async () => {
      await api(`/api/devices/${d.id}`, { method: "DELETE" });
      devices.reload();
    });
  }
  return (
    <div className="settings-stack">
      <section className="settings-section">
        <h2>配对 Chrome 和 Edge 插件</h2>
        <p className="muted">
          插件无需工作台账号即可独立使用。配对只为明确发送至工作台，不会同步源站登录态与模型
          Key。
        </p>
        <form className="form-stack" onSubmit={create}>
          <Field label="设备名称" required>
            <input
              value={label}
              required
              maxLength={100}
              onChange={(e) => setLabel(e.target.value)}
            />
          </Field>
          <p>
            固定目标空间：<strong>{workspace.name}</strong>
          </p>
          <Button type="submit" busy={op.busy}>
            生成一次性配对码
          </Button>
        </form>
        <OperationNotice op={op} />
        {pair && (
          <div className="pair-code">
            <p className="eyebrow">在插件中输入此码</p>
            <strong>{pair.code}</strong>
            <p className="muted">
              有效期至 {date(pair.expires_at)}；仅使用一次。
            </p>
            <div className="toolbar">
              <Button
                onClick={() =>
                  void op.run(
                    () => navigator.clipboard.writeText(pair.code),
                    "配对码已复制。",
                  )
                }
              >
                复制
              </Button>
              <Button
                onClick={() => {
                  devices.reload();
                  setPair(undefined);
                }}
              >
                已配对，刷新设备
              </Button>
            </div>
          </div>
        )}
      </section>
      <section className="settings-section">
        <div className="section-heading">
          <h2>我的已配对设备</h2>
          <Button onClick={devices.reload}>
            <Icon name="refresh" />
            刷新
          </Button>
        </div>
        <LoadState {...devices} retry={devices.reload}>
          {devices.data?.length ? (
            devices.data.map((d) => (
              <div className="device-row" key={d.id}>
                <Icon name="connections" />
                <div className="grow">
                  <strong>{d.label}</strong>
                  <span className="muted">
                    空间 {d.workspace_id}，最近使用 {date(d.last_seen_at)}
                  </span>
                </div>
                {d.revoked_at ? (
                  <Badge value="revoked" />
                ) : (
                  <Button danger onClick={() => void revoke(d)}>
                    撤销
                  </Button>
                )}
              </div>
            ))
          ) : (
            <p className="muted">没有已配对设备。本机独立使用不需要配对。</p>
          )}
        </LoadState>
      </section>
    </div>
  );
}
function AgentSettings() {
  const { wid, workspace } = useWorkbench();
  const tokens = useApi<ToolToken[]>(endpoint(wid, "/tools-tokens"));
  const [label, setLabel] = useState("我的本地 Agent"),
    [scopes, setScopes] = useState(["read"]),
    [created, setCreated] = useState<ToolToken>();
  const op = useOperation();
  async function create(e: FormEvent) {
    e.preventDefault();
    const r = await op.run(() =>
      api<ToolToken>(endpoint(wid, "/tools-tokens"), {
        method: "POST",
        body: { label, scopes },
      }),
    );
    if (r) {
      setCreated(r);
      tokens.reload();
    }
  }
  async function revoke(t: ToolToken) {
    if (!confirm(`撤销「${t.label}」？外部 Agent 将不能继续访问此空间。`))
      return;
    await op.run(async () => {
      await api(endpoint(wid, `/tools-tokens/${t.id}`), { method: "DELETE" });
      tokens.reload();
    });
  }
  return (
    <div className="settings-stack">
      <section className="settings-section">
        <h2>有限的业务工具，不开放浏览器控制</h2>
        <p className="muted">
          外部 MCP 和本地 Agent 只能读取、创建限定加工任务或导出业务材料，不能拿
          Cookie、Key、源站浏览器或任意网络代理。
        </p>
        <Notice>
          固定空间：{workspace.name}
          。外部创建的加工任务仍走审批与预算，令牌不会授予源站采集权限。
        </Notice>
        <form className="form-stack" onSubmit={create}>
          <Field label="授权名称" required>
            <input
              required
              maxLength={100}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </Field>
          <fieldset>
            <legend>预授权业务范围</legend>
            <div className="checks">
              {[
                ["read", "读取材料与任务状态"],
                ["process", "创建加工任务"],
                ["export", "导出明确材料"],
              ].map(([id, name]) => (
                <label className="check" key={id}>
                  <input
                    type="checkbox"
                    checked={scopes.includes(id)}
                    onChange={(e) =>
                      setScopes(
                        e.target.checked
                          ? [...scopes, id]
                          : scopes.filter((s) => s !== id),
                      )
                    }
                  />
                  {name}
                </label>
              ))}
            </div>
          </fieldset>
          <Button type="submit" disabled={!scopes.length} busy={op.busy}>
            生成 MCP 令牌
          </Button>
        </form>
        <OperationNotice op={op} />
        <LoadState {...tokens} retry={tokens.reload}>
          {tokens.data?.map((t) => (
            <div className="device-row" key={t.id}>
              <div className="grow">
                <strong>{t.label}</strong>
                <span className="muted">
                  {t.scopes?.join("，")}，到期 {date(t.expires_at)}
                </span>
              </div>
              {t.revoked_at ? (
                <Badge value="revoked" />
              ) : (
                <Button danger onClick={() => void revoke(t)}>
                  撤销
                </Button>
              )}
            </div>
          ))}
        </LoadState>
      </section>
      {created && (
        <Dialog
          title="保存一次性展示的令牌"
          description="仅本次展示完整令牌。请存入你的 Agent 密钥配置，关闭后不会再次显示。"
          onClose={() => setCreated(undefined)}
        >
          <div className="form-stack">
            <Field label="MCP 地址">
              <input readOnly value={`${location.origin}/mcp`} />
            </Field>
            <Field label="Authorization Bearer 令牌">
              <input type="password" readOnly value={created.token || ""} />
            </Field>
            <p>
              空间：{workspace.name}，能力：{created.scopes?.join("、")}
            </p>
            <Button
              onClick={() =>
                void op.run(
                  () => navigator.clipboard.writeText(created.token || ""),
                  "令牌已复制，请妥善保存。",
                )
              }
            >
              复制令牌
            </Button>
            <OperationNotice op={op} />
            <Button primary onClick={() => setCreated(undefined)}>
              我已保存，关闭
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
function DataSettings() {
  const { wid, workspace } = useWorkbench();
  const materials = useApi<Material[]>(endpoint(wid, "/materials")),
    artifacts = useApi<Artifact[]>(endpoint(wid, "/artifacts"));
  const [archive, setArchive] = useState<LocalArchive>(),
    [filename, setFilename] = useState(""),
    [receipt, setReceipt] = useState<unknown>(),
    [progress, setProgress] = useState("");
  const bundle = archive?.bundle;
  const op = useOperation();
  const input = useRef<HTMLInputElement>(null),
    uploads = useRef(new Map<string, UploadState>());
  async function readFile(file?: File) {
    if (!file) return;
    setArchive(undefined);
    setReceipt(undefined);
    setProgress("");
    await op.run(async () => {
      const parsed = await parseArchive(file);
      setArchive(parsed);
      setFilename(file.name);
    });
  }
  async function importBundle() {
    if (!archive) return;
    const res = await op.run(async () => {
      await uploadArchiveAttachments(
        wid,
        archive,
        uploads.current,
        setProgress,
      );
      setProgress("提交已校验证据包…");
      return api(endpoint(wid, "/import"), {
        method: "POST",
        body: { bundle: archive.bundle },
        headers: { "X-Idempotency-Key": importKey(archive.bundle) },
      });
    });
    setProgress("");
    if (res) {
      setReceipt(res);
      setArchive(undefined);
      if (input.current) input.current.value = "";
      materials.reload();
      artifacts.reload();
    }
  }
  async function exportAll(zip: boolean) {
    await op.run(async () => {
      if (!materials.data || !artifacts.data)
        throw new Error("材料列表尚未读取，请稍后重试。");
      const params = new URLSearchParams({
        material_ids: materials.data.map((m) => m.id).join(","),
        artifact_ids: artifacts.data.map((a) => a.id).join(","),
        annotations: "true",
        attachments: "true",
      });
      const b = await api<TransferBundle>(endpoint(wid, `/export?${params}`));
      if (zip) {
        const bytes = await createArchive(wid, b, setProgress);
        download(
          `xingjian-${b.bundle_id}.zip`,
          bytes.slice().buffer,
          "application/zip",
        );
      } else
        download(`xingjian-${b.bundle_id}.json`, JSON.stringify(b, null, 2));
    }, "导出包已生成；请核对包内 coverage。");
    setProgress("");
  }
  return (
    <div className="settings-stack">
      <section className="settings-section">
        <h2>导入当前空间</h2>
        <p className="muted">
          文件先在本机解析预览，只有点击确认后才上传。服务端校验
          digest，重复导入使用同一幂等键。
        </p>
        <input
          ref={input}
          type="file"
          accept=".json,.zip,application/json,application/zip"
          aria-label="选择迁移包"
          onChange={(e) => void readFile(e.target.files?.[0])}
        />
        <OperationNotice op={op} />
        {progress && (
          <p className="muted" role="status">
            {progress}
          </p>
        )}
        {bundle && (
          <div className="panel">
            <h3>{filename}</h3>
            <dl className="facts">
              <div>
                <dt>目标空间</dt>
                <dd>{workspace.name}</dd>
              </div>
              <div>
                <dt>原文记录</dt>
                <dd>{bundle.records.length}</dd>
              </div>
              <div>
                <dt>成果</dt>
                <dd>{bundle.artifacts?.length || 0}</dd>
              </div>
              <div>
                <dt>批注</dt>
                <dd>{bundle.annotations?.length || 0}</dd>
              </div>
              <div>
                <dt>已校验附件原件</dt>
                <dd>
                  {Object.keys(archive?.blobs ?? {}).length} /{" "}
                  {bundle.attachments.length}
                </dd>
              </div>
              <div>
                <dt>导出时间</dt>
                <dd>{date(bundle.exported_at)}</dd>
              </div>
            </dl>
            <Notice>
              包内成果包含其固定历史证据原文。确认后先按 1 MiB
              分片上传并核验附件，再导入材料；失败保留断点可重试。缺失原件只恢复元信息，不覆盖已有人工稿。
            </Notice>
            <div className="card-actions">
              <Button disabled={op.busy} onClick={() => setArchive(undefined)}>
                取消
              </Button>
              <Button
                primary
                busy={op.busy}
                onClick={() => void importBundle()}
              >
                确认导入「{workspace.name}」
              </Button>
            </div>
          </div>
        )}
        {receipt !== undefined && (
          <div className="panel">
            <h3>服务端导入回执</h3>
            <pre className="json-view">{JSON.stringify(receipt, null, 2)}</pre>
            <Link className="button" to="/library">
              查看资料库
            </Link>
          </div>
        )}
      </section>
      <section className="settings-section">
        <h2>导出当前空间</h2>
        <p className="muted">
          跨工作台的契约包，包含当前原文与成果/批注引用的历史证据，不包含未被引用的旧快照。knowledge-system
          仅使用契约导出，不在这里合并数据库。
        </p>
        <LoadState
          loading={materials.loading || artifacts.loading}
          error={materials.error || artifacts.error}
          retry={() => {
            materials.reload();
            artifacts.reload();
          }}
        >
          <p>
            {materials.data?.length || 0} 条材料，{artifacts.data?.length || 0}{" "}
            份成果
          </p>
          <div className="toolbar">
            <Button
              disabled={
                op.busy || (!materials.data?.length && !artifacts.data?.length)
              }
              onClick={() => void exportAll(false)}
            >
              <Icon name="export" />
              导出 JSON
            </Button>
            <Button
              disabled={
                op.busy || (!materials.data?.length && !artifacts.data?.length)
              }
              onClick={() => void exportAll(true)}
            >
              导出 ZIP
            </Button>
          </div>
        </LoadState>
        <Notice>
          JSON 包包含业务资料与附件元信息，ZIP
          额外下载并校验已保存原件。成果引用会携带固定历史原文，不是只导出成果。缺失附件不会补齐；凭据、Cookie、临时下载地址永不导出。
        </Notice>
      </section>
    </div>
  );
}
