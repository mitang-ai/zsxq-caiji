import test from "node:test";
import assert from "node:assert/strict";
import { zipSync, strToU8 } from "fflate";
import { extractAttachment } from "../server/attachments.js";

function pdf(contents: string): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(contents)} >>\nstream\n${contents}\nendstream`,
  ];
  let out = "%PDF-1.4\n",
    offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const start = Buffer.byteLength(out);
  out +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets
      .slice(1)
      .map((x) => `${String(x).padStart(10, "0")} 00000 n \n`)
      .join("") +
    `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return Buffer.from(out);
}
test("real PDF text is parsed in bounded worker and scan-only PDF stays inaccessible", async () => {
  const text = await extractAttachment(
    pdf("BT /F1 12 Tf 20 100 Td (Attachment evidence 42) Tj ET"),
    "evidence.pdf",
  );
  assert.equal(text.state, "parsed", text.reason);
  assert.match(text.text!, /Attachment evidence 42/);
  const scan = await extractAttachment(pdf(""), "scan.pdf");
  assert.equal(scan.state, "inaccessible");
  assert.match(scan.reason!, /OCR/);
});
test("real OOXML DOCX is parsed; corrupt binary preserves explicit failure", async () => {
  const xml: Record<string, Uint8Array> = {};
  xml["[Content_Types].xml"] = strToU8(
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  xml["_rels/.rels"] = strToU8(
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  xml["word/document.xml"] = strToU8(
    '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>附件隔离验收，不是源站资料。</w:t></w:r></w:p></w:body></w:document>',
  );
  const doc = await extractAttachment(Buffer.from(zipSync(xml)), "note.docx");
  assert.equal(doc.state, "parsed", doc.reason);
  assert.match(doc.text!, /附件隔离验收/);
  for (const name of ["bad.pdf", "bad.docx"])
    assert.equal(
      (await extractAttachment(Buffer.from("not a valid file"), name)).state,
      "failed",
    );
});
test("large text reports partial; HTML scripts are not included; oversized binary is not sent to parser", async () => {
  const text = await extractAttachment(
    Buffer.from("x".repeat(1000001)),
    "note.txt",
  );
  assert.equal(text.state, "partial");
  assert.equal(text.text!.length, 1000000);
  const html = await extractAttachment(
    Buffer.from(
      '<script>fetch("private")</script><style>x</style><p>visible</p>',
    ),
    "note.html",
  );
  assert.equal(html.state, "parsed");
  assert(!html.text!.includes("fetch"));
  assert.match(html.text!, /visible/);
  assert.equal(
    (await extractAttachment(Buffer.alloc(50 * 1024 * 1024 + 1), "big.pdf"))
      .state,
    "partial",
  );
});
