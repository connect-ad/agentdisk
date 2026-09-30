# AgentDisk

Serverless file storage built for AI agents. Files, folders and metadata over
REST and MCP; scoped credentials, hard-capped pricing, no servers to run.

**AgentDisk is the brand; Kernelv5 Inc. (https://kernelv5.com/) is the
company.** The legal name is what Stripe prints on the checkout page and the
card statement, so the site carries it wherever a customer will look, all of
it from one file, `apps/web/src/lib/company.js`.

**Production has been live since 30 September 2026.** Everything before that
date was a build; this page and the skills describe the product as it runs.

---

## Where things are

| Path | Holds |
|---|---|
| `apps/api/` | The Cloudflare Worker: REST at `api.`, MCP at `/mcp`, the hourly cron. MCP tools call the REST handlers, so the two surfaces cannot drift. |
| `apps/web/` | The dashboard and the marketing site, one bundle on two hostnames. Vendored components in `src/components/`, hand-written code in `src/routes/` and `src/components-local/`. |
| `apps/admin/` | The internal console at `securepanel.`. Its own palette, deliberately unlike the dashboard. |
| `apps/cli/` | `npx agentdisk`, a dependency-free client for the REST API. Not yet published. |
| `infra/terraform/` | All infrastructure as code. One root, one module, one workspace per environment. |
| `infra/firebase/` | The Google provider's display config for `firebase deploy --only auth`. |
| `.github/workflows/` | Three areas, `infra`, `backend`, `frontend`, each one reusable engine plus thin per-environment callers. `ci.yml` gates PRs. |
| `Skill/` | How this project is built, deployed and operated, by topic. **Read the skill for the area before touching it.** |
| `design-system/` | Four hand-exported Claude Design artboards and the logo. Read-only; the source of truth is the Claude Design project `d311bfd0-9751-4a9b-84f4-b33e7a09378e`. |
| `docs/` | `USER_TESTING_GUIDE.md`, the walkthrough a person follows, and `ui-layering.md`, which owns the overlay scale. |
| `regression-tests/` | Playwright against a live hostname. |
| `.claude/commands/` | `cpack`, which persists session knowledge into these documents. |

This page is the only index. The root `README.md` is a symlink to it; never
write to `README.md` directly.

**Where the built code and a document disagree, the code wins and the
document gets corrected.**

## Skills

| # | Skill | Read it when |
|---|---|---|
| 1 | [Build](Skill/1%20Build.md) | Running, building, testing, checking conventions, reading a failed run |
| 2 | [Email](Skill/2%20Email.md) | Anything that sends mail, from the Worker or from Firebase |
| 3 | [Deploy](Skill/3%20Deploy.md) | Pipelines, prod approvals, the variable and secret inventory, smoke tests, migrations, the cron |
| 4 | [Infrastructure](Skill/4%20Infrastructure.md) | Terraform, state, custom domains and DNS, the WAF rule, the `cf` CLI, testing from behind the VPN |
| 5 | [Hostnames](Skill/5%20Hostnames.md) | The site and app split, indexing, security headers, prerendering, SEO |
| 6 | [Auth and Firebase](Skill/6%20Auth%20and%20Firebase.md) | Sign-in, the two Firebase projects, the password policy, token verification, administrators |
| 7 | [Billing and Stripe](Skill/7%20Billing%20and%20Stripe.md) | Plans, prices, checkout, the webhook, cancellation, the grace ladder, the live setup |
| 8 | [Storage and Tenancy](Skill/8%20Storage%20and%20Tenancy.md) | Isolation, keys, quota, workspaces, sandboxes, claiming |
| 9 | [Admin Console](Skill/9%20Admin%20Console.md) | Roles, audit, deletion, routing, what the console refuses to render |
| 10 | [Dashboard](Skill/10%20Dashboard.md) | Vendored components, tokens, overlays, focus, the resource cache, route groups |
| 11 | [Operations](Skill/11%20Operations.md) | What is live, what was set up by hand, known gaps, what to check when something stops |

## Rules that apply everywhere

- **Never deploy by hand.** Push to `dev`; merge a PR into `main` for prod
  and approve each prod run in order. Skill 3.
- **Resource IDs, hostnames and secrets are never typed into code.** CI
  injects IDs from Terraform, asserts every hostname against the environment's
  variables, and pipes secrets from GitHub. Skill 3 and 4.
- **Terraform state holds live credentials.** Never pull it to a laptop.
  Skill 4.
- **Every authentication failure returns one identical body.** Skill 6.
- **A handler never gets a raw bucket or database binding.** Skill 8.
- **Every destructive job defaults to reporting** and deletes only when its
  flag is `"true"` in `wrangler.toml`. Skill 3.
- **The plan catalogue is changed by a person in the console and by nothing
  else.** Skill 7.
- **Import components from the barrel, style with tokens, pair every colour
  with a word.** Nothing enforces this; the greps in Skill 1 approximate it.
- **`design-system/` is read-only.** Changes go into Claude Design, then
  re-import.

## Status

```
apps/api   1009 tests · 52 files · typecheck clean
apps/web    469 tests · 41 files · build clean
apps/admin   52 tests ·  4 files · build clean
apps/cli     11 tests ·  1 file
```

Prod: `agentdisk.io`, `app.`, `api.`, `mcp.`, `securepanel.`. Dev: the same
five with `dev.` and `-dev` suffixes, deployed on every push to `dev`. The
four plans are linked to live Stripe. No customers yet. The open work is the
known-gaps list in Skill 11, of which the plan count gates are the one piece
of the billing module left unbuilt.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
