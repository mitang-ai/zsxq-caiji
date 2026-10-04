import { presets, analysisInstructions } from "../shared/recipes";
import { baseUrl, canonical, now, providerEndpoint, uid } from "./browser-core";
import { appendEvent, activateJob, get, list, put, setMeta } from "./database";
import { secret } from "./vault";
import type { Artifact, Citation, Job, Material, Provider } from "./types";
export { presets };
export async function grantOrigin(raw: string): Promise<string> {
  const base = baseUrl(raw),
    pattern = new URL(base).origin + "/*";
  if (
    !(await chrome.permissions.contains({ origins: [pattern] })) &&
    !(await chrome.permissions.request({ origins: [pattern] }))
  )
    throw new Error("未授权访问 " + new URL(base).origin + "。");
  return base;
}
async function permission(base: string): Promise<void> {
  if (
    !(await chrome.permissions.contains({
      origins: [new URL(base).origin + "/*"],
    }))
  )
    throw new Error("该 API origin 尚未授权，请在设置中保存/授权。");
}
export function modelText(
  raw: any,
  protocol: Provider["protocol"],
): { text: string; model?: string; complete: boolean; truncated: boolean } {
  if (protocol === "chat") {
    const choice = raw.choices?.[0];
    const text =
      typeof choice?.message?.content === "string"
        ? choice.message.content
        : Array.isArray(choice?.message?.content)
          ? choice.message.content.map((v: any) => v.text ?? "").join("")
          : "";
    return {
      text,
      model: raw.model,
      complete: choice?.finish_reason === "stop",
      truncated: choice?.finish_reason === "length",
    };
  }
  if (protocol === "responses") {
    const text =
      raw.output_text ??
      (raw.output ?? [])
        .flatMap((o: any) => o.content ?? [])
        .filter((c: any) => c.type === "output_text")
        .map((c: any) => c.text ?? "")
        .join("");
    return {
      text,
      model: raw.model,
      complete: raw.status === "completed",
      truncated: raw.status === "incomplete",
    };
  }
  return {
    text: (raw.content ?? [])
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text ?? "")
      .join(""),
    model: raw.model,
    complete:
      raw.stop_reason === "end_turn" || raw.stop_reason === "stop_sequence",
    truncated: raw.stop_reason === "max_tokens",
  };
}
export async function providerModels(provider: Provider): Promise<string[]> {
  await permission(provider.base_url);
  const key = await secret("provider:" + provider.id);
  if (!key) throw new Error("密钥未设置或已锁定。");
  const headers: Record<string, string> = { Accept: "application/json" };
  if (provider.protocol === "anthropic") {
    headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
    headers["anthropic-dangerous-direct-browser-access"] = "true";
  } else headers.Authorization = "Bearer " + key;
  const r = await fetch(providerEndpoint(provider.base_url, "models"), {
    headers,
    credentials: "omit",
    redirect: "error",
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok)
    throw new Error(
      "模型目录返回 HTTP " +
        r.status +
        "。可手动填写模型 ID，不会改用其他服务。",
    );
  const data = await r.json();
  const models = (data.data ?? data.models ?? [])
    .map((m: any) => String(m.id ?? m.name ?? ""))
    .filter(Boolean);
  if (!models.length) throw new Error("响应没有模型目录；请手动填写模型 ID。");
  return [...new Set<string>(models)];
}
export async function generate(
  provider: Provider,
  prompt: string,
  maxTokens: number,
  signal?: AbortSignal,
): Promise<ReturnType<typeof modelText>> {
  await permission(provider.base_url);
  const key = await secret("provider:" + provider.id);
  if (!key) throw new Error("模型 Key 未设置或锁定，请解锁后重新确认。");
  if (!provider.model) throw new Error("填写准确的模型 ID。");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  let body: any;
  if (provider.protocol === "chat") {
    headers.Authorization = "Bearer " + key;
    body = {
      model: provider.model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: maxTokens,
      stream: false,
    };
  } else if (provider.protocol === "responses") {
    headers.Authorization = "Bearer " + key;
    body = {
      model: provider.model,
      input: [{ role: "user", content: prompt }],
      max_output_tokens: maxTokens,
      stream: false,
    };
  } else {
    headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
    headers["anthropic-dangerous-direct-browser-access"] = "true";
    body = {
      model: provider.model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
      stream: false,
    };
  }
  const signals = [AbortSignal.timeout(120000), ...(signal ? [signal] : [])];
  let response: Response;
  try {
    response = await fetch(
      providerEndpoint(provider.base_url, provider.protocol),
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.any(signals),
      },
    );
  } catch {
    throw Object.assign(
      new Error(
        "模型请求结果未知：连接中断/超时，可能已计费。不会自动重试；请先核对服务端。",
      ),
      { unknown: true },
    );
  }
  if (response.status >= 500)
    throw Object.assign(
      new Error(
        "模型调用返回 HTTP " +
          response.status +
          "；服务端可能已处理/计费，结果未知，禁止自动重试。",
      ),
      { unknown: true },
    );
  if (!response.ok)
    throw Object.assign(
      new Error(
        "模型调用返回 HTTP " + response.status + "；未更换模型或服务。",
      ),
      { definitive_response: true },
    );
  let raw: any;
  try {
    raw = await response.json();
  } catch {
    throw Object.assign(
      new Error("服务已响应但结果无法读取，计费结果未知；禁止自动重试。"),
      { unknown: true },
    );
  }
  const result = modelText(raw, provider.protocol);
  if (!result.text)
    throw Object.assign(
      new Error("模型返回没有可保存的文本；结果未知，请核对后手动决定。"),
      { unknown: true },
    );
  return result;
}
export function readArtifactOutput(text: string): {
  title: string;
  body: string;
  citations: string[];
} {
  try {
    const clean = text
      .trim()
      .replace(/^```(?:json)?\s*/, "")
      .replace(/\s*```$/, "");
    const o = JSON.parse(clean);
    if (typeof o.body === "string")
      return {
        title: String(o.title ?? "整理成果"),
        body: o.body,
        citations: Array.isArray(o.citations) ? o.citations.map(String) : [],
      };
  } catch {}
  return {
    title: "整理成果（需核对结构）",
    body: text,
    citations: [...text.matchAll(/\[(S\d+)\]/g)].map((m) => m[1]),
  };
}
export function inspectArtifactOutput(
  text: string,
): ReturnType<typeof readArtifactOutput> & { issues: string[] } {
  const issues: string[] = [];
  let value: any;
  try {
    value = JSON.parse(
      text
        .trim()
        .replace(/^```(?:json)?\s*/, "")
        .replace(/\s*```$/, ""),
    );
  } catch {
    issues.push("返回不是约定的 JSON 结构。");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    issues.push("返回不是支持的成果对象。");
    return {
      title: "整理成果（保留原始返回）",
      body: text,
      citations: [...text.matchAll(/\[(S\d+)\]/g)].map((m) => m[1]),
      issues,
    };
  }
  if (typeof value.title !== "string" || !value.title.trim())
    issues.push("成果标题为空或格式不支持。");
  if (typeof value.body !== "string" || !value.body.trim())
    issues.push("成果正文为空或格式不支持。");
  if (
    !Array.isArray(value.citations) ||
    value.citations.some((c: any) => typeof c !== "string" || !/^S\d+$/.test(c))
  )
    issues.push("引用输出不符合 S 编号数组约定。");
  const citations = Array.isArray(value.citations)
    ? value.citations.filter(
        (c: any) => typeof c === "string" && /^S\d+$/.test(c),
      )
    : [];
  return {
    title:
      typeof value.title === "string" && value.title.trim()
        ? value.title
        : "整理成果（待人工命名）",
    body:
      typeof value.body === "string" && value.body.trim() ? value.body : text,
    citations,
    issues,
  };
}
export function reserveBillableAttempt(
  checkpoint: Job["checkpoint"],
  stage: string,
  at = now(),
): number {
  const legacy =
      (checkpoint.outputs ?? []).filter(Boolean).length +
      (checkpoint.final_output ? 1 : 0) +
      (checkpoint.inflight ? 1 : 0),
    used = Number.isSafeInteger(checkpoint.attempts_used)
      ? checkpoint.attempts_used
      : legacy,
    limit = Number(checkpoint.max_calls);
  if (!Number.isSafeInteger(limit) || limit < 1 || used >= limit)
    throw Object.assign(
      new Error(
        "计费尝试预算已耗尽（" +
          used +
          "/" +
          limit +
          "）；未知结果也计次数。请核对已有结果，不会继续调用。",
      ),
      { code: "CALL_BUDGET_EXHAUSTED" },
    );
  checkpoint.attempts_used = used + 1;
  checkpoint.attempt_log ??= [];
  checkpoint.attempt_log.push({
    attempt: used + 1,
    stage,
    at,
    state: "inflight",
  });
  checkpoint.inflight = true;
  return used + 1;
}
export function preserveEditedDraft(
  candidate: Artifact,
  existing?: Artifact,
): Artifact {
  return existing
    ? {
        ...candidate,
        id: uid(),
        title: candidate.title + "（后续草稿）",
        revision: 1,
        revisions: [],
        status: "draft",
      }
    : candidate;
}
function settleAttempt(
  job: Job,
  state: "settled" | "unknown" | "rejected",
): void {
  const attempt = job.checkpoint.attempt_log?.at(-1);
  if (attempt?.state === "inflight") {
    attempt.state = state;
    attempt.settled_at = now();
  }
  job.checkpoint.inflight = false;
}
interface Source {
  label: string;
  text: string;
  citation: Citation;
  title: string;
  author: string;
  type: string;
  coverage: string;
}
export async function planAnalysis(
  materials: Material[],
  provider: Provider,
  presetId: string,
  goal: string,
  inputLimit: number,
  maxCalls: number,
  maxTokens: number,
): Promise<Job> {
  if (!materials.length)
    throw new Error("请选择实际材料，空任务不会调用模型。");
  if (!presets.some((p) => p.id === presetId)) throw new Error("模板不存在。");
  if (inputLimit < 2000 || inputLimit > 100000)
    throw new Error("每批材料预算应在 2,000–100,000 字符之间。");
  if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 100)
    throw new Error("调用次数预算必须为 1–100 次。");
  if (!Number.isInteger(maxTokens) || maxTokens < 64 || maxTokens > 32000)
    throw new Error("单次输出预算必须为 64–32,000 tokens。");
  const sources: Source[] = [];
  for (const m of materials) {
    for (const fragment of m.fragments.length
      ? m.fragments
      : [{ id: "body", text: m.text, start: 0, end: m.text.length }]) {
      for (
        let offset = 0;
        offset < fragment.text.length;
        offset += inputLimit - 500
      ) {
        const text = fragment.text.slice(offset, offset + inputLimit - 500),
          label = "S" + (sources.length + 1);
        sources.push({
          label,
          text,
          title: m.title,
          author: m.author_name + " (" + m.author_id + ")",
          type: m.source_key.entity_type,
          coverage: JSON.stringify(m.coverage),
          citation: {
            citation_id: label,
            material_id: m.id,
            revision_id: m.revision_id,
            version_hash: m.version_hash,
            fragment_id: fragment.id,
            source_key: m.source_key,
            quote: text.slice(0, 10000),
            source_url: m.source_url,
          },
        });
      }
    }
  }
  if (!sources.length) throw new Error("所选材料没有正文，不发送空请求。");
  const batches: Source[][] = [];
  let batch: Source[] = [],
    size = 0;
  for (const s of sources) {
    if (batch.length && size + s.text.length + 200 > inputLimit) {
      batches.push(batch);
      batch = [];
      size = 0;
    }
    batch.push(s);
    size += s.text.length + 200;
  }
  if (batch.length) batches.push(batch);
  const calls = batches.length + (batches.length > 1 ? 1 : 0);
  if (calls > maxCalls)
    throw new Error(
      `本次需要 ${calls} 次请求，超过预算 ${maxCalls} 次；请缩小材料或显式提高预算。`,
    );
  const at = now(),
    job: Job = {
      id: uid(),
      kind: "process",
      title: presets.find((p) => p.id === presetId)!.label,
      status: "queued",
      created_at: at,
      updated_at: at,
      events: [],
      material_ids: materials.map((m) => m.id),
      checkpoint: {
        provider: { ...provider },
        provider_config: canonical(provider),
        preset_id: presetId,
        goal,
        max_tokens: maxTokens,
        max_calls: maxCalls,
        attempts_used: 0,
        attempt_log: [],
        batches,
        sources,
        next_batch: 0,
        outputs: [],
        calls,
        characters: sources.reduce((n, s) => n + s.text.length, 0),
        inflight: false,
      },
    };
  return put("jobs", job);
}
export async function runAnalysis(
  id: string,
  onProgress: () => void = () => {},
  retryUnknown = false,
): Promise<void> {
  return navigator.locks.request(
    "xingjian-process:" + id,
    { ifAvailable: true },
    async (lock) => {
      if (!lock)
        throw new Error(
          "该任务已发请求尚未 settle；请等待当前执行页停止，再恢复。",
        );
      await runAnalysisSettled(id, onProgress, retryUnknown);
    },
  );
}
async function runAnalysisSettled(
  id: string,
  onProgress: () => void,
  retryUnknown: boolean,
): Promise<void> {
  const job = await get<Job>("jobs", id);
  if (!job || job.kind !== "process") throw new Error("加工任务不存在。");
  if (
    (job.status === "unknown" ||
      job.checkpoint.unresolved_attempt ||
      job.checkpoint.inflight) &&
    !retryUnknown
  )
    throw new Error("结果未知任务必须先核对计费并显式确认重试。");
  if (["complete", "cancelled"].includes(job.status)) return;
  if (!Number.isSafeInteger(job.checkpoint.attempts_used)) {
    const events = job.events.filter((e) =>
      /^发送第 \d|^各批已保存；正在综合/.test(e.message),
    ).length;
    job.checkpoint.attempts_used = Math.max(
      events,
      (job.checkpoint.outputs ?? []).filter(Boolean).length +
        (job.checkpoint.final_output ? 1 : 0) +
        (job.checkpoint.inflight ? 1 : 0),
      job.status === "unknown" ? 1 : 0,
    );
  }
  if (job.status === "unknown" || job.checkpoint.inflight) {
    job.checkpoint.unresolved_attempt = true;
    settleAttempt(job, "unknown");
  }
  const config = job.checkpoint.provider as Provider,
    live = await get<Provider>("providers", config.id);
  if (!live || canonical(live) !== job.checkpoint.provider_config)
    throw new Error("模型配置已变化，请重新创建并确认执行计划。");
  if (!(await secret("provider:" + config.id)))
    throw new Error("模型 Key 已锁定，请先解锁。");
  if (!(await activateJob(id))) return;
  job.status = "running";
  job.reason = undefined;
  await appendEvent(
    job,
    retryUnknown
      ? "用户确认了未知结果重试风险。"
      : "用户确认来源范围与外发模型后开始。",
  );
  onProgress();
  try {
    const batches = job.checkpoint.batches as Source[][];
    for (let i = Number(job.checkpoint.next_batch); i < batches.length; i++) {
      const state = await get<Job>("jobs", id);
      if (state?.status === "paused" || state?.status === "cancelled") return;
      const attempt = reserveBillableAttempt(
        job.checkpoint,
        "batch:" + (i + 1),
      );
      await appendEvent(
        job,
        `计费尝试 ${attempt}/${job.checkpoint.max_calls}：发送第 ${i + 1}/${batches.length} 批到 ${new URL(config.base_url).origin} / ${config.model}。`,
      );
      onProgress();
      const prompt =
        analysisInstructions(job.checkpoint.preset_id, job.checkpoint.goal) +
        "\n这是第 " +
        (i + 1) +
        " 批，仅处理本批内容，不声称全文完整。SOURCES:\n" +
        JSON.stringify(
          batches[i].map((s) => ({
            id: s.label,
            title: s.title,
            author: s.author,
            type: s.type,
            coverage: s.coverage,
            text: s.text,
          })),
        );
      const output = await generate(
        config,
        prompt,
        Number(job.checkpoint.max_tokens),
      );
      job.checkpoint.outputs[i] = output;
      job.checkpoint.next_batch = i + 1;
      job.checkpoint.unresolved_attempt = false;
      settleAttempt(job, "settled");
      await appendEvent(job, "第 " + (i + 1) + " 批响应已保存到本机。");
      onProgress();
      if (!output.complete || output.truncated) {
        job.status = "partial";
        job.reason = "模型输出截断或未完整结束，停止后续计费调用。";
        break;
      }
    }
    const state = await get<Job>("jobs", id);
    if (state?.status === "paused" || state?.status === "cancelled") return;
    const outputs = job.checkpoint.outputs as {
        text: string;
        model?: string;
        complete: boolean;
        truncated: boolean;
      }[],
      partialOutputs =
        outputs.some((o) => !o.complete || o.truncated) ||
        Number(job.checkpoint.next_batch) < batches.length;
    let final = outputs.at(-1);
    if (partialOutputs) {
      job.status = "partial";
      final = {
        text: outputs
          .map((o, i) => "## 第 " + (i + 1) + " 批已保存返回\n\n" + o.text)
          .join("\n\n"),
        model: outputs.at(-1)?.model,
        complete: false,
        truncated: outputs.some((o) => o.truncated),
      };
    }
    if (batches.length > 1 && !partialOutputs) {
      if (job.checkpoint.final_output) final = job.checkpoint.final_output;
      else {
        const attempt = reserveBillableAttempt(job.checkpoint, "synthesis");
        await appendEvent(
          job,
          "计费尝试 " +
            attempt +
            "/" +
            job.checkpoint.max_calls +
            "：各批已保存，开始综合，不增加新资料。",
        );
        onProgress();
        final = await generate(
          config,
          analysisInstructions(job.checkpoint.preset_id, job.checkpoint.goal) +
            "\n以下仅为分段 AI 草稿，不是新的事实来源。保留原来的 [S编号]，不虚构引用:\n" +
            outputs.map((o, i) => "批 " + (i + 1) + "\n" + o.text).join("\n\n"),
          Number(job.checkpoint.max_tokens),
        );
        job.checkpoint.final_output = final;
        job.checkpoint.unresolved_attempt = false;
        settleAttempt(job, "settled");
        await appendEvent(job, "综合响应已保存；不因暂停而重发已结算请求。");
      }
    }
    if (!final) throw new Error("没有已完成的模型输出。");
    const parsed = inspectArtifactOutput(final.text);
    const cited = new Set(
      parsed.citations.concat(
        [...parsed.body.matchAll(/\[(S\d+)\]/g)].map((m) => m[1]),
      ),
    );
    const sources = job.checkpoint.sources as Source[];
    const known = new Set(sources.map((s) => s.label));
    const invalid = [...cited].filter((c) => !known.has(c));
    const complete =
      final.complete &&
      !partialOutputs &&
      !parsed.issues.length &&
      !invalid.length &&
      cited.size > 0;
    const at = now(),
      previous = job.artifact_id
        ? await get<Artifact>("artifacts", job.artifact_id)
        : undefined,
      candidate: Artifact = {
        id: uid(),
        title: parsed.title,
        body:
          parsed.body +
          (invalid.length ? "\n\n> 引用待核对：" + invalid.join(", ") : "") +
          (parsed.issues.length
            ? "\n\n> 返回结构待核对：" +
              parsed.issues.join(" ") +
              "\n\n## 已付费原始返回\n\n" +
              final.text
            : ""),
        citations: sources
          .filter((s) => cited.has(s.label))
          .map((s) => s.citation),
        revision: 1,
        revisions: [],
        status: "draft",
        created_at: at,
        updated_at: at,
        model_attribution: {
          requested_model: config.model,
          response_model: final.model,
          generated_at: at,
          protocol: config.protocol,
          complete,
          truncated: final.truncated,
        },
      };
    if (!cited.size)
      candidate.body += "\n\n> 模型未提供可回查引用，尚未人工核验。";
    const artifact = preserveEditedDraft(candidate, previous);
    await put("artifacts", artifact);
    if (previous) {
      job.checkpoint.previous_artifact_ids ??= [];
      job.checkpoint.previous_artifact_ids.push(previous.id);
    }
    job.artifact_id = artifact.id;
    job.status = complete ? "complete" : "partial";
    job.reason = complete
      ? undefined
      : "已保留付费文本；输出结构、引用或完整度仍需核对。";
    await appendEvent(
      job,
      previous
        ? "后续输出另存新草稿，原人工编辑稿与全部历史保留。"
        : "成果已保存为待核对草稿；原文保持完整。",
    );
    onProgress();
  } catch (error) {
    const unknown =
      !!(error as any)?.unknown ||
      (job.checkpoint.inflight && !(error as any)?.definitive_response);
    settleAttempt(job, unknown ? "unknown" : "rejected");
    if (unknown) job.checkpoint.unresolved_attempt = true;
    job.status =
      (error as any)?.code === "CALL_BUDGET_EXHAUSTED"
        ? "partial"
        : unknown
          ? "unknown"
          : "failed";
    job.reason = error instanceof Error ? error.message : "调用失败";
    await appendEvent(job, "停止：" + job.reason);
    onProgress();
  }
}
export async function recoverInterruptedJobs(): Promise<void> {
  for (const job of await list<Job>("jobs"))
    if (
      job.status === "running" ||
      (job.kind === "process" &&
        job.checkpoint.inflight &&
        !["complete", "cancelled"].includes(job.status))
    ) {
      const unknown = job.kind === "process" && job.checkpoint.inflight;
      job.status = unknown ? "unknown" : "paused";
      if (unknown) job.checkpoint.unresolved_attempt = true;
      job.reason = unknown
        ? "上次扩展页在计费请求期间关闭，结果未知。"
        : "上次扩展页关闭，保留断点等待用户恢复。";
      await appendEvent(job, job.reason);
    }
}
