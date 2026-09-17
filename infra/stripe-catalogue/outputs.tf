# Identifiers only. No Stripe credential is ever an output here: the API key
# arrives through the environment and never enters state, so there is nothing
# sensitive to forward — unlike the main stack, whose Turnstile and R2 outputs
# are genuine secrets.
#
# Nothing consumes these automatically. The Worker does NOT read price IDs from
# configuration: it discovers the catalogue from Stripe by `metadata.package_id`
# and mirrors it into D1, which is what keeps one pricing definition rather than
# two. These outputs exist so that a human reconciling a failed checkout, or a
# workflow summary, can see which objects this environment actually built.

output "environment" {
  description = "Environment this state represents, derived from the workspace."
  value       = local.environment
}

output "product_ids" {
  description = "Plan id to Stripe Product id, for every plan including free."
  value       = { for id, product in stripe_product.plan : id => product.id }
}

output "price_ids" {
  description = "Plan id to Stripe Price id, for the paid plans only. Free has no price by design."
  value       = { for id, price in stripe_price.plan_monthly : id => price.id }
}

output "price_lookup_keys" {
  description = "Plan id to the price's stable lookup key, which survives a price rotation."
  value       = { for id, price in stripe_price.plan_monthly : id => price.lookup_key }
}
