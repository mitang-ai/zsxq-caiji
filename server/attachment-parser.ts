import { extname, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
export type AttachmentText = { state: string; text?: string; reason?: string };
export function extractText(bytes: Buffer, name: string): AttachmentText {
  const ext = extname(name).toLowerCase();
  if (![".txt", ".md", ".csv", ".json", ".html", ".htm"].includes(ext))
    return {
      state: "unsupported",
      reason: "保留原件，该文件类型尚无文本解析器",
    };
  let text = bytes.toString("utf8");
  if (ext === ".html" || ext === ".htm")
    text = text
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]*>/g, " ");
  return {
    state: text.length > 1000000 ? "partial" : "parsed",
    text: text.slice(0, 1000000),
    ...(text.length > 1000000
      ? { reason: "达到文本解析字数上限，原件保留" }
      : {}),
  };
}
export async function extractBinary(
  bytes: Buffer,
  name: string,
): Promise<AttachmentText> {
  const ext = extname(name).toLowerCase();
  if (ext === ".docx") {
    try {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({ buffer: bytes });
      return {
        state: result.value.length > 1000000 ? "partial" : "parsed",
        text: result.value.slice(0, 1000000),
        ...(result.value.length > 1000000
          ? { reason: "达到文本解析字数上限，原件保留" }
          : {}),
      };
    } catch {
      return { state: "failed", reason: "DOCX 无法解析，原件保留" };
    }
  }
  if (ext === ".pdf") {
    let doc: any, loading: any;
    try {
      const pdf = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const assets = dirname(
        fileURLToPath(import.meta.resolve("pdfjs-dist/package.json")),
      );
      loading = pdf.getDocument({
        data: new Uint8Array(bytes),
        useWorkerFetch: false,
        disableFontFace: true,
        stopAtErrors: true,
        cMapUrl: join(assets, "cmaps") + "/",
        cMapPacked: true,
        standardFontDataUrl: join(assets, "standard_fonts") + "/",
      });
      doc = await loading.promise;
      if (doc.numPages > 500)
        return { state: "partial", reason: "超过 500 页解析上限，原件保留" };
      let text = "";
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        text += content.items.map((s: any) => s.str ?? "").join(" ") + "\n\n";
        page.cleanup();
        if (text.length > 1000000)
          return {
            state: "partial",
            text: text.slice(0, 1000000),
            reason: "达到文本解析字数上限，原件保留",
          };
      }
      return text.trim()
        ? { state: "parsed", text }
        : {
            state: "inaccessible",
            reason: "扫描型 PDF 未含文本；不冒充已 OCR",
          };
    } catch (error: any) {
      return {
        state: "failed",
        reason: "PDF 无法解析，原件保留：" + error.message,
      };
    } finally {
      await loading?.destroy();
    }
  }
  return extractText(bytes, name);
}
