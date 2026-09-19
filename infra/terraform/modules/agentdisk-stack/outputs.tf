# These outputs are the contract between Terraform and Wrangler: CI reads them
# with `terraform output -json` and injects the IDs into wrangler.toml, so a
# resource ID is never typed by a human. None of them is sensitive — they are
# identifiers, not credentials.

output "d1_database_id" {
  description = "D1 database ID, bound as DB in wrangler.toml."
  value       = cloudflare_d1_database.main.id
}

output "d1_database_name" {
  description = "D1 database name, used by `wrangler d1 migrations apply`."
  value       = cloudflare_d1_database.main.name
}

output "kv_namespace_id" {
  description = "KV namespace ID, bound as CACHE in wrangler.toml."
  value       = cloudflare_workers_kv_namespace.cache.id
}

output "r2_bucket_name" {
  description = "R2 bucket name, bound as FILES in wrangler.toml."
  value       = cloudflare_r2_bucket.files.name
}

output "queue_name" {
  description = "Primary job queue name."
  value       = cloudflare_queue.jobs.queue_name
}

output "dlq_name" {
  description = "Dead-letter queue name."
  value       = cloudflare_queue.jobs_dlq.queue_name
}

output "worker_name" {
  description = "Worker script name that `wrangler deploy` targets."
  value       = cloudflare_workers_script.api.script_name
}

output "api_url" {
  description = "Base URL of the REST API, used by the deploy smoke test."
  value       = "https://${local.api_hostname}"
}

output "mcp_url" {
  description = "Base URL of the MCP endpoint."
  value       = "https://${local.mcp_hostname}"
}

output "web_worker_name" {
  description = "Worker script name serving the dashboard SPA, targeted by `wrangler deploy` from apps/web."
  value       = cloudflare_workers_script.web.script_name
}

output "web_url" {
  description = "Base URL of the dashboard SPA, used by the deploy smoke test."
  value       = "https://${local.web_hostname}"
}

# --- Credentials. Unlike everything above, these ARE secrets. ---
#
# They exist as outputs because CI pushes them to the Worker with
# `wrangler secret put`; they are read with `terraform output -raw` and piped
# straight to stdin, so no value is ever an argument or a log line.

output "turnstile_sitekey" {
  description = "Turnstile site key. Public by design - it is embedded in the dashboard HTML."
  value       = cloudflare_turnstile_widget.bootstrap.sitekey
}

output "turnstile_secret_key" {
  description = "Turnstile secret key, pushed to the Worker as TURNSTILE_SECRET_KEY."
  value       = cloudflare_turnstile_widget.bootstrap.secret
  sensitive   = true
}

output "r2_access_key_id" {
  description = <<-DESC
    R2 S3 Access Key ID: the signing token's own identifier.

    Empty when manage_r2_signing_token is false. Empty means "Terraform is not
    the source for this credential", not "there is no credential" - the deploy
    workflow then requires it from the GitHub Environment instead, and fails
    if neither source has it. Silence is never taken for "no R2 needed".
  DESC
  value       = try(one(cloudflare_account_token.r2_signing).id, "")
  sensitive   = true
}

output "r2_secret_access_key" {
  description = <<-DESC
    R2 S3 Secret Access Key.

    Cloudflare defines this as the SHA-256 of the API token value, not the
    value itself (developers.cloudflare.com/r2/api/tokens). Deriving it here
    rather than in CI keeps the raw token value out of the workflow entirely.
  DESC
  value       = try(sha256(one(cloudflare_account_token.r2_signing).value), "")
  sensitive   = true
}

output "admin_worker_name" {
  description = "Wrangler deploys the staff console into this script."
  value       = cloudflare_workers_script.admin.script_name
}

output "admin_url" {
  description = "Where the staff console is served."
  value       = "https://${cloudflare_workers_custom_domain.admin.hostname}"
}
