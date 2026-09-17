terraform {
  # Matches the main stack's floor. Native S3-backend locking (`use_lockfile`)
  # went GA in 1.11 and is the only locking that works against R2; on 1.6.x the
  # backend runs with no locking at all. This root writes far less often than
  # the main one, but "rarely written" is not "safe to corrupt".
  required_version = ">= 1.11.0"

  required_providers {
    # Stripe's own provider, from github.com/stripe/terraform-provider-stripe.
    # The registry labels it "community" because Stripe is not a HashiCorp
    # partner, not because it is a third-party reimplementation - the publishing
    # namespace is Stripe's. Its release artifacts are self-signed, which is why
    # .terraform.lock.hcl here pins checksums for all three platforms CI and
    # developers actually use.
    stripe = {
      source  = "stripe/stripe"
      version = "~> 0.3"
    }
  }

  # Same bucket as the main stack, different key, so the two states cannot
  # collide and neither takes the other's lock. With workspace_key_prefix = ""
  # this resolves to <workspace>/stripe-catalogue.tfstate - i.e.
  # dev/stripe-catalogue.tfstate alongside dev/terraform.tfstate.
  #
  # Partial config for the same reason as the main stack: the endpoint embeds
  # the Cloudflare account ID and the credentials are R2 S3 tokens, so both
  # arrive at `terraform init` via -backend-config. Nothing account-specific is
  # committed here.
  backend "s3" {
    key                  = "stripe-catalogue.tfstate"
    workspace_key_prefix = ""

    # R2 is S3-compatible but is not AWS: no region, no IMDS, no STS, no
    # AWS-style checksum negotiation. These skips are required, not cosmetic -
    # without them init fails against R2. Copied deliberately from the main
    # stack rather than rediscovered.
    region                      = "us-east-1"
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_s3_checksum            = true
    use_path_style              = true

    use_lockfile = true
  }
}
