# The plan catalogue: one Stripe Product per plan, one Price per paid plan.
#
# Why this lives in its own Terraform root, and why it is temporary, is in
# main.tf. What follows is the pricing table itself and the one procedure that
# must not be got wrong.
#
# ── Changing a price ─────────────────────────────────────────────────────────
# A Stripe Price is immutable. Editing `amount_cents` below does not change a
# price; it asks Terraform to REPLACE one, and `prevent_destroy` will refuse.
# That refusal is the feature - a replacement would re-price every live
# subscriber mid-cycle. To rotate a price:
#
#   1. Add a NEW stripe_price resource for that plan, with a suffixed key
#      (pro_v2). Give it the same lookup_key only after step 2.
#   2. Set the old resource's `active = false`. It stays alive, and everybody
#      already subscribed keeps billing it until they renew - which is what
#      Stripe expects and what amardrive's reference architecture does.
#   3. Let the catalogue sync move `plans.stripe_price_id` onto the new price,
#      so new checkouts get the new amount.
#
# Never edit a live price in place, and never let Terraform replace one.

locals {
  # ── The canonical pricing table ────────────────────────────────────────────
  # Decided 17 Sept 2026. See docs/superpowers/specs/2026-09-17-billing-module-design.md
  # for the eight decisions behind these numbers, several of which override the
  # older 07 PART 19.0 table.
  #
  # `unlimited` is written as the literal string rather than a very large
  # number. Stripe metadata values are strings regardless, and "unlimited" says
  # what it means — a reader does not have to recognise 9007199254740991, and
  # nobody can mistake it for a cap somebody chose.
  #
  # Egress and requests are unlimited on every plan because R2 egress costs
  # nothing, so it is free to promise. File count is unlimited because storage
  # already bounds it and a second aggregate cap is a second number to
  # contradict.
  stripe_plans = {
    free = {
      display_name = "AgentDisk Free"
      description  = "One workspace, one agent identity, 1 GB. No card required."
      amount_cents = 0
      sort_order   = 10
      is_default   = true

      storage_bytes  = 1 * 1024 * 1024 * 1024
      max_file_bytes = 100 * 1024 * 1024
      agents         = 1
      members        = 1
      workspaces     = 1
      api_keys       = 2

      priority_support = false
    }

    basic = {
      display_name = "AgentDisk Basic"
      description  = "Three workspaces and five agent identities, for a single developer running more than a demo."
      amount_cents = 900
      sort_order   = 20
      is_default   = false

      storage_bytes  = 5 * 1024 * 1024 * 1024
      max_file_bytes = 500 * 1024 * 1024
      agents         = 5
      members        = 2
      workspaces     = 3
      api_keys       = 6

      priority_support = false
    }

    pro = {
      display_name = "AgentDisk Pro"
      description  = "Ten workspaces, ten agent identities and 50 GB, with priority support."
      amount_cents = 2000
      sort_order   = 30
      is_default   = false

      storage_bytes  = 50 * 1024 * 1024 * 1024
      max_file_bytes = 1 * 1024 * 1024 * 1024
      agents         = 10
      members        = 5
      workspaces     = 10
      api_keys       = 20

      priority_support = true
    }

    team = {
      display_name = "AgentDisk Team"
      description  = "Fifty workspaces, fifty agent identities and 500 GB, for a team running agents in production."
      amount_cents = 8000
      sort_order   = 40
      is_default   = false

      storage_bytes  = 500 * 1024 * 1024 * 1024
      max_file_bytes = 5 * 1024 * 1024 * 1024
      agents         = 50
      members        = 25
      workspaces     = 50
      api_keys       = 100

      priority_support = true
    }
  }

  # Free has a Product but no Price. A $0 recurring price would mean every free
  # account carries a real Stripe Subscription that can go `past_due`, dunning
  # somebody for nothing — and a Checkout Session for $0 is a card form asking
  # for a card it will never charge. Free is the absence of a subscription, and
  # `applySubscriptionState` already reverts to it when one ends.
  stripe_priced_plans = {
    for id, plan in local.stripe_plans : id => plan if plan.amount_cents > 0
  }
}

# One Product per plan. The entitlements ride in `metadata`, which is the whole
# mechanism: Stripe has no concept of "50 GB of storage" or "10 agent
# identities", so the catalogue sync reads them back out of metadata and mirrors
# them into D1. `package_id` is the join key — a Stripe product without one is
# invisible to the sync, so an unrelated one-off charge in this account can
# never appear in the pricing table.
resource "stripe_product" "plan" {
  for_each = local.stripe_plans

  name        = each.value.display_name
  description = each.value.description
  active      = true

  metadata = {
    package_id  = "agentdisk-${each.key}"
    plan_id     = each.key
    environment = local.environment
    sort_order  = tostring(each.value.sort_order)
    is_default  = each.value.is_default ? "1" : "0"

    storage_bytes  = tostring(each.value.storage_bytes)
    max_file_bytes = tostring(each.value.max_file_bytes)
    agents         = tostring(each.value.agents)
    members        = tostring(each.value.members)
    workspaces     = tostring(each.value.workspaces)
    api_keys       = tostring(each.value.api_keys)

    # Unlimited on every plan, and stated rather than omitted. An absent key
    # reads as "nobody decided"; "unlimited" reads as the decision it is, and
    # the parser maps it to no ceiling.
    egress_bytes_period = "unlimited"
    requests_period     = "unlimited"
    file_count          = "unlimited"

    # Available on every plan. They appear here so the pricing page can be
    # generated from the same metadata as everything else, not because anything
    # gates on them — no code reads these to refuse a request.
    permanent_share_links = "1"
    webhooks_enabled      = "1"
    path_scoped_keys      = "1"

    # The one genuine per-plan feature flag, and it is display-only. There is
    # nothing in the request path that could enforce a support commitment.
    priority_support = each.value.priority_support ? "1" : "0"
  }

  lifecycle {
    # See the header. A destroy here archives products that live subscriptions
    # point at. Removing this block is a deliberate act, not a cleanup.
    prevent_destroy = true
  }
}

# One recurring monthly Price per paid plan.
#
# `lookup_key` gives every price a stable, human-readable handle that survives
# rotation — if a price is ever replaced, the new one carries the same lookup
# key and anything resolving by key keeps working without learning a new ID.
resource "stripe_price" "plan_monthly" {
  for_each = local.stripe_priced_plans

  product     = stripe_product.plan[each.key].id
  currency    = "usd"
  unit_amount = each.value.amount_cents
  active      = true
  nickname    = "${each.value.display_name} — monthly"
  lookup_key  = "agentdisk-${each.key}-monthly"

  recurring {
    interval = "month"
  }

  metadata = {
    package_id  = "agentdisk-${each.key}"
    plan_id     = each.key
    environment = local.environment
  }

  lifecycle {
    # A price is immutable in Stripe, so any change to `unit_amount`, `currency`
    # or `recurring` is a REPLACEMENT. This turns that into a loud failure at
    # plan time rather than a silent swap that re-prices live subscribers. The
    # rotation procedure is in the header.
    prevent_destroy = true
  }
}
