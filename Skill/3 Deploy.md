# 3 · Deploy

How code reaches dev and prod, what gates it, and what each pipeline needs.
Infrastructure itself is [4 Infrastructure](4%20Infrastructure.md).

---

## Never deploy by hand

Push to `dev` and let the pipeline run. It applies Terraform, injects resource
IDs into `wrangler.toml` from `terraform output`, pushes secrets, applies D1
migrations, deploys, and smoke-tests the live hostname. A hand deploy ships a
`wrangler.toml` full of `TF_OUTPUT_*` placeholders.

## Three areas, one engine each

| Engine | Callers | Owns |
|---|---|---|
| `infra.yml` | `infra-dev.yml`, `infra-prod.yml` | `terraform apply`. **The only pipeline that writes state.** |
| `backend.yml` | `backend-dev.yml`, `backend-prod.yml` | The API Worker: secrets, migrations, deploy, smoke test |
| `frontend.yml` | `frontend-web-*.yml`, `frontend-admin-*.yml` | The dashboard and the console, one call per app |

Every caller is dispatchable. `ci.yml` gates pull requests: lint, typecheck,
tests and builds for all three apps, plus `terraform plan` for **both**
workspaces, so a PR into `main` shows the prod plan before anyone merges it.
`deploy-all-dev.yml` runs the three dev areas in order by hand.

Path filters mean a push touching only `apps/web` moves nothing else. **The
cost is a race**: a push touching both `infra/terraform` and an app runs the
two pipelines in parallel, and the app may read pre-apply outputs. Every name
the app pipeline reads is asserted against the environment's variables, so the
dangerous version fails loudly; for the benign version re-run the app pipeline.
The first prod deploy hit exactly this, and the three app runs were re-run
after the apply.

## Dev

A push to `dev` deploys. Nothing waits for approval. The dashboard, the
console and the API each finish with a smoke test against the live hostname,
and a red smoke test is the only thing that turns a missing header or a stale
bundle into a red pipeline.

## Prod

Three gates, set on 30 September 2026 and verified through the API:

1. **`main` accepts only pull requests**, admins included. The two required
   checks are named `App (lint, typecheck, test, build)` and
   `Terraform (fmt, validate)`; renaming either job leaves every PR waiting on
   a check that never reports. Zero approvals are required, because GitHub
   never lets the author approve their own PR and there is one author.
2. **The `prod` environment deploys from `main` only.** A dispatch on `dev`
   is refused.
3. **Every prod job waits for a reviewer**, and admins cannot bypass it. The
   reviewer is the repository owner.

The merge starts all four prod pipelines at once. Approve them in order and
wait for each to succeed:

1. **Infrastructure prod**
2. **Backend prod**
3. **Frontend web prod**
4. **Frontend admin prod**, unaffected by ordering

A run that started before the apply it depends on fails at its assertion step.
Re-run it with `gh run rerun <id> --failed`; the re-run waits for approval
again.

## What the pipelines read

Repository-level, shared by both environments:

| | Holds |
|---|---|
| `CF_ACCOUNT_ID`, `CF_ZONE_ID`, `DOMAIN_NAME`, `TFSTATE_BUCKET` | Cloudflare identifiers, the zone, the state bucket |
| `TERRAFORM_CF_ACCESS_TOKEN` | The deploy token. Can mint API tokens; a leak is full account compromise |
| `R2_STATE_ACCESS_KEY_ID`, `R2_STATE_SECRET_ACCESS_KEY` | The state bucket. **The most powerful secrets in the system**, because state holds live credentials |
| `GH_BOOTSTRAP_PAT` | Repository bootstrap |

Per environment (`dev`, `prod`), variables:

| | Meaning |
|---|---|
| `ENVIRONMENT`, `WORKER_NAME`, `D1_DATABASE`, `R2_BUCKET` | Asserted against Terraform's outputs before anything deploys |
| `API_DOMAIN`, `MCP_DOMAIN`, `WEB_DOMAIN`, `SITE_DOMAIN`, `ADMIN_DOMAIN` | The five hostnames |
| `WEB_WORKER_NAME`, `ADMIN_WORKER_NAME` | The two asset Workers |
| `FIREBASE_PROJECT_ID`, `VITE_FIREBASE_*` | The Firebase project and its public web config |

Per environment, secrets:

| | Pushed to the Worker as |
|---|---|
| `DATABASE_ENCRYPTION_KEY`, `SESSION_SIGNING_KEY` | Same names. Never touch Terraform |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Same names. **Both or neither**; one alone fails the deploy |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Same name. The whole key file. **Missing is fatal in prod, a warning in dev** |
| `R2_FILES_ACCESS_KEY_ID`, `R2_FILES_SECRET_ACCESS_KEY` | `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`. Named differently in GitHub so they can never be confused with the state pair beside them |

Secrets are piped to `wrangler secret put` from stdin, never passed as
arguments. **A changed secret does not reach the Worker until a deploy runs**;
updating GitHub and retrying the request tests the old value.

Resource IDs are never typed by hand. `apply-tf-outputs.mjs` writes them into
`wrangler.toml` from `terraform output -json`, and that JSON includes sensitive
values in full, so the job deletes it as soon as it is used.

## Smoke tests

Each app has `scripts/smoke-test.mjs`. They are stricter than "the deploy
exited 0", because an asset deploy can succeed and still serve the Terraform
placeholder, break every deep link, or publish a `workers.dev` bypass.

The dashboard's checks the root, a hashed asset, the SPA fallback, the three
prerendered pages, the absence of a source map, the `workers.dev` and preview
hostnames, the five security headers, indexing in the direction the
environment demands, and on a split deploy the marketing host, its redirects
and the `www` alias. Header rules propagate after asset content, so it polls
for about a minute before failing section 5.

To run one by hand against a live environment:

```bash
cd apps/web && ENVIRONMENT_NAME=prod SITE_URL=https://agentdisk.io WWW_URL=https://www.agentdisk.io \
  node scripts/smoke-test.mjs https://app.agentdisk.io agentdisk-prod-web
```

Without `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` section 4 reports
one expected failure.

## Migrations

`backend.yml` runs `wrangler d1 migrations apply --remote` **before** the code
deploy, so new code never meets an old schema. That assumes additive,
backward-compatible migrations. Prod received all 34 on its first deploy.

## The cron

Both environments run the Worker's `scheduled` handler at 17 minutes past
every hour. It reaps files whose delete was interrupted between D1 and R2,
purges expired share links, reconciles usage counters, runs the sandbox sweep,
the billing ladder, the admin purge and the erasure notices. Three of those
default to reporting and delete only when their flag is `"true"` in
`wrangler.toml`: `SANDBOX_EXPIRY_ENABLED` (dev true, prod false),
`BILLING_EXPIRY_ENABLED`, `ADMIN_PURGE_ENABLED`.
