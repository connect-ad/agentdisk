# The Stripe plan catalogue — a separate, deliberately temporary Terraform root.
#
# ── Why this is not part of infra/terraform ─────────────────────────────────
# Three reasons, and the third is the one that decided it.
#
# **It needs a credential the main stack's plan job cannot have.** `ci.yml`'s
# terraform-plan job is deliberately not scoped to a GitHub Environment, so that
# a plan runs from any feature branch using repository-level secrets. But
# STRIPE_SECRET_KEY is a per-environment secret — dev must run against a
# test-mode key and prod against a live-mode one, because test and live are
# separate object namespaces in Stripe and that separation is what stops a dev
# apply touching a real price. Putting Stripe resources in the main stack would
# therefore have left that plan job permanently red the moment the first apply
# wrote Stripe resources into state.
#
# **Its blast radius is unlike everything else's.** A Stripe Product and Price
# are referenced by live subscriptions that bill real cards. `terraform destroy`
# against the main stack is a teardown; against these resources it is a billing
# incident. Separate state means a destroy of one cannot reach the other.
#
# **It is meant to be deleted.** This root exists to get a catalogue into Stripe
# before the staff console can manage plans itself (14 PART 29.6). Once the
# admin plan editor ships, plans are created and edited there, this directory
# and `.github/workflows/stripe-catalogue.yml` are removed, and the D1 catalogue
# is reconciled from Stripe by the sync endpoint exactly as it is today. Nothing
# else in the repository imports from here, precisely so that deletion is one
# `git rm -r` and a workflow file.
#
# ── The environment ─────────────────────────────────────────────────────────
# Derived from terraform.workspace and nowhere else, for the same reason the
# main root does it: if the environment could also arrive as a variable, the two
# could disagree, and you could create live-mode prices while standing in the
# dev workspace.

locals {
  environments = ["dev", "prod"]

  workspace_is_valid = contains(local.environments, terraform.workspace)

  # Falls back to dev only so the guard below can produce a readable error
  # rather than an opaque lookup failure.
  environment = local.workspace_is_valid ? terraform.workspace : "dev"
}

resource "terraform_data" "workspace_guard" {
  input = terraform.workspace

  lifecycle {
    precondition {
      condition     = local.workspace_is_valid
      error_message = <<-MSG
        Refusing to run in the "${terraform.workspace}" workspace.

        The Stripe catalogue is provisioned only from the "dev" or "prod"
        workspace. The "default" workspace is never used: an unselected
        workspace must not create billing objects, and because test mode and
        live mode are distinct Stripe namespaces, the workspace is the only
        thing recording which of the two this state describes.

        Run: terraform workspace select -or-create dev   (or prod)
      MSG
    }
  }
}
