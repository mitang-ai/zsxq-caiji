export interface User {
  id: string;
  email: string;
  name: string;
}
export interface Workspace {
  id: string;
  name: string;
  role?: string;
  type?: string;
  kind?: string;
}
export interface Session {
  user: User;
  workspaces: Workspace[];
  csrf: string;
}
export interface Coverage {
  body?: string;
  comments?: string;
  attachments?: string;
  reasons?: string[];
}
export interface Revision {
  id: string;
  text?: string;
  body?: string;
  title?: string;
  hash?: string;
  captured_at?: string;
  created_at?: string;
  citations?: Citation[];
  fragments?: Fragment[];
  coverage?: Coverage;
  images?: ImageMeta[];
  files?: FileMeta[];
  record_meta?: {
    title?: string;
    author_name?: string;
    created_at?: string;
    group_id?: string;
    source_url?: string;
  };
}
export interface Fragment {
  id: string;
  text: string;
  start: number;
  end: number;
}
export interface ImageMeta {
  id: string;
  name?: string;
  url?: string;
}
export interface FileMeta {
  id: string;
  name: string;
  size?: number;
  mime?: string;
}
export interface Material {
  id: string;
  title: string;
  text: string;
  snippet?: string;
  full_text_length?: number;
  group_id: string;
  author_id?: string;
  author_name?: string;
  entity_type?: string;
  created_at?: string;
  captured_at?: string;
  source_url?: string;
  source_key?: unknown;
  status?: string;
  starred?: boolean;
  tags?: string[];
  revision_id: string;
  revisions?: Revision[];
  coverage?: Coverage;
  reading_position?: number | { offset?: number; revision_id?: string };
  attachments?: Attachment[];
  images?: ImageMeta[];
  files?: FileMeta[];
  comments?: unknown[];
}
export interface Attachment {
  id: string;
  name?: string;
  filename?: string;
  mime?: string;
  size?: number;
  hash?: string;
  status?: string;
  parse_state?: string;
  extracted_text?: string;
  parse_reason?: string;
}
export interface Annotation {
  id: string;
  material_id: string;
  revision_id: string;
  start: number;
  end: number;
  quote: string;
  note: string;
  created_at?: string;
}
export interface Dataset {
  id: string;
  name: string;
  mode: string;
  material_ids?: string[];
  rule?: { q?: string; group_id?: string; author_id?: string; tags?: string[] };
  snapshot?: { material_id: string; revision_id: string }[];
  snapshots?: unknown[];
  created_at?: string;
  frozen_at?: string;
  count?: number;
  materials?: Material[];
}
export interface Citation {
  material_id: string;
  revision_id: string;
  quote?: string;
  start?: number;
  end?: number;
}
export interface Artifact {
  id: string;
  title: string;
  body: string;
  citations: Citation[];
  dataset_id?: string;
  revision_id?: string;
  current_revision?: string;
  revision?: string | number;
  revisions?: Revision[];
  status?: string;
  stale?: boolean;
  created_at?: string;
  updated_at?: string;
}
export interface Proposal {
  id: string;
  artifact_id: string;
  base_revision: string;
  base_revision_number?: number;
  base_title?: string;
  base_body?: string;
  base_citations?: Citation[];
  title: string;
  body: string;
  citations: Citation[];
  job_id?: string;
  draft_artifact_id?: string;
  created_at?: string;
  status?: string;
  conflict?: boolean;
  rejected_at?: string;
  adopted_at?: string;
}
export interface Connection {
  id: string;
  label: string;
  channel: string;
  policy?: string;
  status?: string;
  state?: string;
  user_name?: string;
  account_name?: string;
  source_user_id?: string;
  verified_user_id?: string;
  source_account_id?: string;
  source_account_name?: string;
  capabilities?: unknown;
  error?: string;
  last_verified_at?: string;
}
export interface SourceGroup {
  id?: string;
  group_id?: string;
  name?: string;
  title?: string;
}
export interface SourceMember {
  id?: string;
  user_id?: string;
  name?: string;
  nickname?: string;
  user?: { id?: string; user_id?: string; name?: string };
  role?: string;
}
export interface Provider {
  id: string;
  label: string;
  protocol: string;
  base_url: string;
  model?: string;
  models?: (string | { id?: string; name?: string })[];
  status?: string;
  tested_at?: string;
  has_key?: boolean;
}
export interface Preset {
  id: string;
  label: string;
  description: string;
  output_schema: unknown;
}
export interface Recipe {
  id: string;
  name: string;
  preset_id: string;
  goal: string;
  provider_id: string;
  model: string;
  max_output_tokens: number;
  input_limit: number;
  max_calls: number;
  approval: string;
  material_ids?: string[];
  dataset_id?: string;
}
export interface JobEvent {
  id?: string;
  type?: string;
  kind?: string;
  message?: string;
  text?: string;
  at?: string;
  created_at?: string;
  data?: unknown;
  details?: unknown;
}
export interface Job {
  id: string;
  kind: string;
  status?: string;
  state?: string;
  connection_id?: string;
  recipe_id?: string;
  material_ids?: string[];
  scope?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
  events?: JobEvent[];
  checkpoint?: Record<string, unknown>;
  progress?: Record<string, unknown>;
  error?: string | { message?: string };
  artifact_id?: string;
  artifact_ids?: string[];
  plan?: unknown;
  result?: unknown;
  recipe?: Recipe;
  provider?: Provider;
}
export interface Device {
  id: string;
  label: string;
  workspace_id?: string;
  created_at?: string;
  last_seen_at?: string;
  revoked_at?: string;
}
export interface ToolToken {
  id: string;
  label: string;
  scopes?: string[];
  created_at?: string;
  expires_at?: string;
  token?: string;
  url?: string;
  revoked_at?: string;
}
export interface TeamMember {
  id?: string;
  user_id?: string;
  name?: string;
  email?: string;
  role: string;
  user?: User;
}
export interface Invite {
  id: string;
  email?: string;
  role?: string;
  token?: string;
  url?: string;
  expires_at?: string;
  status?: string;
}
export type { TransferBundle } from "../../shared/transfer";
