# 4 · Infrastructure

Terraform, Cloudflare resources, DNS, and the credentials that hold it together.
Pipelines are [3 Deploy](3%20Deploy.md); hostnames are [5 Hostnames](5%20Hostnames.md).

---

## Layout

One root config in `infra/terraform/`, one module in `modules/agentdisk-stack`,
**one workspace per environment** (`dev`, `prod`) sharing the `agentdisk-tfstate`
bucket. There are no `environments/` directories.

The environment is derived from `terraform.workspace` and nowhere else. A
`terraform_data` precondition hard-fails any other workspace, `default`
included, and CI re-asserts `terraform workspace show` after selecting and
before applying, because workspace selection is mutable CLI state and a stale
selection is the one way this layout can apply dev intent to prod.

**Terraform >= 1.11 is mandatory.** Native S3-backend locking (`use_lockfile`)
is the only locking that works against R2 and went GA in 1.11; on 1.6.x the
backend silently runs with no locking at all.

## What the stack creates

Per environment: a D1 database, an R2 files bucket with CORS, a KV namespace,
a jobs queue and its dead-letter queue, a Turnstile widget, the API Worker with
custom domains on `api` and `mcp`, the dashboard Worker with custom domains on
`app`, the site (`dev.agentdisk.io` or the apex) and, on prod, `www`, and the
admin Worker on `securepanel`. Prod was first applied on 30 September 2026:
fifteen resources, then two more domains the same day.

The Worker scripts are placeholders. Terraform owns their **existence**;
Wrangler owns their **content**, and `ignore_changes` covers everything
Wrangler writes. **A Worker that owns static assets needs `assets` and
`keep_assets` in that list**, or a routine plan proposes stripping the
deployed site's own files.

## State is a secret store

The original rule was "no secret ever enters Terraform". It was amended
deliberately: the stack creates the Turnstile widget and, when
`manage_r2_signing_token` is on, the R2 signing token, so provisioning needs
no dashboard step. `sensitive` only masks a value in CLI output; state is
unencrypted JSON. Consequences:

- Never `terraform state pull` to a laptop or into a CI artifact. A state
  backup is a credential backup.
- `terraform output -json` includes sensitive values in full. CI deletes that
  file the moment it is done with it, and the frontend pipeline reads named
  outputs only.
- `DATABASE_ENCRYPTION_KEY` and `SESSION_SIGNING_KEY` still never touch
  Terraform. They stay GitHub Environment secrets.
- Creating the signing token needs Account → API Tokens: Edit on the deploy
  token, and Cloudflare does not restrict a token to minting only what it
  already holds. A leak of `TERRAFORM_CF_ACCESS_TOKEN` is full account
  compromise.

Prod's R2 signing credential was made by hand in the dashboard (Object Read &
Write, scoped to `agentdisk-prod-files`) and stored as `R2_FILES_*` on the prod
environment, rather than through Terraform.

## Custom domains and DNS

A Workers custom domain **creates its own DNS record**. There is deliberately
no `cloudflare_dns_record` beside it: declaring both races, and Cloudflare
refuses to attach a domain to a hostname that already carries a record. That is
why the first prod apply of the site needed two GoDaddy A records and a `www`
CNAME deleted by hand first, and why a "record already exists" error on a
domain resource means somebody re-added one.

The apex keeps its MX rows (Cloudflare Email Routing), SPF, DKIM, DMARC, the
Firebase DKIM CNAMEs, the `firebase=` and Google site-verification TXT rows.
None of them conflicts with a Worker domain. In an export, Worker-backed
hostnames do not appear; that is normal.

Every hostname is flat (`app-dev.`, never `app.dev.`) so the free Universal SSL
wildcard covers it. `www.dev.agentdisk.io` would need a paid certificate, which
is why dev has no `www`.

## Reading and writing DNS from a machine

Cloudflare's own `cf` CLI is installed globally and signed in with OAuth as the
account that owns the zone. It is the tool that can list and delete records;
Wrangler's login has `zone:read` only and never will have more.

```bash
cf dns records list --zone agentdisk.io --name www.agentdisk.io
cf dns records delete <record-id> --zone agentdisk.io --force
```

Its JSON output follows a banner; parse from the first `[`.

## Perpetual diffs

A green plan on an unmodified tree says `No changes`. `0 to add, 1 to change`
forever is a defect, and it has happened twice: `cloudflare_d1_database` sends
`read_replication: null` on update, and `cloudflare_turnstile_widget` returns
its `domains` list sorted, so any other declared order re-applies on every run
and round-trips the widget's secret. Both are fixed and commented. Chase the
next one rather than learning to ignore it.

## The one thing not in code

The zone has a WAF rate-limiting rule, *Rate limit sandbox creation
(POST /v1/workspaces)*, rule ID `19943058f8c14b89bb894df8528e3dd4`, made in
the dashboard on 28 September 2026: expression
`http.request.uri.path eq "/v1/workspaces"`, ten-second block, answered as
429 with body `error code: 1015`. The Terraform token lacks Zone WAF: Edit and
a zone allows one rate-limit ruleset, so Terraform would have to import it.

On the Free plan a rate-limiting expression may use only the Path and Verified
Bot fields; a method match is accepted and silently never evaluated, which is
why the original rule counted nothing. The path-only rule also counts the
dashboard's `GET /v1/workspaces`, so its threshold must stay well above one
page load.

## Testing anything per-IP from this machine

The development machine sits behind a VPN that hands every TCP connection a
different address. A loop of separate `curl` calls never presents one IP to a
rate limit, the Worker's KV limit or the unclaimed-sandbox cap. Send every
request over one connection: one `curl` invocation with many URLs. The same
VPN's resolver caches a negative answer for a hostname probed before it exists,
so a brand-new hostname "fails to load" locally for up to an hour after it is
live; prove it with `https://cloudflare-dns.com/dns-query?name=<host>&type=A`
or the pipeline's smoke test instead.

## Faults found only by running it

`wrangler deploy` refuses a declared queue consumer when the Worker exports no
`queue` handler. Wrangler silently enables `workers.dev` and preview URLs,
publishing a second public hostname that bypasses the custom domains; every
`wrangler.toml` sets both off and every smoke test checks. `firebase deploy
--only auth` silently resets `passwordRequired`, turning email-link sign-in off
on every run.
