# AgentDisk — Proposed Product & MVP Scope
### PART 5–6 of the AgentStorage-Inspired Platform Design

All decisions in this document are **PROPOSAL** (our own design choices) unless explicitly marked otherwise. See file `01-research-and-opportunity.md` for the evidence base.

---

## PART 5 — Proposed Product

### 5.1 User Personas

**Persona 1 — Riya, AI Developer (primary persona for MVP)**
Builds agents/coding tools professionally or as a serious side project. Lives in a terminal and an IDE, not a dashboard. Needs: a REST API and/or MCP endpoint she can point an agent at in minutes; an API key she can generate from a CLI or a two-click dashboard flow; predictable pricing she can reason about before shipping; SDKs (TypeScript/Python) that don't fight her existing tooling. She will judge the product almost entirely by how good `skill.md`/docs/OpenAPI are and how few surprises the API has. She almost never opens the dashboard except to check usage or rotate a key.

**Persona 2 — Marcus, Individual AI Power User**
Runs several personal agents (a research assistant, a journaling agent, a browser-automation bot) and wants a place to *see* what they've been doing — a real dashboard, not just an API. Needs: drag-and-drop upload, folder browsing, thumbnail previews, search, and a way to tell which files were written by which agent and when. He wants to occasionally intervene — delete something an agent shouldn't have kept, rename a mess of auto-generated filenames, download something to share.

**Persona 3 — Priya (Team Lead), Team/Startup**
Runs a small startup building an agent product or using agents internally across 3–15 people. Needs: workspaces scoped per project or per client, teammates with different permission levels, a usage view she can hold up in a board meeting, an audit log she can hand to a customer's security reviewer, and API keys she can attribute to a specific service or teammate and revoke individually when someone leaves.

**Persona 4 — The Agent Itself, Autonomous Agent (non-human actor)**
Not a person — a running LLM-driven process. Needs: a credential it can be handed (or can self-provision) that is scoped tightly enough that a mistake or a prompt-injection attempt can't do much damage; a way to discover what tools/files it has access to without a human explaining it; deterministic, structured error messages it can reason about and retry correctly; metadata-rich listing so it doesn't have to download bytes just to know what something is; a persistent namespace so its "memory" of what it's done survives between runs.

### 5.2 Core Product Abstraction — Evaluating the Proposed Hierarchy

The brief's candidate hierarchy is: `Organization → Workspace → Agent → Storage namespace → Folder → File → File version → Metadata → Permissions → Audit event`. We evaluate every layer on: why it exists, what it stores, who can access it, and whether it belongs in MVP or should be deferred.

| Entity | Why it exists | What it stores | Who can access | MVP? |
|---|---|---|---|---|
| **Organization** | Billing and top-level tenant boundary; the thing a Stripe customer maps to; the root of every authorization scope check | Name, billing plan, owner user, created_at | Org members (role-scoped) | **Yes — MVP-0.** Even a solo developer's account is "an org of one." Skipping this layer now would force a painful migration later (every foreign key would need re-scoping) — this is the one layer where under-building costs more than over-building. |
| **Workspace** | The unit a project/client/environment is organized around; the unit billing quotas and MCP connections attach to | Name, org_id, plan overrides, created_at, storage/asset counters (denormalized for fast quota checks) | Org members with workspace-level role | **Yes — MVP-0.** This is the primary "container" the whole product is organized around — AgentStorage's own design (and Cloudflare Agents' per-agent-DO model) both validate that *some* mid-tier container between "account" and "file" is necessary. |
| **Agent (identity record)** | A named, auditable identity distinct from a human user — so "who wrote this file" and "what can this credential do" are answerable without conflating agents with human accounts | Name, workspace_id, description, created_by (human), status (active/disabled), last_seen_at | Workspace members; the agent itself only via its API key | **Yes — MVP-0, but deliberately thin.** We do *not* build agent orchestration/runtime (that's Letta's/Cloudflare Agents' job, not ours). An "Agent" here is just an identity + credential attachment point + audit-trail label. This is the single most important entity AgentStorage got wrong by not having explicitly — its "workspace" conflates workspace and agent identity. |
| **Storage namespace** | A logical division *within* a workspace (e.g., separate an agent's private scratch space from a workspace's shared files) | — | — | **No — deferred, and we recommend never building it as a separate DB entity.** In practice, "namespace" is fully expressible as a folder path convention (`/agents/{agentId}/...` vs `/shared/...`) enforced by prefix-scoped API keys. Adding a distinct namespace table on top of folders is the over-engineering the brief explicitly warns against — folders already do this job. |
| **Folder** | Human/agent-legible organization; the unit move/list/prefix-scope operations act on | path, workspace_id, created_by, created_at | Scoped by workspace + API key path-prefix restriction | **Yes — MVP-0.** AgentStorage's flat-path-only model (no real folder entity, no move endpoint) was a documented weakness (PART 2.4/2.10) — we fix this from day one because retrofitting "real" folders onto a flat key-value path scheme later is a painful migration. |
| **File** | The core object | path/name, folder_id, workspace_id, r2_object_key, size_bytes, mime_type, checksum (SHA-256), created_by, created_at, updated_at, status (active/deleted) | Scoped by workspace + folder-prefix + API key scope | **Yes — MVP-0.** Obviously core. |
| **File version** | Recover from an agent overwriting/corrupting a file; support "what changed" auditing | version_id, file_id, r2_object_key (versioned key), size_bytes, checksum, created_by, created_at | Same scope as the parent file | **Deferred to V2**, but the data model reserves the hook in MVP-1 (see 6.3) — R2 has native object versioning we can enable per-bucket cheaply later without a schema rewrite if `files` already points at a stable `file_id` rather than directly at a mutable R2 key. |
| **Metadata** | Agent-legible structured description without downloading bytes; the thing that makes search and "what is this" cheap | caption, tags[], custom key/value JSON, mime_type, size, checksums, lineage (optional "derived_from_file_id") | Same scope as the parent file | **Yes — MVP-0**, as columns/JSON on the `files` row, not a separate table (see PART 11 for schema reasoning). |
| **Permissions** | Enforce who/what can do what, at every layer | role (owner/admin/member) for humans; scope (path-prefix + operation allow-list) for API keys | Enforced by middleware before any handler runs | **Yes — MVP-0.** This is not optional; see PART 16. |
| **Audit event** | Answer "who did what, when" for humans, agents, and support/security investigations | actor (user_id or api_key_id), action, resource_type/id, workspace_id, ip, user_agent/client, timestamp, result (success/denied) | Workspace owners/admins | **Yes — MVP-1** (not MVP-0: log the events from day one cheaply via a D1 table + Workers Analytics Engine, but the *UI* to browse them can wait one milestone — see 6.3). |

**Resulting MVP hierarchy (six real entities, not ten):**

```
Organization
 └─ Workspace
     ├─ Agent (identity + credential attachment point)
     ├─ Folder
     │   └─ File (with embedded metadata; version + namespace layers explicitly not separate entities)
     └─ Audit event (append-only log, workspace-scoped)
```

Permissions are not a table of their own in MVP-0 — they're a small enum on org membership rows plus a JSON scope blob on API-key rows (see PART 11). This mirrors the AgentStorage decision that worked (scoped keys) while fixing the two it got wrong (no real folders, no distinct agent identity from workspace).

### 5.3 Core Functionality Overview (detail in later parts)

- **Authentication** (full design in PART 15): email/password + magic link for humans (no OAuth in MVP-0 — see 6.2 for why), API keys for agents. No SSO in MVP-0/1 (V2, on enterprise demand).
- **File storage** (full design in PART 11/12/13): direct-to-R2 upload/download via presigned URLs; the Worker never proxies file bytes for anything above a small inline threshold.
- **Agent access** (full design in PART 14): REST API and MCP server share one authorization core; MCP is not an afterthought bolted on post-launch.
- **Search** (full design in PART 10 of the technical-architecture document): filename/path substring match and structured-metadata filter in MVP-1 (a D1 index, not embeddings); full-text content search deferred to V2; semantic/vector search deferred pending evidence of real customer demand (see cost/complexity discussion there — Pinecone's and Chroma's steep per-GB markups in PART 3 are exactly the cost trap we avoid by not defaulting to vector search).

---

## PART 6 — MVP Definition

### 6.1 Prioritization Method

Every candidate feature below is scored on five axes — customer value, implementation complexity, infrastructure cost, security risk, and scalability impact — each Low/Med/High, to justify why it lands where it does. Only High-value, Low/Med-complexity, Low/Med-cost, Low-risk-when-deferred items make MVP-0.

### 6.2 MVP-0 — "Prove the concept"

*Goal: the smallest thing that lets one real developer point one real agent at persistent storage over REST, with API-key auth and basic web visibility, safely. Ships in weeks, not months.*

| Feature | Value | Complexity | Cost | Risk | Included? |
|---|---|---|---|---|---|
| Org + workspace creation (human signup, email+password) | High | Low | Low | Low | ✅ |
| Agent identity record + one API key per agent | High | Low | Low | Med (key handling) | ✅ |
| Folder create/list; file upload/download/delete via presigned R2 URLs | High | Med | Low | Med | ✅ |
| File metadata (caption, tags, MIME, size, checksum) | High | Low | Low | Low | ✅ |
| REST API (`/v1/*`) covering the above | High | Med | Low | Low | ✅ |
| Minimal dashboard: file browser + upload + API key management | High | Med | Low | Low | ✅ |
| Basic per-workspace quota (storage bytes, file count) enforced at write time | High | Low | Low | Med | ✅ |
| Rate limiting on auth + upload endpoints | High | Low | Low | High-if-skipped | ✅ |
| API keys carry a scope at creation (operations + optional path prefix, one key = one fixed scope) | High | Low | Low | Med | ✅ (the `scopes` column exists from the first migration, PART 11 — a key without a declared scope isn't a meaningful credential) |
| Move/rename/copy (metadata-only operation — PART 12.1's key strategy makes this a pure D1 update, not an R2 copy) | Med | Low | Low | Low | ✅ (cheap enough, and expected baseline behavior for any file browser worth shipping) |
| Filename/path search — Level 1 only (PART 10.5) | Med | Low | Low | Low | ✅ (a single indexed `LIKE` query — materially cheaper than the folder/file work already in MVP-0, no reason to hold it back) |
| **Sub-key minting** — an existing key programmatically creating a new, narrower-scoped key (as opposed to a key simply *having* a scope, which is MVP-0) | Med | Med | Low | Med | ❌ → MVP-1 (nice but not required to validate the core loop — a human can create every key by hand in the dashboard until this ships) |
| MCP server | High | Med-High | Low | Med | ❌ → MVP-1 (deliberately just after MVP-0, not in V2 — see 6.5 rationale) |
| Metadata/tag search — Level 2 (PART 10.5) | Med | Low | Low | Low | ❌ → MVP-1 (needs the tag-editing UI, which is a small but real additional surface beyond Level 1's filename search) |
| Webhooks | Med | Med | Low | Med | ❌ → MVP-1 |
| OAuth login (GitHub/Google) | Low-Med | Med | Low | Low | ❌ → MVP-1 |
| Billing/Stripe | Low (pre-revenue validation stage) | Med | Low | Low | ❌ → MVP-1 |
| Audit log UI | Low at MVP-0 scale | Low | Low | Low | ❌ → MVP-1 (events are still *recorded* from day one — cheap — just not surfaced in UI yet) |
| Team members / multi-user workspaces | Low (single-dev persona dominates MVP-0) | Med | Low | Med | ❌ → MVP-1 |
| Versioning | Low | High | Med | Low | ❌ → V2 |
| Semantic/vector search | Low (no evidenced demand yet) | High | Med-High | Low | ❌ → V2, conditional |
| AI document processing (OCR/summarize/embed) | Low at MVP-0 | High | Med-High | Med | ❌ → V2 |

**MVP-0 explicitly excludes OAuth.** Reasoning: AgentStorage shipped GitHub OAuth day one; we instead ship email/password + magic link first because it requires zero third-party app registration/approval lead time and covers 100% of the target persona (a developer will always accept email+password for a dev tool), and add GitHub OAuth in MVP-1 once the core loop is validated — this is a sequencing choice, not a permanent omission.

### 6.3 MVP-1 — "Commercially usable"

*Goal: a product you could charge for and hand to a stranger without hand-holding.*

Adds on top of MVP-0: MCP server (full tool set, PART 14), sub-key minting (a key creating a new, narrower-scoped key — MVP-0 already ships keys that carry a fixed scope at creation; MVP-1 adds the ability to mint one from an existing key without going through a human/dashboard step), metadata/tag search (Level 2 — MVP-0 already ships filename/path search), webhooks, GitHub OAuth, Stripe billing (Free/Pro/Team plans), audit log UI, team members with roles (owner/admin/member), usage dashboard with real numbers, signed download links (expiring + revocable-permanent), CSV/zip bulk export, rate limiting across all endpoint classes (not just auth+upload), structured error catalogue, and the data-model hook for versioning (a stable `file_id` decoupled from the current R2 object key, so V2 versioning is additive, not a migration).

**Why MCP lands in MVP-1, not MVP-0 or V2:** MCP is the single biggest differentiator identified in PART 3/4 (no comparable product pairs MCP-native design with general file storage). It is High value. But building it correctly requires the REST API's authorization core to already be stable — building MCP and REST simultaneously in MVP-0 risks getting both wrong under time pressure. One milestone of REST-only lets the authorization/quota/scoping logic get proven against real traffic before MCP becomes a second consumer of the same core. This is a sequencing decision, not a statement that MCP is less important — it is the headline feature of MVP-1 and should be marketed as such.

### 6.4 V2 — "Advanced"

File versioning (using the MVP-1 data-model hook), semantic/vector search (Cloudflare Vectorize — only if usage data from MVP-1 shows customers actually asking for it; see PART 19's explicit cost comparison of why this is not a default), async AI document processing (text extraction, OCR, summarization, auto-tagging via a Queue-driven pipeline, PART 10 §Async Processing), full-text content search (Cloudflare's D1 FTS5 or a dedicated search index), SSO/SAML for enterprise, per-workspace custom domains for signed URLs, fine-grained folder-level ACLs beyond path-prefix, multi-region considerations if latency data warrants it, and a public status page/SLA.

### 6.5 Quotas (plan-based, workspace-scoped — see PART 19 for exact numbers)

**PROPOSAL.** Quotas are workspace-scoped (not user- or agent-scoped) because billing is per-workspace, matching AgentStorage's own (sound) choice — a team can have one workspace on Free and another on Pro. Within a workspace, individual agents share the workspace quota by default; a future V2 feature can add per-agent sub-quotas for teams that want to bound a single misbehaving agent without capping the whole workspace. Quota dimensions: total storage bytes, file count, monthly egress bytes, monthly request count, number of agents, number of API keys, max single-file size. All quota checks happen in the authorization middleware *before* the operation runs (PART 16), returning a structured `429 LIMIT_EXCEEDED` with the specific limit that was hit — following AgentStorage's honest hard-cap model rather than surprise metered overage, which is a real trust advantage worth keeping for a developer-trust product.

### 6.6 Billing (modular, not built first)

**PROPOSAL.** Per the brief's explicit instruction, billing is not implemented in MVP-0. The plan/quota model is designed so Stripe can be added in MVP-1 without touching storage logic: a `workspace.plan` enum and a `plan_limits` lookup table (or config object) are the only things billing code touches; the storage/API/MCP code paths only ever read `workspace.plan_limits`, never call Stripe directly. This keeps billing logic swappable (Stripe today, something else later) without a storage-layer rewrite — the modularity the brief explicitly asks for.
