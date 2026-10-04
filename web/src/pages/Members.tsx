import { useEffect, useState } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { api, date, endpoint, query, useApi, useOperation } from "../api";
import type {
  Connection,
  Dataset,
  Material,
  SourceGroup,
  SourceMember,
} from "../types";
import {
  Badge,
  Button,
  CaptureDialog,
  Empty,
  Field,
  Icon,
  LoadState,
  Notice,
  OperationNotice,
  PageHeader,
  useWorkbench,
} from "../ui";

export function MembersPage() {
  const { wid, notify } = useWorkbench();
  const navigate = useNavigate();
  const { groupId, memberId: routeMember } = useParams();
  const [memberParams] = useSearchParams();
  const connections = useApi<Connection[]>("/api/connections");
  const [connection, setConnection] = useState(
      memberParams.get("connection") || "",
    ),
    [group, setGroup] = useState(groupId || ""),
    [memberQuery, setMemberQuery] = useState(""),
    [search, setSearch] = useState("");
  const groups = useApi<SourceGroup[]>(
    connection ? `/api/connections/${connection}/groups` : null,
  );
  const members = useApi<SourceMember[]>(
    connection && group
      ? `/api/connections/${connection}/groups/${encodeURIComponent(group)}/members` +
          query({ q: search })
      : null,
  );
  const [member, setMember] = useState<SourceMember | undefined>(
      routeMember
        ? { user_id: routeMember, name: `成员 ${routeMember}` }
        : undefined,
    ),
    [category, setCategory] = useState("topic"),
    [capture, setCapture] = useState(false),
    [from, setFrom] = useState(""),
    [to, setTo] = useState("");
  const op = useOperation();
  useEffect(() => {
    const t = setTimeout(() => setSearch(memberQuery), 300);
    return () => clearTimeout(t);
  }, [memberQuery]);
  useEffect(() => {
    if (groupId) setGroup(groupId);
    if (routeMember)
      setMember({ user_id: routeMember, name: `成员 ${routeMember}` });
    if (memberParams.get("connection"))
      setConnection(memberParams.get("connection")!);
  }, [groupId, routeMember]);
  useEffect(() => {
    if (!routeMember) return;
    const found = members.data?.find(
      (m) => (m.user_id || m.id) === routeMember,
    );
    if (found) setMember(found);
  }, [members.data, routeMember]);
  const memberId =
    member?.user_id ??
    member?.id ??
    member?.user?.user_id ??
    member?.user?.id ??
    "";
  const materialResource = useApi<Material[]>(
    group && memberId
      ? endpoint(wid, "/materials") +
          query({ group_id: group, author_id: memberId })
      : null,
  );
  const filtered = (materialResource.data ?? []).filter(
    (m) =>
      (m.entity_type ?? "topic") === category &&
      (!from || (m.created_at ?? "") >= from) &&
      (!to || (m.created_at ?? "") <= `${to}T23:59:59`),
  );
  async function saveResearch() {
    await op.run(async () => {
      const result = await api<Dataset>(endpoint(wid, "/datasets"), {
        method: "POST",
        body: {
          name: `${member?.name ?? member?.user?.name ?? memberId} · 星球 ${group} 的研究`,
          mode: "dynamic",
          material_ids: [],
          rule: { group_id: group, author_id: memberId },
        },
      });
      notify("成员研究专题已保存。");
      if (result.id) navigate(`/projects/${result.id}`);
    });
  }
  return (
    <>
      <PageHeader
        eyebrow="范围明确的作者研究"
        title="成员研究"
        description="这里只研究一个成员在当前星球中的内容，不混入跨星球足迹或他人的发帖。"
      />
      <LoadState {...connections} retry={connections.reload}>
        {!connections.data?.length && !group ? (
          <Empty
            icon="members"
            title="先连接一个星球账号"
            description="连接后读取你有权访问的星球与成员，再建立个人研究范围。"
            action={
              <Link className="button primary" to="/connections">
                连接来源
              </Link>
            }
          />
        ) : (
          <>
            <div className="scope-bar">
              <Field label="来源连接">
                <select
                  value={connection}
                  onChange={(e) => {
                    setConnection(e.target.value);
                    setGroup("");
                    setMember(undefined);
                  }}
                >
                  <option value="">请选择连接</option>
                  {(connections.data ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label} ·{" "}
                      {c.channel === "browser" ? "工作台浏览器" : "官方"}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="当前星球">
                <select
                  value={group}
                  disabled={!connection || groups.loading}
                  onChange={(e) => {
                    setGroup(e.target.value);
                    setMember(undefined);
                  }}
                >
                  <option value="">
                    {groups.loading ? "正在读取…" : "请选择星球"}
                  </option>
                  {groups.data?.map((g) => (
                    <option key={g.id ?? g.group_id} value={g.id ?? g.group_id}>
                      {g.name ?? g.title}
                    </option>
                  ))}
                  {group &&
                    !groups.data?.some(
                      (g) => (g.group_id ?? g.id) === group,
                    ) && (
                      <option value={group}>
                        指定星球 {group} · 需核验来源
                      </option>
                    )}
                </select>
              </Field>
              <span className="scope-position">
                源站会话归当前用户；团队空间不共享该连接。
              </span>
            </div>
            {groups.error && (
              <Notice
                tone="error"
                action={<Button onClick={groups.reload}>重试读取星球</Button>}
              >
                {groups.error.message}
              </Notice>
            )}
            {group && (
              <div className="member-layout">
                <aside className="member-selector">
                  <div className="search-field">
                    <Icon name="search" />
                    <input
                      aria-label="搜索当前星球成员"
                      placeholder="搜索成员名称"
                      value={memberQuery}
                      onChange={(e) => setMemberQuery(e.target.value)}
                    />
                  </div>
                  <LoadState {...members} retry={members.reload}>
                    {members.data?.length ? (
                      members.data.map((m) => {
                        const mid = m.user_id ?? m.id ?? m.user?.user_id;
                        return (
                          <button
                            className={`member-choice ${memberId === mid ? "selected" : ""}`}
                            key={mid}
                            onClick={() => {
                              setMember(m);
                              navigate(
                                `/groups/${encodeURIComponent(group)}/members/${encodeURIComponent(mid || "")}?connection=${encodeURIComponent(connection)}`,
                              );
                            }}
                          >
                            <span className="avatar">
                              {(m.name ?? m.user?.name ?? "?").slice(0, 1)}
                            </span>
                            <span>
                              <strong>
                                {m.name ?? m.nickname ?? m.user?.name ?? mid}
                              </strong>
                              <small>
                                {m.role || "星球成员"} · {mid}
                              </small>
                            </span>
                          </button>
                        );
                      })
                    ) : (
                      <p className="muted">
                        没有匹配成员。成员列表关闭或能力不足时请查看来源连接状态。
                      </p>
                    )}
                  </LoadState>
                </aside>
                <section className="member-results">
                  {member ? (
                    <>
                      <div className="section-header">
                        <div>
                          <h2>
                            {member.name ?? member.user?.name ?? memberId}
                          </h2>
                          <p className="muted">
                            只限星球 {group} · 成员 {memberId}
                          </p>
                        </div>
                        <div className="header-actions">
                          <Button
                            onClick={() => void saveResearch()}
                            busy={op.busy}
                          >
                            保存研究专题
                          </Button>
                          <Button primary onClick={() => setCapture(true)}>
                            采集该成员内容
                          </Button>
                        </div>
                      </div>
                      <div className="tabs">
                        {[
                          ["topic", "发布"],
                          ["answer", "回答"],
                          ["comment", "评论"],
                        ].map(([type, label]) => (
                          <button
                            key={type}
                            onClick={() => setCategory(type)}
                            className={category === type ? "active" : ""}
                          >
                            {label} ·{" "}
                            {
                              (materialResource.data ?? []).filter(
                                (m) => (m.entity_type ?? "topic") === type,
                              ).length
                            }
                          </button>
                        ))}
                      </div>
                      <div className="filter-bar">
                        <Field label="开始日期">
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
                      <OperationNotice op={op} />
                      <LoadState
                        {...materialResource}
                        retry={materialResource.reload}
                      >
                        {filtered.length ? (
                          <div className="simple-list">
                            {filtered.map((m) => (
                              <Link to={`/materials/${m.id}`} key={m.id}>
                                <div>
                                  <strong>{m.title || "无标题材料"}</strong>
                                  <span className="muted">
                                    {date(m.created_at)} · 当前星球
                                  </span>
                                </div>
                                <Badge value={m.status} />
                              </Link>
                            ))}
                          </div>
                        ) : (
                          <Empty
                            title="当前空间尚无该成员的匹配内容"
                            description="这不代表源站没有内容。先按当前范围创建采集，再核对正文和讨论覆盖。"
                            action={
                              <Button onClick={() => setCapture(true)}>
                                采集当前范围
                              </Button>
                            }
                          />
                        )}
                      </LoadState>
                    </>
                  ) : (
                    <Empty
                      title="选择当前星球中的一位成员"
                      description="发布、回答和评论将分开呈现；他人的讨论只作为上下文。"
                    />
                  )}
                </section>
              </div>
            )}
          </>
        )}
      </LoadState>
      {capture && (
        <CaptureDialog
          initialConnection={connection}
          initialGroup={group}
          initialAuthor={memberId}
          onClose={() => {
            setCapture(false);
            materialResource.reload();
          }}
        />
      )}
    </>
  );
}
