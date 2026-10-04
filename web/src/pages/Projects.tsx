import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, date, endpoint, useApi, useOperation } from "../api";
import type { Dataset, Material } from "../types";
import {
  Badge,
  Button,
  Dialog,
  Empty,
  Field,
  Icon,
  LoadState,
  MaterialPicker,
  Notice,
  OperationNotice,
  PageHeader,
  useWorkbench,
} from "../ui";

export function ProjectsPage() {
  const { wid, notify } = useWorkbench();
  const { id } = useParams();
  const navigate = useNavigate();
  const list = useApi<Dataset[]>(endpoint(wid, "/datasets"));
  const detail = useApi<Dataset>(
    id ? endpoint(wid, `/datasets/${encodeURIComponent(id)}`) : null,
  );
  const materials = useApi<Material[]>(endpoint(wid, "/materials"));
  const [edit, setEdit] = useState(false),
    [name, setName] = useState(""),
    [mode, setMode] = useState("manual"),
    [selected, setSelected] = useState<string[]>([]),
    [q, setQ] = useState(""),
    [group, setGroup] = useState(""),
    [author, setAuthor] = useState(""),
    [tags, setTags] = useState(""),
    [frozen, setFrozen] = useState<unknown>();
  const op = useOperation();
  function startEdit(d?: Dataset) {
    setName(d?.name ?? "");
    setMode(d?.mode === "dynamic" ? "dynamic" : "manual");
    setSelected(d?.material_ids ?? []);
    setQ(d?.rule?.q ?? "");
    setGroup(d?.rule?.group_id ?? "");
    setAuthor(d?.rule?.author_id ?? "");
    setTags(d?.rule?.tags?.join(", ") ?? "");
    setEdit(true);
    op.clear();
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    const result = await op.run(() =>
      api<Dataset>(endpoint(wid, id ? `/datasets/${id}` : "/datasets"), {
        method: id ? "PATCH" : "POST",
        body: {
          name,
          mode,
          material_ids: selected,
          rule: {
            q: q || undefined,
            group_id: group || undefined,
            author_id: author || undefined,
            tags: tags
              .split(/[,，]/)
              .map((t) => t.trim())
              .filter(Boolean),
          },
        },
      }),
    );
    if (result) {
      setEdit(false);
      list.reload();
      detail.reload();
      notify(id ? "专题已更新。" : "专题已建立。");
      if (!id && result.id) navigate(`/projects/${result.id}`);
    }
  }
  async function freeze() {
    const result = await op.run(() =>
      api(endpoint(wid, `/datasets/${id}/freeze`), { method: "POST" }),
    );
    if (result !== undefined) {
      setFrozen(result);
      detail.reload();
      list.reload();
      notify("已固定本次分析的材料版本。");
    }
  }
  const d = detail.data;
  const ids = d?.material_ids ?? d?.snapshot?.map((s) => s.material_id) ?? [];
  const included =
    d?.materials ?? (materials.data ?? []).filter((m) => ids.includes(m.id));
  return (
    <>
      <PageHeader
        eyebrow="长期积累"
        title={id ? (d?.name ?? "专题") : "专题"}
        description="把相关原文放在一起；动态选材和冻结分析快照分开。"
        actions={
          id ? (
            <>
              <Link className="button" to="/projects">
                全部专题
              </Link>
              <Button onClick={() => startEdit(d)} disabled={!d}>
                编辑选材
              </Button>
              <Button
                primary
                busy={op.busy}
                onClick={() => void freeze()}
                disabled={!d}
              >
                冻结快照
              </Button>
            </>
          ) : (
            <Button primary onClick={() => startEdit()}>
              <Icon name="plus" />
              建立专题
            </Button>
          )
        }
      />
      <OperationNotice op={op} />
      {id ? (
        <LoadState {...detail} retry={detail.reload}>
          {d && (
            <>
              <section className="scope-bar">
                <Badge value={d.mode} />
                <span>
                  {d.rule?.q ? `关键词：${d.rule.q}` : "手动选材"}
                  {d.rule?.group_id ? `，星球 ${d.rule.group_id}` : ""}
                  {d.rule?.author_id ? `，成员 ${d.rule.author_id}` : ""}
                </span>
                <Link
                  className="button"
                  to={`/process?dataset=${encodeURIComponent(d.id)}`}
                >
                  从本专题加工
                </Link>
                <Button
                  danger
                  onClick={() => {
                    if (window.confirm("删除这个专题？材料原文不会删除。"))
                      void op.run(async () => {
                        await api(endpoint(wid, `/datasets/${d.id}`), {
                          method: "DELETE",
                        });
                        navigate("/projects");
                      });
                  }}
                >
                  删除专题
                </Button>
              </section>
              {d.mode === "dynamic" && (
                <Notice>
                  这是动态选材规则，不是固定分析快照。启动加工前请冻结或核对服务端锁定的输入版本。
                </Notice>
              )}
              <div className="section-header">
                <h2>专题材料</h2>
                <span className="muted">{included.length} 条可查看材料</span>
              </div>
              {included.length ? (
                <div className="simple-list">
                  {included.map((m) => (
                    <Link key={m.id} to={`/materials/${m.id}`}>
                      <div>
                        <strong>{m.title || "无标题材料"}</strong>
                        <span className="muted">
                          {m.author_name ?? "作者未提供"}，{date(m.created_at)}
                        </span>
                      </div>
                      <Badge value={m.status} />
                      <Icon name="arrow" />
                    </Link>
                  ))}
                </div>
              ) : (
                <Empty
                  title="当前专题没有可阅读的选材"
                  description="编辑手动清单，或检查动态规则是否匹配已采集资料。"
                  action={
                    <Button onClick={() => startEdit(d)}>编辑选材</Button>
                  }
                />
              )}
              <div className="section-header">
                <h2>已固定的版本</h2>
              </div>
              {d.snapshot?.length ? (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>材料</th>
                        <th>原文快照</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.snapshot.map((s) => (
                        <tr key={`${s.material_id}:${s.revision_id}`}>
                          <td>
                            <Link to={`/materials/${s.material_id}`}>
                              {s.material_id}
                            </Link>
                          </td>
                          <td>
                            <code>{s.revision_id}</code>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : d.snapshots?.length ? (
                <details className="panel">
                  <summary>{d.snapshots.length} 份快照，查看版本记录</summary>
                  <pre className="json-view">
                    {JSON.stringify(d.snapshots, null, 2)}
                  </pre>
                </details>
              ) : (
                <p className="muted">
                  尚未冻结。冻结后才形成可重复分析的原文版本清单。
                </p>
              )}
            </>
          )}
        </LoadState>
      ) : (
        <LoadState {...list} retry={list.reload}>
          {list.data?.length ? (
            <div className="project-grid">
              {list.data.map((p) => (
                <Link
                  className="project-card"
                  key={p.id}
                  to={`/projects/${p.id}`}
                >
                  <div className="project-card-top">
                    <Icon name="projects" />
                    <Badge value={p.mode} />
                  </div>
                  <h2>{p.name}</h2>
                  <p className="muted">
                    {p.rule?.q ||
                      (p.mode === "dynamic"
                        ? "按已保存规则选材"
                        : `${p.material_ids?.length ?? 0} 条选材`)}
                  </p>
                  <div className="row-meta">
                    {date(p.created_at)}
                    <Icon name="arrow" />
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <Empty
              icon="projects"
              title="从一个具体问题建立专题"
              description="例如某位成员的 Agent 实践，或同一方法在不同星球里的讨论。资料为空时也可以先保存研究规则。"
              action={
                <Button primary onClick={() => startEdit()}>
                  建立专题
                </Button>
              }
            />
          )}
        </LoadState>
      )}
      {edit && (
        <Dialog
          title={id ? "编辑专题选材" : "建立专题"}
          onClose={() => setEdit(false)}
          wide
        >
          <form className="form-stack" onSubmit={submit}>
            <Field label="专题名称" required>
              <input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="一个具体的长期研究问题"
              />
            </Field>
            <Field label="选材方式">
              <select value={mode} onChange={(e) => setMode(e.target.value)}>
                <option value="manual">手动材料清单</option>
                <option value="dynamic">动态筛选规则</option>
              </select>
            </Field>
            {mode === "manual" ? (
              <LoadState {...materials} retry={materials.reload}>
                <MaterialPicker
                  materials={materials.data ?? []}
                  selected={selected}
                  onChange={setSelected}
                />
              </LoadState>
            ) : (
              <>
                <Field label="搜索关键词">
                  <input value={q} onChange={(e) => setQ(e.target.value)} />
                </Field>
                <div className="form-grid">
                  <Field label="星球 ID">
                    <input
                      value={group}
                      onChange={(e) => setGroup(e.target.value)}
                    />
                  </Field>
                  <Field label="成员 ID">
                    <input
                      value={author}
                      onChange={(e) => setAuthor(e.target.value)}
                    />
                  </Field>
                </div>
                <Field label="个人标签，逗号分隔">
                  <input
                    value={tags}
                    onChange={(e) => setTags(e.target.value)}
                  />
                </Field>
                <Notice>
                  规则只筛选当前空间已有材料，不会自动扩大源站采集范围。
                </Notice>
              </>
            )}
            <OperationNotice op={op} />
            <Button primary type="submit" busy={op.busy}>
              保存专题
            </Button>
          </form>
        </Dialog>
      )}
      {frozen !== undefined && (
        <Dialog
          title="快照已固定"
          description="以下是服务端返回的实际版本清单。"
          onClose={() => setFrozen(undefined)}
          wide
        >
          <pre className="json-view">{JSON.stringify(frozen, null, 2)}</pre>
          <Button onClick={() => setFrozen(undefined)}>完成</Button>
        </Dialog>
      )}
    </>
  );
}
