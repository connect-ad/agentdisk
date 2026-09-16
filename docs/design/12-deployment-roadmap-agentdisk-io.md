# AgentDisk → Deployment Roadmap for agentdisk.io

*A concrete, numbered execution plan for taking the design in `01`–`11` and standing up a real, Terraform-managed, GitHub-Actions-deployed system on Cloudflare under the `agentdisk.io` domain. Replaces the placeholder `agentdrive.dev` domain used throughout the earlier design docs. Two environments only (Development, Production) — simpler than the three-tier Dev/Preview/Production model sketched in `07` PART 18.1; a per-PR preview tier can be added later without restructuring anything below.*

Verified against the current (Sept 2026) Cloudflare Terraform provider (`cloudflare/cloudflare` v5.x) before writing this — resource names below are real, not assumed.

---

## Naming Standard (fix this before creating anything)

**Resource name pattern:** `agentdisk-<env>-<resource>`, `env` ∈ `{dev, prod}`.

| Resource | Dev | Prod |
|---|---|---|
| Worker (API + MCP, one fleet) | `agentdisk-dev-api` | `agentdisk-prod-api` |
| D1 database | `agentdisk-dev-db` | `agentdisk-prod-db` |
| R2 bucket | `agentdisk-dev-files` | `agentdisk-prod-files` |
| KV namespace | `agentdisk-dev-cache` | `agentdisk-prod-cache` |
| Queue | `agentdisk-dev-jobs` | `agentdisk-prod-jobs` |
| Dead-letter queue | `agentdisk-dev-jobs-dlq` | `agentdisk-prod-jobs-dlq` |
| Terraform state (separate, own small R2 bucket, not app data) | `agentdisk-tfstate` (one bucket, two keys: `dev/terraform.tfstate`, `prod/terraform.tfstate`) | — |

**Subdomain pattern — flat, not nested.** Use `<service>-dev.agentdisk.io` for dev, not `<service>.dev.agentdisk.io` — Cloudflare's free Universal SSL wildcard only covers one level (`*.agentdisk.io`); a second-level wildcard (`*.dev.agentdisk.io`) needs Advanced Certificate Manager (paid). The flat pattern keeps everything on the free cert.

| Purpose | Prod | Dev |
|---|---|---|
| REST API | `api.agentdisk.io` | `api-dev.agentdisk.io` |
| MCP endpoint | `mcp.agentdisk.io` | `mcp-dev.agentdisk.io` |
| Dashboard (when built) | `app.agentdisk.io` | `app-dev.agentdisk.io` |
| Docs site (when built) | `docs.agentdisk.io` | `docs-dev.agentdisk.io` |
| Marketing | `agentdisk.io` | n/a |

**GitHub naming:** branches `main` (prod) and `dev` (development); GitHub Environments named `Production` and `Development` (exact case, used later in workflow YAML).

---

## Phase A — One-time account & domain setup (manual, human-required)

**1.** Confirm the Cloudflare account that will own everything (you said you already have one). Note its Account ID (Cloudflare dashboard → right sidebar) — you'll need it in every Terraform run.

**2.** Add `agentdisk.io` as a zone in that Cloudflare account (Dashboard → Add a site). Cloudflare gives you two nameservers.

**3.** At your domain registrar, change `agentdisk.io`'s nameservers to the two Cloudflare ones. **This step can't be automated by Terraform and can take anywhere from minutes to ~24h to propagate** — do this first, today, so it's not the thing blocking you later.

**4.** While that propagates: create a Cloudflare API Token (not the legacy Global API Key) at My Profile → API Tokens → Create Token. Give it exactly the permissions Terraform will need: Account → D1:Edit, Account → Workers R2 Storage:Edit, Account → Workers KV Storage:Edit, Account → Workers Scripts:Edit, Account → Workers Routes:Edit, Account → Queues:Edit, Zone → DNS:Edit (scoped to the `agentdisk.io` zone only), Zone → Workers Routes:Edit. Create **two** tokens, not one — see step 5.

**5. Heads-up / decision needed:** Cloudflare API token permissions are granted per *resource type* (e.g., "D1:Edit" for the whole account), not per individual database. That means a single token with D1:Edit can touch **both** `agentdisk-dev-db` and `agentdisk-prod-db` — there's no built-in way to scope a token to "only the dev database" the same way you scope it to "only this DNS zone." So: two tokens from the same account (one used only in the Development GitHub environment, one only in Production) reduces *accidental* cross-environment deploys, but does not give you a hard security boundary — a leaked dev token can still technically reach prod resources. If you need that guarantee to actually hold, the only way is **two separate Cloudflare accounts** (one for dev, one for prod), which is a bigger decision (billing, dashboard-switching, R2 cross-account replication if you ever need it). Recommend: start with one account + two tokens + careful CI scripting (each environment's Terraform/Wrangler commands only ever reference that environment's resource names); revisit two accounts if/when a compliance requirement forces it. Flag this to whoever owns that decision before proceeding.

**6.** Register a small, separate Terraform-state R2 bucket by hand once (`agentdisk-tfstate`) — this is infrastructure-for-the-infrastructure, so it's the one resource created outside Terraform itself (you can't Terraform the bucket that Terraform's own state lives in on day one). Generate R2 API credentials (Access Key ID/Secret) for this bucket specifically (Dashboard → R2 → Manage API Tokens) — these are S3-compatible credentials, separate from the Cloudflare API token above.

---

## Phase B — Repository & branching setup

**7.** Create the GitHub repo (e.g. `agentdisk/agentdisk`), monorepo layout:
```
apps/api/            # the Worker: routes/, mcp/, services/, middleware/, db/, jobs/
infra/terraform/
  modules/agentdisk-stack/     # one reusable module: D1+R2+KV+Queues+DNS+route, parameterized by env
  environments/dev/            # backend config + tfvars, calls the module once
  environments/prod/           # backend config + tfvars, calls the module once
.github/workflows/
  ci.yml                       # lint/typecheck/test/build + terraform plan — runs on every PR
  deploy-dev.yml                # runs on push to `dev`
  deploy-prod.yml               # runs on push to `main`
```
Directory-per-environment (not Terraform *workspaces*) is deliberate: each has its own state file and its own tfvars, so there is no shared state a mistaken `terraform workspace select` could point at the wrong environment — this is what actually delivers "completely separate dev and prod," not just naming discipline.

**8.** Push an initial commit to `main` with that skeleton (empty Worker, empty Terraform modules — content comes in Phase D/E).

**9.** Create the `dev` branch from `main`.

**10.** Set branch protection on `main` (Settings → Branches → Add rule): require a pull request before merging, require the `ci.yml` status check to pass, require branches to be up to date before merging, require at least 1 approving review. No direct pushes to `main` — this is the literal mechanism behind "need PR to move to main branch."

**11.** Decide protection on `dev`: recommend requiring the same CI check to pass (so a broken build never lands even in dev) but allowing direct pushes without a review, to keep day-to-day iteration fast. Tighten later if the team grows.

**12.** Create two GitHub Environments (Settings → Environments): `Development` and `Production`. On `Production`, turn on **required reviewers** (at least one person must approve before a Production deploy job runs) — this is your safety net against a merge-to-main immediately hitting real customer data. **Heads-up:** required reviewers on Environments needs GitHub Team/Enterprise for a *private* repo (it's free on public repos) — check your plan before assuming this gate is available.

---

## Phase C — Secrets & credentials (GitHub side)

**13.** In the `Development` environment, add these repository secrets: `CLOUDFLARE_API_TOKEN` (the dev-scoped token from step 4/5), `CLOUDFLARE_ACCOUNT_ID`, `TF_STATE_R2_ACCESS_KEY_ID`, `TF_STATE_R2_SECRET_ACCESS_KEY`, plus the app's own runtime secrets scoped to dev: `DATABASE_ENCRYPTION_KEY`, `SESSION_SIGNING_KEY` (generate distinct random values per environment — never reuse a prod secret in dev or vice versa).

**14.** In the `Production` environment, add the same secret *names* with prod-scoped values (the other API token, and separately-generated `DATABASE_ENCRYPTION_KEY`/`SESSION_SIGNING_KEY`). Same names across environments means the workflow YAML never needs an `if` branch to pick which secret to read — `environment: Production` vs `environment: Development` in the job does that automatically.

**15.** Confirm nothing above is ever committed to the repo — no `.env` with real values, no hardcoded token in a workflow file. `wrangler.toml`/Terraform `.tfvars` files that reference `${{ secrets.* }}` or `var.*` only, never a literal secret.

---

## Phase D — Terraform: the shared module (built once, used by both environments)

**16.** In `infra/terraform/modules/agentdisk-stack`, define one module taking `environment` ("dev"/"prod") and `subdomain_suffix` ("-dev" or "") as input variables, and creating, per environment, using the real current provider resources: `cloudflare_d1_database`, `cloudflare_r2_bucket`, `cloudflare_workers_kv_namespace`, `cloudflare_queue` (×2, jobs + dlq), `cloudflare_dns_record` (note: renamed from `cloudflare_record` in provider v5 — don't copy an old tutorial using the old name), and `cloudflare_workers_custom_domain` binding `api${subdomain_suffix}.agentdisk.io` / `mcp${subdomain_suffix}.agentdisk.io` to the Worker.

**17. Decision to make explicitly (don't let it default silently):** for the Worker script itself, Cloudflare's own docs recommend a hybrid — Terraform owns the surrounding infrastructure (D1/R2/KV/Queues/DNS/custom domain), while the actual code deploy goes through Wrangler in CI (`wrangler deploy`), because Terraform's Worker-script resources lag behind Wrangler for day-to-day code iteration. Recommend adopting that hybrid rather than trying to push every `wrangler deploy` through Terraform's newer `cloudflare_worker`/`cloudflare_worker_version`/`cloudflare_workers_deployment` trio — simpler CI, and it's the pattern Cloudflare itself documents. If you specifically want 100% of everything (including code releases) as Terraform-applied state, that trio exists and is real, but it's more moving parts for less benefit at this stage — flag if you want that instead.

**18.** Do **not** put `DATABASE_ENCRYPTION_KEY`/`SESSION_SIGNING_KEY` into any `.tf` file, even as a Terraform-managed secret binding. Terraform state is plaintext by default (even in a remote R2 backend) — anyone who can read the state file reads the secret. Push those secrets via `wrangler secret put <NAME> --env <environment>` as a distinct CI step reading from the GitHub Environment secret, never through Terraform. This mirrors the exact "webhook secret must exist encrypted at rest, decrypted only in-memory" discipline already in `06` PART 16.16a — same principle, applied to how it gets *there* in the first place.

---

## Phase E — Terraform: wire up the two environments

**19.** In `infra/terraform/environments/dev/main.tf`, configure the R2-backed remote state (`backend "s3"` block pointed at `agentdisk-tfstate` bucket, key `dev/terraform.tfstate`, using R2's S3-compatible endpoint and the credentials from step 6/13), then call the shared module with `environment = "dev"`, `subdomain_suffix = "-dev"`.

**20.** Mirror that in `infra/terraform/environments/prod/main.tf` — same module, `environment = "prod"`, `subdomain_suffix = ""`, state key `prod/terraform.tfstate`. **Heads-up:** confirm at implementation time whether Terraform's S3-compatible backend has reliable native state locking against R2 specifically (S3-backend locking without a separate DynamoDB-equivalent is a newer Terraform feature and R2's exact compatibility should be verified, not assumed) — if it turns out unreliable, fall back to HCP Terraform's free tier purely for state+locking instead of R2, everything else in this plan is unaffected either way.

**21.** Run `terraform init && terraform plan` locally (or in a throwaway CI run) against `environments/dev` first, review the plan output line by line, then `terraform apply`. Do the same for `environments/prod` only after dev is verified working end to end (Phase G) — don't stand up prod resources before you've proven the dev path once.

---

## Phase F — GitHub Actions pipelines

**22.** `ci.yml` — triggers on every PR into `main` (and pushes to `dev`, for fast feedback): `npm install`, lint, typecheck, unit+integration tests, `npm run build`, `terraform fmt -check` and `terraform plan` (no apply) against both environment directories using read-only credentials, so a PR shows you what *would* change in infrastructure before anyone merges. This is the required status check from step 10.

**23.** `deploy-dev.yml` — triggers on push to `dev`. Job runs `environment: Development` (so it automatically gets that environment's secrets). Steps: checkout → install → build → `terraform apply -auto-approve` in `environments/dev` → `wrangler deploy --env dev` (deploying the Worker to `agentdisk-dev-api`, routed to `api-dev.agentdisk.io`/`mcp-dev.agentdisk.io` by the Terraform-created custom domain bindings) → `wrangler d1 migrations apply agentdisk-dev-db --remote` → a scripted smoke test against `https://api-dev.agentdisk.io/v1/healthz`.

**24.** `deploy-prod.yml` — triggers on push to `main` (i.e., after a PR merges). Job runs `environment: Production` — this is what makes the required-reviewer gate from step 12 actually block the job until someone approves. Same steps as dev, targeted at `environments/prod`, `agentdisk-prod-api`, `agentdisk-prod-db`, `api.agentdisk.io`/`mcp.agentdisk.io`.

**25.** Wire both deploy workflows to fail loudly (not silently continue) on any step failure, and to post the deploy result (success/failure + which environment) somewhere visible (a GitHub deployment status is automatic; a Slack/webhook notification is optional, add later if wanted).

---

## Phase G — First real run, in order

**26.** Merge the Phase B skeleton, then build the actual Worker per `11-backend-implementation-prompt.md`'s Phase 0–3 (foundation, D1 schema, R2 storage core) on the `dev` branch, pushing incrementally — each push runs `deploy-dev.yml` automatically once Phase F exists.

**27.** Once `https://api-dev.agentdisk.io/v1/healthz` responds and a real file round-trips through `agentdisk-dev-files` via a presigned URL, open a PR from `dev` into `main`. `ci.yml` runs; get the review; merge.

**28.** Merging triggers `deploy-prod.yml`; approve the Production environment gate; confirm `https://api.agentdisk.io/v1/healthz` and a real end-to-end file round-trip against `agentdisk-prod-files`/`agentdisk-prod-db`.

**29.** From here, the loop is: branch off `dev` (or work directly on `dev` for small changes) → push → auto-deploys to dev → verify → PR into `main` → review → merge → auto-deploys to prod. Continue through the rest of `11`'s phases (auth, REST API, MCP server, security hardening, testing) inside this same loop rather than as a one-time setup.

---

## Heads-up — open decisions and gaps, collected in one place

- **One Cloudflare account vs. two** (step 5): naming + two tokens reduces accidental cross-environment mistakes but is not a hard security boundary within one account. Decide if that's acceptable or if dev/prod need separate accounts.
- **Terraform state locking on R2** (step 20): verify at implementation time rather than assuming; HCP Terraform free tier is the fallback if R2-backend locking isn't solid.
- **How much of the Worker deploy lives in Terraform vs. Wrangler** (step 17): recommended hybrid (Terraform for infra shell, Wrangler for code) — confirm that's acceptable versus wanting 100% Terraform-applied releases.
- **GitHub Environment required-reviewer gate on a private repo** (step 12): needs a paid GitHub plan; confirm your repo's visibility/plan supports it, or the "approval before prod deploy" safety net won't actually exist.
- **Preview-per-PR tier**: this plan deliberately drops the three-tier Dev/Preview/Production model from `07` PART 18.1 down to two tiers per your instructions. Nothing here blocks adding a per-PR preview environment later (it's just a third copy of the same module with `subdomain_suffix = "-pr-<number>"`), but it's not built now — say so if you actually want it from day one.
- **Dashboard/Pages, docs site**: this roadmap covers the backend (`apps/api`) only, matching `11-backend-implementation-prompt.md`'s scope. `app.agentdisk.io`/`docs.agentdisk.io` are named in the subdomain table for consistency but have no Terraform/workflow steps yet — that's a follow-up roadmap once the backend is live, same sequencing already agreed for the design docs.
