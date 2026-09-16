# Consumed by CI (`terraform output -json`) to configure the Wrangler deploy and
# the post-deploy smoke test. Identifiers only — no credentials.

output "environment" {
  description = "Environment this state represents, derived from the workspace."
  value       = local.config.environment
}

output "d1_database_id" {
  description = "D1 database ID, injected into wrangler.toml as the DB binding."
  value       = module.stack.d1_database_id
}

output "d1_database_name" {
  description = "D1 database name, targeted by `wrangler d1 migrations apply`."
  value       = module.stack.d1_database_name
}

output "kv_namespace_id" {
  description = "KV namespace ID, injected into wrangler.toml as the CACHE binding."
  value       = module.stack.kv_namespace_id
}

output "r2_bucket_name" {
  description = "R2 bucket bound as FILES."
  value       = module.stack.r2_bucket_name
}

output "worker_name" {
  description = "Worker script name that `wrangler deploy` targets."
  value       = module.stack.worker_name
}

output "api_url" {
  description = "Base URL of the REST API, used by the deploy smoke test."
  value       = module.stack.api_url
}

output "mcp_url" {
  description = "Base URL of the MCP endpoint."
  value       = module.stack.mcp_url
}

output "web_worker_name" {
  description = "Worker script name serving the dashboard SPA."
  value       = module.stack.web_worker_name
}

output "web_url" {
  description = "Base URL of the dashboard SPA, used by the deploy smoke test."
  value       = module.stack.web_url
}

output "account_id" {
  description = <<-DESC
    Cloudflare account ID, injected into wrangler.toml as R2_ACCOUNT_ID.

    An identifier, not a credential - it names the R2 S3 endpoint host that
    presigned URLs are signed against (05 PART 12.2). It is an output rather
    than a hand-typed var for the same reason every other ID here is: so
    nothing in wrangler.toml can drift from what Terraform actually built.
  DESC
  value       = var.account_id
}

# --- Credentials, forwarded for `wrangler secret put`. See the module's
#     outputs.tf for what putting these in state costs. ---

output "turnstile_sitekey" {
  description = "Turnstile site key. Public - embedded in the dashboard HTML."
  value       = module.stack.turnstile_sitekey
}

output "turnstile_secret_key" {
  description = "Turnstile secret key, pushed to the Worker as TURNSTILE_SECRET_KEY."
  value       = module.stack.turnstile_secret_key
  sensitive   = true
}

output "r2_access_key_id" {
  description = "R2 S3 Access Key ID, pushed to the Worker as R2_ACCESS_KEY_ID."
  value       = module.stack.r2_access_key_id
  sensitive   = true
}

output "r2_secret_access_key" {
  description = "R2 S3 Secret Access Key, pushed to the Worker as R2_SECRET_ACCESS_KEY."
  value       = module.stack.r2_secret_access_key
  sensitive   = true
}

output "admin_worker_name" {
  description = "Wrangler deploys the staff console into this script."
  value       = module.stack.admin_worker_name
}

output "admin_url" {
  description = "Where the staff console is served."
  value       = module.stack.admin_url
}
