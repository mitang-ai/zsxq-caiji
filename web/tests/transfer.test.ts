import test from "node:test";
import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import { createBundle, sha256 } from "../../shared/transfer";
import {
  createArchive,
  importKey,
  parseArchive,
  uploadArchiveAttachments,
  type UploadState,
} from "../src/transfer";

const bytes = strToU8("isolated attachment test\n");
const bundle = () =>
  createBundle({
    attachments: [
      {
        id: "test-attachment",
        hash: sha256(bytes),
        size: bytes.length,
        name: "isolated.txt",
        mime: "text/plain",
        status: "available",
      },
    ],
  });
const file = (data: Uint8Array, name = "test.zip") =>
  new File([data.slice().buffer], name);

test("ZIP export fetches authenticated original, checks hash and restores bytes locally", async () => {
  const original = globalThis.fetch;
  const b = bundle();
  const calls: string[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push(String(input));
    assert.equal(init?.credentials, "same-origin");
    return new Response(bytes.slice().buffer);
  };
  try {
    const zip = await createArchive("isolated-workspace", b);
    const restored = await parseArchive(file(zip));
    assert.deepEqual(restored.bundle, b);
    assert.deepEqual(restored.blobs[sha256(bytes)], bytes);
    assert.deepEqual(calls, [
      "/api/w/isolated-workspace/attachments/test-attachment",
    ]);
  } finally {
    globalThis.fetch = original;
  }
});
test("tampered attachment and digest are rejected before upload", async () => {
  const b = bundle();
  await assert.rejects(
    parseArchive(
      file(
        zipSync({
          "bundle.json": strToU8(JSON.stringify(b)),
          [`attachments/${sha256(bytes)}`]: strToU8("tampered"),
        }),
      ),
    ),
    /SHA-256/,
  );
  await assert.rejects(
    parseArchive(
      file(
        strToU8(JSON.stringify({ ...b, digest: "0".repeat(64) })),
        "bad.json",
      ),
    ),
    /bundle_digest_mismatch/,
  );
});
test("credential fields are rejected and unknown ZIP files never restored", async () => {
  await assert.rejects(
    parseArchive(
      file(
        strToU8(JSON.stringify({ ...bundle(), cookie: "synthetic-test-only" })),
        "bad.json",
      ),
    ),
    /凭据/,
  );
  const parsed = await parseArchive(
    file(
      zipSync({
        "bundle.json": strToU8(JSON.stringify(bundle())),
        "unknown-secret.txt": bytes,
        "../attachments/data": bytes,
      }),
    ),
  );
  assert.deepEqual(parsed.blobs, {});
});
test("attachment upload uses 1 MiB chunks, preserves receipt and avoids repeating complete bytes", async () => {
  const large = new Uint8Array(1024 * 1024 + 9);
  large.fill(65);
  const b = createBundle({
    attachments: [
      {
        id: "test",
        hash: sha256(large),
        size: large.length,
        name: "large.bin",
        mime: "application/octet-stream",
        status: "available",
      },
    ],
  });
  const archive = {
    bundle: b,
    blobs: { [sha256(large)]: large },
    filename: "test.zip",
  };
  const states = new Map<string, UploadState>();
  const calls: string[] = [];
  let offset = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    calls.push(path);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    let response: unknown;
    if (path.endsWith("/uploads")) response = { id: "upload-test", offset: 0 };
    else if (path.endsWith("/chunks")) {
      const chunk = Buffer.from(body.data_base64, "base64");
      assert.ok(chunk.length <= 1024 * 1024);
      assert.equal(body.offset, offset);
      offset += chunk.length;
      response = { offset };
    } else {
      assert.equal(offset, large.length);
      response = { id: "attachment-test" };
    }
    return new Response(JSON.stringify(response), {
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    await uploadArchiveAttachments("w", archive, states);
    assert.equal(calls.length, 4);
    await uploadArchiveAttachments("w", archive, states);
    assert.equal(calls.length, 4);
    assert.equal(offset, large.length);
    assert.ok(importKey(b).length <= 128);
  } finally {
    globalThis.fetch = original;
  }
});
test("export refuses corrupt original rather than generating a misleading ZIP", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("bad");
  try {
    await assert.rejects(createArchive("w", bundle()), /校验失败/);
  } finally {
    globalThis.fetch = original;
  }
});
