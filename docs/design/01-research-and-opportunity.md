# AgentDisk — Research & Product Opportunity
### PART 1–4 of the AgentStorage-Inspired Platform Design (see `00-INDEX.md` for the full document set)

**Working product name used throughout this document set: "AgentDisk."** It's a placeholder — pick your own before launch — used so every doc can refer to "the product" concretely instead of "the platform."

**Evidence key used throughout:**
- **FACT** — directly verified from a live, public, primary source (URL cited).
- **INFERENCE** — a technically reasonable conclusion drawn from observed behavior, not directly verified. Reasoning is shown.
- **PROPOSAL** — our own design decision for the new product. Not a claim about AgentStorage or any competitor.

---

## PART 1 — Executive Summary

[FACT/INFERENCE/PROPOSAL — see body] AgentStorage (`agentstorage.ai`) is a small, likely solo-developer product that gives AI agents a self-service, S3-like file store: an agent can create a "workspace" with zero human involvement, get an API key immediately, and start writing files; a human later "claims" the workspace via a one-click link to unlock full limits. It is built on **Convex** (serverless TypeScript backend + database + auth), fronted by a Vite/React marketing site on **Vercel**. It has **no MCP server** — agent integration is a plain REST API plus a single Markdown reference file (`skill.md`) the agent is told to fetch and read. It has no discoverable Terms of Service or Privacy Policy, no compliance claims, no team page, and several internal documentation inconsistencies (mismatched limits between the live pricing page, the live docs, and the GitHub repo; a webhooks feature listed on the homepage but undocumented in the API reference; a published onboarding command that resolves to an unrelated, empty npm package). Pricing is flat, hard-capped tiers ($0 / $19 / $79 per month) with no metered overage — you hit a wall, not a surprise bill.

The broader competitive landscape (20 products researched across agent memory, agent sandboxes, MCP-native storage, AI workspaces, agent-facing BaaS, and vector/RAG storage) shows a consistent pattern: almost nobody builds a novel storage primitive. Nearly everyone wraps S3/GCS-class object storage, Postgres, or SQLite in an agent-friendly API and monetizes the wrapper — often at a steep markup (Pinecone Assistant: ~$3/GB/month vs. ~$0.023/GB/month for raw S3; Chroma Cloud: $2.50 per logical GiB *written*). The market is fragmented into four solution families an agent builder currently has to stitch together themselves: memory/fact stores (Mem0, Zep, Letta, Supermemory), sandboxes with incidental storage (E2B, Modal, Daytona, Northflank), MCP-native document gateways over existing platforms (Box, Notion, fast.io), and general BaaS retrofitted with AI positioning (Supabase, Convex). Critically, **Anthropic's own official MCP servers repo has archived its storage-adjacent reference servers** (Google Drive, Postgres, Redis, SQLite), leaving no canonical, well-maintained MCP storage backend for the ecosystem to build against. And most sandbox-adjacent storage bills hourly, coupled to compute — nobody offers storage that is genuinely serverless (scale-to-zero, pay only for bytes and requests, zero idle cost) *and* MCP-native *and* general-purpose (files + folders + metadata, not RAG-chunked documents or memory facts only).

**This is the opportunity.** A product that is REST **and** MCP-native from day one (not MCP bolted on later), general-purpose (files, folders, metadata, search — not memory-only or RAG-only), priced close to raw object-storage economics with transparent hard caps, and built on a genuinely serverless architecture (Cloudflare Workers + R2 + D1) with zero fixed monthly cost until real usage arrives. The rest of this document set designs exactly that product — call it **AgentDisk** — from MVP-0 through a production-hardened V2, with complete UX specs, API/MCP specs, a Cloudflare-native architecture, security and privacy design, test plans, and two standalone implementation prompts (one for Claude Design, one for Claude Code).

**What we are explicitly *not* doing:** copying AgentStorage's UI, copying its API route names verbatim, or assuming its homepage represents its whole product (it largely does — the site has almost no depth beyond three routes, which is itself a finding, not an oversight on our part).

---

## PART 2 — AgentStorage (agentstorage.ai) Analysis

*All findings below are reproduced from direct primary-source research (browser-rendered pages, the live API reference at `skill.md`, the OpenAPI draft, and the public GitHub repo). Full source list is at the end of this section.*

### 2.1 Product Positioning

**FACT.** Tagline: *"Asset storage built for autonomous agents. Agents upload, humans claim and control."* Hero copy: *"AgentStorage is the file storage API for AI agents. It gives agents their own place to store, retrieve, and share files — like S3 does for apps, but built for AI agents."*

**INFERENCE.** One-line pitch for competitive framing: *S3-like object storage designed to be self-provisioned by an autonomous agent first, with a human brought in after the fact via a "claim" link to unlock full limits and sensitive operations.* The core product idea is the **agent-first, human-second onboarding sequence** — this is the one genuinely distinctive mechanic in the product, and it deserves to be evaluated seriously (see PART 4).

### 2.2 Target Users

**FACT** (pricing page + homepage use-case list). Buyer is an individual developer or small team building autonomous or long-running agents. Named use cases: agent memory/journals, content pipelines (drafts, transcripts, generated images), UI-automation artifacts (screenshots, scrape output), human-in-the-loop approval via signed links, multi-agent scoped sub-keys, webhook-driven automation. **INFERENCE:** no enterprise buying signals (no SSO/SAML, no compliance badges, no team/seat management) — this is a solo-developer/prosumer product, not an enterprise one.

### 2.3 Core Mechanic: Sandbox → Claim

**FACT.** `POST /v1/workspaces` requires **no authentication** and returns `{workspaceId, apiKey, claimUrl}` immediately. Before a human visits `claimUrl` and signs in (email+password or GitHub OAuth), the workspace runs in a "sandbox" state: capped at 50 MB storage / 500 assets / 500 MB egress/month / 0 transforms, blocked from paid-tier operations, and **auto-deleted after 7 days if never claimed**. The API key issued at creation never changes — claiming unlocks capability server-side rather than rotating credentials.

**INFERENCE.** This mechanic is a genuine, exportable insight: it solves a real cold-start problem (an agent shouldn't need a human to sit through an OAuth flow before it can start working) while bounding the blast radius of an unclaimed, unaccountable workspace (small caps, short TTL, no paid capabilities). We adopt a version of this pattern in PROPOSAL form in PART 4/5 (see "Agent-first provisioning").

### 2.4 API Surface

**FACT** (from the live `skill.md` v3 and the OpenAPI draft, cross-checked against each other). Base path `/v1/*`, bearer-token auth (`Authorization: Bearer ask_...`), uniform JSON error envelope `{"error":{"code","message","retryable"?}}`. Key endpoints: `POST /v1/workspaces` (no-auth create), `GET /v1/whoami`, `GET /v1/usage`, `POST /v1/assets/base64` (≤2MB inline), a 3-step register→PUT→finalize flow for larger files, `POST /v1/assets/append` (atomic append for logs/journals — text/markdown/JSON/JSONL only), `GET /v1/assets` (prefix-scoped list, cursor pagination), `GET /v1/assets/:id`, `GET /v1/assets/:id/raw`, `PATCH`/`DELETE /v1/assets/:id`, `GET /v1/search` (caption + tag only — **not** filename/path), webhooks CRUD (listed on the homepage but not documented in the API reference body — a real gap), `POST /v1/assets/:id/sign` (expiring or permanent-revocable signed URLs, served through a metered proxy path distinct from the unmetered direct `downloadUrl`), `POST /v1/assets/:id/transform` (async resize/compress via `jimp`, pure-JS, no native bindings — hence WebP-in becomes JPEG-out), and `POST /v1/keys` (scoped sub-keys, clamped to ≤ the minting key's own permissions).

**FACT.** Files are organized by flat **path string** (e.g. `/projects/demo/inputs/photo.jpg`) with prefix-based listing — there is no folder-as-object API, and **no documented rename/move endpoint** at all. **FACT.** There is no versioning — deletion is destructive, and transforms create a new derived asset rather than versioning the original. **FACT.** Search indexes only `caption` and structured tags supplied at upload time, explicitly not filename or path.

**FACT — two additional API conventions worth naming explicitly, since we adopt versions of both ourselves (PART 4.4/13, PART 16.15).** The `Idempotency-Key` header is honored on `POST /v1/workspaces` and `POST /v1/assets` with a 24-hour dedup window, per the live `skill.md`/OpenAPI draft. Separately, the repo's own `scripts/test-webhooks.sh` E2E harness confirms webhook deliveries are HMAC-signed and that the harness explicitly verifies signature, `eventId`, and timestamp drift — i.e., replay-resistance is present in the actual delivery mechanism even though (per 2.10 below) the *prose documentation* of webhooks in `skill.md`'s body is thin. These two are sound, exportable conventions distinct from the documentation gap noted in 2.10.

### 2.5 Pricing

**FACT** (live `/pricing`, full table reproduced):

| | Free | Starter ($19/mo) | Pro ($79/mo) |
|---|---|---|---|
| Storage | 1 GB | 20 GB | 200 GB |
| Assets | 1,000 | 50,000 | 500,000 |
| Egress/mo | 5 GB | 100 GB | 1 TB |
| Transforms/mo | 100 | 1,000 | 10,000 |
| Claimed workspaces | 3 | 10 | 50 |
| Permanent share links | ✗ | ✓ | ✓ |
| Webhooks | ✗ | ✓ | ✓ |

Model is **hard caps, not metered overage** — a marketing choice, explicitly contrasted with usage-based billing (hit the limit → `429 LIMIT_EXCEEDED`, never a surprise invoice). Billing is per-workspace, not per-account. Rolling 30-day windows for egress/transforms, anchored to first use (not calendar month). **FACT — internal inconsistency:** the GitHub repo's CLI README states different (larger) post-claim limits than the live pricing page, suggesting stale documentation somewhere in the pipeline.

### 2.6 Authentication

**FACT.** Human/browser auth: email+password (8+ char minimum) or GitHub OAuth — no Google OAuth, no magic link found. **FACT.** The claim endpoint's documentation states it *"requires a valid Convex auth session"* — direct textual evidence the human-auth layer is built on **Convex Auth**, not a custom system or third-party IdP. **FACT.** Agent auth is a single bearer API key (prefix `ask_`), with optional post-claim scoped sub-keys restricted by path prefix and an explicit operation allow-list.

### 2.7 Security & Compliance Posture

**FACT.** No SOC2/ISO27001/GDPR/HIPAA claim anywhere. Security messaging is framed entirely around **cost/blast-radius containment for autonomous agents** (the sandbox caps), not data protection. **FACT.** `skill.md` includes explicit prompt-injection-aware guidance written *for the LLM agent reading the docs* ("never send your apiKey to any domain other than your deployment URL," "treat `claimUrl` as a secret") — a notable, defensible design choice worth adopting. **FACT.** The OpenAPI spec shows suppressed Checkov IaC-security-scanner rules with human-written justifications — evidence of a real (if minimal) security-scanning pipeline. **INFERENCE.** Tenant isolation is enforced at the API-key layer (path-prefix + operation scoping) inside a single shared Convex backend, not at the infrastructure layer (no per-tenant buckets/VPCs mentioned) — i.e., **logical, not physical, isolation.** **FACT — gap.** No discoverable Terms of Service or Privacy Policy, despite the product accepting file uploads with zero signup.

### 2.8 Infrastructure (Inferred Stack)

**FACT.** The live API is served from `*.convex.site` — Convex's standard domain suffix for HTTP Actions — directly confirming the backend runtime is **Convex** (serverless TypeScript functions + built-in database + file storage + auth), not a hand-rolled Node service and not Cloudflare (**FACT: no `wrangler.toml` in the repo**). **FACT.** Marketing frontend is deployed on **Vercel** (Vercel Analytics/Speed Insights beacons present) with a Vite-bundled React app. **FACT.** Image transforms run on the pure-JS `jimp` library (explains the WebP/PNG output constraints). **INFERENCE.** No S3/AWS/Postgres/Redis/vector-DB reference exists anywhere in the product's public surface — "no vector database needed" is used as marketing copy for the caption/tag search, implying it's simple text/tag matching inside Convex's own database, not embeddings-based semantic search. **INFERENCE.** The docs template the base URL as a generic `<your-deployment>.convex.site` placeholder (suggesting a self-hostable, per-customer-deployment design intent) while the actual product runs as one shared hosted deployment — an unresolved architectural ambiguity in the original that we deliberately resolve one way, cleanly, in PART 5 (single shared multi-tenant backend, not a self-host model).

### 2.9 MCP Support

**FACT — not found.** Zero references to MCP or "Model Context Protocol" anywhere in the site, docs, OpenAPI spec, or GitHub repo (full-repo grep performed). AgentStorage's "agent integration" story is: a plain REST API, a single Markdown reference file the agent is told to fetch (`skill.md` — positioned explicitly as an alternative to formal tool-calling protocols), and a `npx agentstorage setup` CLI bootstrap. **This is the single most important differentiation opportunity for the new product:** building MCP as a first-class interface, not an afterthought, directly addresses a documented gap both in AgentStorage itself and in the wider MCP ecosystem (PART 3).

### 2.10 Notable Weaknesses / Gaps (evidence-based, not speculative)

1. **No MCP server** — despite operating squarely in the "AI agent" space.
2. **No move/rename API**, no folder-as-object model, no filename/path search.
3. **No versioning** — deletion is destructive; transforms fork a new file rather than version in place.
4. **No Terms of Service or Privacy Policy** reachable anywhere, despite accepting uploads with zero signup.
5. **No compliance posture** (no SOC2, no data-residency statement, no sub-processor list, no encryption-at-rest claim).
6. **Documentation inconsistencies**: pricing numbers differ across three of the product's own surfaces; webhooks are marketed but undocumented; the published npm onboarding command resolves to an unrelated, empty package on the public registry — a real, verifiable "getting started" failure mode.
7. **No team/company/launch presence** — no Product Hunt, Hacker News, X/Twitter, or press footprint found despite targeted searches; the GitHub owner's activity pattern (deep Convex-ecosystem contributions, several small solo tools) strongly suggests an indie/solo project rather than a funded, staffed company.
8. **Ambiguous hosting model** — docs are written as if self-hostable, but the actual product is a single shared SaaS deployment; this ambiguity is never resolved for the customer.

**Sources:** `agentstorage.ai` (home, `/pricing`, `/signin`, `/claim`, `/dashboard`), `glorious-monitor-495.convex.site/skill.md` (v3) and `/setup.sh`, `github.com/Dan-Cleary/agentstorage` (README, LICENSE, `packages/cli`, `openapi/agentstorage.v1.yaml`, `scripts/test-webhooks.sh`), `github.com/Dan-Cleary` (owner profile), `registry.npmjs.org/agentstorage` / `npmjs.com/package/agentstorage`. `docs.agentstorage.ai` does not resolve (DNS failure) — treated as not existing.

---

## PART 3 — Competitor Analysis

*20 products across seven categories, researched directly (vendor pricing/docs pages, GitHub, MCP registry). Full per-product detail preserved; this section adds structured synthesis. FACT/INFERENCE tags as sourced by the research pass.*

### 3.1 Category Map

| Category | Products researched | What they actually sell |
|---|---|---|
| Direct agent-storage comparables | fast.io, Turso agentfs | A connector/index layer over your *existing* Drive/Box/Dropbox (fast.io); an embedded single-file SQLite runtime unifying files+KV+audit log (agentfs, unhosted/beta) |
| Agent memory platforms | Mem0, Zep, Letta, Supermemory | Semantic/graph *fact* recall about users/conversations — not general file storage |
| Sandbox / persistent workspace | E2B, Modal, Daytona, Northflank, CodeSandbox, Replit Object Storage, Val Town, Cloudflare Agents | Storage bundled with (and billed alongside) rented compute/VMs — persistence as a side effect of renting a sandbox |
| MCP-native storage servers | Official MCP servers repo, Box MCP, Turso MCP, Notion MCP | Read/search gateways over an existing enterprise content platform, permission-preserving, mostly read-oriented |
| AI workspace / "second brain" | Dropbox Dash, Google Drive + Gemini Enterprise | Human-facing search/knowledge tools; agent-facing APIs thin or absent (Dash) to full CRUD but enterprise-gated (Gemini) |
| Agent-accessible BaaS | Supabase, Convex Agent component | General-purpose backend-as-a-service retrofitted with AI-agent marketing; real capability, not agent-native design |
| Object storage + vector/semantic search | Pinecone Assistant, Chroma Cloud, Qdrant Cloud | RAG-shaped document stores with heavy per-GB markups over raw storage |

### 3.2 Per-Product Findings (condensed; full detail in research appendix available on request)

**fast.io** — FACT: "cloud storage for AI agents," syncs Drive/Box/Dropbox/OneDrive, exposes via one MCP connection with search + metadata + activity tracking; enterprise logos (Samsung, Amazon, Walmart, Target) cited; from $29/mo. INFERENCE: metadata/search index over other providers' storage (not a storage system of record); cost driver is sync/indexing compute against rate-limited upstream APIs, not bytes. Weakness: doesn't replace your storage bill, it adds to it.

**Turso agentfs** — FACT: open-source (3.3k★), unifies POSIX-like FS + KV + tool-call audit trail inside one SQLite/libSQL file; FUSE/NFS mountable; explicitly BETA. INFERENCE: a library/spec, not a hosted product — no pricing, no multi-tenant service. Genuinely novel primitive (whole-agent-state-as-one-file, SQL-queryable audit trail) but not competitive as a SaaS today.

**Mem0** — FACT: Add/Retrieve memory API, graph memory, "Dream" consolidation; Free/​$19/​$249/Enterprise tiers metered on adds+retrievals. INFERENCE: vector DB + graph DB stack; cost driver is embedding-generation LLM calls, not storage. Not a file store — no folders, no blobs, no large files.

**Zep** — FACT: temporal knowledge graph ("Graphiti"), ships a Memory MCP Server, credit-metered on ingestion bytes (1 credit/350B), $0/​$125/​$375/Enterprise (HIPAA BAA, SOC2, BYOC available). INFERENCE: graph engine + vector search; cost driver is entity-extraction compute at ingest. Strong enterprise compliance posture — a real moat vs. smaller memory startups. Not general file storage.

**Letta** — FACT: "stateful agents," MemFS + shared multi-agent memory, billed per-active-agent + per-second tool execution ($0.10/agent/mo + $0.00015/s). INFERENCE: agent-hosting-as-a-service with memory bundled in, Postgres-backed. Not usable as headless storage independent of running their agent runtime.

**Supermemory** — FACT: unified memory/RAG/connector API, entity knowledge graph, token-metered ($0.005–0.010/1K), self-hosting at Scale tier, explicit MCP docs (Claude/Cursor). INFERENCE: token-deduplicated graph; 2x pricing for rich content implies OCR/transcription cost pass-through.

**E2B / Modal / Daytona / Northflank / CodeSandbox** — FACT (aggregate): all are compute-first sandbox/VM platforms where storage is a secondary, usually hourly-billed, attached-disk feature (Daytona: $0.078/GiB/mo *by the hour*; Northflank: $0.15/GB/mo SSD PVCs; Modal Volumes: $0.09/GiB/mo with 1TiB free, clearly a loss-leader for their GPU compute business). INFERENCE: none offer storage that persists cheaply with **zero compute running** — cost is coupled to renting a VM, unlike true object storage.

**Replit Object Storage** — FACT: explicitly built on GCS ("11 9s durability"). INFERENCE: "GCS with a friendlier SDK," not a novel abstraction — proves the point that most of this market is a thin wrapper over hyperscaler storage.

**Val Town** — FACT: per-project SQLite + Blob Storage, explicit "build an MCP server" docs. INFERENCE: fine for prototypes, unclear production scale (SQLite concurrency ceilings).

**Cloudflare Agents (Workers/Durable Objects/R2/D1/Vectorize/KV)** — FACT: one Durable Object per agent with an embedded SQLite database, automatic persistence, explicit MCP support ("connect to any MCP server," "Code Mode"). INFERENCE: **architecturally the most sophisticated agent-storage story in the entire landscape** — colocated compute + strongly-consistent state at the edge, native MCP. Weakness: no single product/price — you assemble it from several separately-billed Cloudflare primitives, and Durable Objects is a distinctive, non-trivial programming model. This is the closest existing pattern to what we design in PART 5/10, and it directly validates building on Cloudflare.

**Official MCP servers repo** — **FACT, important:** Google Drive, Postgres, Redis, SQLite, and AWS-KB-retrieval reference servers have been **archived** by Anthropic; only Filesystem and Git remain actively maintained. INFERENCE: **there is no canonical, well-maintained, Anthropic-blessed MCP server for any durable storage backend today.** This is a direct, structural market gap.

**Box MCP / Notion MCP** — FACT: both are permission-preserving read/search (and, for Notion, read-write-block) gateways over an *existing* enterprise content platform you must already be a customer of. Not standalone storage products.

**Dropbox Dash** — FACT: human-facing AI workspace search; **no MCP or agent API found** — a visible lag vs. Box, which already shipped MCP.

**Google Drive + Gemini Enterprise connector** — FACT: full CRUD action API (not just search), OAuth-scoped, respects Drive permissions; hard limits (75MB file cap, 1MB/80-page text-extraction cap for indexing); enterprise-gated (Gemini Enterprise licensing, enterprise sales cycle), not self-serve.

**Supabase** — FACT: Postgres+Auth+Storage+Realtime BaaS, Free/​$25/​$599/Enterprise, storage overage $0.125/GB, egress $0.09/GB. INFERENCE: general-purpose BaaS retrofitted with "AI builder" marketing, not agent-native by design (though popular with the vibe-coding crowd generally). Storage is S3-compatible under the hood per Supabase's known architecture.

**Convex Agent component** — FACT: ACID chat-history + built-in vector search + workflow-state, all inside Convex's reactive database (this is very likely the same underlying platform AgentStorage itself is built on — see PART 2.8). INFERENCE: reactivity (live-updating queries) is a genuine differentiator none of the pure-storage products have, but it comes with deep lock-in to Convex's proprietary model and is not a general blob/file store.

**Pinecone Assistant** — FACT: chunk-and-embed RAG pipeline, storage **$3/GB/month** (~130x raw S3), file-size caps (10MB general / 100MB PDF), multi-dimension metered pricing (ingestion + storage + retrieval + chat tokens). Turnkey RAG convenience at a steep, stacked price.

**Chroma Cloud** — FACT: **$2.50 per logical GiB written**, $0.33/GiB/mo storage, novel copy-on-write "fork" primitive. INFERENCE: monetizes vector-indexing compute, not bytes; write-heavy agent workloads get expensive fast.

**Qdrant Cloud** — FACT: resource-hour (vCPU/RAM/disk) infra pricing, BYOC/air-gapped options, thin agent-specific marketing relative to Zep/Mem0/Supermemory.

### 3.3 Synthesis: The Structural Gap

Four things are true simultaneously across all 20 products, and no single product satisfies all four:

1. **MCP is bolted on, not native**, or entirely absent (only fast.io, Zep, Supermemory, Cloudflare Agents, Box, Notion, Turso ship any MCP surface at all — 7 of 20 — and none pairs MCP-native design with general-purpose file storage; the closest, Cloudflare Agents, requires deep platform assembly, not a turnkey product). The official MCP storage-server reference has been abandoned.
2. **Pricing carries a heavy "agent convenience" markup over raw bytes** — 5x to 130x over S3/GCS list price is common wherever a vector/RAG layer is involved (Pinecone, Chroma). Where pricing is closer to raw economics (Modal Volumes, Replit), the product isn't agent-native — it's general compute storage with an SDK.
3. **Storage is bundled with, and billed alongside, running compute** almost everywhere in the sandbox category (E2B, Daytona, Northflank, Modal) — true zero-idle-cost persistence (pay only for bytes at rest and requests made, nothing for idle hours) exists only in the plain object-storage tier of hyperscalers, not in any agent-branded product researched.
4. **General-purpose file/folder/metadata storage is rare.** Most products are shaped for one narrow data type: RAG-chunked documents (Pinecone), conversational facts (Mem0/Zep), reactive JSON+vectors (Convex), or existing platform content (Box/Notion/Dash). Nobody offers a clean "files + folders + metadata + full-text/tag search, agent- and human-accessible, at S3-like economics."

**PROPOSAL.** AgentDisk is positioned exactly in this gap: REST + MCP native from the start, general-purpose file/folder/metadata storage (not memory-only, not RAG-only), priced close to Cloudflare R2's raw economics with transparent hard caps (following AgentStorage's honest "you hit a wall, not a surprise bill" model, which is worth keeping), and truly serverless — R2 storage costs nothing when idle, Workers cost nothing when idle, D1 costs nothing when idle. No product researched combines all four properties.

---

## PART 4 — Product Opportunity

### 4.1 Why Traditional Cloud Storage (Raw S3/R2/GCS) Isn't Enough for Agents

**PROPOSAL — reasoning, not a factual claim about any vendor.** Raw object storage gives you bytes and a key. An agent needs more than that to be a reliable, safe, multi-agent-capable actor:

- **No identity model for non-human callers.** IAM is built for humans and services with long-lived infrastructure roles, not for a coding agent that should get a narrowly scoped, easily-revocable credential the moment it's spun up and nothing more.
- **No metadata or search surface an LLM can use cheaply.** An agent burns context and money re-reading raw bytes to figure out "what is this file" every time; it needs structured, queryable metadata (captions, tags, MIME, size, lineage) it can list and filter without downloading content.
- **No natural unit of "workspace" or "agent."** A bucket is not a workspace; a bucket policy is not an agent-scoped credential. Every team re-invents this layer themselves (as AgentStorage, Cloudflare Agents, and several BaaS products in PART 3 all independently did).
- **No standard, safe self-provisioning flow.** Handing an autonomous agent a static, long-lived, account-wide S3 key is a real security anti-pattern occurring in practice today; there's no "give me a small sandboxed credential, let a human upgrade it later" flow with plain object storage.
- **No agent-native access protocol.** Raw storage has REST or SDKs, not MCP tool schemas an LLM can discover and call directly.

### 4.2 Why an Agent-Specific Storage Abstraction Is Useful

**PROPOSAL.** The useful abstraction sits one layer above the bytes: **scoped credential → workspace → namespace → folder/file → structured metadata**, with REST and MCP as two views onto the same authorization and data layer, built by a control plane (Workers) that never becomes the data pipe for large files (R2 direct upload/download). This is validated by the pattern independently converged on by AgentStorage (workspace + scoped sub-keys), Cloudflare's own Agents SDK (per-agent durable state), and every agent-memory product's insistence on structured, filterable metadata over raw blobs.

### 4.3 What AgentStorage Got Right (worth keeping)

1. **Agent-first, human-second provisioning** (sandboxed, capped, auto-expiring) — solves a real cold-start UX problem.
2. **Hard-capped, predictable pricing** with no metered-overage surprise billing — good trust signal for a developer audience.
3. **Scoped sub-keys** restricted by path prefix and operation allow-list, clamped to ≤ the parent key's own scope — sound authorization design.
4. **Docs written defensively for an LLM reader** (prompt-injection-aware instructions) — a real, exportable insight for our own agent-facing docs and MCP tool descriptions.
5. **Append-only write primitive** for logs/journals — a genuinely useful primitive for agent memory/transcript use cases that a plain PUT-object API doesn't give you cleanly.

### 4.4 What AgentStorage Got Wrong (and how AgentDisk addresses each)

| Gap in AgentStorage | AgentDisk's answer |
|---|---|
| No MCP server at all | MCP is a first-class interface from MVP-1, sharing one authorization core with the REST API (PART 14) |
| No move/rename, no real folders, no path search | Folder is a first-class entity; move/rename/copy are core file operations; search covers name, path, and metadata (PART 3/11 data model) |
| No versioning | Lightweight file versioning is scoped for V2 with a clear data-model hook left in MVP-1 (PART 6) |
| No ToS/Privacy Policy | Both drafted in full in PART 17, gated behind signup before any paid capability |
| No compliance posture | Security model, audit logging, and data-handling claims are honest about what Cloudflare's architecture actually provides — no unsupported "we can never see your data" claims (PART 16/17) |
| Ambiguous self-host vs. SaaS story | AgentDisk is explicitly a single multi-tenant hosted SaaS; self-hosting is out of scope, stated plainly, not implied and left unresolved |
| Documentation inconsistencies (pricing/route drift, dead onboarding command) | One source of truth: OpenAPI spec generates both the human docs and the MCP tool schemas (PART 14), CI checks that pricing constants match the billing config (PART 24) |
| Search limited to caption/tag only | MVP-1 search covers filename/path + metadata; full-text content search is V2 (opt-in, async); semantic/vector search is deferred pending evidence of need (PART 19 §Search) |

### 4.5 Positioning Statement

**PROPOSAL.** *AgentDisk is serverless, agent-native file storage: a REST and MCP API that gives every AI agent its own scoped, persistent workspace for files, folders, and structured metadata — built on Cloudflare so it costs nothing when idle and scales without a rewrite when it isn't.*

Target wedge: individual AI developers and small teams building autonomous or long-running agents (coding agents, browser-automation agents, content pipelines, research agents) who currently either (a) hand an agent a raw, over-privileged cloud storage key, (b) stitch together a memory product + a sandbox + a BaaS product to cover what should be one job, or (c) have outgrown AgentStorage's undocumented, MCP-less, unversioned model but don't want Cloudflare Agents' full platform-assembly complexity.

The remaining parts of this document set (files `02` through `10` in this set) turn this positioning into a complete, implementation-ready design.
