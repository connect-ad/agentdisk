# AgentDisk — Cloudflare Deployment & Cost Model
### PART 18–19 of the AgentStorage-Inspired Platform Design

All content is **PROPOSAL** unless marked otherwise. Cost figures use Cloudflare's published pricing as of this research (Sept 2026) and are clearly labeled as **assumptions** where they depend on usage patterns we can't know in advance.

---

## PART 18 — Cloudflare Deployment

**Note (Sept 2026, added after `12-deployment-roadmap-agentdisk-io.md`/`13-infra-cicd-implementation-prompt.md` were written):** the real domain is **`agentdisk.io`**, not the `agentdrive.dev` placeholder used when this section was first drafted — fixed below wherever it appears. Two other things `12` supersedes rather than merely updates: (1) it uses **two** environments (Development, Production), not the three-tier Dev/Preview/Production sketch in 18.1 below — a per-PR preview tier was explicitly deferred; (2) it defines the actual resource-naming standard (`agentdisk-<env>-<resource>`, flat `-dev`-suffixed subdomains like `api-dev.agentdisk.io` rather than nested `api.dev.agentdisk.io`, chosen because Cloudflare's free Universal SSL wildcard covers only one subdomain level) — treat `12` as canonical for exact resource/domain names in the real deployment, and this PART 18 as the background reasoning (cost model, observability approach, directory layout) that's still accurate. Also new since this section was drafted: an `apps/admin` deployable and an `admin`/`admin-dev` subdomain — see `14-admin-panel-and-billing-design.md` PART 28.1 — added to 18.4/18.6 below.

### 18.1 Environments

Three environments, each a fully separate set of Cloudflare resources (not just config flags on shared resources — real isolation, so a preview-environment bug can never touch production data):

| | Development | Preview | Production |
|---|---|---|---|
| Purpose | Local iteration (`wrangler dev`) | Per-PR or staging validation | Live customer traffic |
| Workers | Local Miniflare simulation, or a `-dev` deployed Worker | `agentdisk-api-preview` | `agentdisk-api` |
| D1 | Local SQLite file (`wrangler d1` local mode) | `agentdisk-db-preview` | `agentdisk-db` |
| R2 | Local simulation or a `-dev` bucket with short lifecycle rules | `agentdisk-files-preview` (7-day auto-purge lifecycle rule, so preview cruft never accumulates cost) | `agentdisk-files` |
| KV | Local simulation | `agentdisk-cache-preview` | `agentdisk-cache` |
| Queues | Local simulation | `agentdisk-jobs-preview` | `agentdisk-jobs` |
| Domain | `localhost` | `preview-*.agentdisk.io` / per-PR subdomain via Cloudflare Pages preview URLs (deferred per `12` — see note above) | `agentdisk.io`, `app.agentdisk.io`, `api.agentdisk.io` |
| Secrets | `.dev.vars` (git-ignored) | `wrangler secret put --env preview` | `wrangler secret put --env production` |

### 18.2 Wrangler Configuration (`wrangler.toml`, sketch)

```toml
name = "agentdisk-api"
main = "src/index.ts"
compatibility_date = "2026-08-01"

[[d1_databases]]
binding = "DB"
database_name = "agentdisk-db"
database_id = "<prod-id>"

[[r2_buckets]]
binding = "FILES"
bucket_name = "agentdisk-files"

[[kv_namespaces]]
binding = "CACHE"
id = "<prod-id>"

[[queues.producers]]
binding = "JOBS"
queue = "agentdisk-jobs"

[[queues.consumers]]
queue = "agentdisk-jobs"
max_batch_size = 10
max_retries = 5
dead_letter_queue = "agentdisk-jobs-dlq"

[triggers]
crons = ["0 * * * *"]   # hourly reconciliation job, PART 10.8

[env.preview]
# preview-scoped bindings mirroring the block above, pointed at *-preview resources

[env.production]
# production-scoped bindings, pointed at the resources above
```

Secrets (`DATABASE_ENCRYPTION_KEY` — used to application-level-encrypt `webhooks.secret` at rest, PART 16.16a — `SESSION_SIGNING_KEY`, `STRIPE_SECRET_KEY`, `GITHUB_OAUTH_CLIENT_SECRET`, email-provider API key, webhook-HMAC signing salt) are **never** committed to source — set via `wrangler secret put <NAME> --env <environment>`, one per environment, sourced from a password manager / CI secrets store, never from a shared `.env` file checked into git. `.dev.vars` (local-only secrets for `wrangler dev`) is git-ignored and a `.dev.vars.example` with placeholder values is committed instead so a new contributor knows what to fill in.

### 18.3 Deployment Process

```
1. Install:            npm install
2. Auth to Cloudflare:  wrangler login   (or CLOUDFLARE_API_TOKEN in CI)
3. Create resources (first time only, per environment):
     wrangler d1 create agentdisk-db
     wrangler r2 bucket create agentdisk-files
     wrangler kv:namespace create CACHE
     wrangler queues create agentdisk-jobs
     wrangler queues create agentdisk-jobs-dlq
4. Configure secrets:   wrangler secret put SESSION_SIGNING_KEY --env production
                         (repeat per secret, per environment)
5. Run migrations:      wrangler d1 migrations apply agentdisk-db --env production
6. Deploy Worker:        wrangler deploy --env production
7. Deploy frontend:      (Cloudflare Pages, connected to the repo — auto-deploys
                          app.agentdisk.io on merge to main; PR previews auto-deploy
                          to *.agentdisk-app.pages.dev)
8. Configure domain:     (one-time DNS setup, 18.4)
9. Smoke test:           scripted hit against /v1/healthz, a signed-up-test-account
                          login, a small file upload+download round trip (PART 24's
                          CI pipeline runs this automatically post-deploy)
```

### 18.4 Domain / DNS

**One registrable domain is sufficient for MVP** (`agentdisk.io`), split by subdomain rather than separate domains — simpler DNS, simpler TLS (one wildcard/multi-SAN cert Cloudflare manages automatically), and simpler cookie-scoping (16.6). Prod subdomains below; `12`'s naming standard adds a flat `-dev` suffix for the dev environment (e.g. `api-dev.agentdisk.io`), not a nested `api.dev.agentdisk.io`, since Cloudflare's free Universal SSL wildcard covers only one subdomain level:

| Subdomain | Serves | Cloudflare product |
|---|---|---|
| `agentdisk.io` | Marketing site / landing / pricing | Cloudflare Pages |
| `app.agentdisk.io` | Dashboard (authenticated SPA) — the customer-facing User panel | Cloudflare Pages |
| `admin.agentdisk.io` | Staff panel (internal only) — separate deployable, separate origin/cookie scope from `app.` on purpose | Cloudflare Pages — see `14-admin-panel-and-billing-design.md` PART 28.1 |
| `api.agentdisk.io` | REST API | Workers (custom domain route) |
| `mcp.agentdisk.io` | MCP server endpoint | Workers (custom domain route) — kept as a distinct hostname from `api.` even though it's the same Worker fleet (PART 14.1), so MCP client configs are unambiguous and future MCP-specific routing/rate-limit rules can attach cleanly |
| `docs.agentdisk.io` | Generated API/MCP documentation | Cloudflare Pages, built from the OpenAPI/MCP schema (PART 25) |
| `files.agentdisk.io` (V2, optional) | Custom domain for signed download/share links, if customers want branded links | R2 custom domain binding |

Setup: add the domain to Cloudflare (nameserver delegation), then `wrangler deploy --routes api.agentdisk.io/*` (and equivalent for `mcp.`) for the Workers-served subdomains, and connect Pages projects to `agentdisk.io`/`app.agentdisk.io`/`admin.agentdisk.io`/`docs.agentdisk.io` via the Cloudflare dashboard or `wrangler pages project create`. TLS is automatic (Cloudflare-managed universal SSL).

### 18.5 Observability (Low-Cost, per the Brief's Cost Constraint)

Tracked, without introducing a third-party paid observability platform for MVP-0/1: **Workers Analytics Engine** (a Cloudflare-native, usage-based, no-fixed-cost time-series store) for request counts/latencies/status-code breakdowns by route; **Workers Logs** (Cloudflare's built-in structured logging, tail-able live and queryable for a retention window) for request-scoped structured log lines (16.18's redaction rules apply before anything is written); D1 queries against `audit_events` for anything customer-facing (the Activity screen, PART 8.20). Specifically tracked: request failures by route and error code, authentication failures (rate over time, to catch a credential-stuffing wave), API usage per workspace (feeds the Usage dashboard, PART 8.19), storage usage trend, upload failures, MCP tool-call errors by tool name, authorization denials (a spike here is either an integration bug on a customer's side or a probing attacker — both worth alerting on), and unhandled Worker exceptions (alert channel: email to the founding team in MVP-0/1; a paid on-call tool is a V2 decision once there's revenue to justify it). **Explicitly not logged**, matching PART 16.18: file contents, secrets, full auth headers.

### 18.6 Project Directory Structure

```
agentdisk/
├── apps/
│   ├── api/                 # Workers: REST + MCP server (one deployable Worker)
│   │   ├── src/
│   │   │   ├── routes/       # REST route handlers, one file per resource
│   │   │   ├── mcp/          # MCP tool handlers (14.4) — call the same services/ as routes/
│   │   │   ├── services/     # business logic: files, folders, agents, keys, workspaces
│   │   │   ├── middleware/   # auth, authz, quota, rate-limit (15–16)
│   │   │   ├── db/           # D1 query layer (the WorkspaceScoped* pattern, 16.1)
│   │   │   ├── jobs/         # Queue consumers: webhook delivery, async processing, reconciliation
│   │   │   └── index.ts
│   │   ├── migrations/       # D1 migrations, sequential, never edited post-apply
│   │   ├── wrangler.toml
│   │   └── test/
│   ├── web/                  # Dashboard SPA (Pages) — customer-facing User panel, PART 8 screens
│   │   ├── src/
│   │   │   ├── routes/       # one per screen in PART 8
│   │   │   ├── components/   # design-system components (PART 7.2)
│   │   │   └── lib/          # API client, auth state
│   │   └── test/
│   ├── admin/                 # Staff panel (Pages), separate deployable & origin — 14-admin-panel-and-billing-design.md PART 28
│   │   ├── src/
│   │   │   ├── routes/       # one per screen in 14 PART 28.2 (Login, Overview, Workspaces, Users, Billing, Audit, Staff Accounts)
│   │   │   ├── components/   # reuses design-system tokens from apps/web, not a second design system
│   │   │   └── lib/          # API client scoped to /v1/staff/*, staff session state
│   │   └── test/
│   └── docs/                 # Generated docs site (Pages), built from openapi.yaml + mcp-tools.json
├── packages/
│   ├── shared/                # Types shared between apps/api and apps/web (generated from OpenAPI)
│   ├── openapi/                # openapi.yaml — canonical source of truth for REST + generated docs
│   └── config/                 # eslint/tsconfig/prettier shared config
├── tests/
│   ├── unit/
│   ├── integration/            # Worker + D1, Worker + R2 (against Miniflare)
│   └── e2e/                    # Playwright, against a deployed preview environment
├── docs/                        # ARCHITECTURE.md, SECURITY.md, DATABASE.md, etc. (PART 25)
├── .github/workflows/           # CI/CD (PART 24)
└── package.json                 # npm workspaces root
```
**Reasoning:** a monorepo with `apps/api` and `apps/web` as clearly separate deployables (one Worker, one Pages project) but sharing generated types from one OpenAPI source of truth directly prevents the exact "docs/pricing/routes drifted apart" failure class documented in AgentStorage (PART 2.10) — there is structurally only one place endpoint shapes are defined.

---

## PART 19 — Cost Model

### 19.0 AgentDisk Plan Limits (the numbers referenced throughout this package)

**PROPOSAL.** Every other document in this set (`02` PART 6.5, `03` PART 8.2/8.19, `05` PART 12.7) refers forward to "PART 19 for exact numbers" — these are those numbers. Modeled on AgentStorage's own hard-cap-not-metered-overage pricing shape (PART 2.5/4.3, a pattern worth keeping for the trust signal it sends) but re-leveled around R2's zero-egress economics, which lets us be meaningfully more generous on egress specifically than a product built on egress-charging storage would be:

| | Free | Pro ($19/mo) | Team ($79/mo) |
|---|---|---|---|
| Storage | 2 GB | 50 GB | 500 GB |
| Files | 5,000 | 100,000 | 1,000,000 |
| Egress/month | 10 GB | 200 GB | 2 TB |
| Requests/month | 100,000 | 2,000,000 | 20,000,000 |
| Max single-file size | 100 MB | 1 GB | 5 GB |
| Agents | 3 | 20 | 100 |
| API keys | 10 | 50 | 500 |
| Workspace members | 1 | 5 | 25 |

These are starting points, not load-bearing commitments — the right numbers should be tuned against real signup/usage data during MVP-0 (per `10-cicd-docs-roadmap-and-recommendation.md` PART 26 Phase 11's cost-reconciliation step), but every quota check, every UI quota bar, and every cost-model assumption elsewhere in this document set assumes a table shaped like this one exists and is enforced server-side at write time (`06` PART 16.1's authorization-middleware-runs-quota-checks-before-business-logic pattern).

### 19.1 Explicit Assumptions

All figures below are **estimates**, not guarantees, and depend on real usage patterns we don't have yet. Stated assumptions: average file size 500KB–2MB (typical for agent-generated documents/artifacts, not video), average workspace stores 200MB–2GB depending on tier, request-to-storage ratio roughly follows AgentStorage's own published plan ratios (PART 2.5) as a reasonable proxy for this product category, and egress is the dominant variable cost risk if any workspace serves files to end users at volume (e.g., an agent generating publicly-served images) — flagged explicitly below.

### 19.2 Cost Driver Reference (Cloudflare published pricing, Sept 2026)

| Component | Pricing shape | Notes |
|---|---|---|
| Workers requests | Free: 100K requests/day. Paid ($5/mo base): 10M requests included, then $0.30/million | The $5/mo Workers Paid plan is the one small fixed cost we recommend accepting early — it also raises CPU-time limits and unlocks Queues/Cron at production-grade limits. |
| Workers CPU time | Included allowance on paid plan, then metered per GB-second | Our handlers are I/O-bound (D1/R2 calls), not compute-heavy, so CPU cost is a minor line item. |
| R2 storage | $0.015/GB-month (first 10GB/mo free) | **No egress fee** — the single biggest structural cost advantage over S3 for this product. |
| R2 Class A ops (writes/lists) | $4.50/million (first 1M/mo free) | Upload, list, create-folder-equivalent operations. |
| R2 Class B ops (reads) | $0.36/million (first 10M/mo free) | Download/get-metadata operations. |
| R2 egress | **$0** | Cloudflare's headline differentiator vs. AWS S3 ($0.09+/GB egress) — directly why R2 was chosen (PART 10.1). |
| D1 | Free: 5GB storage, 25M row reads/day, 50M row writes/day. Paid tier scales from there, metered beyond free allowance | Comfortably covers MVP-0/1 metadata volume even at several thousand active workspaces. |
| KV | Free: 100K reads/day, 1K writes/day. Paid: $0.50/million reads, $5/million writes beyond allowance | Used for caching, not source-of-truth — read-heavy, which is KV's cheap side. |
| Queues | Free: 1M operations/mo. Paid: $0.40/million beyond | Webhook delivery + async processing volume; low at MVP-0/1 scale. |
| Workers AI (if used for OCR/embeddings, V2) | Per-neuron metered, varies by model | Only incurred for workspaces that opt into AI processing (10.6) — not a default cost. |
| Email (verification, notifications) | Third-party provider (e.g., Resend/Postgres-adjacent transactional email), typically free tier to ~3K emails/mo, then a few dollars per additional thousand | Not a Cloudflare product; a small, predictable fixed-ish cost once volume passes the free tier. |
| Auth | $0 — self-built on Workers, no per-MAU vendor fee | Deliberately avoided a per-monthly-active-user auth vendor (e.g., Auth0-style pricing) specifically to keep this line item at zero — see ADR discussion in the roadmap document. |
| Observability | $0 — Workers Analytics Engine + Workers Logs are included in the Workers Paid plan | No separate observability vendor bill in MVP-0/1 (18.5). |

### 19.3 Cost by Growth Stage

**0–100 users (validation stage).** Assume: ~60 active workspaces, ~15GB total stored, well under 1M requests/month. **Fixed cost: $5/month** (Workers Paid plan — the only line item we recommend paying for before revenue, because it's required for Queues/Cron at usable limits and because the free-tier request ceiling is easy to brush against even in early testing). R2 storage (~15GB) and D1 usage stay within free allowances. Email likely stays within a free transactional-email tier. **Total: ~$5–20/month.**

**100–1,000 users.** Assume: ~500 active workspaces, ~250GB total stored (average ~500MB/workspace, consistent with a Free/Pro-heavy mix), a few million requests/month, egress in the tens of GB/month (R2 egress is $0 regardless — this line item is $0 even at this stage, unlike an S3-based competitor). R2 storage: ~250GB × $0.015 ≈ **$3.75/month** (after the 10GB free allowance, effectively ~$3.60). Workers requests: likely still within or just over the 10M included on the $5/mo plan — a few dollars of overage at most. D1/KV/Queues: comfortably within free/low-tier allowances at this volume. Email: likely into a paid tier now, roughly **$10–20/month** depending on provider. **Total: ~$25–50/month.**

**1,000–10,000 users.** Assume: ~4,000 active workspaces, ~2TB total stored, tens of millions of requests/month. R2 storage: 2TB × $0.015/GB ≈ **$30/month**. R2 operations: likely a few dollars/month even at this volume (operations are cheap per-million). Workers requests: at, say, 30M requests/month, that's 20M over the included 10M → 20 × $0.30 = **$6/month**. D1: likely into its metered tier now, but D1's per-row-read/write pricing is low enough that this stays a two-digit-dollar line item, not a dominant one. Email at this volume: **$30–60/month** depending on provider tier. **Total: roughly $100–250/month** — still dramatically below what an equivalent EC2+RDS+ElastiCache+S3-with-egress stack would cost at this traffic level (a rough, directional comparison, not a precise one, since we haven't priced that alternative stack in detail — the point is the order of magnitude, not a specific competing number).

**10,000+ users.** At this point the product has real revenue backing it, and the conversation shifts from "minimize fixed cost" to "cost-per-workspace stays roughly flat as a fraction of that workspace's subscription price" — the architecture's core property (everything scales by usage, nothing by a fixed server count) means there is no re-architecture required to reach this stage; the same Workers/R2/D1/Queues stack scales by simply costing more as usage grows, which is the explicit goal stated in the brief (§10/§54). At this scale it becomes worth evaluating: Durable-Object-backed strict rate limiting more broadly (16.14) as request volume makes KV's eventual consistency slop matter more, R2 storage-class tiering if any workspaces hold large, rarely-accessed archives, and a paid observability tool if Workers Analytics Engine's query ergonomics become limiting — all additive decisions, not rewrites.

### 19.4 What Creates Fixed Monthly Cost (vs. What's Purely Usage-Based)

**Fixed, regardless of usage:** the $5/month Workers Paid plan (recommended from day one), the domain registration (~$10–15/year, negligible monthly), and — once adopted — a transactional email provider's base tier if one has a nonzero minimum (many don't below a few thousand emails/month). **Everything else — R2 storage, R2 operations, D1 reads/writes beyond free tier, KV, Queues, Workers requests beyond free tier — is purely usage-based and literally $0 at zero usage.** This is the direct, load-bearing consequence of the "serverless-first, scale-to-zero" architecture choice: an AgentDisk deployment with zero customers costs roughly $5/month, not the $50–200+/month a minimal always-on VPS + managed Postgres + Redis stack would cost sitting idle.

### 19.5 Realistic Range for Early-Stage Deployment

**$5–20/month** is realistic and achievable for the 0–100-user validation stage, matching the brief's target — achieved specifically because R2's zero-egress pricing and D1/KV/Queues' generous free tiers mean the *only* cost that isn't purely usage-based is the $5/month Workers Paid plan itself. We do not claim $0/month is achievable while remaining production-ready (the free Workers plan's Cron/Queues limits are too restrictive for the reconciliation job and async processing design in PART 10.8/10.6), and we do not claim costs stay under $20/month indefinitely — 19.3's later-stage figures are the honest picture of costs rising *proportionally with paying usage*, not a promise of permanently flat low cost.
