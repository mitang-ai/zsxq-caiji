import { useEffect, useState } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { api, endpoint, modelIds, useApi, useOperation } from "../api";
import type {
  Artifact,
  Dataset,
  Job,
  Material,
  Preset,
  Provider,
  Recipe,
} from "../types";
import {
  Badge,
  Button,
  Dialog,
  Empty,
  Field,
  LoadState,
  MaterialPicker,
  Notice,
  OperationNotice,
  PageHeader,
  statusLabel,
  useWorkbench,
} from "../ui";

export function ProcessPage() {
  const { wid, notify } = useWorkbench();
  const { id } = useParams();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const presets = useApi<Preset[]>("/api/recipes/presets");
  const providers = useApi<Provider[]>("/api/providers");
  const materials = useApi<Material[]>(endpoint(wid, "/materials"));
  const datasets = useApi<Dataset[]>(endpoint(wid, "/datasets"));
  const recipes = useApi<Recipe[]>(endpoint(wid, "/recipes"));
  const [presetId, setPresetId] = useState(""),
    [name, setName] = useState(""),
    [goal, setGoal] = useState(""),
    [providerId, setProviderId] = useState(""),
    [model, setModel] = useState(""),
    [inputMode, setInputMode] = useState(
      params.get("dataset") ? "dataset" : "materials",
    ),
    [datasetId, setDatasetId] = useState(params.get("dataset") ?? ""),
    [selected, setSelected] = useState<string[]>([]);
  const [maxTokens, setMaxTokens] = useState(4096),
    [inputLimit, setInputLimit] = useState(40000),
    [calls, setCalls] = useState(1),
    [approval, setApproval] = useState("manual");
  const [plan, setPlan] = useState(false);
  const [saved, setSaved] = useState<Recipe>();
  const op = useOperation();
  const preset = presets.data?.find((p) => p.id === presetId);
  const provider = providers.data?.find((p) => p.id === providerId);
  const targetId = params.get("target_artifact") || "";
  const targetBase = params.get("base_revision") || "";
  const target = useApi<Artifact>(
    targetId
      ? endpoint(wid, `/artifacts/${encodeURIComponent(targetId)}`)
      : null,
  );
  useEffect(() => {
    if (target.data && !id)
      setSelected([
        ...new Set(target.data.citations.map((c) => c.material_id)),
      ]);
  }, [target.data?.id]);
  useEffect(() => {
    const r = recipes.data?.find((r) => r.id === id);
    if (r) {
      setSaved(r);
      setPresetId(r.preset_id);
      setName(r.name);
      setGoal(r.goal);
      setProviderId(r.provider_id);
      setModel(r.model);
      setMaxTokens(r.max_output_tokens);
      setInputLimit(r.input_limit);
      setCalls(r.max_calls);
      setApproval(r.approval);
      setSelected(r.material_ids ?? []);
      setDatasetId(r.dataset_id ?? "");
      setInputMode(r.dataset_id ? "dataset" : "materials");
    }
  }, [id, recipes.data]);
  function payload() {
    return {
      name: name || preset?.label || "",
      preset_id: presetId,
      goal,
      provider_id: providerId,
      model,
      max_output_tokens: maxTokens,
      input_limit: inputLimit,
      max_calls: calls,
      approval: targetId ? "manual" : approval,
      material_ids: inputMode === "materials" ? selected : [],
      dataset_id: inputMode === "dataset" ? datasetId : undefined,
    };
  }
  async function save() {
    const r = await api<Recipe>(
      endpoint(wid, id ? `/recipes/${id}` : "/recipes"),
      { method: id ? "PATCH" : "POST", body: payload() },
    );
    setSaved(r);
    return r;
  }
  async function begin() {
    await op.run(async () => {
      const r = await save();
      const job = await api<Job>(endpoint(wid, "/jobs"), {
        method: "POST",
        body: {
          kind: "process",
          recipe_id: r.id,
          material_ids: inputMode === "materials" ? selected : undefined,
          approved: false,
          ...(targetId
            ? {
                target_artifact_id: targetId,
                base_revision:
                  target.data && String(target.data.revision) === targetBase
                    ? target.data.revision
                    : targetBase,
              }
            : {}),
        },
      });
      notify(
        (job.state || job.status) === "awaiting_approval"
          ? "加工计划已建立，请在任务详情确认外发计划。"
          : "已按服务端批准状态建立加工任务。",
      );
      navigate(`/tasks/${job.id}`);
    });
  }
  const valid = Boolean(
    presetId &&
      providerId &&
      model.trim() &&
      goal.trim() &&
      (!targetId ||
        Boolean(
          target.data &&
            !target.error &&
            [
              String(target.data.revision),
              target.data.revision_id,
              target.data.current_revision,
            ].includes(targetBase),
        )) &&
      (inputMode === "materials" ? selected.length : datasetId),
  );
  return (
    <>
      <PageHeader
        eyebrow="从材料到知识产物"
        title={id ? "编辑加工配置" : "加工台"}
        description="先选择材料与目标，再确认模型、预算和外发范围。聊天不能替代这些边界。"
        actions={
          <Link className="button" to="/settings/models">
            模型配置
          </Link>
        }
      />
      <OperationNotice op={op} />
      {targetId && (
        <LoadState {...target} retry={target.reload}>
          <Notice tone="warning">
            为「{target.data?.title || targetId}
            」生成新提案。已保存前稿全文与本次选材将外发给所选模型；新结果只进入提案，不覆盖原稿。新增前稿不属于旧流程预授权，本次强制手动审批。固定前稿版本：
            <code>{targetBase}</code>
            {target.data &&
              ![
                String(target.data.revision),
                target.data.revision_id,
                target.data.current_revision,
              ].includes(targetBase) && (
                <p>原稿已有新版本，请回成果页重新建立计划。</p>
              )}
          </Notice>
        </LoadState>
      )}
      <LoadState {...presets} retry={presets.reload}>
        {presets.data?.length ? (
          <div className="preset-grid">
            {presets.data.map((p) => (
              <button
                className={`preset-choice ${presetId === p.id ? "selected" : ""}`}
                key={p.id}
                onClick={() => {
                  setPresetId(p.id);
                  if (!name) setName(p.label);
                }}
              >
                <strong>{p.label}</strong>
                <span>{p.description}</span>
              </button>
            ))}
          </div>
        ) : (
          <Empty
            title="服务端尚未返回加工模板"
            description="请检查后台模板接口；前端不会用虚假的模板执行计划替代真实能力。"
            action={<Button onClick={presets.reload}>重新检查</Button>}
          />
        )}
      </LoadState>
      {presetId && (
        <div className="process-layout">
          <form
            className="form-stack process-form"
            onSubmit={(e) => {
              e.preventDefault();
              setPlan(true);
            }}
          >
            <div className="section-header">
              <h2>{preset?.label ?? "加工配置"}</h2>
              {saved && <Badge>已保存配置</Badge>}
            </div>
            <Field label="配置名称">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={preset?.label}
              />
            </Field>
            <Field label="这次希望解决的问题" required>
              <textarea
                required
                rows={4}
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder="具体说明用途、关注的问题与希望保留的证据…"
              />
            </Field>
            <fieldset>
              <legend>输入材料</legend>
              <div className="segmented">
                <button
                  type="button"
                  className={inputMode === "materials" ? "active" : ""}
                  onClick={() => setInputMode("materials")}
                >
                  材料清单
                </button>
                <button
                  type="button"
                  className={inputMode === "dataset" ? "active" : ""}
                  onClick={() => setInputMode("dataset")}
                >
                  专题
                </button>
              </div>
              {inputMode === "materials" ? (
                <LoadState {...materials} retry={materials.reload}>
                  <MaterialPicker
                    materials={materials.data ?? []}
                    selected={selected}
                    onChange={setSelected}
                  />
                </LoadState>
              ) : (
                <LoadState {...datasets} retry={datasets.reload}>
                  <select
                    aria-label="选择输入专题"
                    value={datasetId}
                    onChange={(e) => setDatasetId(e.target.value)}
                  >
                    <option value="">选择专题</option>
                    {datasets.data?.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}，{statusLabel(d.mode)}
                      </option>
                    ))}
                  </select>
                  <p className="field-hint">
                    分析输入由服务端固定版本；动态专题不会成为无限增长的本次输入。
                  </p>
                </LoadState>
              )}
            </fieldset>
            <div className="form-grid">
              <Field label="模型连接" required>
                <select
                  required
                  value={providerId}
                  onChange={(e) => {
                    const p = providers.data?.find(
                      (p) => p.id === e.target.value,
                    );
                    setProviderId(e.target.value);
                    setModel(p?.model ?? modelIds(p?.models)[0] ?? "");
                  }}
                >
                  <option value="">选择个人模型连接</option>
                  {providers.data?.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label="模型 ID"
                required
                hint="可从发现结果选择，也可手动填写真实 ID。"
              >
                <input
                  required
                  list="recipe-models"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                />
                <datalist id="recipe-models">
                  {modelIds(provider?.models).map((m) => (
                    <option value={m} key={m} />
                  ))}
                </datalist>
              </Field>
            </div>
            {providers.error && (
              <Notice tone="error">{providers.error.message}</Notice>
            )}
            {!providers.loading && !providers.data?.length && (
              <Notice action={<Link to="/settings/models">配置模型</Link>}>
                尚无模型连接。用户凭据归个人，不归团队。
              </Notice>
            )}
            <fieldset>
              <legend>本次预算</legend>
              <div className="form-grid three">
                <Field label="最大输出 tokens">
                  <input
                    type="number"
                    min={256}
                    max={32000}
                    required
                    value={maxTokens}
                    onChange={(e) => setMaxTokens(Number(e.target.value))}
                  />
                </Field>
                <Field label="输入字符上限">
                  <input
                    type="number"
                    min={1000}
                    max={200000}
                    required
                    value={inputLimit}
                    onChange={(e) => setInputLimit(Number(e.target.value))}
                  />
                </Field>
                <Field label="最大调用次数">
                  <input
                    type="number"
                    min={1}
                    max={20}
                    required
                    value={calls}
                    onChange={(e) => setCalls(Number(e.target.value))}
                  />
                </Field>
              </div>
            </fieldset>
            <Field label="审批方式">
              <select
                value={targetId ? "manual" : approval}
                disabled={Boolean(targetId)}
                onChange={(e) => setApproval(e.target.value)}
              >
                <option value="manual">建立计划后手动批准</option>
                <option value="automatic">确认范围后自动批准</option>
              </select>
            </Field>
            <Notice>
              执行位置：工作台服务端。材料将发送至{" "}
              {provider?.base_url ?? "所选模型服务"}
              ；仅使用本次授权输入，不共享模型 Key。
            </Notice>
            <div className="form-actions">
              <Button
                busy={op.busy}
                disabled={!valid}
                onClick={() =>
                  void op.run(async () => {
                    await save();
                    notify("加工配置已保存，尚未向模型发送材料。");
                    recipes.reload();
                  })
                }
              >
                仅保存配置
              </Button>
              <Button primary type="submit" disabled={!valid || op.busy}>
                检查执行计划
              </Button>
            </div>
          </form>
          <aside className="process-inspector">
            <h3>产物结构</h3>
            <p className="muted">{preset?.description}</p>
            <pre className="json-view">
              {JSON.stringify(preset?.output_schema ?? {}, null, 2)}
            </pre>
            <div className="inspector-note">
              <strong>先形成草稿</strong>
              <p>
                模型输出不会覆盖原文或已采纳的人工稿。结果进入成果区，并保留固定引用。
              </p>
            </div>
          </aside>
        </div>
      )}
      <section className="saved-recipes">
        <div className="section-header">
          <h2>已保存的加工配置</h2>
        </div>
        <LoadState {...recipes} retry={recipes.reload}>
          {recipes.data?.length ? (
            <div className="simple-list">
              {recipes.data.map((r) => (
                <div className="simple-row" key={r.id}>
                  <Link to={`/recipes/${r.id}`}>
                    <strong>{r.name}</strong>
                    <span className="muted">
                      {r.model} ，{" "}
                      {r.approval === "automatic"
                        ? "范围内自动审批"
                        : "手动审批"}
                    </span>
                  </Link>
                  <Button
                    danger
                    onClick={() => {
                      if (
                        window.confirm(
                          `删除配置“${r.name}”？历史任务与成果不会被修改。`,
                        )
                      )
                        void op.run(async () => {
                          await api(endpoint(wid, `/recipes/${r.id}`), {
                            method: "DELETE",
                          });
                          recipes.reload();
                          if (id === r.id) navigate("/process");
                        });
                    }}
                  >
                    删除
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted">
              还没有保存配置。建立一次具体的加工目标后可复用。
            </p>
          )}
        </LoadState>
      </section>
      {plan && (
        <Dialog
          title="确认本次执行计划"
          description="这是材料外发与模型调用的真实边界，不是推理过程。"
          onClose={() => setPlan(false)}
          wide
        >
          <dl className="plan-list">
            <div>
              <dt>任务</dt>
              <dd>{name || preset?.label}</dd>
            </div>
            <div>
              <dt>输入</dt>
              <dd>
                {inputMode === "materials"
                  ? `${selected.length} 条明确选中的材料`
                  : datasets.data?.find((d) => d.id === datasetId)?.name}
              </dd>
            </div>
            {targetId && (
              <div>
                <dt>额外外发前稿</dt>
                <dd>
                  「{target.data?.title}」的固定正文与引用（版本 {targetBase}
                  ）；只形成可人工复核的新提案。
                </dd>
              </div>
            )}
            <div>
              <dt>外发目的地</dt>
              <dd>{provider?.base_url}</dd>
            </div>
            <div>
              <dt>模型</dt>
              <dd>
                <code>{model}</code>
              </dd>
            </div>
            <div>
              <dt>预算</dt>
              <dd>
                最多 {calls} 次调用，单次输出不超过 {maxTokens} tokens ，
                输入上限 {inputLimit} 字符
              </dd>
            </div>
            <div>
              <dt>审批</dt>
              <dd>
                {targetId
                  ? "新增外发前稿，强制在任务详情手动批准"
                  : approval === "automatic"
                    ? "本次明确范围内自动批准，不增加工具或数据权限"
                    : "仅建立计划，任务详情另行批准"}
              </dd>
            </div>
            <div>
              <dt>产物</dt>
              <dd>固定来源版本 → {preset?.label}草稿 → 成果区复核</dd>
            </div>
          </dl>
          <OperationNotice op={op} />
          <div className="form-actions">
            <Button onClick={() => setPlan(false)}>返回调整</Button>
            <Button primary busy={op.busy} onClick={() => void begin()}>
              {!targetId && approval === "automatic"
                ? "确认外发并开始"
                : "建立待批准计划"}
            </Button>
          </div>
        </Dialog>
      )}
    </>
  );
}
