import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  Link,
  Navigate,
  NavLink,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";
import {
  api,
  ApiError,
  date,
  query,
  setCsrf,
  useApi,
  useOperation,
} from "./api";
import { normalizeAppearance } from "../../shared/appearance";
import { AppearanceSelect, type AppearanceProps } from "./Appearance";
import { QuickAccount } from "./QuickAccount";
import { LandingPage, PluginsPage } from "./pages/Public";
import { MaterialsPage, ReaderPage } from "./pages/Materials";
import { clearMaterialListStates } from "./listState";
import { ConnectionsPage, SettingsPage } from "./pages/Settings";
import {
  ArtifactPage,
  ArtifactsPage,
  MembersPage,
  ProcessPage,
  ProjectsPage,
  TasksPage,
} from "./pages/Work";
import type { Material, Session } from "./types";
import {
  Badge,
  Button,
  defaults,
  Dialog,
  Field,
  Icon,
  LoadState,
  Notice,
  OperationNotice,
  useFocusTrap,
  useWorkbench,
  WorkbenchContext,
  type Preferences,
} from "./ui";

const navigation = [
  ["/inbox", "收件箱", "inbox"],
  ["/library", "资料库", "library"],
  ["/projects", "专题", "projects"],
  ["/members", "成员研究", "members"],
  ["/process", "加工台", "process"],
  ["/tasks", "任务", "tasks"],
  ["/artifacts", "成果", "artifacts"],
];
export function App() {
  const [session, setSession] = useState<Session | null>(null),
    [checking, setChecking] = useState(true),
    [checkError, setCheckError] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [preferences, setPreferencesState] = useState<Preferences>(() => {
    try {
      return {
        ...defaults,
        theme: normalizeAppearance(localStorage.getItem("xingjian.appearance")),
      };
    } catch {
      return defaults;
    }
  });
  const [toast, setToast] = useState("");
  const [search, setSearch] = useState(false),
    [menu, setMenu] = useState(false);
  const location = useLocation(),
    navigate = useNavigate();
  const logoutOp = useOperation();
  const [mobileNavigation, setMobileNavigation] = useState(
    () => window.matchMedia("(max-width:767px)").matches,
  );
  const sidebarRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const media = window.matchMedia("(max-width:767px)");
    const update = () => setMobileNavigation(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useFocusTrap(Boolean(session) && mobileNavigation && menu, sidebarRef, () =>
    setMenu(false),
  );
  const [pendingInvite, setPendingInvite] = useState("");
  useEffect(() => {
    if (!session && location.pathname.startsWith("/invite/"))
      setPendingInvite(location.pathname);
  }, [location.pathname, session]);
  const refreshSession = useCallback(async () => {
    const result = await api<Session>("/api/me");
    setCsrf(result.csrf);
    setSession(result);
  }, []);
  const check = useCallback(async () => {
    setChecking(true);
    setCheckError("");
    try {
      await refreshSession();
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401))
        setCheckError(err instanceof Error ? err.message : "会话检查失败");
      setSession(null);
      setCsrf("");
    } finally {
      setChecking(false);
    }
  }, [refreshSession]);
  useEffect(() => {
    void check();
  }, [check]);
  useEffect(() => {
    const expired = () => {
      setSession(null);
      setCsrf("");
      setToast("工作台会话已过期，请重新登录。未保存草稿仍在本设备。");
    };
    window.addEventListener("xingjian:session-expired", expired);
    return () =>
      window.removeEventListener("xingjian:session-expired", expired);
  }, []);
  useEffect(() => {
    if (!session) return;
    let last: string | null = null;
    try {
      last = localStorage.getItem(`xingjian.workspace.${session.user.id}`);
    } catch {
      /* Preference persistence is optional. */
    }
    setWorkspaceId((current) =>
      session.workspaces.some((w) => w.id === current)
        ? current
        : session.workspaces.some((w) => w.id === last)
          ? last!
          : (session.workspaces[0]?.id ?? ""),
    );
    try {
      const p = JSON.parse(
        localStorage.getItem(`xingjian.preferences.${session.user.id}`) ??
          "null",
      );
      if (p)
        setPreferencesState({
          ...defaults,
          ...p,
          theme: normalizeAppearance(p.theme),
          reader: Math.max(16, Math.min(22, Number(p.reader) || 17)),
        });
    } catch {
      setPreferencesState(defaults);
    }
  }, [session?.user.id]);
  useEffect(() => {
    if (session && workspaceId)
      try {
        localStorage.setItem(
          `xingjian.workspace.${session.user.id}`,
          workspaceId,
        );
      } catch {
        /* Keep the selected space in React state. */
      }
  }, [workspaceId, session?.user.id]);
  const setPreferences = (p: Preferences) => {
    setPreferencesState(p);
    if (session)
      try {
        localStorage.setItem(
          `xingjian.preferences.${session.user.id}`,
          JSON.stringify(p),
        );
      } catch {
        setToast("外观已应用，本机偏好存储不可用，重新打开后不会保留。");
      }
    if (!session)
      try {
        localStorage.setItem("xingjian.appearance", p.theme);
      } catch {
        setToast("外观已应用，本机偏好存储不可用。");
      }
  };
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme =
        preferences.theme === "system"
          ? media.matches
            ? "graphite"
            : "paper"
          : preferences.theme;
      document.documentElement.dataset.density = preferences.density;
      document.documentElement.dataset.contrast = String(preferences.contrast);
      document.documentElement.style.setProperty(
        "--reader-size",
        `${preferences.reader}px`,
      );
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [preferences]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && session) {
        if (document.querySelector(".dialog-overlay") && !search) return;
        e.preventDefault();
        setMenu(false);
        setSearch((v) => !v);
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [session, search]);
  useEffect(() => {
    setMenu(false);
    document.getElementById("main-content")?.scrollTo(0, 0);
  }, [location.pathname]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 6500);
    return () => clearTimeout(timer);
  }, [toast]);
  function signedIn(result: Session) {
    setCsrf(result.csrf);
    setSession(result);
    setWorkspaceId(result.workspaces[0]?.id ?? "");
    navigate(
      pendingInvite ||
        (location.pathname.startsWith("/artifacts/") ||
        location.pathname.startsWith("/materials/")
          ? location.pathname + location.search
          : "/inbox"),
    );
    setPendingInvite("");
  }
  if (location.pathname === "/plugins")
    return (
      <PluginsPage
        appearance={normalizeAppearance(preferences.theme)}
        onAppearanceChange={(theme) =>
          setPreferences({ ...preferences, theme })
        }
      />
    );
  if (
    location.pathname === "/welcome" ||
    (!session && !checking && !checkError && location.pathname === "/")
  )
    return (
      <LandingPage
        appearance={normalizeAppearance(preferences.theme)}
        onAppearanceChange={(theme) =>
          setPreferences({ ...preferences, theme })
        }
      />
    );
  if (checking)
    return (
      <div className="auth-shell">
        <div className="auth-appearance">
          <AppearanceSelect
            appearance={normalizeAppearance(preferences.theme)}
            onAppearanceChange={(theme) =>
              setPreferences({ ...preferences, theme })
            }
          />
        </div>
        <div className="brand">
          <Icon name="mark" size={26} />
          <strong>集见</strong>
        </div>
        <div className="loading" role="status">
          <span className="spinner" />
          正在检查会话…
        </div>
      </div>
    );
  if (checkError)
    return (
      <div className="auth-shell">
        <div className="auth-appearance">
          <AppearanceSelect
            appearance={normalizeAppearance(preferences.theme)}
            onAppearanceChange={(theme) =>
              setPreferences({ ...preferences, theme })
            }
          />
        </div>
        <Notice
          tone="error"
          action={<Button onClick={() => void check()}>重新连接</Button>}
        >
          {checkError}
        </Notice>
      </div>
    );
  if (!session)
    return (
      <>
        {toast && (
          <div className="session-notice">
            <Notice tone="warning">{toast}</Notice>
          </div>
        )}
        <Routes>
          <Route
            path="/register"
            element={
              <AuthPage
                mode="register"
                onSuccess={signedIn}
                appearance={normalizeAppearance(preferences.theme)}
                onAppearanceChange={(theme) =>
                  setPreferences({ ...preferences, theme })
                }
              />
            }
          />
          <Route
            path="/recovery"
            element={
              <AuthPage
                mode="recovery"
                onSuccess={signedIn}
                appearance={normalizeAppearance(preferences.theme)}
                onAppearanceChange={(theme) =>
                  setPreferences({ ...preferences, theme })
                }
              />
            }
          />
          <Route
            path="*"
            element={
              <AuthPage
                mode="login"
                onSuccess={signedIn}
                appearance={normalizeAppearance(preferences.theme)}
                onAppearanceChange={(theme) =>
                  setPreferences({ ...preferences, theme })
                }
              />
            }
          />
        </Routes>
      </>
    );
  const workspace =
    session.workspaces.find((w) => w.id === workspaceId) ??
    session.workspaces[0];
  if (!workspace)
    return (
      <div className="auth-shell">
        <div className="auth-appearance">
          <AppearanceSelect
            appearance={normalizeAppearance(preferences.theme)}
            onAppearanceChange={(theme) =>
              setPreferences({ ...preferences, theme })
            }
          />
        </div>
        <Notice
          tone="error"
          action={<Button onClick={() => void check()}>重新检查</Button>}
        >
          当前账号没有可访问的工作空间。
        </Notice>
      </div>
    );
  const currentTitle =
    [...navigation, ["/connections", "来源与连接"], ["/settings", "设置"]].find(
      ([path]) => location.pathname.startsWith(path),
    )?.[1] ?? "知识工作台";
  async function logout() {
    await logoutOp.run(async () => {
      await api("/api/auth/logout", { method: "POST" });
      try {
        for (const k of Object.keys(sessionStorage))
          if (k.startsWith("xingjian.draft.")) sessionStorage.removeItem(k);
      } catch {
        setToast("工作台已退出，但本机存储不可访问，未能清理本地草稿。");
      }
      if (session) clearMaterialListStates(session.user.id);
      setSession(null);
      setCsrf("");
      navigate("/login");
    });
  }
  return (
    <WorkbenchContext.Provider
      value={{
        session,
        workspace,
        wid: workspace.id,
        refreshSession,
        preferences,
        setPreferences,
        notify: setToast,
      }}
    >
      <a className="skip-link" href="#main-content">
        跳到内容
      </a>
      <div className={`app-shell ${menu ? "navigation-open" : ""}`}>
        <aside
          ref={sidebarRef}
          className="sidebar"
          inert={mobileNavigation && !menu}
          aria-hidden={mobileNavigation && !menu}
          role={mobileNavigation && menu ? "dialog" : undefined}
          aria-modal={mobileNavigation && menu ? true : undefined}
          aria-label="工作台导航"
        >
          <Link className="brand" to="/inbox">
            <Icon name="mark" size={25} />
            <strong>集见</strong>
            <span>知识工作台</span>
          </Link>
          <div className="workspace-switch">
            <label className="visually-hidden" htmlFor="workspace-select">
              当前空间
            </label>
            <select
              id="workspace-select"
              value={workspace.id}
              onChange={(e) => {
                setWorkspaceId(e.target.value);
                setToast("已切换空间；个人来源连接和模型凭据不会共享。");
              }}
            >
              {session.workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
            <span className="muted">
              {workspace.role === "viewer"
                ? "只读权限"
                : workspace.type === "personal" ||
                    ["personal", "legacy_private"].includes(
                      workspace.kind || "",
                    )
                  ? "个人私有"
                  : workspace.kind === "team"
                    ? "团队共享"
                    : "当前空间"}{" "}
              ，{" "}
              {(
                {
                  owner: "拥有者",
                  admin: "管理员",
                  editor: "编辑",
                  viewer: "只读",
                } as Record<string, string>
              )[workspace.role || ""] ?? "成员"}
            </span>
          </div>
          <Button className="search-button" onClick={() => setSearch(true)}>
            <Icon name="search" />
            <span>搜索资料</span>
            <kbd>{navigator.platform.includes("Mac") ? "⌘ K" : "Ctrl K"}</kbd>
          </Button>
          <nav aria-label="主要导航">
            {navigation.map(([path, label, icon]) => (
              <NavLink key={path} to={path}>
                <Icon name={icon} />
                <span>{label}</span>
              </NavLink>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <NavLink to="/connections">
              <Icon name="connections" />
              来源与连接
            </NavLink>
            <NavLink to="/settings">
              <Icon name="settings" />
              设置
            </NavLink>
            <div className="account-row">
              <div className="avatar">
                {session.user.name?.slice(0, 1) ?? "我"}
              </div>
              <div>
                <strong>{session.user.name}</strong>
                <span>{session.user.email}</span>
              </div>
              <Button
                className="text-button"
                busy={logoutOp.busy}
                onClick={() => void logout()}
              >
                退出
              </Button>
            </div>
          </div>
        </aside>
        {menu && (
          <button
            className="navigation-backdrop"
            aria-label="关闭导航"
            onClick={() => setMenu(false)}
          />
        )}
        <div className="workspace-main">
          <header className="topbar">
            <div className="topbar-leading">
              <Button
                className="icon-button mobile-menu"
                aria-label="打开导航"
                aria-expanded={menu}
                onClick={() => setMenu(!menu)}
              >
                <Icon name="menu" />
              </Button>
              <span className="muted workspace-name">{workspace.name}</span>
              <select
                className="compact-workspace-switch"
                aria-label="切换空间"
                value={workspace.id}
                onChange={(e) => {
                  setWorkspaceId(e.target.value);
                  setToast("已切换空间；个人来源连接和模型凭据不会共享。");
                }}
              >
                {session.workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>

              <span>{currentTitle}</span>
            </div>
            <div className="topbar-trailing">
              <AppearanceSelect
                appearance={normalizeAppearance(preferences.theme)}
                onAppearanceChange={(theme) =>
                  setPreferences({ ...preferences, theme })
                }
              />
              <span className="execution-label">独立工作台</span>
              <Link to="/settings/team" className="quiet-link">
                分享与团队
              </Link>
            </div>
          </header>
          <main id="main-content" tabIndex={-1} key={workspace.id}>
            <OperationNotice op={logoutOp} />
            {workspace.role === "viewer" && (
              <Notice>
                当前空间是只读权限，阅读与导出可用。采集、加工、编辑或邀请需要切换到有编辑权限的空间。
              </Notice>
            )}
            <Routes>
              <Route
                path="/inbox"
                element={<MaterialsPage key="inbox" inbox />}
              />
              <Route
                path="/library"
                element={<MaterialsPage key="library" />}
              />
              <Route path="/materials/:id" element={<ReaderRoute />} />
              <Route path="/projects" element={<ProjectsPage />} />
              <Route path="/projects/:id" element={<ProjectsPage />} />
              <Route path="/members" element={<MembersPage />} />
              <Route
                path="/groups/:groupId/members/:memberId"
                element={<MembersPage />}
              />
              <Route path="/process" element={<ProcessPage />} />
              <Route path="/recipes/:id" element={<ProcessPage />} />
              <Route path="/tasks" element={<TasksPage />} />
              <Route path="/tasks/:id" element={<TasksPage />} />
              <Route path="/artifacts" element={<ArtifactsPage />} />
              <Route path="/artifacts/:id" element={<ArtifactRoute />} />
              <Route path="/connections" element={<ConnectionsPage />} />
              <Route path="/settings/*" element={<SettingsPage />} />
              <Route path="/invite/:token" element={<AcceptInvitePage />} />
              <Route path="*" element={<Navigate to="/inbox" replace />} />
            </Routes>
          </main>
          <nav className="mobile-bottom" aria-label="移动导航">
            {[
              ["/library", "资料", "library"],
              ["/projects", "专题", "projects"],
              ["/tasks", "任务", "tasks"],
              ["/settings", "我的", "settings"],
            ].map(([path, label, icon]) => (
              <NavLink key={path} to={path}>
                <Icon name={icon} />
                {label}
              </NavLink>
            ))}
          </nav>
        </div>
      </div>
      {toast && (
        <div className="toast" role="status">
          <Icon name="check" />
          <span>{toast}</span>
          <Button
            className="icon-button"
            aria-label="关闭提示"
            onClick={() => setToast("")}
          >
            <Icon name="close" />
          </Button>
        </div>
      )}
      {search && <SearchDialog onClose={() => setSearch(false)} />}
    </WorkbenchContext.Provider>
  );
}

function AuthPage({
  mode,
  onSuccess,
  ...appearanceProps
}: AppearanceProps & {
  mode: "login" | "register" | "recovery";
  onSuccess: (s: Session) => void;
}) {
  const [email, setEmail] = useState(""),
    [name, setName] = useState(""),
    [password, setPassword] = useState(""),
    [token, setToken] = useState("");
  const op = useOperation();
  const [requested, setRequested] = useState(false);
  const [quickActive, setQuickActive] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (mode === "recovery") {
      await op.run(
        async () => {
          if (token) {
            await api("/api/auth/recovery/complete", {
              method: "POST",
              body: { token, password },
            });
            op.clear();
          } else {
            await api("/api/auth/recovery/request", {
              method: "POST",
              body: { email },
            });
            setRequested(true);
          }
        },
        token
          ? "密码已更新，请返回登录。"
          : "请求已提交。此实例使用管理员提供的站外恢复令牌，不会模拟发送邮件。",
      );
      return;
    }
    const result = await op.run(() =>
      api<Session>(`/api/auth/${mode}`, {
        method: "POST",
        body: { email, password, ...(mode === "register" ? { name } : {}) },
      }),
    );
    if (result) onSuccess(result);
  }
  const title =
    mode === "register"
      ? "建立你的工作空间"
      : mode === "recovery"
        ? "找回工作台账号"
        : "回到你的知识工作台";
  return (
    <div className="auth-shell">
      <div className="auth-appearance">
        <AppearanceSelect {...appearanceProps} />
      </div>
      <Link
        className="brand"
        to="/welcome"
        aria-disabled={quickActive || undefined}
        onClick={(e) => {
          if (quickActive) e.preventDefault();
        }}
      >
        <Icon name="mark" size={28} />
        <strong>集见</strong>
      </Link>
      <section className="auth-card">
        <p className="eyebrow">独立知识工作台</p>
        <h1>{title}</h1>
        <p className="muted">
          {mode === "recovery"
            ? "源站登录与工作台账号是两套独立身份。"
            : "整理原文，留下证据，把讨论变成自己的知识。"}
        </p>
        {mode !== "recovery" && (
          <QuickAccount
            disabled={op.busy}
            onActiveChange={setQuickActive}
            onSuccess={onSuccess}
          />
        )}
        {!quickActive && (
          <form className="form-stack" onSubmit={submit}>
            {mode === "register" && (
              <Field label="称呼" required>
                <input
                  autoComplete="name"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={80}
                />
              </Field>
            )}
            {!(mode === "recovery" && token) && (
              <Field
                label={mode === "login" ? "邮箱或系统账号" : "邮箱"}
                required
              >
                <input
                  type="email"
                  autoComplete="username"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </Field>
            )}
            {mode === "recovery" && (
              <Field
                label="管理员提供的恢复令牌"
                hint="已有令牌可直接填写；尚未获得则先提交恢复请求。"
              >
                <input
                  value={token}
                  autoComplete="off"
                  onChange={(e) => setToken(e.target.value)}
                />
              </Field>
            )}
            {(mode !== "recovery" || token) && (
              <Field
                label={mode === "recovery" ? "新密码" : "密码"}
                required
                hint="至少 12 个字符"
              >
                <input
                  type="password"
                  required
                  minLength={12}
                  maxLength={128}
                  autoComplete={
                    mode === "login" ? "current-password" : "new-password"
                  }
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
            )}
            <OperationNotice op={op} />
            {requested && (
              <p className="field-hint">
                请联系此工作台实例的管理员取得令牌后完成恢复。
              </p>
            )}
            <Button primary type="submit" busy={op.busy}>
              {mode === "register"
                ? "创建账号"
                : mode === "recovery"
                  ? token
                    ? "设置新密码"
                    : "提交恢复请求"
                  : "登录"}
            </Button>
          </form>
        )}
        {!quickActive && (
          <div className="auth-links">
            {mode === "login" ? (
              <>
                <Link to="/register">创建账号</Link>
                <Link to="/recovery">找回密码</Link>
              </>
            ) : (
              <Link to="/login">返回登录</Link>
            )}
          </div>
        )}
      </section>
      <p className="auth-footnote">
        知识星球会话和模型凭据单独连接；注册不会采集任何内容。
      </p>
    </div>
  );
}
function AcceptInvitePage() {
  const { token } = useParams();
  const { refreshSession } = useWorkbench();
  const op = useOperation();
  const navigate = useNavigate();
  return (
    <section className="narrow-page">
      <h1>加入团队空间</h1>
      <p className="muted">
        接受后只获得邀请指定的空间权限。你的来源会话、个人材料和模型 Key
        不会自动共享。
      </p>
      <OperationNotice op={op} />
      <Button
        primary
        busy={op.busy}
        onClick={() =>
          void op.run(async () => {
            await api("/api/invites/accept", {
              method: "POST",
              body: { token },
            });
            await refreshSession();
            navigate("/settings/team");
          })
        }
      >
        接受邀请
      </Button>
    </section>
  );
}
function SearchDialog({ onClose }: { onClose: () => void }) {
  const { wid } = useWorkbench();
  const [value, setValue] = useState(""),
    [search, setSearch] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setSearch(value), 250);
    return () => clearTimeout(timer);
  }, [value]);
  const results = useApi<Material[]>(
    search
      ? `/api/w/${encodeURIComponent(wid)}/materials${query({ q: search })}`
      : null,
  );
  return (
    <Dialog title="搜索资料" onClose={onClose} wide>
      <input
        autoFocus
        className="command-input"
        aria-label="全局搜索关键词"
        placeholder="搜索原文、标题或作者…"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      {search ? (
        <LoadState {...results} retry={results.reload}>
          <div className="command-results">
            {results.data?.length ? (
              results.data.slice(0, 30).map((m) => (
                <Link to={`/materials/${m.id}`} key={m.id} onClick={onClose}>
                  <Icon name="mark" />
                  <div>
                    <strong>{m.title || "无标题材料"}</strong>
                    <span className="muted">
                      {m.author_name ?? "作者未提供"}，{date(m.created_at)}
                    </span>
                  </div>
                  <Badge value={m.status} />
                </Link>
              ))
            ) : (
              <p className="muted">
                没有匹配材料。可更换关键词或在资料库导入内容。
              </p>
            )}
          </div>
        </LoadState>
      ) : (
        <div className="command-results">
          {navigation.map(([path, label, icon]) => (
            <Link key={path} to={path} onClick={onClose}>
              <Icon name={icon} />
              {label}
              <Icon name="arrow" />
            </Link>
          ))}
        </div>
      )}
    </Dialog>
  );
}

// Isolate reader/editor state when only the route entity ID changes.
function ReaderRoute() {
  const { id } = useParams();
  return <ReaderPage key={id} />;
}
function ArtifactRoute() {
  const { id } = useParams();
  return <ArtifactPage key={id} />;
}
