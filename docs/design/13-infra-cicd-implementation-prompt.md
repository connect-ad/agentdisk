# Claude Code — Standalone Infra & CI/CD Implementation Prompt for AgentDisk (agentdisk.io)

*This prompt executes `12-deployment-roadmap-agentdisk-io.md` step by step. It is scoped to infrastructure, environment separation, and CI/CD only — Terraform, GitHub repo/branch/Environment setup, and GitHub Actions pipelines. It does **not** write the application's business logic — that's `11-backend-implementation-prompt.md`'s job, and it can run before, after, or interleaved with this one (Phase G below is exactly where they meet). Copy-paste this into Claude Code as-is. It assumes `12-deployment-roadmap-agentdisk-io.md` and `07-cloudflare-deployment-and-cost.md` are available in the repo (e.g. `docs/design/`) for reference.*

---

## Prompt

You are setting up the **infrastructure and deployment pipeline** for **AgentDisk**, under the domain **agentdisk.io**, on **Cloudflare**, provisioned with **Terraform**, deployed via **GitHub Actions**, with `main` as production and `dev` as development. The full plan is already decided in `12-deployment-roadmap-agentdisk-io.md` — your job is to execute it, in order, not redesign it. Read that file in full before doing anything else; it is the source of truth for naming, resource lists, and sequencing. This prompt exists to turn its 29 steps into an autonomous, checkpointed execution.

### Read First

1. `12-deployment-roadmap-agentdisk-io.md` — the whole thing. It defines the naming standard, the phase order (A–G), and a "Heads-up" section of open decisions you must not silently resolve yourself.
2. `07-cloudflare-deployment-and-cost.md` PART 18 — background on the environments/Wrangler model this roadmap adapts.
3. Inspect the repository. If `infra/terraform`, `.github/workflows`, or `apps/api` already exist, read them fully before changing anything — do not overwrite unreviewed prior work.

### The Hard Boundary: What You Can Do vs. What Only the Human Can Do

Terraform, GitHub Actions YAML, repo scaffolding, and Wrangler config are all things you write directly. **The following are not** — they require the human to have already done them, or to do them live, because they need access you don't have (a browser session to the Cloudflare dashboard, the domain registrar, or authority to type real secret values):

- Cloudflare account creation, adding `agentdisk.io` as a zone, and the nameserver change at the registrar (roadmap steps 1–3). **Before starting Phase A's remaining steps, ask the human to confirm these three are done** — check with `dig NS agentdisk.io` or equivalent if you have network access; if the zone isn't live yet, stop and wait rather than proceeding on an assumption.
- Creating the Cloudflare API token(s) and the R2 state-bucket S3 credentials (steps 4–6). You can tell the human exactly which permissions to grant (the roadmap lists them) and generate the `terraform init`/`wrangler login` commands that will consume them, but you cannot create these credentials yourself. Ask for them to be placed in your local environment (`.dev.vars`, shell env, or however this Claude Code session receives secrets) — never ask the human to paste a raw secret value into the chat/prompt itself.
- Entering the actual secret **values** into GitHub Environment secrets (steps 13–14). You can create the Environment *shells* via `gh api` if the `gh` CLI is authenticated with sufficient permissions, and tell the human the exact secret **names** each Environment needs (from the roadmap's Phase C), but the human enters the values themselves in the GitHub UI or via `gh secret set` run under their own authentication — not yours.
- Approving a Production deploy behind the required-reviewer gate (step 12's protection). Never attempt to bypass, disable, or self-approve this gate, even if it's blocking your own progress — that gate is the point.
- The "Heads-up" decisions in the roadmap (one-account-vs-two, R2 state-locking reliability, Terraform-vs-Wrangler split for Worker releases, GitHub plan supporting required reviewers, whether a preview-per-PR tier is wanted now). These are marked as open in the roadmap precisely because they need a human answer — surface them using the Decision format below at the point each becomes actionable, don't assume the roadmap's stated default is automatically approved.

If you hit a step above and the prerequisite isn't in place, stop, state plainly what you need and from whom, and don't fabricate a workaround (e.g., don't hardcode a token, don't skip the state backend and use local state "for now" without flagging it).

### Build Order

**Phase 0 — Verify prerequisites.** Confirm the human has completed the manual account/domain steps (roadmap Phase A, steps 1–6) before writing any Terraform. Confirm your working environment actually has `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and the R2 state-bucket credentials available (as env vars or a `.dev.vars`-equivalent) — do not proceed to Phase 1 on a guess that they'll show up later. **DoD:** you can run `wrangler whoami` and a minimal `terraform init` (even against an empty config) successfully.

**Phase 1 — Repository & branching scaffold (roadmap steps 7–12).** Create the monorepo directory structure exactly as specified (`apps/api`, `infra/terraform/modules/agentdisk-stack`, `infra/terraform/environments/{dev,prod}`, `.github/workflows`). Initialize `main`, create `dev` from it. If `gh` CLI is authenticated with admin rights on the repo, configure branch protection on `main` (PR required, status check required, 1 approval, no direct pushes) and create the `Development`/`Production` GitHub Environments with the Production required-reviewer rule; if `gh` isn't available or lacks permission, produce the exact settings as a checklist for the human to apply in the GitHub UI instead of skipping this silently. **DoD:** repo skeleton exists on `main`; `dev` branch exists; branch protection and Environments are either configured or handed to the human as an explicit checklist (never just omitted without saying so).

**Phase 2 — Terraform shared module (roadmap steps 16–18).** Write `infra/terraform/modules/agentdisk-stack` taking `environment` and `subdomain_suffix` as inputs, creating (per the roadmap's naming table) one each of `cloudflare_d1_database`, `cloudflare_r2_bucket`, `cloudflare_workers_kv_namespace`, two `cloudflare_queue` (jobs + dlq), and `cloudflare_dns_record`/`cloudflare_workers_custom_domain` bindings for the API and MCP subdomains. Use the module to provision infrastructure only — the Worker's actual code deploy stays on Wrangler in CI (the roadmap's stated hybrid), unless the human has explicitly said otherwise per the Phase D decision. Do not write any application secret (`DATABASE_ENCRYPTION_KEY`, `SESSION_SIGNING_KEY`, etc.) into any `.tf` file or Terraform variable that would land in state — those are pushed via `wrangler secret put` in the CI workflow, sourced from GitHub Environment secrets, full stop. **DoD:** `terraform validate` passes on the module in isolation; a code review of the module contains zero secret material.

**Phase 3 — Wire the two environments (roadmap steps 19–21).** Create `infra/terraform/environments/dev` and `.../prod`, each with its own backend block pointed at the shared `agentdisk-tfstate` R2 bucket under a distinct state key (`dev/terraform.tfstate`, `prod/terraform.tfstate`), each calling the Phase 2 module with the correct `environment`/`subdomain_suffix`. Run `terraform init && terraform plan` for `dev` first and show the plan to the human before applying — do not `apply` unreviewed infrastructure changes on a first run. Only after dev is applied and verified (Phase 5 below) do the same for `prod`. **DoD:** `terraform plan` is clean (no errors, matches expected resource list) for both environments; `dev` is applied; `prod` is applied only after Phase 5 passes on dev.

**Phase 4 — GitHub Actions pipelines (roadmap steps 22–25).** Write `ci.yml` (install → lint → typecheck → test → build → `terraform fmt -check` and `terraform plan` against both environment directories with read-only credentials — this becomes the required status check from Phase 1). Write `deploy-dev.yml` (triggers on push to `dev`, runs under the `Development` GitHub Environment, `terraform apply` for `environments/dev`, `wrangler deploy` targeting `agentdisk-dev-api`, D1 migrations against `agentdisk-dev-db`, then a scripted smoke test against `https://api-dev.agentdisk.io/v1/healthz`). Write `deploy-prod.yml` (triggers on push to `main`, runs under the `Production` GitHub Environment so the required-reviewer gate applies, otherwise identical shape targeting the prod resource names and `https://api.agentdisk.io`). Every step must fail loudly on error — no swallowed exit codes, no `continue-on-error` on anything that matters. **DoD:** a deliberately-broken PR is correctly blocked by `ci.yml`; a push to `dev` triggers `deploy-dev.yml` end to end (even against a still-minimal "hello world" Worker at this stage — full app logic comes from `11`'s phases).

**Phase 5 — First verified loop (roadmap steps 26–29).** Once Phases 1–4 are in place, this is where `11-backend-implementation-prompt.md`'s own phases actually get built and shipped: work happens on `dev`, pushes auto-deploy to `api-dev.agentdisk.io`, and once verified, a PR into `main` (passing `ci.yml`, reviewed, merged) auto-deploys to `api.agentdisk.io` behind the Production approval gate. If `11`'s prompt hasn't been run yet, hand off to it explicitly now rather than writing application routes yourself under this prompt's scope. **DoD:** one real end-to-end round trip (a "hello world" `/v1/healthz` is enough at minimum) has gone `dev` push → auto-deploy → verified → PR → merge → auto-deploy → verified on `main`, proving the whole pipeline works before real feature work piles on top of it.

### When to Stop and Ask

Use this format for every "Heads-up" item from the roadmap, and for anything else genuinely undocumented:

```
Decision required:
Option A: <description>
Option B: <description>
Recommendation: <which, and why>
Reason: <the tradeoff driving the recommendation>
Impact: <what happens if we proceed with the recommendation vs. wait for an answer>
```

Do not silently pick the roadmap's stated "default" recommendation and proceed as if it were already approved — the roadmap explicitly separates "decided" from "flagged," and the flagged items need an actual answer from whoever owns Cloudflare billing/account structure and GitHub plan/permissions.

### Quality Bar

When this prompt is complete: a fresh clone of the repo, with only the GitHub Environment secrets populated by a human, can run `terraform plan` cleanly against both `environments/dev` and `environments/prod`; a push to `dev` deploys to `agentdisk-dev-*` resources and passes a smoke test against `api-dev.agentdisk.io` with no manual steps; a PR into `main` is blocked until CI passes and it's reviewed; merging it deploys to `agentdisk-prod-*` resources and `api.agentdisk.io` only after a human approves the Production Environment gate. Every credential lives in a GitHub Environment secret or was generated by Terraform/Wrangler at apply/deploy time — none appear in any committed file, Terraform state committed to the repo, or workflow log.
