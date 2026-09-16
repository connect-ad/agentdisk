# 013 · Deploy the dashboard to `app-dev.agentdisk.io`

**Status:** Done — 2026-09-06

The follow-up doc 12's closing scope note deferred: `app.agentdisk.io` /
`app-dev.agentdisk.io` were named in the subdomain table but had no Terraform or
workflow steps. This is those steps.

## What was built

- `infra/terraform/modules/agentdisk-stack/main.tf` — a `cloudflare_workers_script`
  (`agentdisk-<env>-web`) plus a `cloudflare_workers_custom_domain` for
  `app<suffix>.agentdisk.io`, additive to the existing module. Same
  placeholder-plus-`ignore_changes` split already used for the API Worker:
  Terraform owns the script's existence so the custom domain has a service to
  bind to, Wrangler owns its content.
- `apps/web/wrangler.toml` — assets-only Worker, `workers_dev`/`preview_urls`
  off, `not_found_handling = "single-page-application"`.
- `apps/web/scripts/smoke-test.mjs` — post-deploy verification.
- `.github/workflows/deploy-web-dev.yml` — build-gated deploy on push to `dev`.
- GitHub `dev` environment variables `WEB_DOMAIN` and `WEB_WORKER_NAME`.

## Decisions

### Workers static assets, not Cloudflare Pages

Doc 07 PART 18.4 assigns `app.` to Pages. Deviated deliberately: everything else
here is Terraform-for-infra + Wrangler-for-code, and a Pages project would add a
second differently-shaped pipeline for no capability the SPA needs. The provider
also covers `cloudflare_workers_custom_domain` well — already proven for
`api.`/`mcp.` — and Pages projects poorly. Static assets are not billed as Worker
invocations, so the old cost argument for Pages no longer applies.

Doc 07 PART 18.4 should be corrected to match, per CLAUDE.md's precedence rule.

### Assets-only: no `main` in `wrangler.toml`

There is no Worker entrypoint at all, so no invocation to pay for and no
request-path code that can fail. Adding a `main` later (to inject headers, say)
is a one-line change.

### react-router 6 → 7: kept

The uncommitted bump predated this session and had never been verified. It is
**not** an arbitrary bump — it is the output of `npm audit fix --force`, and it
closes two moderate advisories against `react-router` 6.0.0–7.17.0:

- **GHSA-wrjc-x8rr-h8h6** (CVE-2026-53669) — open redirect via backslash in
  `<Link>` and `useNavigate`, an incomplete-fix follow-up to CVE-2025-68470.
  Both APIs are used throughout, including `routes/Auth.jsx`.
- **GHSA-337j-9hxr-rhxg** — constructor injection via `deserializeErrors()` in
  SSR hydration. Not reachable here; this SPA does not server-render.

**There is no patched 6.x.** `6.30.6` is the latest of that line and is still
vulnerable; the fix landed in `7.18.0`. So the choice was v7 or a known open
redirect on a public hostname — not "current baseline vs. upgrade".

Verified rather than assumed: `npm ci` clean, `npm audit` reports 0
vulnerabilities, build clean, and every route renders in headless Chrome. The
app uses only declarative APIs (`BrowserRouter`, `Routes`, `Route`, `Navigate`,
`Outlet`, `Link`, `useNavigate`, `useParams`, `useLocation`) whose signatures are
identical across v6 and v7.

**`Skill/1 Build.md` is now stale** and needs updating by whoever owns it: it
records `react-router-dom ^6.26.2` and a build baseline of 81 modules /
271.50 kB JS. The current baseline is **89 modules / 289.11 kB JS**; CSS is
unchanged at 37.10 kB. Its "Deploy" section — "Nothing is deployable yet" — is
also now wrong for `apps/web`.

### Separate workflow, separate concurrency group

`deploy-web-dev.yml` is not another caller of `deploy.yml`, because that
workflow's D1 migrations, `wrangler secret put` and `/v1/healthz` smoke test are
all meaningless for static files. It copies the shape — `backend.hcl`
construction, workspace select-then-re-assert, Terraform output as the source of
truth — without the API-specific steps.

Its concurrency group is `deploy-web-dev`, deliberately **not** the shared
`deploy-dev`. GitHub keeps only one pending run per group, so sharing would let a
burst of pushes silently drop a queued dashboard deploy — a deploy that vanishes
without failing. The cost is possible Terraform state-lock contention with the
API deploy, handled loudly by `-lock-timeout=10m`.

## Verified

Against the live `https://app-dev.agentdisk.io`, not just a green workflow:

- Root serves the built SPA shell with its hashed bundle, not the Terraform
  placeholder Worker.
- Deep links (`/login`, `/signup`, `/w/acme-research/files`) return 200 and the
  SPA shell — `not_found_handling` working.
- Cloudflare's API reports `workers.dev` and preview URLs disabled for
  `agentdisk-dev-web`, and the constructed `*.workers.dev` hostname does not
  serve the app.

## Not done

- **Prod.** The `prod` workspace has never been applied and stays that way. The
  `[env.prod]` block and the `subdomain_suffix = ""` naming are written to be
  correct when it is, but nothing here deploys them.
- **No `ci.yml` integration.** `apps/web` is still absent from the PR gate; only
  this deploy workflow builds it.
- **No lint/typecheck/test for `apps/web`.** The build is the only gate. See
  [010](010-test-suite.md).
- **Sourcemaps are published.** `vite.config.js` sets `sourcemap: true`, so
  `dist/assets/index-*.js.map` (~1 MB) is uploaded and publicly fetchable.
  Harmless for a mock-data dev dashboard and useful for debugging; revisit
  before prod, when the bundle will contain real API wiring.
