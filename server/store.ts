import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { resolve, join } from "node:path";

export type Entity = { id: string; [key: string]: any };
export type RecordScope = { userId?: string; workspaceId?: string };
export type MaterialFilters = {
  q?: string;
  groupId?: string;
  authorId?: string;
  includeArchived?: boolean;
};

/** All helpers are synchronous: transactions must never cross an await boundary. */
export class Store {
  readonly db: DatabaseSync;
  readonly dataDir: string;
  readonly blobDir: string;
  private depth = 0;
  constructor(dataDir: string) {
    this.dataDir = resolve(dataDir);
    this.blobDir = join(this.dataDir, "blobs");
    mkdirSync(this.blobDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(this.dataDir, "workbench.sqlite"));
    // Preserve the previous Unicode-aware search semantics while filtering before material JSON reaches JS.
    this.db.function("xingjian_lower", { deterministic: true }, (value) =>
      typeof value === "string" ? value.toLowerCase() : "",
    );
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      PRAGMA cache_size=-8192;
      CREATE TABLE IF NOT EXISTS records (
        kind TEXT NOT NULL, id TEXT NOT NULL, user_id TEXT, workspace_id TEXT,
        json TEXT NOT NULL CHECK(json_valid(json)),
        PRIMARY KEY(kind,id)
      );
      CREATE INDEX IF NOT EXISTS records_user ON records(kind,user_id);
      CREATE INDEX IF NOT EXISTS records_workspace ON records(kind,workspace_id);
      CREATE UNIQUE INDEX IF NOT EXISTS users_email ON records(json_extract(json,'$.email')) WHERE kind='user';
      CREATE UNIQUE INDEX IF NOT EXISTS materials_source ON records(workspace_id,json_extract(json,'$.source_identity')) WHERE kind='material';
      CREATE INDEX IF NOT EXISTS material_comments ON records(workspace_id,json_extract(json,'$.group_id'),json_extract(json,'$.parent_entity_id')) WHERE kind='material' AND json_extract(json,'$.entity_type')='comment' AND json_extract(json,'$.archived_at') IS NULL;
      CREATE INDEX IF NOT EXISTS job_queue ON records(json_extract(json,'$.state'),json_extract(json,'$.approved')) WHERE kind='job';
    `);
  }

  put<T extends Entity>(
    kind: string,
    entity: T,
    userId?: string | null,
    workspaceId?: string | null,
  ): T {
    if (!kind || !entity || typeof entity.id !== "string" || !entity.id)
      throw new TypeError("record requires kind and nonempty string id");
    const old = this.db
      .prepare("SELECT user_id,workspace_id FROM records WHERE kind=? AND id=?")
      .get(kind, entity.id) as
      | { user_id: string | null; workspace_id: string | null }
      | undefined;
    // Omitted scope preserves ownership during updates; scope is never inferred from untrusted JSON.
    this.db
      .prepare(
        `INSERT INTO records(kind,id,user_id,workspace_id,json) VALUES(?,?,?,?,?)
      ON CONFLICT(kind,id) DO UPDATE SET user_id=excluded.user_id, workspace_id=excluded.workspace_id, json=excluded.json`,
      )
      .run(
        kind,
        entity.id,
        userId === undefined ? (old?.user_id ?? null) : userId,
        workspaceId === undefined ? (old?.workspace_id ?? null) : workspaceId,
        JSON.stringify(entity),
      );
    return entity;
  }

  get<T = any>(kind: string, id: string): T | undefined {
    const row = this.db
      .prepare("SELECT json FROM records WHERE kind=? AND id=?")
      .get(kind, id) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as T) : undefined;
  }

  /** Uses the workspace/source unique index; never parses the whole material corpus to resolve identity. */
  findMaterialBySource<T = any>(
    workspaceId: string,
    sourceIdentity: string,
  ): T | undefined {
    const row = this.db
      .prepare(
        "SELECT json FROM records WHERE kind='material' AND workspace_id=? AND json_extract(json,'$.source_identity')=?",
      )
      .get(workspaceId, sourceIdentity) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as T) : undefined;
  }

  materialSummaries(
    workspaceId: string,
    filters: MaterialFilters = {},
  ): Entity[] {
    const where = ["kind='material'", "workspace_id=?"];
    if (!filters.includeArchived)
      where.push("json_extract(json,'$.archived_at') IS NULL");
    const args: string[] = [workspaceId];
    if (filters.groupId) {
      where.push("json_extract(json,'$.group_id')=?");
      args.push(filters.groupId);
    }
    if (filters.authorId) {
      where.push("json_extract(json,'$.author_id')=?");
      args.push(filters.authorId);
    }
    if (filters.q) {
      // % and _ were literal under String.includes; never turn a user's query into implicit wildcards.
      const literal = filters.q
        .toLowerCase()
        .replace(/[\\%_]/g, (c) => `\\${c}`);
      where.push(
        "xingjian_lower(coalesce(json_extract(json,'$.title'),'') || char(10) || coalesce(json_extract(json,'$.text'),'') || char(10) || coalesce(json_extract(json,'$.author_name'),'')) LIKE ? ESCAPE '\\'",
      );
      args.push(`%${literal}%`);
    }
    const rows = this.db
      .prepare(
        `SELECT json_remove(json,'$.revisions','$.text') AS summary_json,
      substr(coalesce(json_extract(json,'$.text'),''),1,600) AS snippet,
      length(coalesce(json_extract(json,'$.text'),'')) AS full_text_length,
      coalesce(json_array_length(json,'$.revisions'),0) AS revision_count
      FROM records WHERE ${where.join(" AND ")} ORDER BY rowid`,
      )
      .all(...args) as {
      summary_json: string;
      snippet: string;
      full_text_length: number;
      revision_count: number;
    }[];
    return rows.map((row) => ({
      ...JSON.parse(row.summary_json),
      text: row.snippet,
      snippet: row.snippet,
      full_text_length: row.full_text_length,
      revision_count: row.revision_count,
      projection: "summary",
    }));
  }

  /** Returns only real flat comments attached to this group/topic; unrelated histories never enter JS. */
  materialComments(
    workspaceId: string,
    groupId: string,
    parentEntityId: string,
  ): Entity[] {
    const rows = this.db
      .prepare(
        `SELECT json FROM records WHERE kind='material' AND workspace_id=?
      AND json_extract(json,'$.entity_type')='comment' AND json_extract(json,'$.archived_at') IS NULL
      AND json_extract(json,'$.group_id')=? AND json_extract(json,'$.parent_entity_id')=? ORDER BY rowid`,
      )
      .all(workspaceId, groupId, parentEntityId) as { json: string }[];
    return rows.map((row) => JSON.parse(row.json));
  }

  list<T = any>(kind: string, scope: RecordScope = {}): T[] {
    const where = ["kind=?"];
    const args: string[] = [kind];
    if (scope.userId !== undefined) {
      where.push("user_id=?");
      args.push(scope.userId);
    }
    if (scope.workspaceId !== undefined) {
      where.push("workspace_id=?");
      args.push(scope.workspaceId);
    }
    return (
      this.db
        .prepare(
          `SELECT json FROM records WHERE ${where.join(" AND ")} ORDER BY rowid`,
        )
        .all(...args) as { json: string }[]
    ).map((row) => JSON.parse(row.json) as T);
  }

  /** The serial worker only deserializes its next approved job, not historical inputs. */
  nextQueuedJob<T = any>(): T | undefined {
    const row = this.db
      .prepare(
        "SELECT json FROM records WHERE kind='job' AND json_extract(json,'$.state')='queued' AND json_extract(json,'$.approved')=1 ORDER BY rowid LIMIT 1",
      )
      .get() as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as T) : undefined;
  }

  recoverableJobs<T = any>(): T[] {
    return (
      this.db
        .prepare(
          "SELECT json FROM records WHERE kind='job' AND json_extract(json,'$.state') IN ('queued','running') ORDER BY rowid",
        )
        .all() as { json: string }[]
    ).map((row) => JSON.parse(row.json) as T);
  }

  /** List views have no frozen source bodies, paid output, or growing event/checkpoint arrays. */
  jobSummaries(workspaceId: string): Entity[] {
    return (
      this.db
        .prepare(
          `SELECT json_object(
      'id',id,'workspace_id',workspace_id,'user_id',user_id,
      'kind',json_extract(json,'$.kind'),'state',json_extract(json,'$.state'),
      'created_at',json_extract(json,'$.created_at'),'updated_at',json_extract(json,'$.updated_at'),
      'processed',json_extract(json,'$.processed'),'artifact_ids',json_extract(json,'$.artifact_ids'),
      'projection','summary') AS summary_json
      FROM records WHERE kind='job' AND workspace_id=? ORDER BY rowid`,
        )
        .all(workspaceId) as { summary_json: string }[]
    ).map((row) => JSON.parse(row.summary_json));
  }

  connectionBusy(userId: string, connectionId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM records WHERE kind='job' AND user_id=?
      AND json_extract(json,'$.state')='running'
      AND (json_extract(json,'$.connection_id')=? OR json_extract(json,'$.actual_connection_id')=?) LIMIT 1`,
        )
        .get(userId, connectionId, connectionId),
    );
  }

  remove(kind: string, id: string): void {
    this.db.prepare("DELETE FROM records WHERE kind=? AND id=?").run(kind, id);
  }

  transaction<T>(fn: () => T): T {
    if (fn.constructor.name === "AsyncFunction")
      throw new TypeError("Store.transaction requires a synchronous callback");
    const name = `nested_${this.depth}`;
    const nested = this.depth > 0;
    this.db.exec(nested ? `SAVEPOINT ${name}` : "BEGIN IMMEDIATE");
    this.depth++;
    try {
      const result = fn();
      if (result && typeof (result as any).then === "function")
        throw new TypeError(
          "Store.transaction requires a synchronous callback",
        );
      this.db.exec(nested ? `RELEASE SAVEPOINT ${name}` : "COMMIT");
      return result;
    } catch (error) {
      this.db.exec(
        nested
          ? `ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name}`
          : "ROLLBACK",
      );
      throw error;
    } finally {
      this.depth--;
    }
  }
  close(): void {
    this.db.close();
  }
}

export function createStore(dataDir: string): Store {
  return new Store(dataDir);
}
