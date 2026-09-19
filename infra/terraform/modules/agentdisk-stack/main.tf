# AgentDisk per-environment stack.
#
# This module owns INFRASTRUCTURE ONLY. It deliberately contains no application
# secret. DATABASE_ENCRYPTION_KEY / SESSION_SIGNING_KEY are pushed with
# `wrangler secret put` from GitHub Environment secrets, because Terraform state
# is plaintext even in a remote backend — anyone who can read state would read
# the secret. See roadmap step 18.

locals {
  prefix = "agentdisk-${var.environment}"

  api_hostname = "api${var.subdomain_suffix}.${var.root_domain}"
  mcp_hostname = "mcp${var.subdomain_suffix}.${var.root_domain}"

  # Dashboard SPA. Flat suffix, exactly like api./mcp., so the free Universal
  # SSL wildcard (*.agentdisk.io) still covers it — a nested app.dev.<domain>
  # would need paid Advanced Certificate Manager. Doc 12's subdomain table.
  web_hostname = "app${var.subdomain_suffix}.${var.root_domain}"

  # The internal staff console (14 PART 28.1). Its own origin, deliberately -
  # a staff session cookie and a customer session cookie can then never share a
  # cookie scope, which makes "these cannot be confused" true at the browser
  # level rather than by naming convention.
  admin_hostname = "admin${var.subdomain_suffix}.${var.root_domain}"

  worker_name = "${local.prefix}-api"

  # Same agentdisk-<env>-<resource> convention as every other resource here, so
  # the prod names are already correct the day the prod workspace is first
  # applied — nothing about these resources is dev-specific.
  web_worker_name   = "${local.prefix}-web"
  admin_worker_name = "${local.prefix}-admin"

  # Placeholder Worker body. Terraform creates the script so that the custom
  # domain bindings below have an existing service to attach to; Wrangler
  # immediately overwrites the code on the first deploy. See the lifecycle
  # block for why that overwrite does not show up as perpetual drift.
  placeholder_worker = <<-JS
    export default {
      fetch() {
        return new Response(
          JSON.stringify({ status: "provisioned", note: "Awaiting first wrangler deploy." }),
          { status: 503, headers: { "content-type": "application/json" } }
        );
      }
    };
  JS
}

# ------------------------------------------------------------------ D1 ---
resource "cloudflare_d1_database" "main" {
  account_id = var.account_id
  name       = "${local.prefix}-db"

  # Must be set explicitly, not left to default. Omitted, the provider sends
  # `read_replication: null` on any in-place update and Cloudflare rejects the
  # request with "Expected object, received null" (code 7400). Creation still
  # succeeds, so the failure only appears on the SECOND apply - which is exactly
  # when a routine deploy would hit it.
  #
  # "disabled" rather than "auto": read replicas are eventually consistent, and
  # a file-metadata store that answers a read-after-write with stale data would
  # surface as files briefly vanishing after upload. There is no scale argument
  # for replicas at MVP. Revisit when read volume actually justifies it.
  read_replication = {
    mode = "disabled"
  }
}

# ------------------------------------------------------------------ R2 ---
resource "cloudflare_r2_bucket" "files" {
  account_id = var.account_id
  name       = "${local.prefix}-files"
  location   = var.r2_location_hint
}

# ------------------------------------------------------------------ KV ---
resource "cloudflare_workers_kv_namespace" "cache" {
  account_id = var.account_id
  title      = "${local.prefix}-cache"
}

# -------------------------------------------------------------- Queues ---
resource "cloudflare_queue" "jobs" {
  account_id = var.account_id
  queue_name = "${local.prefix}-jobs"
}

# Dead-letter queue. Created here so it exists before the Worker's consumer
# config (in wrangler.toml) references it by name; Wrangler wires the
# consumer -> DLQ relationship at deploy time.
resource "cloudflare_queue" "jobs_dlq" {
  account_id = var.account_id
  queue_name = "${local.prefix}-jobs-dlq"
}

# --------------------------------------------------------------- Worker ---
# Terraform owns the script's EXISTENCE; Wrangler owns its CONTENT.
#
# This split is what makes the roadmap's hybrid model actually work:
# cloudflare_workers_custom_domain requires `service` to name a Worker that
# already exists, but the real code cannot be deployed until D1/KV IDs from
# this same apply are known. Creating a placeholder here breaks that cycle.
resource "cloudflare_workers_script" "api" {
  account_id         = var.account_id
  script_name        = local.worker_name
  content            = local.placeholder_worker
  main_module        = "worker.js"
  compatibility_date = "2026-08-01"

  lifecycle {
    # Everything below is Wrangler's to manage after the first deploy. Without
    # this, every `terraform plan` after a deploy would propose reverting the
    # live Worker to the placeholder above — which would be a live outage
    # triggered by a routine plan/apply.
    ignore_changes = [
      content,
      main_module,
      bindings,
      compatibility_date,
      compatibility_flags,
      migrations,
      observability,
      placement,
      usage_model,
    ]
  }
}

# -------------------------------------------------------- Custom domains ---
# NOTE — deliberate deviation from roadmap step 16, which lists BOTH
# cloudflare_dns_record AND cloudflare_workers_custom_domain for these
# hostnames. Cloudflare creates the DNS record as part of adding a custom
# domain, and explicitly refuses to attach a custom domain to a hostname that
# already has a CNAME. Declaring both would therefore race and fail. The custom
# domain resource is the correct single owner of api./mcp. DNS.
resource "cloudflare_workers_custom_domain" "api" {
  account_id = var.account_id
  zone_id    = var.zone_id
  hostname   = local.api_hostname
  service    = cloudflare_workers_script.api.script_name
}

# A distinct hostname from api., on the same Worker fleet, so MCP client configs
# are unambiguous and MCP-specific routing or rate-limit rules can attach later
# without touching the REST surface (design doc 07 PART 18.4).
resource "cloudflare_workers_custom_domain" "mcp" {
  account_id = var.account_id
  zone_id    = var.zone_id
  hostname   = local.mcp_hostname
  service    = cloudflare_workers_script.api.script_name
}

# ===================================================================== WEB ===
# The dashboard SPA (apps/web), served as a Workers static-assets Worker rather
# than a Cloudflare Pages project.
#
# DELIBERATE DEVIATION from doc 07 PART 18.4, which assigns app.<domain> to
# Cloudflare Pages. Three reasons, in order of weight:
#
#   1. One deploy mechanism. Everything else here is Terraform-for-infra +
#      Wrangler-for-code. A Pages project would add a second, differently-shaped
#      pipeline (`wrangler pages deploy`, its own preview semantics, its own
#      domain attachment) for no capability the SPA actually needs.
#   2. The provider covers Worker custom domains well and Pages projects poorly.
#      cloudflare_workers_custom_domain is already proven in this module for
#      api./mcp.; cloudflare_pages_project + cloudflare_pages_domain is a
#      thinner, more awkward path for the same result.
#   3. Static assets on a Worker are served from Cloudflare's asset store and
#      are not billed as Worker invocations, so the cost argument that once
#      favoured Pages no longer applies.
#
# The SPA is assets-only: apps/web/wrangler.toml declares no `main`, so there is
# no Worker code in front of the assets at all. Terraform still has to create a
# script resource, because a custom domain must bind to a service that exists -
# same bootstrap ordering problem already solved for the API above.

resource "cloudflare_workers_script" "web" {
  account_id         = var.account_id
  script_name        = local.web_worker_name
  content            = local.placeholder_worker
  main_module        = "worker.js"
  compatibility_date = "2026-08-01"

  lifecycle {
    # Same split as the API script: Terraform owns EXISTENCE, Wrangler owns
    # CONTENT. `assets` and `keep_assets` are in this list for a reason specific
    # to this Worker - once Wrangler uploads the SPA bundle, the live script has
    # an asset manifest that Terraform's config does not describe. Without them
    # a routine plan would propose stripping the site's own files.
    ignore_changes = [
      content,
      main_module,
      assets,
      keep_assets,
      bindings,
      compatibility_date,
      compatibility_flags,
      migrations,
      observability,
      placement,
      usage_model,
    ]
  }
}

# No cloudflare_dns_record here, for the same reason as api./mcp. above: adding
# a custom domain creates the DNS record itself, and Cloudflare refuses to
# attach one to a hostname that already has a CNAME. Declaring both races.
resource "cloudflare_workers_custom_domain" "web" {
  account_id = var.account_id
  zone_id    = var.zone_id
  hostname   = local.web_hostname
  service    = cloudflare_workers_script.web.script_name
}

# The staff console (apps/admin), same shape as the dashboard above: an
# assets-only Worker on its own hostname.
#
# Its own origin is the point, not an accident of layout. 14 PART 27.2 gives
# staff a separate session cookie scoped to this hostname alone, so a staff
# credential and a customer credential cannot reach each other in a browser
# even if some future handler were careless. Same-origin would make that a
# matter of naming discipline; a separate origin makes it a matter of the
# browser's own rules.
resource "cloudflare_workers_script" "admin" {
  account_id         = var.account_id
  script_name        = local.admin_worker_name
  content            = local.placeholder_worker
  main_module        = "worker.js"
  compatibility_date = "2026-08-01"

  lifecycle {
    ignore_changes = [
      content,
      main_module,
      assets,
      keep_assets,
      bindings,
      compatibility_date,
      compatibility_flags,
      migrations,
      observability,
      placement,
      usage_model,
    ]
  }
}

resource "cloudflare_workers_custom_domain" "admin" {
  account_id = var.account_id
  zone_id    = var.zone_id
  hostname   = local.admin_hostname
  service    = cloudflare_workers_script.admin.script_name
}

# ----------------------------------------------------- credentials ---
#
# EVERYTHING BELOW THIS LINE PUTS A LIVE CREDENTIAL IN TERRAFORM STATE.
#
# The module header says this file contains no application secret. That is
# still true of DATABASE_ENCRYPTION_KEY and SESSION_SIGNING_KEY, which remain
# GitHub Environment secrets. It is deliberately no longer true of the two
# below, on an explicit decision to trade the rule for removing every manual
# dashboard step from provisioning.
#
# What that costs, stated plainly so nobody rediscovers it during an incident:
# `sensitive` only masks a value in CLI output. State is unencrypted JSON, so
# `agentdisk-tfstate` now holds a live R2 read/write credential for the files
# bucket. Anyone who can read that state can read every file in it. That makes
# R2_STATE_ACCESS_KEY_ID / R2_STATE_SECRET_ACCESS_KEY - the credentials for the
# state bucket itself - the most powerful secrets in the system, above the
# application secrets they were previously beneath.
#
# Consequences to keep in mind:
#   - Never `terraform state pull` to a laptop, or into a CI artifact.
#   - Rotating the state credentials no longer only affects Terraform runs.
#   - A state backup is a credential backup. Treat it accordingly.

# Turnstile gates POST /v1/workspaces, the only endpoint that creates resources
# without a credential (05 PART 13). The domain list belongs in code rather
# than a dashboard form: it is the entire allowlist of origins a challenge may
# be solved on, and it should be reviewed in a PR like any other access rule.
resource "cloudflare_turnstile_widget" "bootstrap" {
  account_id = var.account_id
  name       = "${local.prefix}-bootstrap"
  mode       = "managed"

  # The dashboard is where the widget renders. The API hostname is included
  # because the Worker pins the solved-on hostname against this same list
  # (TURNSTILE_ALLOWED_HOSTNAMES), and a direct API caller solving the
  # challenge itself is a supported agent flow.
  #
  # sort() is not cosmetic. Cloudflare returns this list alphabetically, so
  # declaring it web-first made every single plan see a reorder and propose an
  # in-place update - the same perpetual-diff shape as cloudflare_d1_database's
  # read_replication. It is worse here than a noisy plan: the update round-trips
  # `secret`, so a live credential was being churned on every deploy, and the
  # only reason nothing broke is that CI pushes the secret to the Worker after
  # the apply. Sorting makes config and API agree, so an apply that changes
  # nothing plans nothing.
  domains = sort([
    local.web_hostname,
    local.api_hostname,
  ])
}

# R2 bindings cannot presign - R2Bucket is get/put/head/list - so presigned
# upload and download URLs (05 PART 12.2/12.3) need S3 credentials the binding
# does not carry. Cloudflare derives those from an ordinary API token:
# Access Key ID is the token's id, Secret Access Key is SHA-256 of its value.
# NOTE: this is the *api_token* permission-group list, not
# cloudflare_account_permission_groups. The latter lists the groups used for
# account MEMBER roles and contains no R2 entries at all - it returned an empty
# list on the first apply, which the precondition below caught.
data "cloudflare_account_api_token_permission_groups_list" "token_groups" {
  # Reading this list is itself gated on "API Tokens" permission, so it must
  # disappear entirely when the signing token is not managed here - a data
  # source with no consumer is still read on every plan, and would 403 the
  # whole stack over a resource we deliberately did not ask for.
  count = var.manage_r2_signing_token ? 1 : 0

  account_id = var.account_id

  # "Object Read and Write" in the dashboard's R2 token UI: read, write and
  # list objects within a bucket, with no bucket-management rights at all.
  name = local.r2_permission_group_name
}

locals {
  r2_permission_group_name = "Workers R2 Storage Bucket Item Write"

  # The API's `name` parameter is a filter, not an exact match, so narrow it
  # again here. Relying on the server to return exactly one row would mean a
  # future group called "...Bucket Item Write V2" silently becomes a candidate.
  r2_permission_groups = [
    for group in try(one(data.cloudflare_account_api_token_permission_groups_list.token_groups).result, []) :
    group if group.name == local.r2_permission_group_name
  ]
}

resource "cloudflare_account_token" "r2_signing" {
  count = var.manage_r2_signing_token ? 1 : 0

  account_id = var.account_id
  name       = "${local.prefix}-r2-signing"

  policies = [{
    effect = "allow"

    permission_groups = [{
      id = one(local.r2_permission_groups).id
    }]

    # Scoped to this environment's bucket alone. The account-level alternative
    # ("Workers R2 Storage Write") would also let this token create and delete
    # buckets, which nothing in the application ever needs to do.
    resources = jsonencode({
      "com.cloudflare.edge.r2.bucket.${var.account_id}_default_${cloudflare_r2_bucket.files.name}" = "*"
    })
  }]

  lifecycle {
    precondition {
      condition     = length(local.r2_permission_groups) == 1
      error_message = <<-MSG
        Expected exactly one API-token permission group named
        "${local.r2_permission_group_name}", found ${length(local.r2_permission_groups)}.

        Zero usually means the deploy token cannot read permission groups: it
        needs Account -> API Tokens: Edit, which also lets it create the token
        below. More than one means Cloudflare split or renamed the group.

        Do not guess which match is right - a wrong permission group here
        either breaks presigning or grants this token more than object access.
      MSG
    }
  }
}
