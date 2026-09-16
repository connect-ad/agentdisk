# AgentDisk infrastructure root — one config, one state bucket, one workspace
# per environment (`dev`, `prod`).
#
# The environment is derived from terraform.workspace and NOWHERE else. There is
# deliberately no `environment` input variable: if the environment could be
# passed in as a var, then workspace and var could disagree, and you could apply
# prod-named resources while standing in the dev workspace. Deriving it from the
# workspace makes that state unrepresentable.

locals {
  # The only place environments are enumerated. Adding a per-PR preview tier
  # later is a new entry here plus a new workspace — no restructuring.
  environments = {
    dev = {
      environment      = "dev"
      subdomain_suffix = "-dev"
    }
    prod = {
      environment      = "prod"
      subdomain_suffix = ""
    }
  }

  workspace_is_valid = contains(keys(local.environments), terraform.workspace)

  # Falls back to the dev entry purely so that validate/plan can still produce a
  # coherent error from the guard below instead of an opaque "key not found".
  config = local.workspace_is_valid ? local.environments[terraform.workspace] : local.environments["dev"]
}

# Hard stop on the wrong workspace.
#
# This is the mitigation for the one real risk workspaces carry over
# directory-per-environment: `terraform workspace select` is mutable CLI state,
# so a stale or defaulted selection can point an apply at the wrong environment.
# The `default` workspace in particular is what you get when someone forgets to
# select at all — it must never provision anything.
resource "terraform_data" "workspace_guard" {
  input = terraform.workspace

  lifecycle {
    precondition {
      condition     = local.workspace_is_valid
      error_message = <<-MSG
        Refusing to run in the "${terraform.workspace}" workspace.

        AgentDisk provisions only from the "dev" or "prod" workspace. The
        "default" workspace is never used, because an unselected workspace must
        not silently create or destroy real infrastructure.

        Run: terraform workspace select -or-create dev   (or prod)
      MSG
    }
  }
}

module "stack" {
  source = "./modules/agentdisk-stack"

  environment      = local.config.environment
  subdomain_suffix = local.config.subdomain_suffix

  account_id  = var.account_id
  zone_id     = var.zone_id
  root_domain = var.root_domain

  manage_r2_signing_token = var.manage_r2_signing_token

  # Ordering, not decoration: nothing is created until the guard has passed.
  depends_on = [terraform_data.workspace_guard]
}
