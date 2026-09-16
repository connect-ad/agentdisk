# 025 · Authorization and hardening follow-ups

**Status:** Open — found by the 8 Sept 2026 audit ([summary.md](../summary.md) F-10, F-11)

Small, independent items. None threatens tenant isolation, which the audit could
not defeat.

**1. Agent API keys can read the billing account, including the owner's email.**
`index.ts:434` routes `GET /v1/billing` with `{ op: null }` — any valid
credential, no capability required — and `getBilling` (`billing.ts:36`) performs
no identity check. Its comment says "safe for any member to read", but an agent
key is not a member. So a key scoped to `{ops:["read"], pathPrefix:"/agents/bot"}`
can read the org's plan, billing status, subscription state, and **`ownerEmail`**
— the human owner's address, which appears nowhere else on the agent-facing
surface. Enough for a targeted phish citing the real plan and status.

The neighbours show the intended pattern: `createPortalSession` checks both
`identity.kind` and `role` (`billing.ts:66`), and `members.ts:65` has a
`requireHuman` helper for exactly this reason ("an agent key has no business
reading the roster"). Billing has no equivalent.

**2. Staff lockout is a denial-of-service primitive.** The counter is keyed on
email alone (`routes/staff.ts:57`), so anyone who knows a staff address can send
five bad passwords every 15 minutes and keep that engineer locked out
indefinitely — including during the incident their access exists for. Key on
`email+IP`, or exempt a correct password+TOTP from the lockout.

**3. `rejectQueryCredential` does not cover staff or Stripe routes.** It runs
inside `withAuth` (`middleware/auth.ts:213`), which `/v1/staff/*` and
`POST /v1/webhooks/stripe` bypass. A staff token arriving in a URL would not
trigger the "treat this credential as burned" warning that the customer surface
gives.

**4. Presigned PUT URLs are replayable inside their 15-minute window.** The URL
authorizes PUT on one key for its TTL, so it can overwrite the object repeatedly.
Bounded by `complete` re-heading the real size — except where `complete` is never
called; see [018](018-reclaim-abandoned-uploads.md).

**5. The dashboard quick-start snippet uses the wrong field name.**
`Dashboard.jsx:24` sends `contentType`; the schema expects `mimeType`
(`files.ts:54`). Zod is non-strict, so the key is silently dropped and every file
uploaded from the documented snippet gets `application/octet-stream`.

**6. `WorkspaceScopedAgents.update` takes `status?: string`**
(`workspace-scoped.ts:518`). The route's Zod enum is the only guard. Fails safe,
because `assertAgentEnabled` refuses anything `!== "active"` — but the type should
carry the constraint.

**7. An API key with `delete` scope can delete another agent** (raised 8 Sept
2026, deliberately not changed). `index.ts` routes `DELETE /v1/agents/:id` as
`{ op: "delete" }`, so any credential holding that op qualifies —
`agents-keys.test.ts:85` proves it on purpose, and its comment gives the reason
the capability exists: an admin key must be able to kill an agent without the
agent's keys outliving it.

The unease is that `delete` mostly means *delete a file*, and using it to also
authorize destroying an identity lets one agent's credential act on an identity
it did not issue — the same shape of argument that made
`DELETE /v1/workspaces/:id` refuse API keys outright. The two are not obviously
the same: destroying a workspace ends the account's own container, while
deleting an agent is routine operational work a management key may legitimately
do, and 05 PART 13 specifies it as scope-gated.

Deciding it means either a new op (`agents:delete`) or a `requireHuman` on the
route, and either one changes a documented, tested capability. **Recorded rather
than resolved**, because it is a product decision about the API's contract and
not a bug. The dashboard's new delete flow does not depend on the answer: it
calls the same endpoint as an owner or admin, whose role already carries
`delete`, and a reader is refused by scope.
