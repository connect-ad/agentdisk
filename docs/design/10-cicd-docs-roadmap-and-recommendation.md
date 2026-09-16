# AgentDisk — CI/CD, Documentation Plan, Roadmap, ADRs & Final Recommendation
### PART 24–26 of the AgentStorage-Inspired Platform Design, plus Architecture Decision Records and the Final Decision Document

All content is **PROPOSAL**.

---

## PART 24 — CI/CD

### 24.1 Pull Request Pipeline (GitHub Actions)

```yaml
name: PR Checks
on: pull_request
jobs:
  checks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm run test:unit
      - run: npm run test:integration   # against Miniflare + local D1/R2 simulation
      - run: npm run build
      - name: OpenAPI contract check
        run: npm run openapi:validate    # fails if generated types drift from openapi.yaml
  preview-deploy:
    needs: checks
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npx wrangler deploy --env preview
        env: { CLOUDFLARE_API_TOKEN: ${{ secrets.CF_API_TOKEN }} }
      - run: npm run test:e2e -- --base-url=https://preview.agentdisk.io
```
Runs on every PR: install → lint → typecheck → unit tests → integration tests → build → (once checks pass) deploy to the preview environment → E2E tests against that live preview deployment. This directly implements the brief's requested PR pipeline shape while adding the preview-deploy-then-E2E step, which catches integration issues unit/mocked-integration tests can't (a real deployed Worker talking to a real preview D1/R2).

### 24.2 Production Pipeline

```yaml
name: Deploy Production
on:
  push:
    branches: [main]
jobs:
  test-and-build:
    # identical checks job as PR pipeline — never deploy anything that didn't pass every check
  deploy:
    needs: test-and-build
    runs-on: ubuntu-latest
    steps:
      - run: npx wrangler d1 migrations apply agentdisk-db --env production
      - run: npx wrangler deploy --env production
      - run: npx wrangler pages deploy apps/web/dist --project-name=agentdisk-app
      - name: Smoke test
        run: npm run test:smoke -- --base-url=https://api.agentdisk.io
      - name: Rollback on smoke-test failure
        if: failure()
        run: npx wrangler rollback --env production
```
`main` → full test/lint/typecheck/build gate (identical to PR checks, run again — never trust a stale PR check result against a `main` that may have merged other changes since) → D1 migrations applied → Worker deployed → Pages deployed → smoke test against the live production URL → automatic rollback (`wrangler rollback`) if the smoke test fails, so a bad deploy self-heals rather than sitting broken until a human notices.

### 24.3 What's Deliberately Not Built

No separate staging *infrastructure* beyond the `preview` environment (one preview tier, not a staging-then-pre-prod-then-prod chain) — unnecessary process overhead at this product's scale, matching the brief's "avoid unnecessary CI infrastructure" instruction. No self-hosted CI runners (GitHub-hosted runners are sufficient at this volume and avoid a whole class of infrastructure-to-maintain). No separate container-build step anywhere in the pipeline — there is nothing containerized in this architecture (18.1's environments are Cloudflare resources, not containers).

---

## PART 25 — Documentation Plan

| Doc | Contents | Source of truth |
|---|---|---|
| `README.md` | What AgentDisk is, quickstart (create a workspace, get a key, make your first API call), links to everything else | Hand-written, kept short |
| `docs/ARCHITECTURE.md` | The diagram and component table from `05-technical-architecture.md` PART 10, kept current as the implementation evolves | Derived from this design doc, then owned by the codebase once implementation starts |
| `docs/SECURITY.md` | Public-facing security posture: what's encrypted, how tenant isolation works at a high level, how to report a vulnerability, what compliance claims we do and don't make (mirrors `06` PART 16's honesty principle — no unsupported claims) | Derived from `06-security-privacy-legal.md` PART 16 |
| `docs/API.md` | Generated from `openapi.yaml` (not hand-maintained prose that can drift) — human-readable rendering of every endpoint in `05` PART 13 | Generated; `openapi.yaml` is canonical |
| `docs/MCP.md` | Generated from the MCP tool-schema source (`05` PART 14.4) — same anti-drift principle | Generated; the tool-schema definitions are canonical |
| `docs/DEPLOYMENT.md` | The exact command sequence from `07-cloudflare-deployment-and-cost.md` PART 18.3, kept current with any real deployment changes | Derived, then owned by the codebase |
| `docs/DATABASE.md` | The schema and migration process from `05-technical-architecture.md` PART 11 | Derived; updated in the same PR as any migration (per the Claude Code prompt's documentation-obligations section) |
| `docs/STORAGE.md` | The R2 key strategy, upload/download flows, signed-URL behavior from `05-technical-architecture.md` PART 12 | Derived |
| `docs/TESTING.md` | The test strategy and how to run each test tier locally/in CI from `09-test-strategy-and-failure-modes.md` PART 21 | Derived |
| `docs/COST.md` | The cost model and its stated assumptions from `07-cloudflare-deployment-and-cost.md` PART 19, updated periodically against real observed usage | Derived, then periodically reconciled against reality |
| `docs/PRIVACY.md` / the public Privacy Policy page | The finalized (post-legal-review) version of `06-security-privacy-legal.md` PART 17.2 | Derived, pending legal review before publication |
| `docs/TERMS.md` / the public Terms of Service page | The finalized (post-legal-review) version of `06-security-privacy-legal.md` PART 17.3 | Derived, pending legal review before publication |

**Docs site (`docs.agentdisk.io`):** built from `openapi.yaml` and the MCP tool-schema file via a static-site generator at build time (part of the CI pipeline, 24.1/24.2), so the *public* docs an agent or developer reads are guaranteed to match the *actual deployed API* — this is the direct, structural fix for AgentStorage's own documented documentation-drift problem (`01` PART 2.10), not just a policy of "try to keep docs updated."

---

## PART 26 — Implementation Roadmap

*Phases 0–1 are what this document set delivers. Phases 2–11 are the forward-looking build, cross-referenced to `08-claude-code-prompt.md`'s phase numbering (shown in parentheses) where the mapping isn't 1:1.*

**Phase 0 — Research.** *Status: complete, delivered in `01-research-and-opportunity.md`.* Objective: understand AgentStorage and the competitive landscape with evidence-tagged findings. Tasks: browser-verified deep dive on agentstorage.ai (site, live API reference, OpenAPI draft, GitHub repo); researched 20 comparable products across 7 categories. Dependencies: none. Deliverables: PART 1–4. Tests: every claim spot-checked against a citable primary source. Definition of done: every claim tagged FACT/INFERENCE/PROPOSAL, sources cited. ✅

**Phase 1 — Design.** *Status: complete, delivered in `02`, `03`, `04`.* Objective: define the product, MVP scope, UX, and design system before any code. Tasks: defined 4 personas; evaluated the full candidate entity hierarchy for MVP inclusion; scoped MVP-0/MVP-1/V2 by value/complexity/cost/risk; specified 27 screens with exact copy; wrote the standalone Claude Design prompt. Dependencies: Phase 0 (the opportunity analysis directly drives what MVP-0 does and doesn't include). Deliverables: personas, entity model, MVP-0/1/V2 scope, full screen specification, Claude Design prompt. Tests: cross-checked screen-by-screen against the MVP-0/1/V2 feature table for consistency. Definition of done: every MVP-0/1 screen specified with states and exact copy; no placeholder text. ✅

**Phase 2 — Foundation** *(Claude Code prompt Phase 0).* Objective: a deployable skeleton. Tasks: monorepo scaffold, TypeScript/lint/format config, empty D1 migration, `wrangler.toml` for dev/preview, CI skeleton. Dependencies: none (can start immediately). Deliverables: a "hello world" Worker responding on `/v1/healthz`, deployed to preview via CI. Tests: `npm run build && npm test` green on an empty scaffold. Definition of done: PR pipeline (24.1) runs successfully end-to-end on this skeleton.

**Phase 3 — Authentication** *(Claude Code prompt Phases 1–2).* Objective: humans and agents can both authenticate. Tasks: D1 schema + tenant-isolated repository layer, email/password + magic-link auth, session/refresh-token handling, API-key generation/hashing/scoping, the authorization middleware chain. Dependencies: Phase 2. Deliverables: working signup/login/logout, working API-key issuance and verification. Tests: the full 21.1 unit-test set for auth/authz/keys, plus SEC-01 through SEC-06 from `09` PART 22.1. Definition of done: cross-tenant-isolation tests pass under the real repository pattern, not just in design.

**Phase 4 — Storage** *(Claude Code prompt Phase 3).* Objective: files and folders work end-to-end. Tasks: R2 key strategy, presigned upload/download, folder CRUD, file CRUD (create/list/get/update/move/copy/delete/restore), quota enforcement, soft-delete + reconciliation Cron. Dependencies: Phase 3 (needs auth/authz to scope everything). Deliverables: a real file can be uploaded, listed, downloaded, moved, deleted, and restored via direct R2 + D1 calls proven by integration tests. Tests: 21.2's Worker+R2/Worker+D1 integration suite, SEC-07 through SEC-10 (path traversal, malformed filenames, oversized uploads, MIME spoofing), the concurrent-upload performance case (22.2). Definition of done: quota cannot be overshot even under concurrent load (tested, not assumed).

**Phase 5 — Agent/API Access** *(Claude Code prompt Phase 4).* Objective: the full REST API is live and documented. Tasks: every endpoint in `05` PART 13, uniform error handling, rate limiting, OpenAPI generation. Dependencies: Phase 4. Deliverables: a complete, generated `openapi.yaml`; every endpoint with happy-path and authorization-denial tests. Tests: SEC-11 through SEC-16 (unauthorized download, expired/replayed signed URLs, brute force, rate-limit behavior, CORS). Definition of done: the generated OpenAPI spec passes a contract test against the real deployed API in CI.

**Phase 6 — MCP** *(Claude Code prompt Phase 5).* Objective: agents can connect over MCP, not just REST. Tasks: the MCP endpoint sharing the REST authorization core, all tools from `05` PART 14.4, per-session rate limiting via Durable Object. Dependencies: Phase 5 (MCP wraps the same service functions REST uses — REST must be solid first). Deliverables: a real MCP client can connect, discover scoped tools, and call them successfully. Tests: MCP+authorization integration tests (21.2), the full E2E "agent reads/writes via MCP" flow (21.3). Definition of done: a tool call outside the key's scope is rejected with a correct MCP-shaped error, verified against a real MCP client, not just a unit test of the handler.

**Phase 7 — Dashboard** *(Claude Code prompt Phase 6).* Objective: the human-facing product is real and complete for MVP-0 (then MVP-1). Tasks: every screen in `03` PART 8's MVP-0 set, wired to the real API; GitHub OAuth. Dependencies: Phase 5 (dashboard consumes the REST API). Deliverables: every MVP-0 user flow completable through the actual UI. Tests: the full E2E suite (21.3), accessibility checks against `03` PART 7.5's baseline. Definition of done: no mock data in the shipped build; Playwright E2E green against a real preview deployment.

**Phase 8 — Security** *(Claude Code prompt Phase 7).* Objective: verify, not just design, every control in `06` PART 16. Tasks: walk the security model top to bottom against the actual implementation; run the full SEC-01–21 test suite; dependency/static-analysis scan. Dependencies: Phases 3–7 (there must be a real system to test). Deliverables: a completed `SECURITY.md` reflecting what's actually true of the shipped system. Tests: all 21 security test cases (`09` PART 22.1) passing. Definition of done: zero unaddressed findings from the scan (fixed or explicitly, documentedly accepted).

**Phase 9 — Testing** *(Claude Code prompt Phase 8).* Objective: close any remaining gap against the full test matrix. Tasks: fill unit/integration/E2E/performance gaps; run the performance matrix (`09` PART 22.2) against a realistic data volume (seed 10,000 files in a test workspace). Dependencies: Phases 3–8. Deliverables: a documented test-coverage summary in `docs/TESTING.md`. Definition of done: no skipped, flaky, or mocked-where-real-was-required tests remain.

**Phase 10 — Deployment** *(Claude Code prompt Phase 9).* Objective: production is live on the real domain. Tasks: create production Cloudflare resources, configure production secrets, run production migrations, deploy Worker + Pages, configure DNS (`07` PART 18.4), run the smoke-test suite. Dependencies: Phases 2–9 all complete and green. Deliverables: `agentdisk.io` / `app.` / `api.` / `mcp.` all live and passing smoke tests. Definition of done: the exact sequence in `07` PART 18.3 completed against real production resources, verified by an external (not just CI-internal) smoke test.

**Phase 11 — Production Hardening** *(Claude Code prompt Phase 10).* Objective: the system is observable, and the cost model is verified against reality. Tasks: wire up Analytics Engine dashboards and error alerting (`07` PART 18.5); after 2–4 weeks of real usage, compare actual R2/D1/Workers costs against `07` PART 19's estimates and reconcile/update the doc; review the backup/recovery gaps disclosed in `09` PART 23.3 and decide whether any need to move up in priority based on real usage patterns. Dependencies: Phase 10, plus real usage time elapsed. Deliverables: an updated `COST.md` reflecting actual figures; a working alert channel for Worker exceptions and authorization-denial spikes. Definition of done: at least one full billing cycle's actual Cloudflare invoice has been compared against the PART 19 model and any material gap is understood and documented.

---

## Architecture Decision Records

**ADR-001: Cloudflare Workers as the compute layer.**
*Context:* need a control-plane compute layer for auth/authz/business logic. *Options:* Cloudflare Workers; a traditional Node.js server on a VM/container platform; AWS Lambda. *Decision:* Cloudflare Workers. *Reason:* zero idle cost, effectively no cold start, colocated bindings to R2/D1/KV/Queues (no network hop for the most common operations), directly satisfies the brief's serverless-first/low-fixed-cost constraint. *Trade-offs:* CPU-time and request-size limits (acceptable — this is a metadata/control-plane workload, not a compute-heavy one, by design, PART 10.4); a Workers-specific runtime (not raw Node) constrains some npm package choices. *Future migration path:* the codebase avoids Workers-only APIs in the service layer (`services/`) where a standard `fetch`/Web-standard API equivalent exists, so a future move to another edge runtime (if ever needed) would primarily touch the thin entrypoint/binding layer, not business logic.

**ADR-002: R2 for object storage.**
*Context:* need durable, cheap, agent/browser-accessible blob storage. *Options:* Cloudflare R2; AWS S3; Google Cloud Storage. *Decision:* R2. *Reason:* zero egress fees (the dominant cost differentiator for a storage-serving product, PART 19.2), native Workers binding, S3-compatible API (portable). *Trade-offs:* smaller ecosystem of third-party tooling than S3; some S3 features/regions may lag. *Future migration path:* R2's S3-API-compatibility means a future multi-cloud or S3 migration is a credentials/endpoint change for anything already written against the S3-compatible surface, not a rewrite.

**ADR-003: D1 over Postgres (Neon/Supabase) for MVP.**
*Context/Options/Decision/Reason:* full comparison in `05-technical-architecture.md` PART 10.3 — D1 chosen for zero-hop colocated access, zero idle cost, and sufficiency for this schema's relational needs. *Trade-offs:* single-writer-per-database ceiling at extreme scale; SQLite dialect, not full Postgres feature set (no `pgvector`, fewer advanced SQL features). *Future migration path:* schema (`05` PART 11.1) deliberately avoids SQLite-only constructs where a Postgres-portable equivalent exists; the concrete trigger for revisiting this decision is sustained D1 write-concurrency ceiling pressure at the "10,000+ users" growth stage (`07` PART 19.3), not a preemptive switch.

**ADR-004: API key architecture (scoped, hashed, sub-key-capable).**
*Context:* agents need credentials distinct from human sessions, safely scopable and revocable. *Options:* a single account-wide static key (rejected — too coarse, mirrors the anti-pattern named in `01` PART 4.1); OAuth client-credentials flow per agent (rejected for MVP — meaningfully more implementation complexity for a machine-to-machine case that doesn't need interactive-user-consent semantics); AgentStorage-style prefixed, hashed, scope-restricted bearer keys with sub-key minting. *Decision:* the third option, detailed in `06-security-privacy-legal.md` PART 15.3. *Reason:* proven pattern (AgentStorage's own good design, PART 4.3), simple to implement and reason about, sufficient scoping granularity for the validated use cases. *Trade-offs:* bearer tokens require careful transport/logging hygiene (addressed in PART 16.4/16.17) since possession alone grants access, unlike a signed-request scheme. *Future migration path:* V2 could add short-lived, signed-request-based credentials for especially security-sensitive workspaces without removing the simpler bearer-key default.

**ADR-005: MCP runs inside the same Workers fleet as REST, not a separate service.**
*Context/Options/Decision/Reason/Trade-offs:* full detail in `05-technical-architecture.md` PART 14.1. *Future migration path:* if MCP-specific traffic patterns ever justify independent scaling/deployment cadence from REST, the shared `services/` layer (PART 18.6 directory structure) means the MCP-specific routing/handshake code could be split into its own Worker without touching business logic — an additive split, not a rewrite.

**ADR-006: Direct-to-R2 uploads/downloads via presigned URLs.**
*Context:* need to move file bytes without the Worker becoming a bandwidth-limited, cost-multiplying proxy. *Options:* proxy all bytes through the Worker; direct presigned-URL upload/download to/from R2. *Decision:* direct, per `05` PART 10.4/12.2/12.3. *Reason:* avoids doubling egress/ingress cost and Worker CPU/request-size limits; directly satisfies the brief's explicit instruction that the Worker act as control plane, not data pipe. *Trade-offs:* slightly more complex client-side upload flow (a create-then-complete round trip, or multipart coordination for large files) versus a single proxied `POST`. *Future migration path:* none needed — this is expected to remain correct at any scale the product reaches.

**ADR-007: Search strategy — filename/metadata now, full-text and vector search deferred.**
*Context/Options/Decision/Reason:* full detail in `05-technical-architecture.md` PART 10.5. *Trade-offs:* MVP-1 search is less powerful than a RAG-style semantic search product — an explicit, deliberate scope limit, not an oversight. *Future migration path:* Vectorize integration (PART 10.5.1) is additive once/if usage data justifies it; no data-model rework required since file metadata already carries the `id` that a future embeddings index would key against.

**ADR-008: Multi-tenancy via workspace-scoped, server-resolved authorization — not client-supplied tenant identifiers.**
*Context/Options/Decision/Reason:* full detail in `06-security-privacy-legal.md` PART 16.1. *Trade-offs:* none meaningful — this is close to a strict-improvement decision (marginally more code structure discipline required, in exchange for a structural rather than convention-based security guarantee). *Future migration path:* if physical (not just logical) per-tenant isolation is ever required by a specific enterprise customer (e.g., a dedicated R2 bucket or D1 database per large customer), the `workspace_id`-scoped repository pattern makes that an additive routing decision (which physical resource does this `workspace_id` map to) rather than an authorization-model rewrite.

---

## Final Recommendation

**Recommended MVP.** Build MVP-0 exactly as scoped in `02-product-and-mvp-scope.md` PART 6.2: org/workspace/agent/API-key model, REST API for folders/files with presigned R2 upload/download, a minimal but real dashboard (file browser, agent management, API keys), workspace-scoped hard-cap quotas, and rate limiting on auth and upload endpoints. Deliberately exclude MCP, OAuth, billing, and team members from MVP-0 — not because they're unimportant, but because sequencing them into MVP-1 (weeks, not months, behind MVP-0) lets the authorization core prove itself under one consumer (REST) before a second consumer (MCP) depends on it.

**Recommended Stack.** Cloudflare Workers (compute/control plane), R2 (object storage), D1 (metadata), KV (cache, rate-limit counters), Queues (async webhook delivery and processing), Durable Objects (narrowly, for MCP per-session strict rate limiting only). No Kubernetes, no VMs, no managed Redis, no managed Postgres in MVP-0/1. TypeScript strict mode throughout.

**Recommended Architecture.** Workers as a stateless control plane in front of D1 (metadata) and R2 (bytes), with clients (browsers and agents alike) talking directly to R2 for upload/download via short-lived presigned URLs — the Worker is never the data pipe. REST and MCP share one authorization core and one service layer, so they can never drift apart in what they permit. Full detail in `05-technical-architecture.md`.

**Estimated Initial Cost.** **$5–20/month** for the 0–100-user validation stage (dominated by the single fixed $5/month Workers Paid plan; everything else is usage-based and near-zero at this volume), rising to roughly **$25–50/month** at 100–1,000 users and **$100–250/month** at 1,000–10,000 users — full breakdown and stated assumptions in `07-cloudflare-deployment-and-cost.md` PART 19. These are estimates, not guarantees, and should be reconciled against real Cloudflare invoices starting in Phase 11 of the roadmap.

**Biggest Technical Risks.** (1) The authorization middleware pattern (`06` PART 16.1) is the single point of failure for tenant isolation — if it's implemented inconsistently across even one handler, that handler becomes a cross-tenant vulnerability; mitigated by making the pattern structural (handlers physically cannot obtain an unscoped database client) rather than a convention to remember, and by the SEC-01–03/19–21 test cases. (2) D1's single-writer-per-database ceiling is a real, if distant, scaling limit (ADR-003) — mitigated by keeping the schema Postgres-portable from day one so it's a migration, not a rewrite, if that ceiling is ever approached. (3) The R2/D1 consistency model is intentionally not fully ACID across both stores (`09` PART 23.2) — mitigated by the disclosed operation-ordering discipline and the reconciliation job, but this remains a real class of edge case to keep monitoring in production, not a solved-and-forgotten problem.

**Biggest Security Risks.** (1) API key handling — a leaked key is a real, high-consequence event given bearer-token possession-equals-access semantics (ADR-004); mitigated by scoping, short defaults, hashing, and the never-log-a-secret discipline (`06` PART 16.4/16.17), but this remains the single most consequential secret in the system and deserves ongoing vigilance (rotation reminders, anomaly detection on key usage patterns, are reasonable V2 hardening candidates). (2) The public, unauthenticated `POST /v1/workspaces` endpoint (kept deliberately, mirroring AgentStorage's validated agent-first UX pattern) is an abuse surface by design — mitigated by Turnstile, tight rate limiting, and small sandbox-tier limits (`02` PART 6.2), but it is the one endpoint in the entire API that accepts unauthenticated traffic and deserves the most monitoring attention. (3) Webhook URLs are the one place the system makes outbound requests based on customer input — an SSRF surface — mitigated by the dual registration-time-and-delivery-time validation in `06` PART 16.11, but any future feature that accepts a customer-supplied URL should be held to this same standard, not assumed safe by analogy.

**Biggest Product Risks.** (1) The core differentiation bet — MCP-native, general-purpose file storage in the specific gap identified in `01` PART 3.3 — depends on that gap actually mattering to developers building agents today; if most agent builders turn out to be satisfied stitching together a memory product plus a sandbox plus a BaaS product (the status quo `01` PART 3 documents), a unified product may be solving a problem developers have already routed around, not one they're actively looking to replace. Mitigated by shipping MCP in MVP-1 (not deferring it) specifically so this bet gets tested early with real usage data, not after months of REST-only development. (2) AgentStorage itself, despite its documented gaps, has first-mover presence in this exact niche and could close the MCP gap before AgentDisk ships — a real competitive-timing risk not fully within this plan's control. (3) The persona split (individual developer vs. team/startup vs. the agent itself as a "user") means the dashboard and the API/MCP surface both need to be genuinely good, not just one — a product that nails the API but ships a weak dashboard (or vice versa) risks looking unfinished to whichever persona hits the weak half first.

**What NOT to Build (explicitly postponed).** MCP in MVP-0 (ships in MVP-1 instead, deliberately sequenced, not cut). Semantic/vector search (V2, conditional on evidence — do not build speculatively, PART 10.5.1). File versioning (V2 — the data-model hook is built in MVP-1, the feature is not). AI document processing/OCR/summarization/embeddings (V2, opt-in, async — never a default cost). SSO/SAML (V2, enterprise-demand-gated). Team members/roles beyond the basic three (V2, only if real customers need more granularity than owner/admin/member). Billing/Stripe integration (MVP-1, not MVP-0 — validate the product loop before building payment infrastructure). A standalone Workspaces list page, in-app documentation pages, and an onboarding-wizard modal flow (deliberately never built as separate screens — covered by simpler existing UI per `03` PART 8.31). Physical (not logical) per-tenant infrastructure isolation, multi-region active-active failover, and a formal RTO/RPO-backed disaster-recovery program (all explicitly deferred, honestly disclosed as gaps rather than silently assumed solved, `09` PART 23.3).

**First 30-Day Build Plan.** Week 1: Phase 2 (Foundation) and start of Phase 3 (Authentication) — scaffold, CI green, D1 schema and repository pattern with cross-tenant-isolation tests passing. Week 2: finish Phase 3 (full auth working end-to-end) and Phase 4 (Storage) — real upload/download/delete/restore against preview R2/D1. Week 3: Phase 5 (REST API complete, generated OpenAPI, rate limiting) and start of Phase 7 (Dashboard) for the MVP-0 screen set, wired to the real API as it lands. Week 4: finish Phase 7, run Phase 8 (Security) against the full SEC-01–21 suite, fix findings, and execute Phase 10 (Deployment) to get a real MVP-0 live on the production domain with a passing smoke test. MCP (Phase 6) deliberately starts in week 5+, after MVP-0 is live and the REST authorization core has run against real traffic for at least a few days.

**First Production Milestone — "MVP Production Ready" Criteria.** AgentDisk is MVP Production Ready when **all** of the following are true: (1) every MVP-0 user flow (`02` PART 6.2's feature list) works end-to-end against the live production URL, verified by the Playwright E2E suite running against production itself, not just preview; (2) every security test case in `09-test-strategy-and-failure-modes.md` PART 22.1 passes against the production deployment; (3) the CI/CD pipeline (`10` PART 24) has successfully completed at least one full automated deploy-to-production cycle, including a rehearsed rollback; (4) `docs/*.md` (PART 25) are present, accurate, and generated (not hand-drifted) for API/MCP surfaces; (5) the Privacy Policy and Terms of Service have completed legal review and are published (not still marked draft, `06` PART 17.2/17.3); (6) observability (`07` PART 18.5) is live and has been proven to actually alert on at least one injected/rehearsed failure (an intentional test exception, not just "the dashboard exists"); (7) the reconciliation job (`05` PART 10.8) has run successfully in production on its real schedule at least once, confirmed by inspecting its output, not just confirmed to be deployed; and (8) actual Cloudflare billing for the first partial month is within a reasonable margin of `07-cloudflare-deployment-and-cost.md` PART 19's 0–100-user estimate, or any material divergence is understood and documented. Meeting all eight is the bar — a product that's merely "the happy path works in a demo" has not met it.
