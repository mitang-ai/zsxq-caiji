import { useState } from "react";
import { Link } from "react-router-dom";
import { api, date, download, endpoint, query, useOperation } from "../api";
import type { Job, TransferBundle } from "../types";
import {
  Button,
  Dialog,
  Field,
  Notice,
  OperationNotice,
  useWorkbench,
} from "../ui";

export function TaskExport({
  job,
  onClose,
}: {
  job: Job;
  onClose: () => void;
}) {
  const { wid } = useWorkbench();
  const [offset, setOffset] = useState(0),
    [limit, setLimit] = useState(100),
    [receipt, setReceipt] = useState<TransferBundle>();
  const op = useOperation();
  const valid =
    Number.isSafeInteger(offset) &&
    offset >= 0 &&
    Number.isInteger(limit) &&
    limit >= 1 &&
    limit <= 1000;
  const next =
    typeof receipt?.coverage.next_offset === "number" &&
    Number.isSafeInteger(receipt.coverage.next_offset)
      ? receipt.coverage.next_offset
      : undefined;
  async function exportBatch() {
    if (!valid) return;
    await op.run(async () => {
      const bundle = await api<TransferBundle>(
        endpoint(wid, `/jobs/${encodeURIComponent(job.id)}/export`) +
          query({ offset: String(offset), limit: String(limit) }),
      );
      download(
        `集见-任务-${job.id}-offset-${offset}.json`,
        JSON.stringify(bundle, null, 2),
      );
      setReceipt(bundle);
    });
  }
  return (
    <Dialog
      title="分批导出任务已完成部分"
      description="只读取本任务的固定保存回执或实际成果，不改用当前资料头版本，不泛导整个星球。"
      onClose={onClose}
    >
      <div className="form-stack">
        <Notice>
          {job.kind === "capture"
            ? "采集按已保存的材料/原文版本回执导出。旧任务没有固定回执时，服务端会拒绝导出，不会替换成当前原文。"
            : "加工按本任务的实际成果分批导出，包内包含成果引用的固定历史原文。"}{" "}
          JSON 不包含附件原件；需要原件请在资料库明确选材后导出 ZIP。
        </Notice>
        <div className="form-grid">
          <Field label="起始回执偏移 · 从 0 计">
            <input
              type="number"
              disabled={op.busy}
              min={0}
              step={1}
              value={Number.isFinite(offset) ? offset : ""}
              onChange={(e) => {
                setOffset(e.target.valueAsNumber);
                setReceipt(undefined);
                op.clear();
              }}
            />
          </Field>
          <Field
            label="每批回执条数 · 1–1000"
            hint="超过包体上限时降低本批条数重试，不自动扩大范围。"
          >
            <input
              type="number"
              disabled={op.busy}
              min={1}
              max={1000}
              step={1}
              value={Number.isFinite(limit) ? limit : ""}
              onChange={(e) => {
                setLimit(e.target.valueAsNumber);
                setReceipt(undefined);
                op.clear();
              }}
            />
          </Field>
        </div>
        <OperationNotice op={op} />
        {receipt && (
          <section className="task-export-receipt">
            <h3>本批实际导出回执</h3>
            <dl className="plan-list">
              <div>
                <dt>任务回执总数</dt>
                <dd>
                  {typeof receipt.coverage.total === "number"
                    ? receipt.coverage.total
                    : "服务端未提供"}
                </dd>
              </div>
              <div>
                <dt>本批偏移 / 上限</dt>
                <dd>
                  {String(receipt.coverage.offset ?? offset)} /{" "}
                  {String(receipt.coverage.limit ?? limit)}
                </dd>
              </div>
              <div>
                <dt>包内内容</dt>
                <dd>
                  {receipt.records.length} 个原文快照 ·{" "}
                  {receipt.artifacts.length} 份成果
                </dd>
              </div>
              <div>
                <dt>生成时间</dt>
                <dd>{date(receipt.exported_at)}</dd>
              </div>
              <div>
                <dt>本批生成时任务状态</dt>
                <dd>{String(receipt.coverage.task_state ?? "未提供")}</dd>
              </div>
              <div>
                <dt>附件原件</dt>
                <dd>不包含，不作为完整二进制备份</dd>
              </div>
            </dl>
            {next !== undefined ? (
              <Button
                disabled={op.busy}
                onClick={() => {
                  setOffset(next);
                  setReceipt(undefined);
                  op.clear();
                }}
              >
                准备下一批 · 偏移 {next}
              </Button>
            ) : (
              <p className="muted">
                服务端没有下一批回执。本次下载已生成，不代表源站范围完整。
              </p>
            )}
            <details>
              <summary>包的覆盖说明</summary>
              <pre className="json-view">
                {JSON.stringify(receipt.coverage, null, 2)}
              </pre>
            </details>
          </section>
        )}
        <div className="form-actions">
          <Link className="button" to="/library" onClick={onClose}>
            去资料库选择原件
          </Link>
          <Button onClick={onClose}>关闭</Button>
          <Button
            primary
            busy={op.busy}
            disabled={!valid}
            onClick={() => void exportBatch()}
          >
            导出本批 JSON
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
