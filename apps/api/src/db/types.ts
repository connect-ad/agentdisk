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
  /**
   * The token, sealed under DATABASE_ENCRYPTION_KEY (lib/secretbox.ts), so
   * the owner can view it again. Null means never kept: minted before
   * migration 0022, or while the secret was unset. Never on the request
   * path - authentication is by key_hash alone.
   */
  key_ciphertext: string | null;
  scopes: string;
  created_by_user_id: string;
  parent_key_id: string | null;
  expires_at: number | null;
  last_used_at: number | null;
  /**
   * The customer's own switch (migration 0024). NULL is enabled. Enabling
   * again rotates the secret, so the token that was live when this was set
   * never authenticates again.
   */
  disabled_at: number | null;
  /**
   * Which switch turned it off: "key" for the customer's own, "agent" for the
   * cascade from its agent, NULL when on. Stored rather than derived because
   * once the agent is active again nothing else would say which keys should
   * come back with it (migration 0025).
   */
  disabled_reason: "key" | "agent" | null;
  /**
   * The admin console's permanent kill switch, and nothing the customer can
   * set or clear. Distinct from `disabled_at` because an operator revoke must
   * not be something the customer can simply switch back on.
   */
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
  storage_bytes_used: number;
  file_count: number;
  egress_bytes_period: number;
  requests_period: number;
  period_reset_at: number;
  /**
   * When a real person took ownership. NULL means this is still an unclaimed
   * sandbox - which decides both its limits (lib/plans.ts) and whether the
   * unclaimed sweep may delete it (jobs/sandbox-expiry.ts).
   */
  claimed_at: number | null;
  /**
   * SHA-256 of the claim link's token, never the token. NULL for every
   * workspace created before claiming existed, and for every one created by a
   * signed-in person - who needs no link to reach what they already own.
   */
  claim_token_hash: string | null;
  claim_token_expires_at: number | null;
  created_at: number;
  updated_at: number;
}

/**
 * The billing account's usage totals, joined onto a workspace row.
 *
 * Storage and files are the *subscription's* allowance: one card, one plan,
 * many workspaces. Counting them per workspace meant an account on Pro with
 * five workspaces held five times the Pro allowance, and that pressing "New
 * workspace" — which is free — was the way to get more room. Migration 0017
 * moved the counters up to `organizations`.
 *
 * Separate names rather than shadowing `storage_bytes_used`, because both
 * numbers are real and both are shown: the account total is what the quota is
 * decided against, the workspace total is what a person looking at one
 * workspace wants to see.
 *
 * Declared as its own interface so it can be *required* by the quota check.
 * `assertWithinQuota` takes `WorkspaceRow & AccountUsage`, which means a
 * caller holding only a workspace row cannot call it at all — the same trick
 * `transferObject` uses, where the signature is the safety property rather
 * than a rule somebody has to remember.
 */
export interface AccountUsage {
  org_storage_bytes_used: number;
  org_file_count: number;
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
  /**
   * When a delivery last succeeded. NULL means none ever has - which is what
   * the dashboard renders as "Never". Only a success writes it; see the
   * migration.
   */
  last_delivery_at: number | null;
}
