# AgentDisk — Technical Architecture, Database, R2 Storage, REST API, MCP API
### PART 10–14 of the AgentStorage-Inspired Platform Design

All content is **PROPOSAL** unless marked otherwise.

---

## PART 10 — Technical Architecture

### 10.1 Component Overview

| Component | Role | Why this and not an alternative |
|---|---|---|
| **Cloudflare Workers** | Control plane: auth, authorization, quota checks, metadata CRUD, presigned-URL issuance, MCP server, webhook dispatch | Scale-to-zero, ~0ms cold start, request-based billing — no idle cost. Never proxies file bytes for large files (10.4). |
| **Cloudflare R2** | Object storage for file bytes | S3-compatible, **zero egress fees** (the single biggest structural cost advantage over AWS S3 for a storage-heavy product — see PART 19), pairs natively with Workers via bindings (no network hop, no signed-URL-generation latency for server-side access). |
| **Cloudflare D1** | Relational metadata: orgs, workspaces, agents, keys, folders, files, audit events | SQLite-based, serverless, zero idle cost, sufficient relational/transactional needs for MVP-0/1 scale (see 10.3 for the full comparison). |
| **Cloudflare KV** | Hot-path cache: API-key-hash → scope lookup, rate-limit counters (short-TTL), workspace quota snapshots | Sub-10ms global reads, eventually consistent (acceptable for a cache in front of D1, not for the source of truth). |
| **Cloudflare Queues** | Async work: webhook delivery, transform/AI-processing jobs, usage-counter reconciliation | Decouples slow/best-effort work from the request path — nothing a user is waiting on ever blocks on a queue consumer. |
| **Durable Objects** | Used **narrowly**: per-workspace rate-limit/quota coordination where KV's eventual consistency isn't tight enough (see 10.6), and optionally a per-MCP-session object for stateful tool-call sequences | Deliberately minimal — the brief's instruction to use DOs "only when genuinely required" is followed literally; most of the product needs no DO at all. |
| **Cloudflare Access** | Not used for the product itself (customer auth is application-level, PART 15) — reserved for protecting internal/staff tooling (an admin panel, if built) | Keeps customer auth flexible (email/password + OAuth) rather than forcing Cloudflare's own identity model on end users. |
| **Cloudflare Turnstile** | Bot/abuse mitigation on signup and the no-auth-required workspace-creation endpoint (mirroring AgentStorage's own need to rate-limit that exact endpoint) | Free, no user-facing puzzle-solving in most cases, directly addresses the automated-signup-abuse risk of a public, unauthenticated creation endpoint. |

### 10.2 Architecture Diagram

```
                              ┌─────────────────────────────┐
                              │        Cloudflare CDN        │
                              │   (dashboard static assets)  │
                              └──────────────┬───────────────┘
                                             │
      Human (browser) ──────────────────────┤
                                             │
      AI Agent (REST) ─────────────┐        │
                                    │        │
      AI Agent (MCP client) ───┐   │        │
                                │   │        │
                                ▼   ▼        ▼
                       ┌────────────────────────────┐
                       │   Cloudflare Workers (API)   │
                       │  ── control plane, stateless ── │
                       │  AuthN → AuthZ → Quota check │
                       │  → business logic → response │
                       └───┬───────┬────────┬────────┬─┘
                           │       │        │        │
                 ┌─────────┘   ┌───┘    ┌───┘    ┌───┘
                 ▼             ▼        ▼        ▼
             ┌───────┐   ┌──────────┐ ┌────┐ ┌─────────┐
             │  D1   │   │    R2    │ │ KV │ │ Queues  │
             │(meta) │   │ (bytes)  │ │(cache,│ │(async  │
             │       │   │          │ │rate) │ │ jobs)  │
             └───────┘   └────┬─────┘ └────┘ └────┬────┘
                               │                    │
                     direct browser/agent            ▼
                     upload & download via     ┌─────────────┐
                     presigned URLs (bypasses   │Queue consumer│
                     the Worker for bytes)      │ Worker: async │
                                                 │ transforms,   │
                                                 │ webhooks,     │
                                                 │ AI processing │
                                                 └──────┬───────┘
                                                        ▼
                                                 writes back to D1
                                                 (job status, derived
                                                  metadata)
```

Agent-specific flow (REST or MCP — both terminate in the same authorization core):

```
AI Agent
  │  Authorization: Bearer ask_live_...
  ▼
Workers: verify key hash (KV cache → D1 fallback) → resolve scope
  → check workspace quota (KV counter, reconciled from D1)
  → check path-prefix + operation allow-list
  ▼
Allowed → business logic (D1 read/write, R2 presigned URL, or direct
          small-object R2 read/write via binding)
  ▼
Audit event appended (D1 insert, fire-and-forget via waitUntil)
  ▼
Structured JSON response
```

### 10.3 Database Decision: D1 vs. Postgres-family Options

| | **Cloudflare D1** | Neon (serverless Postgres) | Supabase (Postgres) | PlanetScale/other serverless SQL |
|---|---|---|---|---|
| Cost at MVP scale | $0 (free tier: 5GB, 25M reads/day) | $0 free tier, but a separate billed service | $0 free tier, separate billed service | Similar — separate service |
| Cold start | None (colocated with Workers, no network hop for reads) | Network round-trip from Worker to Neon's endpoint (typically 10s of ms, more from some Worker regions) | Same network-hop cost as Neon | Same class of cost |
| Relational capability | Full SQL (SQLite dialect), foreign keys, indexes, joins — sufficient for this schema's scale | Full Postgres — richer (window functions, extensions, `pgvector`) | Same as Neon plus built-in auth/storage/realtime (unused here — would be redundant with our own auth/R2) | Varies |
| Transactions | Single-statement and batched transactions within one D1 database; **no cross-database distributed transactions** | Full ACID Postgres transactions | Same | Varies |
| Vendor lock-in | Cloudflare-specific SQL dialect (SQLite), but schema/data is portable via standard export | Standard Postgres — most portable option | Standard Postgres + Supabase-specific extras | Varies |
| Cloudflare integration | Native binding, zero extra network hop, zero extra vendor relationship | External HTTP call from Worker egress (adds latency + a second bill + a second incident surface) | Same | Same |
| Operational complexity | One dashboard, one bill, migrations via Wrangler | Two dashboards, two bills, two things that can be down | Same | Same |
| Vector search | Not built in — pair with Cloudflare Vectorize if/when needed | `pgvector` extension available | `pgvector` available | Varies |

**Recommendation: D1.** Per the brief's explicit instruction ("if D1 is sufficient for MVP, prefer D1; do not introduce Postgres simply because it is familiar"), and because this product's actual relational needs (orgs/workspaces/agents/keys/folders/files/audit — a handful of tables with straightforward foreign keys, no complex analytical joins, no need for `pgvector` in MVP-0/1) are squarely within D1's capability envelope, while a Postgres option would add a second vendor relationship, a network hop on every metadata operation, and a second bill — for zero functional gain at this stage. **Migration path if D1 is ever outgrown:** the schema (PART 11) is written in portable, mostly-standard SQL avoiding SQLite-only tricks where a Postgres equivalent exists, specifically so a future move to Postgres (via Neon/Hyperdrive, if D1's single-writer-per-database ceiling or storage size ever becomes limiting at extreme scale) is a data migration, not a rewrite. This is flagged explicitly as ADR-003 (PART 10 of the roadmap document).

### 10.4 Serverless Data Flows

**Upload (human, browser):**
```
Browser → Worker: POST /v1/files (metadata: path, size, mimeType, checksum optional)
Worker: authN (session cookie) → authZ (workspace membership) → quota check
       → creates a "pending" file row in D1 → generates a presigned R2 PUT URL
       → returns {fileId, uploadUrl, uploadHeaders}
Browser → R2: PUT {uploadUrl} with file bytes directly (Worker is not in this path)
Browser → Worker: POST /v1/files/:id/complete {actualSize, checksum}
Worker: verifies actualSize against declared size (within quota tolerance),
        verifies checksum if provided, flips file row to "active",
        increments workspace usage counters (KV fast path + D1 durable write),
        appends audit event (non-blocking)
Worker → Browser: 200 {file object}
```
**Why not proxy through the Worker:** Workers have request/response size and CPU-time limits, and proxying bytes doubles egress (ingress to Worker, then Worker to R2) for no benefit — R2 accepts presigned PUTs directly, so the Worker's job is authorization and bookkeeping only, exactly as the brief requires (§7, §16).

**Upload (agent, large file, multipart):** identical shape, but `POST /v1/files` for files above a size threshold (default 100MB) returns R2 multipart-upload part URLs instead of one PUT URL; the agent PUTs each part directly to R2, then calls `POST /v1/files/:id/complete` with the part ETags, which the Worker forwards to R2's `CompleteMultipartUpload`.

**Upload (agent, small file, inline):** for files ≤ 1MB, `POST /v1/files` accepts the bytes as base64 directly in the same request the metadata is created with (mirroring AgentStorage's own inline-upload convenience for small payloads, which is a sound UX shortcut worth keeping) — the Worker writes to R2 via its binding (no presigned URL round-trip needed) and returns the finished object in one call.

**Download (browser or agent):** `GET /v1/files/:id/download` → Worker authZ+quota-adjacent egress accounting → returns a short-lived (default 1 hour, max 7 days) presigned R2 GET URL (or a permanent-but-revocable signed URL if explicitly requested and the plan allows it) → client fetches bytes directly from R2, never through the Worker.

**File listing:** `GET /v1/files?folder=&cursor=` → Worker authZ (path-prefix scope filter applied as a SQL `WHERE path LIKE ? || '%'` clause, never post-filtered in application code, to avoid ever returning a row outside scope) → D1 query with cursor pagination → JSON response. No R2 call at all — listing is metadata-only.

**Deletion:** `DELETE /v1/files/:id` → Worker authZ → D1 row marked `deleted_at` (soft delete, see 10.7 for why) → R2 object deletion enqueued via Queues (not synchronous — see Failure Modes, PART 23) → audit event appended.

**Search:** `GET /v1/search?q=&tag=` → Worker authZ → D1 query against indexed `name`, `path`, `caption`, and a `tags` join table, scope-filtered identically to listing → JSON response. No embeddings call, no external service — see 10.8.

**API key creation:** `POST /v1/keys` → Worker authZ (must be workspace admin/owner, or an agent-identity-scoped self-service path if the calling key is allowed to mint sub-keys with ≤ its own scope) → generates a cryptographically random secret (PART 16.3) → stores only its hash in D1 → returns the plaintext secret exactly once in the response body → audit event appended.

**MCP request:** see PART 14 in full; at a glance — `POST /mcp` (JSON-RPC per the MCP spec) → Worker resolves the bearer key exactly as REST does (shared authorization core) → dispatches to the named tool handler → the handler calls the *same* internal service functions the REST handlers call (list/get/create/update/delete file, create folder, search) → returns an MCP-shaped JSON-RPC response.

### 10.5 Search — Level Selection

| Level | What it is | MVP status | Why |
|---|---|---|---|
| 1. Filename/path search | Substring/prefix match on `name`/`path` | **MVP-0** | Cheap (a single D1 indexed `LIKE`), immediately useful, and directly fixes a documented AgentStorage gap (search excluded filename/path entirely — PART 2.4). Cheap enough relative to the folder/file CRUD already required for MVP-0 (PART 6.2) that holding it back to MVP-1 would be artificial. |
| 2. Metadata search | Filter/match on caption, tags, custom key-value | **MVP-1** | Same low cost profile as level 1, but needs the tag-editing UI surface (PART 8.10's chip input) as well as the `file_tags` join table — that UI-side dependency, not cost or complexity, is what pushes it one milestone later than plain filename search. |
| 3. Full-text content search | Index file *contents* (text/markdown/PDF-extracted text) | **V2** | Requires an extraction pipeline (10.6/PART 20 async processing) before there's any text to index; not needed to validate MVP-1's core loop. |
| 4. Semantic/vector search | Embedding-based similarity search | **V2, conditional on evidence** | See 10.5.1 — deliberately not a default, unlike much of the competitive set (PART 3), because of real, demonstrated cost risk. |

**10.5.1 — Why semantic search is not a default.** PART 3's research found semantic/RAG-shaped storage products charging 5–130x raw storage economics (Pinecone Assistant ~$3/GB/month storage plus per-unit ingestion and retrieval fees; Chroma Cloud $2.50 per logical GiB *written*). Embeddings also require either an external AI provider call (cost + latency + a new sub-processor to disclose, PART 17) or Cloudflare Workers AI (cost per neuron, plus quality tradeoffs vs. frontier embedding models). Building this into MVP-1 by default would violate the brief's core cost constraint before there's evidence customers need it over simple metadata/tag search. **If/when it's built (V2):** Cloudflare Vectorize is the correct choice over an external vector DB or a D1-based approximation — native Workers binding (no egress, no second vendor), usage-based pricing with a real free tier (30M queried dimensions / 5M stored dimensions monthly, per PART 3 research), and it composes with the existing R2/D1 model without introducing Postgres/pgvector as the brief warns against defaulting to.

### 10.6 Optional AI Document Processing (V2, Async by Design)

```
R2 upload finalized (file marked "active" in D1)
   ↓
Worker enqueues a job to Cloudflare Queues: {fileId, workspaceId, mimeType}
   ↓ (never blocks the upload response — the user/agent already got 200 OK)
Queue consumer Worker picks up the job
   ↓
Extract text (PDF/docx/plain-text parsing; images skip to OCR if enabled)
   ↓
[Optional, plan-gated] OCR (Workers AI or an external provider) for image/scanned content
   ↓
[Optional, plan-gated] Summarize / classify / auto-tag via an LLM call
   ↓
[Optional, V2+] Generate embeddings → write to Vectorize
   ↓
Write extracted text / tags / summary back to D1 as file metadata
   ↓
Fire a "file.processed" webhook if the workspace has one registered
```
This is explicitly opt-in per workspace/plan (not run by default on every upload, which would be a hidden, unpredictable cost driver directly contradicting PART 17/19's cost-transparency requirements) and never blocks the synchronous upload path.

### 10.7 Why Soft Delete, Not Hard Delete, at the D1 Layer

**PROPOSAL.** File rows are soft-deleted (`deleted_at` timestamp set, row retained) with actual R2 byte deletion happening asynchronously via a Queue after a short grace period (default 24 hours), for three reasons: (1) it gives a cheap "oops" recovery window without building a full trash/restore UI in MVP-0, (2) it decouples the fast, synchronous "delete" API response from the R2 delete call's own latency/failure modes, and (3) it avoids the exact "metadata says gone, but the R2 object still exists" or vice versa inconsistency class discussed in PART 23 — a background reconciliation job (10.8) can always find and finish incomplete deletes.

### 10.8 Reconciliation

A scheduled Worker (Cron Trigger, e.g. hourly) reconciles: (a) file rows soft-deleted past the grace period whose R2 objects haven't yet been purged (retries the R2 delete), (b) file rows stuck in "pending" past a timeout (upload never completed — mark as `failed`, release any reserved quota), and (c) usage-counter drift between the KV fast-path counters and a D1-derived recount (corrects for any lost `waitUntil` writes). This is the mechanism that keeps the "R2 object exists but metadata doesn't" / "metadata exists but R2 object doesn't" failure classes from PART 23 self-healing rather than requiring manual intervention.

### 10.9 Rate Limiting Mechanism

**PROPOSAL.** Cloudflare's native **Rate Limiting rules** (WAF-layer, configured per route pattern) handle coarse, cheap protection (e.g., blanket IP-based limits on `/v1/workspaces` no-auth creation and on `/login`/`/signup`) at effectively zero additional cost and zero Worker CPU spent. Finer-grained, identity-aware limits (per-API-key request budgets, per-workspace MCP call budgets) use a **KV counter with a short TTL** (sliding-window-approximate, cheap, globally available) as the default; only where KV's eventual consistency could let a burst slip through in a way that matters (e.g., strict per-second MCP tool-call throttling to stop a runaway agent loop) does a **Durable Object** provide a strongly-consistent counter — used narrowly, per the brief's instruction, and only for that one high-value case (full trade-off table in PART 16.9).

---

## PART 11 — Database Design (Cloudflare D1)

### 11.1 Schema

```sql
-- Organizations: billing root, tenant boundary
CREATE TABLE organizations (
  id TEXT PRIMARY KEY,              -- 'org_' + 26-char ULID
  name TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free', -- 'free' | 'pro' | 'team'
  stripe_customer_id TEXT,
  created_at INTEGER NOT NULL,       -- unix ms
  updated_at INTEGER NOT NULL
);

-- Users: human accounts
CREATE TABLE users (
  id TEXT PRIMARY KEY,               -- 'usr_' + ULID
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT,                -- NULL if OAuth-only
  email_verified_at INTEGER,
  oauth_github_id TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Org membership (also used for workspace-level role override)
CREATE TABLE memberships (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL,                -- 'owner' | 'admin' | 'member'
  created_at INTEGER NOT NULL,
  UNIQUE(org_id, user_id)
);
CREATE INDEX idx_memberships_user ON memberships(user_id);

-- Refresh tokens: backs human session security (PART 15.1) and the Active Sessions UI (PART 8.23).
-- The 15-minute access-token JWT is stateless and verified by signature alone — it is never
-- looked up here. This table exists purely to track the long-lived refresh-token side so a
-- session can be listed and individually revoked, and so token-reuse-after-rotation can
-- invalidate the whole family (PART 16.6).
CREATE TABLE refresh_tokens (
  id TEXT PRIMARY KEY,               -- 'rft_' + ULID
  user_id TEXT NOT NULL REFERENCES users(id),
  family_id TEXT NOT NULL,           -- shared across every rotation of one login session;
                                      -- revoking by family_id kills that whole session lineage
  token_hash TEXT NOT NULL UNIQUE,   -- SHA-256(token), hex — raw token is never stored, mirrors api_keys.key_hash
  device_label TEXT,                 -- parsed User-Agent, e.g. "Chrome on macOS", for the Active Sessions list
  ip_created TEXT,
  last_used_at INTEGER,
  expires_at INTEGER NOT NULL,       -- 30 days from issuance (PART 15.1)
  revoked_at INTEGER,                -- set on logout, explicit "Sign out" of this session, or
                                      -- reuse-detected rotation defense (the whole family gets this set)
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_family ON refresh_tokens(family_id);

-- Workspaces: primary container; quota + billing plan attach here
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,               -- 'ws_' + ULID
  org_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  slug TEXT,                         -- dashboard URL segment; unique per org, never regenerated on rename (migration 0009)
  claimed_at INTEGER,                -- NULL until a sandbox workspace is claimed (migration 0003)
  status TEXT NOT NULL DEFAULT 'active', -- 'active' | 'suspended' | 'deleted'
  plan_override TEXT,                -- NULL = inherit org plan
  storage_bytes_used INTEGER NOT NULL DEFAULT 0,   -- denormalized, reconciled hourly
  file_count INTEGER NOT NULL DEFAULT 0,            -- denormalized
  egress_bytes_period INTEGER NOT NULL DEFAULT 0,   -- resets on period rollover
  requests_period INTEGER NOT NULL DEFAULT 0,
  period_reset_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_workspaces_org ON workspaces(org_id);
CREATE UNIQUE INDEX idx_workspaces_org_slug ON workspaces(org_id, slug);
CREATE INDEX idx_workspaces_unclaimed ON workspaces(claimed_at) WHERE claimed_at IS NULL;

-- Agents: identities distinct from human users
CREATE TABLE agents (
  id TEXT PRIMARY KEY,               -- 'agt_' + ULID
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active', -- 'active' | 'disabled'
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  last_seen_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(workspace_id, name)
);
CREATE INDEX idx_agents_workspace ON agents(workspace_id);

-- API keys: never store the raw secret (see PART 16.3 for generation/hash design)
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,               -- 'key_' + ULID
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  agent_id TEXT REFERENCES agents(id),   -- NULL for a human-issued personal/CI key
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,          -- 'ask_live_' + first 8 chars, shown in UI
  key_last_four TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,     -- SHA-256(secret), hex
  scopes TEXT NOT NULL,              -- JSON: {"ops":["read","write"],"pathPrefix":"/projects/*"}
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  parent_key_id TEXT REFERENCES api_keys(id), -- set if minted as a sub-key
  expires_at INTEGER,                -- NULL = never
  last_used_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_keys_workspace ON api_keys(workspace_id);
CREATE INDEX idx_keys_hash ON api_keys(key_hash);

-- Folders: real, first-class entities (fixes AgentStorage's flat-path-only gap)
CREATE TABLE folders (
  id TEXT PRIMARY KEY,               -- 'fld_' + ULID
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  parent_folder_id TEXT REFERENCES folders(id), -- NULL = workspace root
  name TEXT NOT NULL,
  path TEXT NOT NULL,                -- materialized full path, e.g. /projects/demo
  created_by TEXT NOT NULL,          -- user_id or agent_id
  created_at INTEGER NOT NULL,
  UNIQUE(workspace_id, path)
);
CREATE INDEX idx_folders_workspace_path ON folders(workspace_id, path);
CREATE INDEX idx_folders_parent ON folders(parent_folder_id);

-- Files: the core object; metadata inline (no separate metadata table — see rationale below)
CREATE TABLE files (
  id TEXT PRIMARY KEY,               -- 'fil_' + ULID -- STABLE across versions (V2 hook)
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  folder_id TEXT REFERENCES folders(id),  -- NULL = workspace root
  name TEXT NOT NULL,
  path TEXT NOT NULL,                -- materialized, e.g. /projects/demo/output.json
  r2_object_key TEXT NOT NULL,       -- see PART 12.1 for key strategy; decoupled from file id
  size_bytes INTEGER NOT NULL,
  mime_type TEXT NOT NULL,
  checksum_sha256 TEXT,
  caption TEXT,
  custom_metadata TEXT,              -- JSON key-value, user/agent supplied
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'active' | 'failed' | 'deleted'
  created_by TEXT NOT NULL,          -- user_id or agent_id
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER                 -- soft delete, see 10.7
);
CREATE INDEX idx_files_workspace_path ON files(workspace_id, path);
CREATE INDEX idx_files_folder ON files(folder_id);
CREATE INDEX idx_files_workspace_status ON files(workspace_id, status);
CREATE INDEX idx_files_name ON files(workspace_id, name);

-- Tags: many-to-many, indexed separately from custom_metadata JSON for fast filter queries
CREATE TABLE file_tags (
  file_id TEXT NOT NULL REFERENCES files(id),
  tag TEXT NOT NULL,
  PRIMARY KEY (file_id, tag)
);
CREATE INDEX idx_file_tags_tag ON file_tags(tag);

-- Audit events: append-only
CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,               -- 'evt_' + ULID (ULIDs sort chronologically)
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  actor_type TEXT NOT NULL,          -- 'user' | 'agent' | 'system'
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,              -- e.g. 'file.create', 'key.revoke', 'auth.login_failed'
  resource_type TEXT,
  resource_id TEXT,
  result TEXT NOT NULL,              -- 'success' | 'denied' | 'error'
  ip TEXT,
  client TEXT,                       -- user agent or MCP client identifier
  request_id TEXT,
  metadata TEXT,                     -- JSON, small, never raw file contents/secrets
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_audit_workspace_time ON audit_events(workspace_id, created_at);
CREATE INDEX idx_audit_actor ON audit_events(actor_type, actor_id);

-- Webhooks (MVP-1)
CREATE TABLE webhooks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  url TEXT NOT NULL,
  secret TEXT NOT NULL,              -- for HMAC signing, stored encrypted (PART 16)
  events TEXT NOT NULL,              -- JSON array, e.g. ["file.created","file.deleted"]
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_webhooks_workspace ON webhooks(workspace_id);
```

### 11.1a Session & Ephemeral-Token Storage — Filling a Gap Between PART 15/PART 8.23 and This Schema

**PROPOSAL — closing a real gap.** `06-security-privacy-legal.md` PART 15.1 states that "the refresh token family is tracked, to support the 'active sessions' list," and `03-ux-architecture-and-screens.md` §8.23 designs that Active Sessions screen in full — but neither file previously named the table that backs it. That's the `refresh_tokens` table above: each row is one issued refresh token (superseded on every rotation, with the old row's `revoked_at` set and a new row inserted sharing the same `family_id`); the Active Sessions UI lists the *current, unrevoked* row per `family_id` for the logged-in user, keyed by `device_label`/`last_used_at`; "Sign out" (per-row) revokes that one family; "Sign out all other sessions" revokes every family except the caller's own current one.

**Magic-link and password-reset tokens are deliberately *not* a D1 table.** Both are single-use, short-lived (15 minutes for magic-link per PART 15.1; a similar short window for password reset), and need no relational query capability — a D1 table for them would need constant pruning of expired rows for no benefit. Store them in **KV instead**, keyed by `SHA-256(token)`, value `{userId, purpose: "magic_link"|"password_reset", expiresAt}`, using KV's native `expirationTtl` so expired entries are dropped automatically rather than needing a cleanup job. Verification deletes the KV entry immediately on first use (enforcing single-use) rather than only checking an "already used" flag. This is consistent with how KV is already used elsewhere in this design for short-TTL, no-durability-required data (PART 10.1).

### 11.2 Why Metadata Is Inline on `files`, Not a Separate Table

**PROPOSAL.** A one-to-one `file_metadata` table would only add a join for data that's always fetched together with the file row — every "get file" or "list files" call wants caption/mime/size/checksum. Tags are the one metadata dimension genuinely many-to-many and filtered independently, so only tags get their own table. This mirrors the "avoid over-engineering, don't add a layer unless it's used independently" principle applied in PART 5.2 to the namespace/version layers.

### 11.3 Why `files.id` Is Decoupled From `r2_object_key`

This is the deliberate V2-versioning hook flagged in PART 5.2/6.3: because the D1 row's stable identity (`id`) is never the same string as the R2 key, a future version history can add a `file_versions` table (`file_id`, `r2_object_key`, `created_at`, ...) and repoint "current" without ever changing `files.id` — every existing REST/MCP reference to a file by ID keeps working unmodified when versioning ships.

### 11.4 Migrations

Wrangler D1 migrations (`wrangler d1 migrations create` / `apply`), one file per schema change, applied in CI before deploy (PART 24), numbered sequentially, never edited after being applied to any shared environment — only forward migrations, matching the "reproducible migrations" requirement from the brief.

---

## PART 12 — R2 Storage Architecture

### 12.1 Object Key Strategy

```
tenant/{workspaceId}/{fileId}
```
**PROPOSAL — chosen over a human-readable path-mirroring key** (e.g. `tenant/{workspaceId}/projects/demo/output.json`) for three reasons: (1) renaming or moving a file becomes a pure D1 metadata update (`files.path`/`files.name` change) with **zero R2 operations**, whereas a path-mirrored key would require a copy+delete in R2 on every move/rename — real cost and latency avoided; (2) it sidesteps R2 key-collision/edge-case handling for special characters, unicode normalization, and case-sensitivity differences between a human path string and object-storage key rules; (3) internal object keys are never exposed to clients — every client-facing reference to a file is its `fileId` or its `path` (resolved server-side), consistent with the brief's explicit instruction not to expose internal object keys unnecessarily. `workspaceId` remains in the key prefix (not `orgId`) because R2 lifecycle rules, per-prefix cost observability, and bulk workspace-deletion cleanup all operate most naturally at the workspace boundary, matching billing.

### 12.2 Upload Flow (detailed)

1. Client (browser or agent) calls `POST /v1/files` with `{path, sizeBytes, mimeType, checksum?}`.
2. Worker: authZ + quota check (does this size fit remaining storage quota? does file count fit?) → reserves the quota optimistically (KV counter increment) → creates a `files` row with `status='pending'` and a freshly generated `r2_object_key = tenant/{workspaceId}/{fileId}`.
3. Worker generates a presigned R2 URL scoped to exactly that key (PUT for single-part; a set of multipart part-upload URLs for files above the multipart threshold), with a short expiry (default 15 minutes).
4. Client uploads bytes directly to R2.
5. Client calls `POST /v1/files/:id/complete` with the actual byte count (and multipart ETags if applicable).
6. Worker verifies actual size ≤ what was reserved (rejects/truncates-quota-adjustment if the client lied about size), optionally verifies the checksum via R2's returned ETag/checksum header, flips `status='active'`, commits the durable quota counters to D1, appends an audit event, and (if configured) enqueues async processing (PART 10.6).
7. If step 5 never happens (abandoned upload), the reconciliation job (PART 10.8) expires the pending row and releases the reserved quota after a timeout.

### 12.3 Download Flow

`GET /v1/files/:id/download` → Worker authZ (does this key/scope include read access to this path?) → generates a presigned R2 GET URL, default 1-hour expiry, egress accounted against the workspace's monthly egress counter at generation time (not at actual download time, since R2 doesn't callback the Worker on GET — this is a deliberate, disclosed approximation, see PART 19 assumptions) → client fetches directly from R2.

### 12.4 Signed URLs

Two modes, mirroring the one AgentStorage mechanic worth keeping (PART 4.3) but with clearer naming: **expiring links** (1 hour / 24 hours / 7 days — max 7 days, no longer-lived expiring links, to bound exposure if a link leaks) and **permanent-revocable links** (a dedicated `signed_links` table mapping an opaque token to a file + workspace, checked against a revocation flag on every access — "permanent" means "until revoked," not "unmanaged forever"). Both are served through a Worker-fronted redirect path (`GET /v1/dl/:token`) rather than a raw R2 presigned URL when created for *sharing* (so revocation and egress accounting are enforceable after issuance), whereas the direct download flow (12.3) issues a real presigned R2 URL for the authenticated owner's own client-side use, where revocation isn't a design requirement (the URL simply expires).

### 12.5 Deletion

Soft-delete at D1 (10.7) → grace period (default 24h, configurable down to 0 for compliance-driven immediate purge on request) → Queue-driven hard delete of the R2 object → reconciliation job catches anything the queue consumer failed to complete. A workspace-level "empty trash now" action (V2) can force immediate purge for a specific file if a customer needs provable immediate deletion (relevant to privacy "right to erasure" requests, PART 17).

### 12.6 Accidental Deletion Protection

The soft-delete grace period *is* the primary protection (12.5) — a human or agent that deletes a file has 24 hours to notice and recover via a "Trash" view (V2 UI; MVP-1 exposes recovery via a support-assisted path or a `POST /v1/files/:id/restore` API call available within the grace window even without a dedicated UI). R2 bucket-level "Object Lock"/versioning (V2, PART 12.7) is a second, coarser layer for workspaces on plans that want it.

### 12.7 Large Files, Multipart, Versioning

Files above a configurable threshold (default 100MB) always use R2 multipart upload (parts of 5–100MB each, per R2's multipart constraints), coordinated by the Worker generating part-upload URLs and finalizing via `CompleteMultipartUpload`. Maximum single-file size is capped per plan (PART 19.0) — not unlimited — both to bound blast radius of a runaway agent and to keep quota math simple.

**Resumable upload — distinct from, and built on top of, multipart.** Multipart isn't just a size-threshold mechanic; it's the resumability mechanism. The client (browser or agent SDK) tracks which part numbers have already returned a successful `ETag` from R2. If a transfer is interrupted (network drop, browser close, process restart), the client does not need to restart the whole file from byte zero: it calls `GET /v1/files/:id` to retrieve the upload's current state (which part numbers the Worker has recorded as completed, from `complete`-adjacent bookkeeping — or, more directly, the client can simply re-attempt any part PUT it never received a 200 for; R2 part uploads are individually idempotent, so re-PUTting an already-succeeded part is harmless) and resumes from the first missing or failed part. For files under the multipart threshold (small, single-PUT uploads), there is no partial-progress state to resume from by design — a failed small upload is cheap enough to simply retry whole, using the same `Idempotency-Key` (PART 13) so a duplicate retry is safely deduplicated rather than creating a second file. This two-tier design (small files: idempotent full retry; large files: true resumable multipart) is a deliberate simplification versus building a bespoke resumable-upload protocol (e.g., the tus protocol) from scratch — R2's native multipart primitive already provides the resumability large files need, without a third upload mechanism to build, test, and document.

**Versioning (V2):** R2 supports native bucket versioning; because `files.id` is already decoupled from `r2_object_key` (11.3), turning this on later means writing new objects to versioned keys and adding a `file_versions` table — additive, not a migration of existing data.

### 12.8 Content-Type and Checksum Handling

MIME type is trusted from the client at creation but **never used for any authorization or execution decision** (PART 16.7 — no "execute based on content-type" anywhere) and is independently sniffable server-side on first byte access if a mismatch is suspected (V2 hardening). SHA-256 checksum is optional at upload (agent-supplied) but always computable server-side from R2's own object metadata if omitted, giving every file a verifiable checksum regardless of client cooperation.

---

## PART 13 — REST API Specification

**Base URL:** `https://api.agentdisk.io/v1` (dev: `https://api-dev.agentdisk.io/v1` — `12-deployment-roadmap-agentdisk-io.md`'s flat `-dev`-suffix naming standard)
**Auth:** `Authorization: Bearer <token>` — either a human session token (dashboard-issued, short-lived, refreshed via httpOnly cookie) or an agent API key (`ask_live_...` / `ask_test_...`, PART 16.3).
**Content type:** `application/json` except direct R2 upload/download, which go straight to R2 URLs.
**Error envelope (uniform across every endpoint):**
```json
{ "error": { "code": "VALIDATION_ERROR", "message": "sizeBytes must be a positive integer", "requestId": "req_01J...", "details": {} } }
```
**Standard error codes:** `UNAUTHORIZED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404), `CONFLICT` (409), `VALIDATION_ERROR` (400), `PAYLOAD_TOO_LARGE` (413), `LIMIT_EXCEEDED` (429, `details.limit` ∈ {storage, files, egress, requests, agents, keys}), `INTERNAL_ERROR` (500).
**Idempotency:** `Idempotency-Key` header honored on all `POST` endpoints that create a resource (24h dedup window, matching the one proven-good AgentStorage convention worth keeping).
**Pagination:** cursor-based (`?cursor=&limit=`, default 50, max 200), response includes `nextCursor` (null when exhausted).

| Method & URL | Auth | Authorization | Rate limit (per key/session) |
|---|---|---|---|
| `POST /v1/workspaces` | None (Turnstile-gated) | n/a — creates a sandboxed workspace, mirrors AgentStorage's agent-first flow (PART 4.3) | 10/hour/IP |
| `POST /v1/workspaces/:id/claim` | Human session | Must be an authenticated, verified user | 20/hour/user |
| `GET /v1/workspaces/:id` | Session or key | Member (any role) or key scoped to workspace | 300/min |
| `PATCH /v1/workspaces/:id` | Session | Owner/admin | 60/min |
| `DELETE /v1/workspaces/:id` | Session | Owner | 5/hour |
| `GET /v1/whoami` | Session or key | Self | 600/min |
| `GET /v1/usage` | Session or key | Member or scoped key | 300/min |
| `POST /v1/agents` | Session | Owner/admin | 60/min |
| `GET /v1/agents` | Session or key | Member or scoped key | 300/min |
| `GET /v1/agents/:id` | Session or key | Member or scoped key | 300/min |
| `PATCH /v1/agents/:id` | Session | Owner/admin | 60/min |
| `DELETE /v1/agents/:id` | Session | Owner/admin | 30/min |
| `POST /v1/keys` | Session or key (if key allows minting sub-keys) | Owner/admin, or key with `keys:create` scope ≤ own scope | 60/min |
| `GET /v1/keys` | Session | Owner/admin | 300/min |
| `DELETE /v1/keys/:id` | Session or the key itself (self-revoke) | Owner/admin, or self | 60/min |
| `POST /v1/folders` | Session or key | write scope covering the path | 300/min |
| `GET /v1/folders` | Session or key | read scope | 300/min |
| `DELETE /v1/folders/:id` | Session or key | delete scope; blocked (409) if non-empty unless `?recursive=true` | 60/min |
| `POST /v1/files` | Session or key | write scope covering the path | 600/min |
| `POST /v1/files/:id/complete` | Session or key | write scope (same key that created it, or workspace admin) | 600/min |
| `GET /v1/files` | Session or key | read scope | 600/min |
| `GET /v1/files/:id` | Session or key | read scope covering the file's path | 600/min |
| `GET /v1/files/:id/download` | Session or key | read scope | 600/min, egress-quota gated |
| `PATCH /v1/files/:id` | Session or key | write scope | 300/min |
| `POST /v1/files/:id/move` | Session or key | write scope on both source and destination path | 300/min |
| `POST /v1/files/:id/copy` | Session or key | read scope on source, write scope on destination | 300/min |
| `DELETE /v1/files/:id` | Session or key | delete scope | 300/min |
| `POST /v1/files/:id/restore` | Session or key | delete scope (same as delete — restoring is the inverse) | 60/min, only within grace period |
| `POST /v1/files/:id/sign` | Session or key | read scope; `permanent:true` requires plan support | 60/min |
| `GET /v1/search` | Session or key | read scope, results filtered to scope | 60/min (search is the most expensive read, throttled tighter) |
| `GET /v1/webhooks` / `POST` / `DELETE /v1/webhooks/:id` | Session | Owner/admin | 60/min |
| `GET /v1/activity` | Session | Member (read), filtered by role | 300/min |
| `GET /v1/healthz` | None | Public | unlimited |

**Example — create a file (small, inline):**
Request:
```http
POST /v1/files HTTP/1.1
Authorization: Bearer ask_live_7hK9...
Content-Type: application/json
Idempotency-Key: 8f14e45f-...

{
  "path": "/agents/research-bot/notes/summary.md",
  "mimeType": "text/markdown",
  "content": "IyBTdW1tYXJ5...",
  "caption": "Weekly research summary",
  "tags": ["research", "weekly"]
}
```
Response `201`:
```json
{
  "id": "fil_01J8QK3ZC9R7X2Y4NPTS6VW1AB",
  "workspaceId": "ws_01J8QJZC1234567890ABCDEF",
  "path": "/agents/research-bot/notes/summary.md",
  "name": "summary.md",
  "sizeBytes": 842,
  "mimeType": "text/markdown",
  "checksumSha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b85",
  "caption": "Weekly research summary",
  "tags": ["research", "weekly"],
  "createdBy": { "type": "agent", "id": "agt_01J8...", "name": "research-bot" },
  "createdAt": "2026-09-04T10:15:00Z",
  "updatedAt": "2026-09-04T10:15:00Z"
}
```
**Example — error (quota):**
```json
{ "error": { "code": "LIMIT_EXCEEDED", "message": "This workspace has reached its storage limit for the Free plan (1 GB). Upgrade to add more.", "requestId": "req_01J8QK4...", "details": { "limit": "storage", "used": 1073741824, "max": 1073741824 } } }
```

*Endpoints for large-file multipart (`POST /v1/files` returning part URLs when `sizeBytes` exceeds the multipart threshold) and folder move/list-with-prefix follow the identical request/response/error shape as above; full OpenAPI 3.1 document is the canonical, generated source of truth (PART 25) rather than hand-duplicating every example here.*

---

## PART 14 — MCP API Design

### 14.1 Where MCP Runs — Decision

| Option | Description | Verdict |
|---|---|---|
| **A. Inside Cloudflare Workers** | The same Worker fleet serving REST also serves `POST /mcp` (JSON-RPC per the MCP spec), sharing the identical authorization core, D1 access, and R2 bindings | **Chosen.** |
| B. Separate service | A standalone Node/Python MCP server (e.g., on a VM or container platform) calling back into the REST API | Rejected — reintroduces exactly the "always-running server" cost and operational burden the brief explicitly says to avoid, for zero functional gain: MCP tool calls are just authorized business-logic calls, identical in shape to REST handlers. |
| C. Hybrid | MCP logic in Workers, but a separate long-lived process for "stateful" MCP sessions | Rejected for MVP — Workers/Durable Objects already provide the one piece of statefulness MCP might need (a per-session object for multi-step tool sequences, PART 10.1), so a second runtime buys nothing. |

**Reasoning:** MCP tool calls (`list_files`, `create_file`, etc.) are, in this product, thin wrappers around the same D1/R2 operations the REST API already performs. Running MCP inside the same Worker fleet means one authorization implementation, one deploy, one bill, one place rate limits and audit logging are enforced — directly satisfying the brief's "cheapest architecture that remains production-ready" requirement. This also means REST and MCP can never drift out of sync in what they allow, unlike a bolted-on separate service.

### 14.2 MCP Endpoint & Transport

`POST https://mcp.agentdisk.io/mcp` (dev: `https://mcp-dev.agentdisk.io/mcp`) — Streamable HTTP transport (the current MCP spec's recommended transport for hosted/remote servers, superseding the older HTTP+SSE transport), JSON-RPC 2.0 message framing. Authentication: `Authorization: Bearer ask_live_...` — the same API key format and the same key table as REST (14.1's shared-core decision made concrete). Tool discovery: standard MCP `tools/list` method, returning the JSON schemas in 14.4 filtered to only the tools the presented key's scope actually permits (an agent never even sees a tool it can't call — reduces both confusion and prompt-injection attack surface, echoing AgentStorage's own defensive-docs instinct from PART 2.7/4.3). Tool execution: standard MCP `tools/call`.

### 14.3 Authorization, Tenant Isolation, Rate Limiting, Logging

Identical mechanisms to REST (PART 16), invoked from the same middleware: resolve bearer key → hash lookup (KV-cached) → resolve `workspaceId` + `scopes` → every tool handler receives an already-scoped "storage client" object that has no way to query outside `workspace_id = ?` (enforced at the query-builder level, not left to each handler to remember — see PART 16.4 for the enforcement pattern). Rate limiting uses the same KV/DO mechanism as PART 10.9, with one MCP-specific addition: a **per-session tool-call budget** (Durable-Object-backed strict counter) specifically to stop a misbehaving or looping agent from exhausting a workspace's quota in a tight, automated retry loop — this is the one case flagged in 10.9 where KV's eventual consistency isn't tight enough. Every tool call appends an `audit_events` row identical in shape to a REST call, with `client` set to the MCP client's declared name/version (from the MCP `initialize` handshake) rather than a browser user-agent.

### 14.4 Tool Definitions

**`list_files`**
- Description: "List files and folders under a path in the current workspace, with pagination."
- Input schema: `{ path?: string = "/", cursor?: string, limit?: integer (1-200) = 50 }`
- Output schema: `{ items: [{ id, name, path, type: "file"|"folder", sizeBytes?, mimeType?, updatedAt }], nextCursor: string|null }`
- Auth: bearer key. Authorization: key must have `read` scope covering `path`.
- Errors: `FORBIDDEN` if path outside scope; `NOT_FOUND` if path doesn't exist.
- Rate limit: 600/min (matches REST `GET /v1/files`).
- Audit: `action: "file.list"`, `resource_type: "folder"`.

**`search_files`**
- Description: "Search files by name, path substring, caption, or tags in the current workspace."
- Input schema: `{ query: string, tags?: string[], cursor?: string, limit?: integer = 50 }`
- Output schema: same item shape as `list_files`, plus `matchedOn: string[]` per item.
- Auth/Authorization: `read` scope; results filtered to the key's path-prefix regardless of match.
- Errors: `VALIDATION_ERROR` if `query` empty and `tags` empty.
- Rate limit: 60/min (search is the most expensive read — matches REST).
- Audit: `action: "file.search"`.

**`get_file`**
- Description: "Get a file's metadata and a short-lived download URL."
- Input schema: `{ id: string }` (or `{ path: string }` — accepts either)
- Output schema: full file object (PART 13 example shape) + `downloadUrl`, `downloadUrlExpiresAt`.
- Auth/Authorization: `read` scope covering the file's path.
- Errors: `NOT_FOUND`, `FORBIDDEN`.
- Rate limit: 600/min; download URL generation additionally counted against egress quota.
- Audit: `action: "file.read"`.

**`create_file`**
- Description: "Create a new file with inline content (small files) or register one for direct upload (large files)."
- Input schema: `{ path: string, mimeType: string, content?: string (base64, ≤1MB), sizeBytes?: integer, caption?: string, tags?: string[] }` — exactly one of `content` or `sizeBytes` required.
- Output schema: file object; if `sizeBytes` was used, also `{ uploadUrl, uploadHeaders, completeToken }`.
- Auth/Authorization: `write` scope covering `path`.
- Errors: `VALIDATION_ERROR`, `LIMIT_EXCEEDED` (storage/file-count quota), `CONFLICT` (path already exists, unless `overwrite:true` explicitly passed).
- Rate limit: 600/min.
- Audit: `action: "file.create"`.

**`update_file`**
- Description: "Update a file's caption, tags, or custom metadata (not its content — use create_file with overwrite to replace bytes)."
- Input schema: `{ id: string, caption?: string, tags?: string[], customMetadata?: object }`
- Output schema: updated file object.
- Auth/Authorization: `write` scope.
- Errors: `NOT_FOUND`, `FORBIDDEN`, `VALIDATION_ERROR`.
- Rate limit: 300/min.
- Audit: `action: "file.update"`.

**`delete_file`**
- Description: "Delete a file (soft delete; recoverable for 24 hours)."
- Input schema: `{ id: string }`
- Output schema: `{ id: string, deletedAt: string, recoverableUntil: string }`
- Auth/Authorization: `delete` scope.
- Errors: `NOT_FOUND`, `FORBIDDEN`.
- Rate limit: 300/min.
- Audit: `action: "file.delete"`.

**`create_folder`**
- Description: "Create a folder at a path, including any missing parent folders."
- Input schema: `{ path: string }`
- Output schema: folder object `{ id, path, createdAt }`.
- Auth/Authorization: `write` scope covering `path`.
- Errors: `VALIDATION_ERROR`, `CONFLICT` (already exists — idempotent success is returned instead of an error if identical).
- Rate limit: 300/min.
- Audit: `action: "folder.create"`.

**`move_file`**
- Description: "Move or rename a file to a new path."
- Input schema: `{ id: string, newPath: string }`
- Output schema: updated file object.
- Auth/Authorization: `write` scope on **both** the current and destination path.
- Errors: `FORBIDDEN` (scope doesn't cover destination — this is a deliberately explicit error, not a silent partial success), `CONFLICT` (destination occupied, unless `overwrite:true`), `NOT_FOUND`.
- Rate limit: 300/min.
- Audit: `action: "file.move"`, `metadata: {fromPath, toPath}`.

**`copy_file`**
- Description: "Copy a file to a new path, optionally in a different folder."
- Input schema: `{ id: string, newPath: string }`
- Output schema: newly created file object (new `id`, same content, `r2_object_key` copied server-side via R2's native copy operation — no bytes round-trip the client).
- Auth/Authorization: `read` scope on source, `write` scope on destination.
- Errors: `FORBIDDEN`, `CONFLICT`, `LIMIT_EXCEEDED` (copy counts against storage/file-count quota like any new file).
- Rate limit: 300/min.
- Audit: `action: "file.copy"`.

**`get_metadata`**
- Description: "Get just the metadata for a file or folder without a download URL (cheaper than get_file for agents that only need to reason about a file, not fetch it)."
- Input schema: `{ id: string }`
- Output schema: file/folder object without `downloadUrl`.
- Auth/Authorization: `read` scope.
- Errors: `NOT_FOUND`, `FORBIDDEN`.
- Rate limit: 600/min (not egress-gated, since no download URL is generated).
- Audit: `action: "file.read_metadata"`.

**`search_content`** *(V2 — gated on full-text indexing landing, PART 10.5)*
- Description: "Search inside file contents (not just names/tags) for a phrase."
- Input schema: `{ query: string, cursor?: string, limit?: integer = 20 }`
- Output schema: matches with `snippet: string` context per hit.
- Auth/Authorization: `read` scope; only searches files whose content has been indexed (opt-in processing, PART 10.6).
- Errors: `VALIDATION_ERROR`; a distinct non-error `{ items: [], indexingNotEnabled: true }` shape if the workspace hasn't enabled content processing, so the agent gets an actionable signal rather than a silent empty result.
- Rate limit: 30/min (most expensive operation in the tool set).
- Audit: `action: "file.search_content"`.

### 14.5 Why Not Every Endpoint Is Also an MCP Tool

Workspace/agent/key *management* (create workspace, create API key, delete workspace) are deliberately **REST-only**, not exposed as MCP tools. **PROPOSAL — reasoning:** letting an LLM agent mint its own new API keys or delete a workspace via a tool call is a meaningfully larger blast radius than letting it manage files within an already-granted scope, and none of the validated use cases (PART 2.2/3) require an agent to provision its own credentials via MCP — a human or an out-of-band bootstrap script does that once, then hands the agent a scoped key. This mirrors AgentStorage's own good instinct (post-claim operations like sub-key minting require the *human-claimed* workspace context) applied more conservatively at the MCP layer specifically.
