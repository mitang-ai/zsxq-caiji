import type {
  Annotation,
  Artifact,
  Dataset,
  Job,
  Material,
  Provider,
  SourceRecord,
  Attachment,
} from "./types";
import {
  fragmentsFor,
  baseUrl,
  recordOf,
  resolveReference,
  revisionRecord,
  now,
  sha256,
  sourceIdentity,
  uid,
} from "./browser-core";
import { assertNoCredentials } from "./archive";
import {
  RecordSchema,
  recordVersionHash,
  validateBundle as validatePortable,
  type TransferBundle,
} from "../shared/transfer";
export const STORES = [
  "materials",
  "annotations",
  "datasets",
  "artifacts",
  "jobs",
  "attachments",
  "providers",
  "meta",
] as const;
export type StoreName = (typeof STORES)[number];
let database: Promise<IDBDatabase> | undefined;
export function openDatabase(): Promise<IDBDatabase> {
  return (database ??= new Promise((resolve, reject) => {
    const r = indexedDB.open("xingjian-local", 1);
    r.onupgradeneeded = () => {
      for (const name of STORES)
        if (!r.result.objectStoreNames.contains(name))
          r.result.createObjectStore(name, { keyPath: "id" });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.onblocked = () =>
      reject(
        new Error("本地数据库升级被另一扩展页阻止，请关闭其他扩展页后重试。"),
      );
  }));
}
export async function list<T = any>(name: StoreName): Promise<T[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const t = db.transaction(name, "readonly");
    const r = t.objectStore(name).getAll();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export async function get<T = any>(
  name: StoreName,
  id: string,
): Promise<T | undefined> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const r = db.transaction(name, "readonly").objectStore(name).get(id);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export function mergeJobEvents(...groups: Job["events"][]): Job["events"] {
  const values = new Map<string, Job["events"][number]>();
  for (const events of groups)
    for (const event of events)
      values.set(event.at + "\u0000" + event.message, event);
  return [...values.values()].sort((a, b) => a.at.localeCompare(b.at));
}
export async function put<T extends { id: string }>(
  name: StoreName,
  value: T,
): Promise<T> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const t = db.transaction(
      name === "jobs" ? ["jobs", "meta"] : name,
      "readwrite",
    );
    if (name === "jobs") {
      const jobs = t.objectStore("jobs"),
        job = value as unknown as Job;
      const previous = jobs.get(value.id),
        control = t.objectStore("meta").get("job-control:" + value.id);
      let ready = 0;
      const save = () => {
        if (++ready !== 2) return;
        job.events = mergeJobEvents(
          previous.result?.events ?? [],
          job.events ?? [],
        );
        if (["paused", "cancelled"].includes(control.result?.value))
          job.status = control.result.value;
        jobs.put(job);
      };
      previous.onsuccess = save;
      control.onsuccess = save;
    } else t.objectStore(name).put(value);
    t.oncomplete = () => resolve(value);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
/** Change only control/status: never replace an in-flight checkpoint with a stale UI snapshot. */
export async function controlJob(
  id: string,
  status: "paused" | "cancelled",
): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const t = db.transaction(["jobs", "meta"], "readwrite"),
      store = t.objectStore("jobs"),
      r = store.get(id);
    r.onsuccess = () => {
      const job = r.result as Job | undefined;
      if (!job) {
        t.abort();
        return;
      }
      const at = now();
      t.objectStore("meta").put({ id: "job-control:" + id, value: status });
      store.put({
        ...job,
        status,
        updated_at: at,
        events: mergeJobEvents(job.events, [
          {
            at,
            message:
              status === "paused"
                ? "用户暂停后续步骤；当前已发请求等待 settle。"
                : "用户取消后续步骤；当前已发请求等待 settle。",
          },
        ]),
      });
    };
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () =>
      reject(t.error ?? new Error("任务不存在或控制事务未完成。"));
  });
}
export async function activateJob(id: string): Promise<boolean> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const t = db.transaction(["jobs", "meta"], "readwrite"),
      r = t.objectStore("jobs").get(id);
    let active = false;
    r.onsuccess = () => {
      if (r.result && !["cancelled", "complete"].includes(r.result.status)) {
        active = true;
        t.objectStore("meta").put({ id: "job-control:" + id, value: "run" });
      }
    };
    t.oncomplete = () => resolve(active);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
export async function remove(name: StoreName, id: string): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const t = db.transaction(name, "readwrite");
    t.objectStore(name).delete(id);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}
export async function meta<T>(id: string, fallback: T): Promise<T> {
  return (await get<{ id: string; value: T }>("meta", id))?.value ?? fallback;
}
export async function setMeta<T>(id: string, value: T): Promise<void> {
  await put("meta", { id, value });
}
export async function ingest(record: SourceRecord): Promise<Material> {
  const id =
      "m-" + (await sha256(sourceIdentity(record.source_key))).slice(0, 24),
    old = await get<Material>("materials", id),
    material = await nextMaterial(record, old);
  await put("materials", material);
  if (old && old.version_hash !== material.version_hash) {
    for (const a of await list<Artifact>("artifacts"))
      if (a.citations.some((c) => c.material_id === id))
        await put("artifacts", { ...a, stale: true });
  }
  return material;
}
export async function nextMaterial(
  record: SourceRecord,
  previous?: Material,
): Promise<Material> {
  const id =
      "m-" + (await sha256(sourceIdentity(record.source_key))).slice(0, 24),
    old = previous ? structuredClone(previous) : undefined,
    hash = await sha256(record.text),
    fragments = structuredClone(record.fragments),
    at = now();
  const snapshot: SourceRecord = {
    ...RecordSchema.parse(record),
    hash,
    fragments,
    captured_at: record.captured_at || at,
  };
  const version_hash = recordVersionHash(snapshot);
  snapshot.version_hash = version_hash;
  if (old) {
    for (const r of old.revisions) {
      if (!r.record && r.id === old.revision_id) r.record = recordOf(old);
      if (!r.version_hash)
        r.version_hash = recordVersionHash(revisionRecord(old, r));
    }
  }
  const oldVersion = old
    ? recordVersionHash({ ...old, fragments: old.fragments })
    : undefined;
  const same = oldVersion === version_hash;
  const existingRevision = old?.revisions.find(
    (r) => r.version_hash === version_hash,
  );
  const revision_id = same ? old!.revision_id : (existingRevision?.id ?? uid());
  const revision = {
    id: revision_id,
    material_id: id,
    hash,
    version_hash,
    record: structuredClone(snapshot),
    text: record.text,
    fragments,
    coverage: record.coverage,
    captured_at: record.captured_at || at,
    title: record.title,
  };
  const material: Material = {
    ...snapshot,
    id,
    revision_id,
    revisions: same
      ? old!.revisions
      : existingRevision
        ? old!.revisions
        : [...(old?.revisions ?? []), revision],
    tags: old?.tags ?? [],
    starred: old?.starred ?? false,
    status: old?.status ?? "unread",
    reading_position: old?.reading_position,
    archived: old?.archived ?? false,
  };
  return material;
}
/** Preflight every frozen reference before one atomic IndexedDB transaction. */
export async function importBundleLocal(
  raw: TransferBundle,
  files: Attachment[],
): Promise<{ materials: number; artifacts: number; annotations: number }> {
  const bundle = validatePortable(raw),
    current = await list<Material>("materials"),
    simulated = new Map(
      current.map((m) => [sourceIdentity(m.source_key), structuredClone(m)]),
    ),
    changed = new Set<string>();
  for (const record of bundle.records) {
    const key = sourceIdentity(record.source_key),
      before = simulated.get(key),
      after = await nextMaterial(record, before);
    simulated.set(key, after);
    changed.add(after.id);
  }
  const all = [...simulated.values()],
    anns: Annotation[] = bundle.annotations.map((a) => {
      const fixed = resolveReference(a, all);
      return {
        ...a,
        material_id: fixed.material.id,
        revision_id: fixed.revision.id,
        version_hash: fixed.record.version_hash,
        kind: "note",
        created_at: a.created_at ?? now(),
      };
    }),
    existingArts = await list<Artifact>("artifacts"),
    arts: Artifact[] = [];
  for (const a of bundle.artifacts) {
    const citations = a.citations.map((c, index) => {
        const fixed = resolveReference(c, all);
        return {
          ...c,
          material_id: fixed.material.id,
          revision_id: fixed.revision.id,
          version_hash: fixed.record.version_hash,
          citation_id: c.citation_id ?? c.label ?? "S" + (index + 1),
          source_key: fixed.record.source_key,
          quote: c.quote ?? "",
          source_url: fixed.record.source_url,
        };
      }),
      existing = existingArts.find((v) => v.id === a.id),
      conflict =
        !!existing &&
        (existing.body !== a.body ||
          existing.title !== a.title ||
          JSON.stringify(existing.citations) !== JSON.stringify(citations));
    let attribution: Artifact["model_attribution"];
    try {
      const value = JSON.parse(a.model_attribution ?? "null");
      if (
        value &&
        typeof value.requested_model === "string" &&
        typeof value.generated_at === "string" &&
        typeof value.protocol === "string"
      )
        attribution = value;
    } catch {}
    if (existing && !conflict) {
      arts.push({
        ...existing,
        stale: citations.some(
          (c) =>
            all.find((m) => m.id === c.material_id)?.revision_id !==
            c.revision_id,
        ),
      });
      continue;
    }
    arts.push({
      id: conflict ? uid() : a.id,
      title: a.title + (conflict ? "（导入副本）" : ""),
      body: a.body,
      citations,
      status: a.status === "adopted" ? "adopted" : "draft",
      stale: citations.some(
        (c) =>
          all.find((m) => m.id === c.material_id)?.revision_id !==
          c.revision_id,
      ),
      revision: 1,
      revisions: [],
      created_at: a.created_at ?? now(),
      updated_at: now(),
      model_attribution: attribution,
    });
  }
  for (const file of files) {
    if (
      file.blob &&
      (file.blob.size !== file.size ||
        (await sha256(await file.blob.arrayBuffer())) !== file.hash)
    )
      throw new Error("附件原件摘要不匹配；未写入任何资料。");
  }
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(
      ["materials", "annotations", "artifacts", "attachments"],
      "readwrite",
    );
    for (const m of all)
      if (changed.has(m.id)) transaction.objectStore("materials").put(m);
    for (const a of anns) transaction.objectStore("annotations").put(a);
    for (const a of existingArts)
      if (a.citations.some((c) => changed.has(c.material_id)))
        transaction.objectStore("artifacts").put({ ...a, stale: true });
    for (const a of arts) transaction.objectStore("artifacts").put(a);
    for (const a of files) transaction.objectStore("attachments").put(a);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("本机导入事务已回滚。"));
  });
  return {
    materials: changed.size,
    artifacts: arts.length,
    annotations: anns.length,
  };
}
export function datasetMaterials(
  dataset: Dataset,
  materials: Material[],
): Material[] {
  const visible = materials.filter((m) => !m.archived);
  if (dataset.mode === "manual")
    return visible.filter((m) => dataset.material_ids.includes(m.id));
  const r = dataset.rule ?? {};
  return visible.filter(
    (m) =>
      (!r.q ||
        (m.title + "\n" + m.text).toLowerCase().includes(r.q.toLowerCase())) &&
      (!r.group_id || m.group_id === r.group_id) &&
      (!r.author_id || m.author_id === r.author_id) &&
      (!r.tags?.length || r.tags.every((t) => m.tags.includes(t))),
  );
}
export async function updateArtifact(
  id: string,
  base: number,
  patch: Partial<Artifact>,
): Promise<Artifact> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const t = db.transaction("artifacts", "readwrite"),
      store = t.objectStore("artifacts"),
      r = store.get(id);
    let result: Artifact | undefined;
    r.onsuccess = () => {
      const a = r.result as Artifact | undefined;
      if (!a) {
        t.abort();
        reject(new Error("成果不存在。"));
        return;
      }
      if (a.revision !== base) {
        t.abort();
        reject(
          new Error(
            "另一扩展页已更新成果。已保留你的输入，请另存或重新读取后合并。",
          ),
        );
        return;
      }
      result = {
        ...a,
        ...patch,
        id,
        revision: base + 1,
        updated_at: now(),
        revisions: [
          ...a.revisions,
          { revision: base, title: a.title, body: a.body, at: a.updated_at },
        ],
      };
      store.put(result);
    };
    t.oncomplete = () => resolve(result!);
    t.onerror = () => reject(t.error);
  });
}
export async function appendEvent(job: Job, message: string): Promise<Job> {
  job.updated_at = now();
  job.events.push({ at: job.updated_at, message });
  return put("jobs", job);
}
export async function localBackup(): Promise<Record<string, unknown>> {
  const data: Record<string, unknown> = {
    schema_version: 1,
    created_at: now(),
  };
  for (const name of STORES) {
    if (name === "attachments") continue;
    if (name === "meta") {
      data[name] = (await list("meta")).filter((m: any) =>
        ["theme", "reader-size", "saved-view"].includes(m.id),
      );
      continue;
    }
    data[name] = await list(name);
  }
  return data;
}
export async function restoreLocal(
  raw: Record<string, unknown>,
): Promise<void> {
  if (raw.schema_version !== 1) throw new Error("本地备份版本不兼容。");
  assertNoCredentials(raw);
  for (const name of STORES) {
    if (name === "attachments" || name === "meta") continue;
    const rows = raw[name];
    if (!Array.isArray(rows)) throw new Error("备份缺少 " + name);
    for (const row of rows) {
      if (!row || typeof row.id !== "string")
        throw new Error("备份对象 ID 无效。");
      if (name === "materials") {
        const m = await ingest(row as SourceRecord);
        const revisions = Array.isArray(row.revisions)
          ? row.revisions.filter(
              (r: any) =>
                typeof r.id === "string" &&
                typeof r.text === "string" &&
                Array.isArray(r.fragments) &&
                r.fragments.every(
                  (f: any) =>
                    typeof f.start === "number" &&
                    typeof f.end === "number" &&
                    r.text.slice(f.start, f.end) === f.text,
                ),
            )
          : [];
        const merged = [...m.revisions];
        for (const r of revisions)
          if (!merged.some((v) => v.id === r.id))
            merged.push({ ...r, material_id: m.id });
        await put("materials", {
          ...m,
          revisions: merged,
          revision_id: merged.some(
            (r) => r.id === row.revision_id && r.text === m.text,
          )
            ? row.revision_id
            : m.revision_id,
          tags: Array.isArray(row.tags)
            ? row.tags.filter((t: any) => typeof t === "string").slice(0, 100)
            : [],
          status: ["unread", "read", "adopted", "ignored"].includes(row.status)
            ? row.status
            : "unread",
          starred: row.starred === true,
          archived: row.archived === true,
          reading_position:
            typeof row.reading_position === "number"
              ? row.reading_position
              : undefined,
        });
      } else if (name === "providers") {
        const { id, label, protocol, base_url, model, models } = row;
        if (
          typeof label !== "string" ||
          !["chat", "responses", "anthropic"].includes(protocol) ||
          typeof base_url !== "string" ||
          typeof model !== "string"
        )
          throw new Error("备份模型配置格式不兼容。");
        const safeBase = baseUrl(base_url),
          existing = await get<Provider>("providers", id);
        await put("providers", {
          id:
            existing &&
            (existing.base_url !== safeBase || existing.protocol !== protocol)
              ? uid()
              : id,
          label,
          protocol,
          base_url: safeBase,
          model,
          models: Array.isArray(models)
            ? models.filter((m: any) => typeof m === "string")
            : [],
          remember: false,
        });
      } else if (name === "jobs") {
        await setMeta("job-control:" + row.id, "run");
        await put("jobs", {
          ...row,
          status:
            row.status === "running"
              ? row.kind === "process" && row.checkpoint?.inflight
                ? "unknown"
                : "paused"
              : row.status,
        });
      } else if (name === "artifacts") {
        const existing = await get<Artifact>("artifacts", row.id);
        if (existing && existing.body !== row.body) {
          await put("artifacts", {
            ...row,
            id: uid(),
            title: row.title + "（恢复副本）",
            status: "draft",
          });
          continue;
        }
        await put(name, row);
      } else await put(name, row);
    }
  }
  for (const row of Array.isArray(raw.meta) ? raw.meta : [])
    if (["theme", "reader-size", "saved-view"].includes(row.id))
      await setMeta(row.id, row.value);
}
export type LocalEntity =
  | Material
  | Annotation
  | Artifact
  | Dataset
  | Job
  | Provider
  | Attachment;
