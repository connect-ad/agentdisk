# 11 · Operations

What is live, what was done to make it live, what is still open, and where to
look when something stops.

---

## Production, as of 30 September 2026

Live on `agentdisk.io`, `www.`, `app.`, `api.`, `mcp.` and `securepanel.`.
The stack was applied from PR #4 and the site split from PR #5, each prod run
approved by hand. Every migration is applied, the four plans carry their live
Stripe IDs, the first administrator is `kernelv5@gmail.com`, and there are no
customers yet.

Set up outside the repository, in this order, and recorded here because
nothing in CI can see it:

1. **Stripe live mode**: four products, one webhook, keys in GitHub. See
   [7 Billing and Stripe](7%20Billing%20and%20Stripe.md).
2. **Firebase project `agentdisk`**: providers, domains, policy, SMTP, web
   config, service-account key. See [6 Auth and Firebase](6%20Auth%20and%20Firebase.md).
3. **GitHub prod environment**: every variable and secret in
   [3 Deploy](3%20Deploy.md), plus the branch and environment gates.
4. **R2 signing token** scoped to `agentdisk-prod-files`.
5. **DNS**: the GoDaddy A records and the `www` CNAME on the apex deleted so
   Terraform could attach the Worker.

Dev is the same shape on `dev.`, `app-dev.`, `api-dev.`, `mcp-dev.` and
`securepanel-dev.`, deployed on every push to `dev`.

## Known gaps

- **Count gates.** `PLAN_LIMITS.agents`, `.apiKeys`, `.members` and
  `.workspaces` are read by nothing on a write path; only share links are
  enforced.
- **No rate limiting on the authenticated surface or on MCP**, beyond the
  auth-failure throttle and the sandbox limits.
- **No alerting, no error reporting, no declared log retention.** Every error
  response carries a `requestId`; `wrangler tail` is the only live view.
- **No React error boundary** in the dashboard.
- Not built, by decision: customer-side promo validation, invoice PDFs,
  multi-currency, multipart upload, signed permanent links, full-text search
  inside files, an `openapi.yaml`, the CLI on npm.
- Six security and correctness items from the September audit were
  deliberately dropped from tracking and are not fixed: authorization
  hardening across the admin routes, rate-limiting the authenticated surface,
  admin-console security headers, audit-trail gaps, webhook delivery tracking,
  abandoned-upload cleanup. They are recoverable from git at the tag
  `pre-billing-module`.
- **Dev data was never reset** for the production start. The dev database,
  the dev files bucket, the Stripe sandbox's test customers and the
  `agentdisk-dev` Firebase users all still hold September's test data.

## Walking the product

The customer walkthrough is [docs/USER_TESTING_GUIDE.md](../docs/USER_TESTING_GUIDE.md):
sign up, create an agent, mint a key, upload from the browser and the API,
invite a colleague, connect an MCP client, buy a plan, close the account, and
the console as the operator. Its own tail says which steps were verified by a
machine and which need a human with a browser.

The regression suite in `regression-tests/` covers the same journeys against
a live hostname; see [1 Build](1%20Build.md).

## When something stops

| Symptom | Look at |
|---|---|
| A hostname does not resolve from this machine but the pipeline passed | The VPN resolver's cache; prove it with Cloudflare DoH. [4 Infrastructure](4%20Infrastructure.md) |
| A prod deploy fails at "State reports environment ''" | It ran before the infrastructure apply. Re-run the failed job after infra succeeds |
| The dashboard serves no security headers | `dist/_headers` was not written; look for `Parsed 1 valid header rule` in the deploy log |
| Every purchase fails, suite green | The Checkout Session's parameters; a live session is the only proof Stripe accepts them |
| Mail stopped | [2 Email](2%20Email.md), and remember Worker mail and Firebase mail share one quota |
| Sign-in fails with `unauthorized-domain` | The Firebase project's authorized domains, which `firebase deploy` does not set |
| Email-link sign-in stopped after a Firebase deploy | `passwordRequired` was reset; re-assert it |
| A plan edit appears to work then reverts | The `product.updated` webhook round-tripped stale metadata; check `metadataForPlan` against the decoder |
| The pricing page shows nothing purchasable | The `plans` rows have no Stripe price IDs; run Sync from the console |
| A per-IP limit never fires from this machine | The VPN rotates addresses per connection; test over one keep-alive connection |
| R2 answers `AccessDenied` | The token's permissions or scope changed, not its secret |

## Data resets, when wanted

None have been done. Each is a separate decision:

- **Dev database and bucket.** Delete every row except `plans` and
  `admin_users`, and empty `agentdisk-dev-files`.
- **Stripe sandbox.** Delete the test customers and subscriptions; keep the
  four products.
- **Firebase `agentdisk-dev` users.** Delete the test accounts.
