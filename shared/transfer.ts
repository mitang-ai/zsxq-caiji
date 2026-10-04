import { z } from "zod";

// This module is deliberately browser-safe: the same canonical format is used
// by the server and the standalone extension. Credentials are never a field.
export function canonical(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map((v) => canonical(v ?? null)).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value ?? null);
}
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
const rr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
export function sha256(input: string | Uint8Array): string {
  const bytes =
    typeof input === "string" ? new TextEncoder().encode(input) : input;
  const size = Math.ceil((bytes.length + 9) / 64) * 64;
  const b = new Uint8Array(size);
  b.set(bytes);
  b[bytes.length] = 128;
  const view = new DataView(b.buffer);
  view.setUint32(size - 8, Math.floor(bytes.length / 0x20000000));
  view.setUint32(size - 4, (bytes.length * 8) >>> 0);
  const h = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ];
  const w = new Uint32Array(64);
  for (let off = 0; off < size; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15],
        y = w[i - 2];
      w[i] =
        (w[i - 16] +
          (rr(x, 7) ^ rr(x, 18) ^ (x >>> 3)) +
          w[i - 7] +
          (rr(y, 17) ^ rr(y, 19) ^ (y >>> 10))) >>>
        0;
    }
    let [a, c, d, e, f, g, j, k] = h;
    for (let i = 0; i < 64; i++) {
      const t =
        (k +
          (rr(f, 6) ^ rr(f, 11) ^ rr(f, 25)) +
          ((f & g) ^ (~f & j)) +
          K[i] +
          w[i]) >>>
        0;
      const u =
        ((rr(a, 2) ^ rr(a, 13) ^ rr(a, 22)) + ((a & c) ^ (a & d) ^ (c & d))) >>>
        0;
      k = j;
      j = g;
      g = f;
      f = (e + t) >>> 0;
      e = d;
      d = c;
      c = a;
      a = (t + u) >>> 0;
    }
    [a, c, d, e, f, g, j, k].forEach((v, i) => (h[i] = (h[i] + v) >>> 0));
  }
  return h.map((x) => x.toString(16).padStart(8, "0")).join("");
}
const id = z.string().min(1).max(200);
const coverageState = z.enum(["complete", "partial", "inaccessible", "failed"]);
export const CoverageSchema = z.object({
  body: coverageState,
  comments: coverageState,
  attachments: coverageState,
  reasons: z.array(z.string().max(1000)).max(200).default([]),
});
export const SourceKeySchema = z.object({
  platform: z.literal("zsxq"),
  group_id: id,
  entity_type: z.enum(["topic", "answer", "comment"]),
  entity_id: id,
});
export const FragmentSchema = z.object({
  id,
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  text: z.string().max(500000),
});
export const RecordSchema = z.object({
  source_key: SourceKeySchema,
  group_id: id,
  author_id: id,
  author_name: z.string().max(300),
  title: z.string().max(1000),
  text: z.string().max(1000000),
  entity_type: z.enum(["topic", "answer", "comment"]).optional(),
  parent_entity_id: id.optional(),
  created_at: z.string().max(100),
  source_url: z.string().max(2000),
  coverage: CoverageSchema,
  fragments: z.array(FragmentSchema).max(10000),
  captured_at: z.string().max(100),
  hash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  version_hash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  images: z
    .array(
      z.object({
        id,
        name: z.string().max(300).optional(),
        url: z.string().max(2000),
      }),
    )
    .max(100)
    .optional(),
  files: z
    .array(
      z.object({
        id,
        name: z.string().max(300),
        size: z.number().nonnegative().optional(),
        mime: z.string().optional(),
      }),
    )
    .max(100)
    .optional(),
});
export const CitationSchema = z.object({
  material_id: id,
  revision_id: id,
  version_hash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  fragment_id: id.optional(),
  citation_id: id.optional(),
  label: id.optional(),
  quote: z.string().max(10000).optional(),
  source_key: SourceKeySchema.optional(),
});
export const ArtifactSchema = z.object({
  id,
  title: z.string().max(1000),
  body: z.string().max(1000000),
  citations: z.array(CitationSchema).max(10000).default([]),
  status: z.enum(["draft", "adopted", "edited"]).default("draft"),
  created_at: z.string().optional(),
  model_attribution: z.string().max(1000).optional(),
});
export const AnnotationSchema = z.object({
  id,
  material_id: id,
  revision_id: id,
  version_hash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  quote: z.string().max(10000),
  note: z.string().max(10000),
  created_at: z.string().optional(),
  source_key: SourceKeySchema.optional(),
});
export const AttachmentSchema = z.object({
  id,
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  size: z
    .number()
    .int()
    .nonnegative()
    .max(50 * 1024 * 1024),
  name: z.string().max(300),
  mime: z.string().max(200),
  record_source_key: SourceKeySchema.optional(),
  status: z.enum(["available", "missing", "pending"]).default("missing"),
});
export const BundleSchema = z.object({
  schema_version: z.literal(1),
  bundle_id: id,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  exported_at: z.string().max(100),
  producer: z.object({
    name: z.string().max(100),
    version: z.string().max(100),
  }),
  records: z.array(RecordSchema).max(10000),
  annotations: z.array(AnnotationSchema).max(50000),
  artifacts: z.array(ArtifactSchema).max(10000),
  attachments: z.array(AttachmentSchema).max(10000),
  coverage: z.record(z.string(), z.unknown()),
});
export type TransferBundle = z.infer<typeof BundleSchema>;
export type SourceRecord = z.infer<typeof RecordSchema>;
export type Coverage = z.infer<typeof CoverageSchema>;
// Stable across transport IDs/capture times, but not across title, author,
// coverage, fragments or attachment metadata edits. Text hash alone cannot
// identify an immutable source version.
export function recordVersionHash(record: SourceRecord): string {
  const safe = RecordSchema.parse(record);
  const { captured_at: _, hash: __, version_hash: ___, ...content } = safe;
  return sha256(
    canonical({
      ...content,
      entity_type: content.entity_type ?? content.source_key.entity_type,
      images: content.images ?? [],
      files: content.files ?? [],
      coverage: {
        ...content.coverage,
        reasons: content.coverage.reasons ?? [],
      },
    }),
  );
}
export function fragmentsFor(text: string) {
  const result: { id: string; start: number; end: number; text: string }[] = [];
  const re = /[^\n]+(?:\n(?!\n)[^\n]+)*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)))
    result.push({
      id: `f-${sha256(`${m.index}:${m[0]}`).slice(0, 16)}`,
      start: m.index,
      end: m.index + m[0].length,
      text: m[0],
    });
  return result;
}
export function createBundle(
  input: Partial<Omit<TransferBundle, "digest" | "schema_version">>,
): TransferBundle {
  const b = {
    schema_version: 1 as const,
    bundle_id: input.bundle_id ?? crypto.randomUUID(),
    exported_at: input.exported_at ?? new Date().toISOString(),
    producer: input.producer ?? { name: "集见", version: "1.1.0" },
    records: input.records ?? [],
    annotations: input.annotations ?? [],
    artifacts: input.artifacts ?? [],
    attachments: input.attachments ?? [],
    coverage: input.coverage ?? {},
  };
  // Parsing strips fields not in the portable schema, including private state.
  const safe = BundleSchema.parse({ ...b, digest: "0".repeat(64) });
  const { digest: _, ...payload } = safe;
  return { ...payload, digest: sha256(canonical(payload)) };
}
export function validateBundle(input: unknown): TransferBundle {
  const b = BundleSchema.parse(input);
  const { digest, ...payload } = b;
  if (sha256(canonical(payload)) !== digest)
    throw new Error("bundle_digest_mismatch");
  for (const r of b.records) {
    if (r.group_id !== r.source_key.group_id)
      throw new Error("group_identity_mismatch");
    if (r.hash && r.hash !== sha256(r.text))
      throw new Error("record_hash_mismatch");
    if (r.version_hash && r.version_hash !== recordVersionHash(r))
      throw new Error("record_version_hash_mismatch");
    if (
      r.fragments.some(
        (f) =>
          f.end < f.start ||
          f.end > r.text.length ||
          r.text.slice(f.start, f.end) !== f.text,
      )
    )
      throw new Error("fragment_mismatch");
    if (
      !/^https:\/\/(?:wx|app|www)\.zsxq\.com\//.test(r.source_url) ||
      new URL(r.source_url).search
    )
      throw new Error("unsafe_source_url");
    if (
      (r.images ?? []).some((img) =>
        /token=|signature=|auth=|key=|expires=/i.test(img.url),
      )
    )
      throw new Error("signed_image_url_not_portable");
  }
  return b;
}
