import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, date, endpoint, useApi, useOperation } from "../api";
import type { Job } from "../types";
import { TaskExport } from "./TaskExport";
import {
  Badge,
  Button,
  Empty,
  Icon,
  LoadState,
  Notice,
  OperationNotice,
  PageHeader,
  useWorkbench,
} from "../ui";

export function TasksPage() {
  const { wid, notify } = useWorkbench();
  const { id } = useParams();
  const list = useApi<Job[]>(endpoint(wid, "/jobs"));
  const detail = useApi<Job>(id ? endpoint(wid, `/jobs/${id}`) : null);
  const [filter, setFilter] = useState(""),
    [retryUnknown, setRetryUnknown] = useState(false),
    [exportOpen, setExportOpen] = useState(false);
  const op = useOperation();
  const job = detail.data;
  useEffect(() => {
    setRetryUnknown(false);
    setExportOpen(false);
  }, [id]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (id) {
        const state = job?.status ?? job?.state;
        if (
          ![
            "completed",
            "succeeded",
            "failed",
            "cancelled",
            "canceled",
          ].includes(state ?? "")
        )
          detail.reload();
      } else list.reload();
    }, 2500);
    return () => clearInterval(timer);
  }, [id, job?.status, job?.state, detail.reload, list.reload]);
  async function action(name: string) {
    await op.run(async () => {
      await api(endpoint(wid, `/jobs/${id}/${name}`), {
        method: "POST",
        body: name === "resume" ? { retry_unknown: retryUnknown } : {},
      });
      detail.reload();
      list.reload();
      notify(
        `任务操作已提交：${name === "approve" ? "批准" : name === "pause" ? "暂停" : name === "resume" ? "恢复" : name === "retry_failed" ? "仅重试失败项" : "取消"}。状态以服务端事件为准。`,
      );
    });
  }
  const state = job?.status ?? job?.state ?? "";
  const active = ["running", "queued", "pending", "rate_limited"].includes(
    state,
  );
  const resumable =
    [
      "paused",
      "failed",
      "login_required",
      "rate_limited",
      "outcome_unknown",
      "partial",
    ].includes(state) && !job?.checkpoint?.unparsed_response;
  const finished = ["completed", "succeeded", "cancelled", "canceled"].includes(
    state,
  );
  const approval = /approv|draft|planned/.test(state);
  const unknown =
    /unknown/.test(state) || Boolean(job?.checkpoint?.outcome_unknown);
  const failures = captureFailures(job);
  const canRetryFailed =
    job?.kind === "capture" &&
    failures.length > 0 &&
    [
      "completed",
      "partial",
      "failed",
      "login_required",
      "rate_limited",
      "paused",
    ].includes(state);
  const hasFixedOutput =
    job?.kind === "capture"
      ? Array.isArray(job.checkpoint?.saved_records) &&
        job.checkpoint.saved_records.length > 0
      : Boolean(job?.artifact_ids?.length);
  return (
    <>
      <PageHeader
        eyebrow="事实与恢复"
        title={
          id ? (job?.kind === "capture" ? "采集任务" : "加工任务") : "任务"
        }
        description="这里只显示实际阶段和事件；未知总量不会变成虚假的百分比。"
        actions={
          id ? (
            <Link className="button" to="/tasks">
              全部任务
            </Link>
          ) : (
            <>
              <Link className="button" to="/process">
                新建加工
              </Link>
              <Link className="button primary" to="/connections">
                新建采集
              </Link>
            </>
          )
        }
      />
      <OperationNotice op={op} />
      {id ? (
        <LoadState {...detail} retry={detail.reload}>
          {job && (
            <>
              <section className="task-summary">
                <div>
                  <Badge value={state} />
                  <p className="muted">
                    {job.id} ，{" "}
                    {job.kind === "capture" ? "读取源站" : "模型加工"} ，
                    工作台服务端
                  </p>
                </div>
                <div className="header-actions">
                  {approval && (
                    <Button
                      primary
                      busy={op.busy}
                      onClick={() => {
                        if (
                          window.confirm(
                            "批准这个任务的实际外发计划？请先核对下方输入、目标和预算。",
                          )
                        )
                          void action("approve");
                      }}
                    >
                      批准执行
                    </Button>
                  )}
                  {active && (
                    <Button busy={op.busy} onClick={() => void action("pause")}>
                      <Icon name="pause" />
                      暂停
                    </Button>
                  )}
                  {canRetryFailed && (
                    <Button
                      primary
                      busy={op.busy}
                      onClick={() => {
                        if (
                          window.confirm(
                            `仅重新读取本任务 ${failures.length} 个已知失败主题的详情、讨论或附件？使用同一已核验账号，不重扫列表、不增加分页预算，成功材料保持不变。`,
                          )
                        )
                          void action("retry_failed");
                      }}
                    >
                      仅重试失败项
                    </Button>
                  )}
                  {resumable && (
                    <Button
                      primary={!canRetryFailed}
                      busy={op.busy}
                      disabled={unknown && !retryUnknown}
                      onClick={() => {
                        if (
                          job.kind === "capture" &&
                          state === "partial" &&
                          !window.confirm(
                            "继续原任务的分页采集？到达原分页上限时，服务端可能再增加 10 页（最多 1000 页）。只补已知失败主题，请改用「仅重试失败项」。",
                          )
                        )
                          return;
                        void action("resume");
                      }}
                    >
                      <Icon name="play" />
                      {job.kind === "capture" ? "继续断点采集" : "从断点恢复"}
                    </Button>
                  )}
                  {!finished && (
                    <Button
                      danger
                      busy={op.busy}
                      onClick={() => {
                        if (
                          window.confirm(
                            "取消剩余工作？已保存材料与成果会保留；已发送的模型请求无法保证撤回。",
                          )
                        )
                          void action("cancel");
                      }}
                    >
                      取消任务
                    </Button>
                  )}
                  {hasFixedOutput && (
                    <Button onClick={() => setExportOpen(true)}>
                      导出已完成部分
                    </Button>
                  )}
                  <Button onClick={detail.reload}>刷新</Button>
                </div>
              </section>
              {/login|expired|challenge|identity/.test(state) && (
                <Notice
                  tone="warning"
                  action={
                    <Link className="button" to="/connections">
                      回到来源登录
                    </Link>
                  }
                >
                  源站会话需要处理。登录或验证完成后，再恢复本任务；不会换成其他账号执行。
                </Notice>
              )}
              {unknown && (
                <Notice tone="warning">
                  <p>上一次调用可能已计费，但结果未确认。默认不自动重复。</p>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={retryUnknown}
                      onChange={(e) => setRetryUnknown(e.target.checked)}
                    />
                    我已了解重复计费风险，允许明确重试未知调用
                  </label>
                </Notice>
              )}
              {Boolean(job.checkpoint?.unparsed_response) && (
                <Notice tone="warning">
                  上一次计费输出已保存，但无法按结构解析。不会重放同一批次；可查看已保存断点人工整理，或建立新的明确审批任务。
                </Notice>
              )}
              {state === "budget_paused" && (
                <Notice
                  tone="warning"
                  action={
                    <Link className="button" to="/process">
                      建立新预算计划
                    </Link>
                  }
                >
                  本次预算已耗尽，不能无声提高原任务预算。请保留当前产物，重新选择输入、预算并审批新任务。
                </Notice>
              )}
              {job.error && (
                <Notice tone="error">
                  {typeof job.error === "string"
                    ? job.error
                    : (job.error.message ?? "执行失败，请查看事件记录。")}
                </Notice>
              )}
              {job.kind === "capture" &&
                !hasFixedOutput &&
                ["completed", "partial"].includes(state) && (
                  <Notice>
                    本任务没有可用的固定原文保存回执，不会把整个星球或当前原文当作本任务产物。已有材料可在资料库自行明确选择导出。
                  </Notice>
                )}
              <div className="task-layout">
                <section>
                  <div className="section-header">
                    <h2>执行事件</h2>
                    <span className="muted">
                      最后更新 {date(job.updated_at)}
                    </span>
                  </div>
                  {job.events?.length ? (
                    <ol className="timeline">
                      {job.events.map((event, index) => (
                        <li key={event.id ?? index}>
                          <span className="timeline-dot" />
                          <time>{date(event.at ?? event.created_at)}</time>
                          <strong>
                            {event.message ??
                              event.text ??
                              event.type ??
                              event.kind ??
                              "执行事件"}
                          </strong>
                          {(event.details ?? event.data) !== undefined && (
                            <details>
                              <summary>事件详情</summary>
                              <pre className="json-view">
                                {JSON.stringify(
                                  event.details ?? event.data,
                                  null,
                                  2,
                                )}
                              </pre>
                            </details>
                          )}
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="muted">
                      服务端尚未记录执行事件。此时不能认定任务成功。
                    </p>
                  )}
                  {(
                    job.artifact_ids ??
                    (job.artifact_id ? [job.artifact_id] : [])
                  ).map((aid) => (
                    <Link
                      key={aid}
                      className="button primary"
                      to={`/artifacts/${aid}`}
                    >
                      打开实际成果
                      <Icon name="arrow" />
                    </Link>
                  ))}
                </section>
                <aside className="task-inspector">
                  <h3>输入与断点</h3>
                  {failures.length > 0 && (
                    <section className="capture-failures">
                      <h3>已知失败项，{failures.length}</h3>
                      <p className="muted small">
                        范围是否完整与这些失败项分别记录。只重试已知主题，不从第一页重新扫描。
                      </p>
                      <ul>
                        {failures.map((f) => (
                          <li key={f.topic_id}>
                            <code>主题 {f.topic_id}</code>
                            <span className="muted small">
                              {f.stages
                                .map(
                                  (stage) =>
                                    (
                                      ({
                                        detail: "详情",
                                        comments: "讨论",
                                        article: "长文",
                                        attachments: "附件",
                                      }) as Record<string, string>
                                    )[stage] || stage,
                                )
                                .join("、") || "阶段未提供"}{" "}
                              ，{date(f.at)}
                            </span>
                          </li>
                        ))}
                      </ul>
                      {canRetryFailed && (
                        <p className="field-hint">
                          重试前须重新核验原来的来源账号；不是改用另一人的连接。
                        </p>
                      )}
                    </section>
                  )}
                  {job.scope && (
                    <dl className="plan-list">
                      {Object.entries(job.scope).map(([key, value]) => (
                        <div key={key}>
                          <dt>
                            {(
                              {
                                group_id: "当前星球",
                                author_id: "成员",
                                from: "开始时间",
                                to: "结束时间",
                                max_pages: "分页上限",
                                include_comments: "读取讨论",
                                include_attachments: "读取附件",
                                types: "内容类型",
                              } as Record<string, string>
                            )[key] ?? key}
                          </dt>
                          <dd>
                            {Array.isArray(value)
                              ? value.join("、")
                              : String(value ?? "—")}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  )}
                  {job.plan !== undefined && <ExecutionPlan value={job.plan} />}
                  {job.checkpoint && (
                    <details>
                      <summary>已保存断点</summary>
                      <pre className="json-view">
                        {JSON.stringify(job.checkpoint, null, 2)}
                      </pre>
                    </details>
                  )}
                  {job.result !== undefined && (
                    <details>
                      <summary>结果回执</summary>
                      <pre className="json-view">
                        {JSON.stringify(job.result, null, 2)}
                      </pre>
                    </details>
                  )}
                </aside>
              </div>
              {exportOpen && (
                <TaskExport job={job} onClose={() => setExportOpen(false)} />
              )}
            </>
          )}
        </LoadState>
      ) : (
        <>
          <div className="filter-bar">
            <select
              aria-label="筛选任务"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="">全部任务</option>
              <option value="capture">采集</option>
              <option value="process">加工</option>
            </select>
            <Button onClick={list.reload}>刷新状态</Button>
          </div>
          <LoadState {...list} retry={list.reload}>
            {list.data?.length ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>任务</th>
                      <th>当前状态</th>
                      <th>执行位置</th>
                      <th>创建时间</th>
                      <th>详情</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.data
                      .filter((j) => !filter || j.kind === filter)
                      .map((j) => (
                        <tr key={j.id}>
                          <td>
                            <strong>
                              {j.kind === "capture"
                                ? "星球内容采集"
                                : "知识加工"}
                            </strong>
                            <span className="muted block small">{j.id}</span>
                          </td>
                          <td>
                            <Badge value={j.status ?? j.state} />
                          </td>
                          <td>工作台服务端</td>
                          <td>{date(j.created_at)}</td>
                          <td>
                            <Link className="button" to={`/tasks/${j.id}`}>
                              查看任务
                            </Link>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty
                icon="tasks"
                title="还没有执行任务"
                description="连接来源创建采集，或从已有材料建立加工计划。任务不会被示例数据填满。"
                action={
                  <>
                    <Link className="button primary" to="/connections">
                      连接并采集
                    </Link>
                    <Link className="button" to="/process">
                      建立加工计划
                    </Link>
                  </>
                }
              />
            )}
          </LoadState>
        </>
      )}
    </>
  );
}

type CaptureFailure = { topic_id: string; stages: string[]; at?: string };
function captureFailures(job?: Job): CaptureFailure[] {
  const raw = job?.checkpoint?.failures;
  if (job?.kind !== "capture" || !Array.isArray(raw)) return [];
  return raw.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const f = value as Record<string, unknown>,
      topicId = String(f.topic_id ?? "");
    if (!/^\d{1,24}$/.test(topicId)) return [];
    return [
      {
        topic_id: topicId,
        stages: Array.isArray(f.stages)
          ? f.stages.filter(
              (stage): stage is string => typeof stage === "string",
            )
          : [],
        at: typeof f.at === "string" ? f.at : undefined,
      },
    ];
  });
}

function ExecutionPlan({ value }: { value: unknown }) {
  const p =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const fields: [string, string][] = [
    ["destination", "外发目的地"],
    ["model", "模型"],
    ["materials", "固定输入材料"],
    ["input_characters", "输入字符"],
    ["max_calls", "最多调用"],
    ["max_output_tokens", "单次输出 tokens"],
    ["partial_materials", "覆盖未全部完整的材料"],
    ["execution", "执行位置"],
    ["output", "产物"],
  ];
  const display = (key: string, v: unknown) =>
    key === "execution" && v === "server"
      ? "工作台服务端"
      : key === "output" && v === "proposal_without_overwrite"
        ? "新提案，不覆盖前稿"
        : typeof v === "string" || typeof v === "number"
          ? String(v)
          : typeof v === "boolean"
            ? v
              ? "是"
              : "否"
            : "结构化内容，见完整计划";
  const previous =
    p.previous_draft && typeof p.previous_draft === "object"
      ? (p.previous_draft as Record<string, unknown>)
      : undefined;
  return (
    <section>
      <h3>本次执行计划</h3>
      <dl className="plan-list">
        {fields
          .filter(([key]) => p[key] !== undefined)
          .map(([key, label]) => (
            <div key={key}>
              <dt>{label}</dt>
              <dd>{display(key, p[key])}</dd>
            </div>
          ))}
        {previous && (
          <div>
            <dt>额外外发的前稿</dt>
            <dd>
              {display("title", previous.title)}
              <span className="block muted small">
                固定版本 {display("revision_id", previous.revision_id)} ，{" "}
                {display("input_characters", previous.input_characters)} 字符
              </span>
            </dd>
          </div>
        )}
      </dl>
      <details>
        <summary>完整服务端计划</summary>
        <pre className="json-view">{JSON.stringify(value, null, 2)}</pre>
      </details>
    </section>
  );
}
