# The Stripe credential comes from the environment, never from code or a var.
#
# This block is intentionally empty, on exactly the same terms as the main
# stack's `provider "cloudflare" {}`. The provider reads STRIPE_API_KEY from the
# environment, which CI populates from the per-environment STRIPE_SECRET_KEY
# secret — so the dev run gets a test-mode key and the prod run a live-mode one
# without this file, or any file, knowing the difference.
#
# Declaring `api_key` here would commit a live billing credential. Routing it
# through a Terraform variable would write one into terraform.tfstate, which is
# unencrypted JSON in the state bucket — and CLAUDE.md's amendment permitting
# secrets in state was a specific exception for the Turnstile widget and the R2
# signing token, not a general licence. A key that can charge cards is not
# covered by it.
#
# Note the difference from Cloudflare: that provider's token is first exercised
# at apply, because creating resources needs no API reads. This one is exercised
# at PLAN, because the provider refreshes existing products to diff them. A
# missing or wrong key therefore fails the plan — which is the better direction,
# but means the workflow checks for the secret before running rather than
# trusting a green plan.
provider "stripe" {}
