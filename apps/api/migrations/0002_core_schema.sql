-- Core schema, per docs/design/05-technical-architecture.md PART 11.1.
-- Forward-only. Never edit after this has been applied to a shared environment.
--
-- Timestamps are unix milliseconds (INTEGER), not TEXT: they sort correctly,
-- compare cheaply, and avoid timezone ambiguity entirely.

-- Organizations: billing root, tenant boundary.
CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free',
  stripe_customer_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  email_verified_at INTEGER,
  oauth_github_id TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE memberships (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(org_id, user_id)
);
CREATE INDEX idx_memberships_user ON memberships(user_id);

-- Workspaces: primary container; quota and plan attach here.
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  plan_override TEXT,
  storage_bytes_used INTEGER NOT NULL DEFAULT 0,
  file_count INTEGER NOT NULL DEFAULT 0,
  egress_bytes_period INTEGER NOT NULL DEFAULT 0,
  requests_period INTEGER NOT NULL DEFAULT 0,
  period_reset_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_workspaces_org ON workspaces(org_id);

-- Agents: identities distinct from human users.
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  last_seen_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(workspace_id, name)
);
CREATE INDEX idx_agents_workspace ON agents(workspace_id);

-- API keys: the raw secret is never stored, only SHA-256 of it.
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  agent_id TEXT REFERENCES agents(id),
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_last_four TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  parent_key_id TEXT REFERENCES api_keys(id),
  expires_at INTEGER,
  last_used_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_keys_workspace ON api_keys(workspace_id);
CREATE INDEX idx_keys_hash ON api_keys(key_hash);

-- Folders: first-class entities, with a materialized path for cheap listing.
CREATE TABLE folders (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  parent_folder_id TEXT REFERENCES folders(id),
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(workspace_id, path)
);
CREATE INDEX idx_folders_workspace_path ON folders(workspace_id, path);
CREATE INDEX idx_folders_parent ON folders(parent_folder_id);

-- Files: the core object. Metadata is inline; only tags are separate (11.2).
-- r2_object_key is deliberately decoupled from id (11.3) so a future version
-- history can repoint "current" without changing any client-visible file ID.
CREATE TABLE files (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  folder_id TEXT REFERENCES folders(id),
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  r2_object_key TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  mime_type TEXT NOT NULL,
  checksum_sha256 TEXT,
  caption TEXT,
  custom_metadata TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX idx_files_workspace_path ON files(workspace_id, path);
CREATE INDEX idx_files_folder ON files(folder_id);
CREATE INDEX idx_files_workspace_status ON files(workspace_id, status);
CREATE INDEX idx_files_name ON files(workspace_id, name);

CREATE TABLE file_tags (
  file_id TEXT NOT NULL REFERENCES files(id),
  tag TEXT NOT NULL,
  PRIMARY KEY (file_id, tag)
);
CREATE INDEX idx_file_tags_tag ON file_tags(tag);

-- Audit events: append-only. ULIDs sort chronologically, so no separate
-- ordering column is needed.
CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  result TEXT NOT NULL,
  ip TEXT,
  client TEXT,
  request_id TEXT,
  metadata TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_audit_workspace_time ON audit_events(workspace_id, created_at);
CREATE INDEX idx_audit_actor ON audit_events(actor_type, actor_id);

-- Webhooks (MVP-1). secret is stored encrypted at rest (06 PART 16.16a).
CREATE TABLE webhooks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_webhooks_workspace ON webhooks(workspace_id);
