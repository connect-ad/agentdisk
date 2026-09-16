# 014 · R2 signing credential for dev

**Status:** Done (Sept 2026) — Option A. An R2 API token scoped to
`agentdisk-dev-files` is set on the `dev` GitHub Environment as
`R2_FILES_ACCESS_KEY_ID` / `R2_FILES_SECRET_ACCESS_KEY`. The `R2_FILES_` prefix
is deliberate: `R2_STATE_*` sits beside it at repo level and unlocks Terraform
state, so the two must not be confusable. `deploy.yml` maps them onto the
Worker's own `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`, where there is only
one bucket and the shorter name is unambiguous. `manage_r2_signing_token` stays
`false`, so the deploy token never gained API-token minting rights.

Presigned upload and download need `R2_ACCESS_KEY_ID` and
`R2_SECRET_ACCESS_KEY`. Dev has neither, so those two routes refuse. Everything
else works: the inline upload path (doc 05 PART 10.4, files at or below 1 MB)
writes through the R2 binding and needs no credential.

This is the only thing between the current state and roadmap step 27's
file round-trip through `agentdisk-dev-files`.

## Two ways to close it

**A · By hand, once per environment.** Cloudflare dashboard → R2 → Manage API
tokens → **Object Read & Write**, scoped to that environment's bucket. It
returns the Access Key ID and Secret Access Key directly, already derived. Put
both in the GitHub Environment (`dev`).

**B · Let Terraform own it.** Set `manage_r2_signing_token = true`. The resource
and its outputs are already written and gated behind that variable.

## Why B is off by default

B needs `Account → API Tokens: Edit` on `TERRAFORM_CF_ACCESS_TOKEN`, and
Cloudflare does not confine a token holding that permission to minting only
permissions it already has. That turns the deploy token from a credential scoped
to the resources it manages into one that can mint any credential in the
account — a materially worse thing to leak.

The user chose "both Turnstile and R2 via Terraform" **before** that consequence
was known, then added `Turnstile: Edit` alone when it was pointed out. That is
read as choosing A, but it was never stated outright, so the Terraform path is
kept working rather than deleted.

## What is already in place

- `manage_r2_signing_token` (default `false`) gates both the
  `cloudflare_account_token` resource and the permission-group data source. The
  data source needs the gate too: a data source with no consumer is still read
  on every plan, and it was 403ing the whole stack — including the dashboard
  pipeline, which shares the root config — over a resource nobody had asked for.
- `deploy.yml` takes the credentials from either source, preferring Terraform.
  Absent from both is a **warning in dev and fatal in prod**: prod must never
  serve a Worker that looks healthy and fails on a customer's first upload,
  while dev is where this is still being built.
- The Worker fails closed without them (`readSigningConfig` returns null and the
  presign routes refuse), the same way `POST /v1/workspaces` refuses without a
  Turnstile secret.

## Proven

7 Sept 2026: a 2 MB file round-tripped through `agentdisk-dev-files` via a
presigned PUT and a presigned GET, SHA-256 identical in and out. That is
roadmap step 27.

The first attempt failed with `InvalidArgument: Credential access key has
length 64, should be 32` - the Access Key ID field held a Secret Access Key.
See [Skill/1 Build](../Skill/1%20Build.md) for that and the other R2 failure
mode worth recognising on sight.

## Note for whoever does this

Cloudflare's R2 token UI hands over both values ready to use. If a credential is
ever derived by hand instead, the rule is: **Access Key ID is the token's `id`,
Secret Access Key is the SHA-256 of the token's `value`**, not the value itself.
