import {
  pageIdentity,
  sourcePath,
  SOURCE_ORIGIN,
  type SourceRequest,
} from "./source";
import { sourceHeaders, parseSourceJson } from "../shared/zsxq";
chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});
async function sourceTab(): Promise<chrome.tabs.Tab> {
  const tabs = await chrome.tabs.query({ url: "https://wx.zsxq.com/*" });
  const tab =
    tabs.find((t) => t.active) ??
    tabs.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
  if (!tab?.id || !tab.url)
    throw new Error("请在当前浏览器打开并登录 https://wx.zsxq.com/。");
  pageIdentity(tab.url);
  return tab;
}
function trustedSender(sender: chrome.runtime.MessageSender): boolean {
  return (
    sender.id === chrome.runtime.id &&
    !!sender.url &&
    sender.url.startsWith(chrome.runtime.getURL("")) &&
    /\/(sidepanel|workbench)\.html(?:[?#]|$)/.test(sender.url)
  );
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!trustedSender(sender)) {
    respond({ ok: false, error: "仅可信扩展界面可调用业务动作。" });
    return false;
  }
  if (
    ![
      "source-context",
      "source-business",
      "source-binary",
      "source-image",
    ].includes(message?.type)
  ) {
    respond({ ok: false, error: "不支持的扩展动作。" });
    return false;
  }
  void (async () => {
    const tab = await sourceTab();
    if (message.type === "source-context")
      return {
        context: { tab_id: tab.id, url: tab.url, ...pageIdentity(tab.url!) },
      };
    const request = message.request as SourceRequest;
    if (
      message.type === "source-binary" &&
      request.operation !== "fileDownload"
    )
      throw new Error("原件通道仅接受固定附件 ID。");
    if (
      message.type === "source-image" &&
      (request.operation !== "detail" ||
        !/^\d{1,24}$/.test(request.image_id ?? ""))
    )
      throw new Error("原图通道仅接受固定主题与图片 ID。");
    const path = sourcePath(request);
    const nonce = crypto.randomUUID();
    const headers = await sourceHeaders("https://api.zsxq.com" + path);
    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id! },
      world: "MAIN",
      func: async (
        path: string,
        nonce: string,
        expectedOrigin: string,
        headers: Record<string, string>,
        binary: boolean,
        imageId: string,
      ) => {
        if (location.origin !== expectedOrigin)
          throw new Error("source_origin_changed");
        // This closure has no page-callable message listener and no arbitrary URL input.
        if (
          !/^\/v2\/(?:users\/self|groups(?:\/\d{1,24}\/(?:topics|members))?|search\/groups\/\d{1,24}\/members|topics\/\d{1,24}\/(?:info|comments)|articles\/[\w-]{1,100}|files\/\d{1,24}\/download_url)(?:\?|$)/.test(
            path,
          )
        )
          throw new Error("source_route_rejected");
        if (
          binary &&
          !(imageId
            ? /^\/v2\/topics\/\d{1,24}\/info$/.test(path)
            : /^\/v2\/files\/\d{1,24}\/download_url$/.test(path))
        )
          throw new Error("source_binary_route_rejected");
        const controller = new AbortController(),
          timeout = setTimeout(
            () => controller.abort(),
            binary ? 90000 : 30000,
          );
        try {
          const response = await fetch("https://api.zsxq.com" + path, {
            headers,
            credentials: "include",
            cache: "no-store",
            signal: controller.signal,
            redirect: "error",
          });
          if (!response.ok)
            return {
              nonce,
              origin: location.origin,
              error:
                "来源返回 HTTP " +
                response.status +
                "，请检查登录状态或访问限制。",
            };
          const text = await response.text();
          if (text.length > 8 * 1024 * 1024)
            throw new Error("source_response_too_large");
          if (!binary) return { nonce, origin: location.origin, text };
          // The URL is derived from a fixed authenticated file-id route, never supplied by a web page or caller.
          // Preserve IDs while selecting a source-returned image; no URL comes from the caller.
          let safe = "",
            quoted = false,
            escape = false;
          for (let i = 0; i < text.length; i++) {
            const c = text[i];
            if (quoted) {
              safe += c;
              if (escape) escape = false;
              else if (c === "\\") escape = true;
              else if (c === '"') quoted = false;
              continue;
            }
            if (c === '"') {
              quoted = true;
              safe += c;
              continue;
            }
            if (/\d/.test(c)) {
              let j = i;
              while (j < text.length && /[\d.eE+\-]/.test(text[j])) j++;
              const n = text.slice(i, j);
              safe += /^\d{16,}$/.test(n) ? JSON.stringify(n) : n;
              i = j - 1;
            } else safe += c;
          }
          const json = JSON.parse(safe),
            body = json.body ?? json;
          if (body.succeeded === false) throw new Error("source_file_denied");
          const data = body.resp_data ?? body;
          let raw: any;
          if (imageId) {
            const topic = data.topic ?? data,
              parts = [
                topic.talk,
                topic.question,
                topic.answer,
                topic.task,
                topic.solution,
                topic,
              ],
              images = parts.flatMap((p) =>
                Array.isArray(p?.images) ? p.images : [],
              ),
              image = images.find((i) => String(i.image_id) === imageId);
            raw = image?.original?.url;
            if (typeof raw !== "string")
              throw new Error("source_original_image_unverified");
          } else raw = data.download_url ?? data.url ?? data.file?.download_url;
          if (typeof raw !== "string")
            throw new Error("source_download_shape_unverified");
          const url = new URL(raw);
          if (
            url.protocol !== "https:" ||
            url.username ||
            url.password ||
            !/(^|\.)zsxq\.com$/.test(url.hostname)
          )
            throw new Error("source_download_host_unverified");
          const file = await fetch(url.href, {
            credentials: "omit",
            redirect: "error",
            cache: "no-store",
            signal: controller.signal,
          });
          if (!file.ok || !file.body)
            throw new Error("source_binary_unavailable");
          const limit = 50 * 1024 * 1024;
          if (Number(file.headers.get("content-length") ?? 0) > limit)
            throw new Error("source_binary_too_large");
          const reader = file.body.getReader(),
            chunks: Uint8Array[] = [],
            mime =
              file.headers.get("content-type") ?? "application/octet-stream";
          let size = 0;
          for (;;) {
            const item = await reader.read();
            if (item.done) break;
            size += item.value.length;
            if (size > limit) {
              await reader.cancel();
              throw new Error("source_binary_too_large");
            }
            chunks.push(item.value);
          }
          const bytes = new Uint8Array(size);
          let at = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, at);
            at += chunk.length;
          }
          let encoded = "";
          for (let i = 0; i < bytes.length; i += 32768)
            encoded += String.fromCharCode(...bytes.subarray(i, i + 32768));
          return {
            nonce,
            origin: location.origin,
            binary: { data: btoa(encoded), mime },
          };
        } finally {
          clearTimeout(timeout);
        }
      },
      args: [
        path,
        nonce,
        SOURCE_ORIGIN,
        headers,
        message.type === "source-binary" || message.type === "source-image",
        message.type === "source-image" ? request.image_id! : "",
      ],
    });
    const value = result[0]?.result as any;
    if (!value || value.nonce !== nonce || value.origin !== SOURCE_ORIGIN)
      throw new Error("来源响应身份验证失败。");
    if (value.error) throw new Error(value.error);
    return value.binary
      ? { binary: value.binary }
      : { data: parseSourceJson(value.text) };
  })()
    .then((value) => respond({ ok: true, ...value }))
    .catch((error) =>
      respond({
        ok: false,
        error: error instanceof Error ? error.message : "来源业务请求失败。",
      }),
    );
  return true;
});
