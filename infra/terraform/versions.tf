terraform {
  # >= 1.11 is load-bearing: native S3-backend state locking (`use_lockfile`)
  # went GA in 1.11 and is the only locking mechanism that works against R2,
  # which has no DynamoDB equivalent for the legacy lock table. It relies on a
  # conditional PutObject (If-None-Match), which R2's S3 API does support.
  # On Terraform 1.6.x this backend would run with NO locking whatsoever —
  # and with workspaces sharing one bucket, unlocked state is how two
  # concurrent applies corrupt each other.
  required_version = ">= 1.11.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.24"
    }
  }

  # Partial backend config. The endpoint embeds the Cloudflare account ID and
  # the credentials are R2 S3 tokens, so both are supplied at `terraform init`
  # time via -backend-config (CI writes backend.hcl from Environment secrets).
  # Nothing account-specific is committed here.
  backend "s3" {
    # `bucket` is deliberately absent: it is supplied at init time from the
    # TFSTATE_BUCKET repository variable, alongside the account-specific
    # endpoint. Nothing account- or deployment-specific is committed here.
    key = "terraform.tfstate"

    # Empty prefix so workspace state lands at <workspace>/terraform.tfstate —
    # i.e. dev/terraform.tfstate and prod/terraform.tfstate, matching the
    # roadmap's naming rather than Terraform's default "env:/" prefix.
    workspace_key_prefix = ""

    # R2 is S3-compatible but is not AWS: there is no region, no IMDS, no STS,
    # and no AWS-style checksum negotiation. These skips are required, not
    # cosmetic — without them init fails against R2.
    region                      = "us-east-1"
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_s3_checksum            = true
    use_path_style              = true

    # Native state locking via conditional write. See required_version above.
    use_lockfile = true
  }
}
