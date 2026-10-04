export type CoverageState = "complete" | "partial" | "inaccessible" | "failed";
export interface Coverage {
  body: CoverageState;
  comments: CoverageState;
  attachments: CoverageState;
  reasons: string[];
}
export interface SourceKey {
  platform: "zsxq";
  group_id: string;
  entity_type: "topic" | "answer" | "comment";
  entity_id: string;
}
export interface Fragment {
  id: string;
  text: string;
  start: number;
  end: number;
}
export interface SourceRecord {
  source_key: SourceKey;
  group_id: string;
  author_id: string;
  author_name: string;
  title: string;
  text: string;
  created_at: string;
  source_url: string;
  coverage: Coverage;
  fragments: Fragment[];
  captured_at: string;
  hash?: string;
  version_hash?: string;
  entity_type?: "topic" | "answer" | "comment";
  parent_entity_id?: string;
  images?: { id: string; name?: string; url: string }[];
  files?: { id: string; name: string; size?: number; mime?: string }[];
  parent_source_key?: SourceKey;
  provenance?: Record<string, unknown>;
}
export interface Revision {
  id: string;
  material_id: string;
  hash: string;
  version_hash?: string;
  record?: SourceRecord;
  text: string;
  fragments: Fragment[];
  coverage: Coverage;
  captured_at: string;
  title: string;
}
export interface Material extends SourceRecord {
  id: string;
  revision_id: string;
  revisions: Revision[];
  tags: string[];
  starred: boolean;
  status: "unread" | "read" | "adopted" | "ignored";
  reading_position?: number;
  archived?: boolean;
}
export interface Annotation {
  id: string;
  material_id: string;
  revision_id: string;
  version_hash?: string;
  start: number;
  end: number;
  quote: string;
  note: string;
  created_at: string;
  kind: "note" | "highlight";
}
export interface Citation {
  citation_id: string;
  material_id: string;
  revision_id: string;
  version_hash?: string;
  fragment_id?: string;
  source_key: SourceKey;
  quote: string;
  source_url: string;
}
export interface Artifact {
  id: string;
  title: string;
  body: string;
  citations: Citation[];
  revision: number;
  revisions: { revision: number; title: string; body: string; at: string }[];
  status: "draft" | "adopted";
  stale?: boolean;
  created_at: string;
  updated_at: string;
  dataset_id?: string;
  model_attribution?: {
    requested_model: string;
    response_model?: string;
    generated_at: string;
    protocol: string;
    complete: boolean;
    truncated: boolean;
  };
}
export interface Dataset {
  id: string;
  name: string;
  mode: "manual" | "dynamic";
  material_ids: string[];
  rule?: { q?: string; group_id?: string; author_id?: string; tags?: string[] };
  snapshot?: { material_id: string; revision_id: string }[];
  updated_at: string;
}
export interface Provider {
  id: string;
  label: string;
  protocol: "chat" | "responses" | "anthropic";
  base_url: string;
  model: string;
  models: string[];
  remember: boolean;
  tested_at?: string;
  tested_model?: string;
}
export interface Scope {
  group_id: string;
  author_id?: string;
  from?: string;
  to?: string;
  types: string[];
  max_pages: number;
  max_comments_pages?: number;
  include_comments: boolean;
  include_attachments: boolean;
}
export interface Job {
  id: string;
  kind: "capture" | "process" | "sync";
  title: string;
  status:
    | "queued"
    | "running"
    | "paused"
    | "unknown"
    | "partial"
    | "complete"
    | "failed"
    | "cancelled";
  created_at: string;
  updated_at: string;
  events: { at: string; message: string }[];
  scope?: Scope;
  checkpoint: Record<string, any>;
  reason?: string;
  material_ids?: string[];
  artifact_id?: string;
}
export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  hash: string;
  blob?: Blob;
  source_key?: SourceKey;
  status: "available" | "missing";
}
export interface Bundle {
  schema_version: 1;
  bundle_id: string;
  digest: string;
  exported_at: string;
  producer: { name: string; version: string };
  records: SourceRecord[];
  annotations: Annotation[];
  artifacts: Artifact[];
  attachments: Omit<Attachment, "blob">[];
  coverage: Record<string, unknown>;
}
export interface SyncTarget {
  origin: string;
  workspace_id: string;
  label: string;
  paired_at: string;
}
export interface Recipe {
  id: string;
  label: string;
  description: string;
  structure: string;
}
