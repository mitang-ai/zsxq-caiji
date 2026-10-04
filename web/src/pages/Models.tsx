import { useState, type FormEvent } from "react";
import { api, modelIds, safeUrl, useApi, useOperation } from "../api";
import type { Provider } from "../types";
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
} from "../ui";

export function ModelSettings() {
  const providers = useApi<Provider[]>("/api/providers");
  const [edit, setEdit] = useState<Provider | "new">(),
    [selection, setSelection] = useState<Provider>();
  const [test, setTest] = useState<{
    provider: Provider;
    mode: "models" | "call";
  }>();
  const [result, setResult] = useState<{
    data: unknown;
    label: string;
    destination: string;
    mode: string;
  }>();
  const op = useOperation();
  async function runTest() {
    if (!test) return;
    setResult(undefined);
    const res = await op.run(() =>
      api(`/api/providers/${test.provider.id}/test`, {
        method: "POST",
        body: { mode: test.mode },
      }),
    );
    if (res !== undefined) {
      setResult({
        data: res,
        label: test.provider.label,
        destination: test.provider.base_url,
        mode: test.mode,
      });
      providers.reload();
    }
  }
  function beginTest(provider: Provider, mode: "models" | "call") {
    op.clear();
    setResult(undefined);
    setTest({ provider, mode });
  }
  async function remove(p: Provider) {
    if (
      !confirm(
        `移除「${p.label}」及服务端保存的 Key？引用它的流程需要重新选择模型服务。`,
      )
    )
      return;
    await op.run(async () => {
      await api(`/api/providers/${p.id}`, { method: "DELETE" });
      providers.reload();
    });
  }
  return (
    <>
      <div className="section-heading">
        <div>
          <h2>我的模型服务</h2>
          <p className="muted">
            自填 Base URL 和 Key。模型发现不等于实际调用验证。
          </p>
        </div>
        <Button primary onClick={() => setEdit("new")}>
          <Icon name="plus" />
          添加服务
        </Button>
      </div>
      {!test && <OperationNotice op={op} />}
      <LoadState {...providers} retry={providers.reload}>
        {providers.data?.length ? (
          <div className="stack-list">
            {providers.data.map((p) => (
              <section className="panel" key={p.id}>
                <div className="card-heading">
                  <div>
                    <h3>{p.label}</h3>
                    <p className="muted wrap-anywhere">
                      {p.base_url}，{p.protocol}
                    </p>
                  </div>
                  <Badge>{p.has_key ? "Key 已保存" : "未配置 Key"}</Badge>
                </div>
                <p>
                  默认模型：<code>{p.model}</code>
                </p>
                <p className="muted">
                  快捷模型：
                  {modelIds(p.models).join("、") || "尚未发现或手动添加"}
                </p>
                <div className="card-actions">
                  <Button onClick={() => setEdit(p)}>编辑配置</Button>
                  <Button onClick={() => beginTest(p, "models")}>
                    发现模型
                  </Button>
                  <Button onClick={() => setSelection(p)}>模型快捷切换</Button>
                  <Button onClick={() => beginTest(p, "call")}>实际测试</Button>
                  <Button danger onClick={() => void remove(p)}>
                    移除
                  </Button>
                </div>
              </section>
            ))}
          </div>
        ) : (
          <Empty
            title="连接你选择的模型服务"
            description="没有预置共享 Key。可以先发现模型，也可手动填写 ID；保存之后才建立供加工使用的连接。"
            action={
              <Button primary onClick={() => setEdit("new")}>
                添加模型服务
              </Button>
            }
          />
        )}
      </LoadState>
      {result && !test && (
        <section className="panel">
          <h3>真实测试结果，{result.label}</h3>
          <p className="muted wrap-anywhere">目的地：{result.destination}</p>
          <ProviderTestResult value={result.data} mode={result.mode} />
          <Button onClick={() => setResult(undefined)}>清除结果</Button>
        </section>
      )}
      {edit && (
        <ProviderForm
          provider={edit === "new" ? undefined : edit}
          onClose={() => setEdit(undefined)}
          onSaved={() => {
            setEdit(undefined);
            providers.reload();
          }}
        />
      )}
      {selection && (
        <ModelSelection
          provider={selection}
          onClose={() => setSelection(undefined)}
          onSaved={() => {
            setSelection(undefined);
            providers.reload();
          }}
        />
      )}
      {test && (
        <Dialog
          title={
            test.mode === "models" ? "发现服务端可用模型" : "实际模型连接测试"
          }
          onClose={() => setTest(undefined)}
        >
          <div className="form-stack">
            <p>
              目的地：<code>{test.provider.base_url}</code>
            </p>
            <p>
              模型：<code>{test.provider.model}</code>
            </p>
            <Notice>
              {test.mode === "models"
                ? "调用供应商模型列表接口，不发送你的材料。部分协议不提供列表，可手动填写模型 ID。"
                : "将发送一条“请回复连接成功”的独立测试请求，最多 256 输出 tokens；可能产生供应商费用，不包含你的材料。失败也不保证没有计费，重试由你明确决定。"}
            </Notice>
            <OperationNotice op={op} />
            {result && (
              <section className="test-response">
                <h3>实际响应</h3>
                <ProviderTestResult value={result.data} mode={test.mode} />
              </section>
            )}
            <div className="form-actions">
              <Button
                primary={Boolean(result)}
                onClick={() => setTest(undefined)}
              >
                {result ? "关闭结果" : "取消"}
              </Button>
              <Button
                primary={!result}
                busy={op.busy}
                onClick={() => void runTest()}
              >
                {result ? "再执行一次" : op.error ? "明确重试测试" : "执行测试"}
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </>
  );
}

function ProviderForm({
  provider,
  onClose,
  onSaved,
}: {
  provider?: Provider;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [label, setLabel] = useState(provider?.label || ""),
    [base, setBase] = useState(provider?.base_url || ""),
    [protocol, setProtocol] = useState(provider?.protocol || "chat");
  const [model, setModel] = useState(provider?.model || ""),
    [key, setKey] = useState(""),
    [models, setModels] = useState(modelIds(provider?.models).join("\n"));
  const [discovered, setDiscovered] = useState<string[]>();
  const op = useOperation();
  const needsNewKey = Boolean(
    provider && base.trim().replace(/\/$/, "") !== provider.base_url,
  );
  const canDiscover = Boolean(
    safeUrl(base.trim()) && (key.trim() || (provider?.has_key && !needsNewKey)),
  );
  async function discover() {
    if (!canDiscover) return;
    const result = await op.run(() =>
      api<{ models: string[]; verified: boolean }>("/api/providers/discover", {
        method: "POST",
        body: {
          ...(provider ? { provider_id: provider.id } : {}),
          base_url: base.trim(),
          protocol,
          ...(key ? { api_key: key } : {}),
        },
      }),
    );
    if (result !== undefined) {
      const ids = modelIds(result.models);
      setDiscovered(ids);
      setModels((previous) =>
        [
          ...new Set([
            ...previous
              .split(/\n|,/)
              .map((s) => s.trim())
              .filter(Boolean),
            ...ids,
          ]),
        ].join("\n"),
      );
    }
  }
  function changeDestination(value: string) {
    setBase(value);
    setDiscovered(undefined);
    op.clear();
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    const res = await op.run(() =>
      api<Provider>(
        provider ? `/api/providers/${provider.id}` : "/api/providers",
        {
          method: provider ? "PATCH" : "POST",
          body: {
            label,
            protocol,
            base_url: base.trim(),
            model: model.trim(),
            models: models
              .split(/\n|,/)
              .map((s) => s.trim())
              .filter(Boolean),
            ...(key ? { api_key: key } : {}),
            remember: true,
          },
        },
      ),
    );
    if (res) {
      setKey("");
      onSaved();
    }
  }
  return (
    <Dialog
      title={provider ? "编辑模型服务" : "添加模型服务"}
      onClose={onClose}
    >
      <form className="form-stack" onSubmit={submit}>
        <Field label="名称" required>
          <input
            required
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={100}
          />
        </Field>
        <Field label="API 协议">
          <select
            disabled={op.busy}
            value={protocol}
            onChange={(e) => {
              setProtocol(e.target.value);
              setDiscovered(undefined);
              op.clear();
            }}
          >
            <option value="chat">OpenAI-compatible Chat Completions</option>
            <option value="responses">OpenAI Responses</option>
            <option value="anthropic">Anthropic Messages</option>
          </select>
        </Field>
        <Field
          label="Base URL"
          required
          hint="填写协议所需根地址；服务端限制内网、重定向与危险目标。"
        >
          <input
            type="url"
            required
            disabled={op.busy}
            value={base}
            onChange={(e) => changeDestination(e.target.value)}
            placeholder="https://api.example.com/v1"
          />
        </Field>
        <Field
          label={
            needsNewKey
              ? "API Key，新地址必须重新填写"
              : provider
                ? "API Key，留空保留现有 Key"
                : "API Key"
          }
          required={!provider || needsNewKey}
        >
          <input
            type="password"
            autoComplete="off"
            required={!provider || needsNewKey}
            disabled={op.busy}
            value={key}
            onChange={(e) => {
              setKey(e.target.value);
              setDiscovered(undefined);
              op.clear();
            }}
          />
        </Field>
        {needsNewKey && (
          <Notice tone="warning">
            Base URL 已变化，不能把已保存的 Key
            带往新地址。请重新填写对应目的地的 Key；不提供仅确认后使用旧 Key
            的选项。
          </Notice>
        )}
        <div className="model-discovery">
          <Button
            busy={op.busy}
            disabled={!canDiscover}
            onClick={() => void discover()}
          >
            发现可用模型
          </Button>
          <p className="field-hint">
            只需 Base URL、协议与 Key，不要求先填模型 ID
            或保存配置。不发送材料，不执行生成；现有连接留空可使用自己的已保存
            Key。
          </p>
        </div>
        <OperationNotice op={op} />
        {discovered !== undefined && (
          <section className="discovered-models">
            <Notice tone={discovered.length ? "success" : "warning"}>
              {discovered.length
                ? `已发现 ${discovered.length} 个模型。模型列表可用不代表生成已验证，请明确选择默认模型。配置尚未保存。`
                : "服务未返回模型列表。可以核对协议与地址，或手动填写供应商提供的模型 ID；没有把空列表当作已验证。"}
            </Notice>
            {discovered.length > 0 && (
              <Field label="从发现结果选择默认模型">
                <select
                  disabled={op.busy}
                  value={discovered.includes(model) ? model : ""}
                  onChange={(e) => setModel(e.target.value)}
                >
                  <option value="">请选择默认模型</option>
                  {discovered.map((id) => (
                    <option value={id} key={id}>
                      {id}
                    </option>
                  ))}
                </select>
              </Field>
            )}
          </section>
        )}
        <Field
          label="默认模型 ID"
          required
          hint="先发现并选择，或直接填写完整模型 ID。保存后仍可做独立实际调用测试。"
        >
          <input
            required
            disabled={op.busy}
            list="provider-discovered-models"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            maxLength={300}
          />
          <datalist id="provider-discovered-models">
            {discovered?.map((id) => (
              <option key={id} value={id} />
            ))}
          </datalist>
        </Field>
        <Field label="手动快捷模型，每行一个">
          <textarea
            rows={3}
            disabled={op.busy}
            value={models}
            onChange={(e) => setModels(e.target.value)}
          />
        </Field>
        <Notice>
          Key
          只保存到当前用户的加密凭据库，不写入浏览器本地存储、不随团队分享。发现操作本身不保存配置。
        </Notice>
        <div className="form-actions">
          <Button onClick={onClose}>取消</Button>
          <Button primary type="submit" busy={op.busy}>
            保存配置
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ProviderTestResult({ value, mode }: { value: unknown; mode: string }) {
  const r =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  return (
    <>
      {mode === "call" ? (
        typeof r.text === "string" && r.text ? (
          <div className="prewrap provider-test-text">{r.text}</div>
        ) : (
          <Notice tone="warning">
            响应没有可阅读的生成文本，不能只凭请求完成判定生成可用。请查看完整回执。
          </Notice>
        )
      ) : (
        <>
          <p>
            列表返回 {Array.isArray(r.models) ? r.models.length : 0}{" "}
            个模型；没有发送材料或执行生成。
          </p>
          {Array.isArray(r.models) && (
            <ul className="provider-test-models">
              {r.models
                .filter((model): model is string => typeof model === "string")
                .map((model) => (
                  <li key={model}>
                    <code>{model}</code>
                  </li>
                ))}
            </ul>
          )}
        </>
      )}
      {typeof r.model === "string" && (
        <p className="muted small">
          实际返回模型：<code>{r.model}</code>
        </p>
      )}
      {r.usage !== undefined && (
        <details>
          <summary>供应商用量回执</summary>
          <pre className="json-view">{JSON.stringify(r.usage, null, 2)}</pre>
        </details>
      )}
      <details>
        <summary>完整测试回执</summary>
        <pre className="json-view">{JSON.stringify(value, null, 2)}</pre>
      </details>
    </>
  );
}

function ModelSelection({
  provider,
  onClose,
  onSaved,
}: {
  provider: Provider;
  onClose: () => void;
  onSaved: () => void;
}) {
  const initial = modelIds(provider.models);
  const [options, setOptions] = useState([
      ...new Set([...initial, provider.model || ""].filter(Boolean)),
    ]),
    [selected, setSelected] = useState(initial),
    [current, setCurrent] = useState(provider.model || ""),
    [manual, setManual] = useState("");
  const op = useOperation();
  async function save() {
    await op.run(async () => {
      await api(`/api/providers/${provider.id}`, {
        method: "PATCH",
        body: { model: current, models: [...new Set([...selected, current])] },
      });
      onSaved();
    });
  }
  return (
    <Dialog title="快捷模型，单选默认，多选收藏" onClose={onClose}>
      <div className="form-stack">
        <div className="inline-input">
          <input
            value={manual}
            aria-label="手动模型 ID"
            placeholder="手动输入模型 ID"
            onChange={(e) => setManual(e.target.value)}
          />
          <Button
            disabled={!manual.trim()}
            onClick={() => {
              const id = manual.trim();
              setOptions([...new Set([...options, id])]);
              setSelected([...new Set([...selected, id])]);
              setCurrent(id);
              setManual("");
            }}
          >
            添加
          </Button>
        </div>
        <div className="model-options">
          {options.map((id) => (
            <div className="model-row" key={id}>
              <label className="check">
                <input
                  type="checkbox"
                  checked={selected.includes(id)}
                  onChange={(e) =>
                    setSelected(
                      e.target.checked
                        ? [...selected, id]
                        : selected.filter((m) => m !== id),
                    )
                  }
                />
                <code>{id}</code>
              </label>
              <label className="check">
                <input
                  type="radio"
                  name="default-model"
                  checked={current === id}
                  onChange={() => setCurrent(id)}
                />
                默认
              </label>
            </div>
          ))}
        </div>
        <OperationNotice op={op} />
        <div className="form-actions">
          <Button onClick={onClose}>取消</Button>
          <Button
            primary
            busy={op.busy}
            disabled={!current}
            onClick={() => void save()}
          >
            保存快捷模型
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
