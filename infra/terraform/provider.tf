# Cloudflare provider credentials come from the environment, never from code.
#
# This block is intentionally empty. The provider reads CLOUDFLARE_API_TOKEN
# from the environment, which in CI is populated from the GitHub Environment
# secret of the same name — so the Development job and the Production job get
# different tokens without this file (or any file) knowing the difference.
#
# Declaring `api_token` here would put a credential in source, and referencing
# it through a Terraform variable would put it in state, which is plaintext even
# in a remote backend. Neither is acceptable; the environment is the only path.
#
# Note that `terraform plan` on a greenfield config succeeds WITHOUT a token,
# because creates require no API reads. The token is first genuinely exercised
# at `apply`. CI therefore checks for the secret explicitly before running,
# rather than trusting a green plan to mean "credentials are fine".
provider "cloudflare" {}
