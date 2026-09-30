variable "environment" {
  description = "Environment name. Drives every resource name as agentdisk-<environment>-<resource>."
  type        = string

  validation {
    condition     = contains(["dev", "prod"], var.environment)
    error_message = "environment must be exactly \"dev\" or \"prod\"."
  }
}

variable "subdomain_suffix" {
  description = "Hostname suffix: \"-dev\" for development, \"\" for production. Flat, not nested, so the free Universal SSL wildcard (*.agentdisk.io) covers it."
  type        = string

  validation {
    condition     = contains(["-dev", ""], var.subdomain_suffix)
    error_message = "subdomain_suffix must be \"-dev\" or the empty string."
  }
}

variable "account_id" {
  description = "Cloudflare account ID that owns these resources."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.account_id))
    error_message = "account_id must be a 32-character lowercase hex Cloudflare account ID."
  }
}

variable "zone_id" {
  description = "Cloudflare zone ID for the root domain."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.zone_id))
    error_message = "zone_id must be a 32-character lowercase hex Cloudflare zone ID."
  }
}

variable "root_domain" {
  description = "Registrable domain the API and MCP hostnames hang off."
  type        = string
  default     = "agentdisk.io"
}

variable "r2_location_hint" {
  description = "Optional R2 location hint (for example \"weur\"). Null lets Cloudflare choose."
  type        = string
  default     = null
}

variable "manage_r2_signing_token" {
  description = <<-DESC
    Whether Terraform creates the R2 S3 signing token used to presign upload
    and download URLs.

    Off by default, and that default is a security decision rather than a
    convenience one. Creating an API token requires "Account -> API Tokens:
    Edit" on the deploy token, and Cloudflare does not confine a token holding
    that permission to minting only permissions it already has. Turning this on
    therefore upgrades TERRAFORM_CF_ACCESS_TOKEN from "can manage the resources
    it manages" to "can mint any credential in the account", which changes what
    a leak of it costs.

    While this is off, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY come from the
    GitHub Environment instead: create an R2 API token by hand once per
    environment, scoped "Object Read and Write" to that environment's bucket.
    The deploy workflow accepts either source and fails if it finds neither.
  DESC
  type        = bool
  default     = false
}
