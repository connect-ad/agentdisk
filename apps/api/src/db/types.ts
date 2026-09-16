/** Row shapes as stored in D1. Timestamps are unix milliseconds. */

export interface FileRow {
  id: string;
  workspace_id: string;
  folder_id: string | null;
  name: string;
  path: string;
  r2_object_key: string;
  size_bytes: number;
  mime_type: string;
  checksum_sha256: string | null;
  caption: string | null;
  custom_metadata: string | null;
  status: "pending" | "active" | "failed" | "deleted";
  created_by: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface FolderRow {
  id: string;
  workspace_id: string;
  parent_folder_id: string | null;
  name: string;
  path: string;
  created_by: string;
  created_at: number;
}

export interface AgentRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  status: "active" | "disabled";
  created_by_user_id: string;
  last_seen_at: number | null;
  created_at: number;
}

export interface ApiKeyRow {
  id: string;
  workspace_id: string;
  agent_id: string | null;
  name: string;
  key_prefix: string;
  key_last_four: string;
  key_hash: string;
  scopes: string;
  created_by_user_id: string;
  parent_key_id: string | null;
  expires_at: number | null;
  last_used_at: number | null;
  revoked_at: number | null;
  created_at: number;
}

export interface AuditEventRow {
  id: string;
  workspace_id: string;
  actor_type: "user" | "agent" | "system";
  actor_id: string;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  result: "success" | "denied" | "error";
  ip: string | null;
  client: string | null;
  request_id: string | null;
  metadata: string | null;
  created_at: number;
}

export interface WorkspaceRow {
  id: string;
  org_id: string;
  name: string;
  /**
   * The dashboard URL segment. Nullable only because the column was added to
   * an existing table; every row has one and every insert writes one.
   */
  slug: string | null;
  status: "active" | "suspended" | "deleted";
  plan_override: string | null;
  storage_bytes_used: number;
  file_count: number;
  egress_bytes_period: number;
  requests_period: number;
  period_reset_at: number;
  created_at: number;
  updated_at: number;
}

/** A customer's own webhook endpoint (05 PART 11.1). */
export interface WebhookRow {
  id: string;
  workspace_id: string;
  url: string;
  /** The signing secret. Never leaves the repository layer in a response. */
  secret: string;
  /** JSON array of event names. */
  events: string;
  status: string;
  created_at: number;
}
