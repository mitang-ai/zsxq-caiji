import { publicRequest, providerURL } from "./net.js";
export type Provider = {
  id: string;
  label: string;
  protocol: "chat" | "responses" | "anthropic";
  base_url: string;
  model: string;
  models: string[];
  secret: string;
  user_id: string;
};
type Request = typeof publicRequest;
function providerHeaders(p: Provider, key: string): Record<string, string> {
  if (p.protocol === "anthropic")
    return { "x-api-key": key, "anthropic-version": "2023-06-01" };
  if (new URL(p.base_url).hostname === "api.xiaomimimo.com")
    return { "api-key": key };
  return { Authorization: `Bearer ${key}` };
}
export async function providerModels(
  p: Provider,
  key: string,
  request: Request = publicRequest,
): Promise<string[]> {
  providerURL(p.base_url);
  const r = await request(`${p.base_url.replace(/\/$/, "")}/models`, {
    headers: providerHeaders(p, key),
  });
  if (r.status < 200 || r.status >= 300)
    throw Object.assign(
      new Error(`模型列表返回 HTTP ${r.status}，可手动填写模型 ID`),
      { code: "provider_models_failed", statusCode: 400 },
    );
  const j = JSON.parse(r.text);
  return (j.data ?? j.models ?? [])
    .map((m: any) => String(m.id ?? m.name ?? m))
    .slice(0, 1000);
}
export async function providerCall(
  p: Provider,
  key: string,
  system: string,
  input: string,
  maxTokens: number,
  model = p.model,
  request: Request = publicRequest,
  verification = false,
) {
  providerURL(p.base_url);
  const endpoint =
    p.protocol === "chat"
      ? "chat/completions"
      : p.protocol === "responses"
        ? "responses"
        : "messages";
  const body: any =
    p.protocol === "chat"
      ? {
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: input },
          ],
          max_tokens: maxTokens,
          stream: false,
        }
      : p.protocol === "responses"
        ? {
            model,
            instructions: system,
            input,
            max_output_tokens: maxTokens,
            store: false,
          }
        : {
            model,
            system,
            messages: [{ role: "user", content: input }],
            max_tokens: maxTokens,
          };
  if (
    verification &&
    new URL(p.base_url).hostname === "api.xiaomimimo.com" &&
    p.protocol === "responses"
  )
    body.reasoning = { effort: "none" };
  let r: Awaited<ReturnType<Request>>;
  try {
    r = await request(`${p.base_url.replace(/\/$/, "")}/${endpoint}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...providerHeaders(p, key),
      },
      body: JSON.stringify(body),
    });
  } catch (e: any) {
    if (
      [
        "private_network_denied",
        "unsafe_provider_url",
        "redirect_denied",
        "dns_verification_failed",
      ].includes(e.code)
    )
      throw e;
    throw Object.assign(
      new Error(
        "请求已发送但无法确认计费与结果，请检查服务商记录后手动决定是否重试",
      ),
      { code: "outcome_unknown", statusCode: 502 },
    );
  }
  if (r.status >= 500)
    throw Object.assign(
      new Error(`模型服务 HTTP ${r.status}，计费结果可能未知；不会自动重试`),
      { code: "outcome_unknown", statusCode: 502 },
    );
  if (r.status < 200 || r.status >= 300)
    throw Object.assign(new Error(`模型服务拒绝请求 HTTP ${r.status}`), {
      code: "provider_rejected",
      statusCode: 400,
      details: { http_status: r.status },
    });
  let j: any;
  try {
    j = JSON.parse(r.text);
  } catch {
    throw Object.assign(new Error("模型返回无法解析，不能自动重试"), {
      code: "outcome_unknown",
      statusCode: 502,
    });
  }
  const text =
    p.protocol === "chat"
      ? j.choices?.[0]?.message?.content
      : p.protocol === "responses"
        ? (j.output_text ??
          j.output
            ?.flatMap((o: any) => o.content ?? [])
            .filter((c: any) => c.type === "output_text")
            .map((c: any) => c.text)
            .join(""))
        : j.content
            ?.filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("");
  if (typeof text !== "string" || !text.trim())
    throw Object.assign(new Error("没有得到文本输出；本次调用可能已计费"), {
      code: "outcome_unknown",
      statusCode: 502,
    });
  const reason =
    p.protocol === "chat"
      ? j.choices?.[0]?.finish_reason
      : p.protocol === "responses"
        ? j.status === "incomplete"
          ? (j.incomplete_details?.reason ?? "incomplete")
          : j.status
        : j.stop_reason;
  const truncated =
    [
      "length",
      "max_tokens",
      "max_output_tokens",
      "incomplete",
      "content_filter",
      "refusal",
      "failed",
    ].includes(reason) ||
    (p.protocol === "responses" && j.status && j.status !== "completed");
  return {
    text,
    model: j.model ?? model,
    usage: j.usage ?? null,
    truncated: !!truncated,
    stop_reason: reason ?? null,
  };
}
