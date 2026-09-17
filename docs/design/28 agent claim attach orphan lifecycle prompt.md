# Agent Claiming, Existing-Workspace Attach, and Orphan Lifecycle — Design & Implementation Prompt
### PART 31 of the AgentDrive/AgentDisk document set

*Grounded directly in the live repo (`agent-storage-mcp`), not in the original design docs — where the two disagree, this doc says so and follows the code, per `CLAUDE.md`'s own precedence rule. Sources: `apps/api/migrations/0002`–`0009`, `apps/api/src/routes/{create-workspace,workspaces}.ts`, `apps/api/src/db/{bootstrap,user-lookup}.ts`, `apps/api/src/storage/keys.ts`, `apps/api/src/lib/{quota,plans,paths,audit}.ts`, `apps/api/src/auth/scopes.ts`, `apps/api/src/jobs/purge.ts`, `backlog/{009,017,018,025}`. Also grounded against the live competitor mechanic this feature is modeled on: `agentstorage.ai`'s sandbox→claim flow and its `skill.md` (already researched in `01-research-and-opportunity.md` §2.3, re-confirmed live for this doc).*

---

## PART 1 — What actually exists today (read from the code, not assumed)

This matters because the feature request assumes a working "agent gets a temporary link, someone clicks it" flow already exists end to end. **It does not — half of it was built and half was deliberately deferred.** Building "attach to an existing workspace" requires first finishing the base claim flow, which was never completed.

**What's real:**
- `POST /v1/workspaces` (Turnstile-gated, no auth, 10/hour/IP — `routes/create-workspace.ts`) lets an agent self-provision with zero human involvement. It creates, in one D1 batch: a **provisional user** (`is_provisional = 1`, placeholder email `unclaimed-{userId}@agentdisk.invalid`), a brand-new **organization** owned by that provisional user, a **workspace** (`claimed_at = NULL`), one **agent**, and one **API key** scoped `{ops: [read, write, delete, list], pathPrefix: ""}` — full read/write/delete over the whole workspace, deliberately without `keys:create` (`db/bootstrap.ts`, `provisionSandboxWorkspace`). The token is returned once in the response.
- The schema already has what a claim needs to act on: `workspaces.claimed_at` (nullable, indexed via `idx_workspaces_unclaimed ... WHERE claimed_at IS NULL`) and `users.is_provisional`, both added in migration `0003_workspace_bootstrap.sql`. That migration's own comment says plainly: *"PART 13 specifies a `POST /v1/workspaces/:id/claim` endpoint — and a claim endpoint only makes sense if an unclaimed state exists for it to act on."*

**What's missing:**
- **There is no `claimUrl` anywhere.** The `POST /v1/workspaces` response body has no claim token or claim link field at all — check `routes/create-workspace.ts`'s response object yourself, it isn't there.
- **There is no claim endpoint.** `routes/workspaces.ts` has exactly three exports — `listWorkspaces`, `createWorkspaceForUser`, `deleteWorkspaceForUser` — and nothing else in the route tree touches `claimed_at`. Nothing ever sets it to non-null.
- **Nothing expires an unclaimed workspace.** `jobs/purge.ts` has exactly two jobs: `purgeExpiredFiles` (soft-deleted files past their 24h grace period) and `reconcileCounters`. Neither looks at `claimed_at`. A sandbox workspace nobody ever claims sits there forever, at full quota, forever accruing storage nobody is billed for and nobody owns.
- **An unclaimed sandbox gets the full `free` plan's limits**, not a reduced one — `create-workspace.ts` hands back `PLAN_LIMITS.free` verbatim (2 GB storage, 5,000 files, 100 MB max file size — see `lib/plans.ts`). Combined with the point above: today, an anonymous caller who only has to clear a Turnstile challenge can create unlimited unclaimed workspaces (bounded only by 10/hour/IP) each capable of holding up to 2 GB, forever, for free, with nothing to ever reclaim it. That is real, currently-live storage-cost and abuse exposure, independent of anything else in this doc — flagging it because "orphan file needs a limit" (your ask) is really two asks: a tighter cap *and* a cap that's actually enforced by a live sweep, and right now there's neither.

**What this means architecturally, for the "attach to existing workspace" feature specifically:**
- R2 object keys are `tenant/{workspaceId}/{fileId}` and nothing else (`storage/keys.ts`) — deliberately so a client-supplied path can never reach where the bytes live. This means a file's storage location is **workspace-bound by construction**. Moving a file from a sandbox workspace into a different, already-existing workspace is not a metadata update — it requires an actual R2 read-and-rewrite (copy under the new key, then delete the old object), because the workspace ID is baked into the key.
- Every storage/D1 repository in this codebase (`WorkspaceScopedStorage`, `WorkspaceScopedFiles`, etc.) is deliberately constructed bound to **one** workspace, specifically so no code path can be handed an argument that names a second tenant (this is called out as a security property, not an accident, in `CLAUDE.md`). A cross-workspace merge is therefore a genuine, narrow exception to that rule — it must be its own tightly-scoped handler that explicitly opens two workspace-scoped contexts, never a generic capability, and never built by loosening the existing single-workspace binding.
- Slugs and agent names are unique **per workspace** (`UNIQUE(workspace_id, name)` on `agents`; `UNIQUE(workspace_id, path)` on `files`/`folders`), so merging a sandbox's agent and files into a workspace that already has content needs an explicit collision policy — see PART 3.

---

## PART 2 — Feature 1: the base claim flow (build this first; "attach" is layered on top)

This is the part `agentstorage.ai` already ships (confirmed live from its `skill.md`): `POST /v1/workspaces` with no auth returns `workspaceId`, `apiKey`, and `claimUrl`; the pre-claim workspace runs under a small, short-lived sandbox cap; a human visits `claimUrl`, authenticates, and `POST /v1/workspaces/:id/claim` derives ownership **server-side from the authenticated session, never from the request body**. `01-research-and-opportunity.md` already flagged that exact server-side-derivation detail as worth adopting — this doc follows through on it.

### 2.1 Schema addition

```sql
-- migrations/0010_workspace_claiming.sql
ALTER TABLE workspaces ADD COLUMN claim_token_hash TEXT;
ALTER TABLE workspaces ADD COLUMN claim_token_expires_at INTEGER;
CREATE UNIQUE INDEX idx_workspaces_claim_token ON workspaces(claim_token_hash)
  WHERE claim_token_hash IS NOT NULL;
```
Store a hash, not the raw token (same reasoning as `api_keys.key_hash` — the claim link is a bearer secret, equal in power to "become the owner of this workspace," and it can leak the same ways a password-reset link can: chat logs, browser history, a proxy log). Generate the raw token with `lib/keys.ts`'s existing random-token machinery (don't invent a second one). Expiry is independent of the sandbox-deletion clock in PART 4 — recommend 30 days for the claim link itself, separately configurable from the 7-day sandbox TTL, and cancel the deletion the moment `claimed_at` is set (a workspace whose owner-designate hasn't gotten around to clicking yet but is clearly on their way loses nothing extra by living a bit past 7 days once claimed).

### 2.2 `create-workspace.ts` changes

Generate the claim token in the same `provisionSandboxWorkspace` D1 batch (one more bound value on the `workspaces` INSERT), and add to the response body:
```jsonc
"claimUrl": "https://app.agentdisk.io/claim/{rawToken}"
```
alongside the existing `notice` about the API key. Do not add a second "store this" warning — one clear notice covering both secrets is enough; don't make the agent parse two.

### 2.3 `GET /v1/workspaces/claim/:token` — unauthenticated preview

Read-only, safe to expose without auth because the token itself is the only thing that can name this workspace (same trust model as a signed download link). Returns: workspace name, agent name, file count, total bytes, plan limits, and whether the token is expired/already claimed. This is what the claim landing page (PART 5) renders *before* asking the visitor to sign in — showing someone what they're about to take ownership of before they commit is table stakes, and it's also where "create new vs. attach existing" gets decided in the UI.

### 2.4 `POST /v1/workspaces/claim/:token` — the actual claim

Sits beside `listWorkspaces`/`createWorkspaceForUser`/`deleteWorkspaceForUser` in `routes/workspaces.ts`, outside `withAuth`, for the identical reason those three are: it authenticates a human via the same Firebase-session path but has no workspace to be scoped *into* yet. **Follow whatever wiring `index.ts` already uses to resolve those three routes' `UserRow` from the Firebase token before touching this — don't invent a second auth path.**

Body:
```ts
{ mode: "new" } | { mode: "attach", targetWorkspaceId: string, pathPrefix?: string }
```

**`mode: "new"`** (the default, and the minimum viable claim — build this even if "attach" slips):
1. `UPDATE workspaces SET claimed_at = ? WHERE id = ? AND claim_token_hash = ? AND claimed_at IS NULL AND claim_token_expires_at > ?` — the `claimed_at IS NULL` guard in the same statement is what makes a double-click or a race between two tabs safe: the loser affects zero rows and gets a clean 409, rather than two people racing to "win" ownership.
2. Reparent the sandbox **workspace** onto the calling user's **existing** org (`UPDATE workspaces SET org_id = ?`), rather than leaving it under its own freshly-minted org. Every other place in this codebase treats "one real user, one owned org" as an invariant (`createWorkspaceForUser`'s `SELECT id FROM organizations WHERE owner_user_id = ?` assumes exactly one row) — giving a claiming user a *second* org for every workspace they ever claim would quietly break that invariant everywhere else it's assumed. Because the R2 key is `tenant/{workspaceId}/...` and the workspace's own ID doesn't change, **no file needs to move for this mode** — it's a metadata reparent only.
3. Re-check the workspace's `slug` for uniqueness within the *new* org (`idx_workspaces_org_slug`) — a collision here is realistic since the sandbox's slug came from a generic name like "Sandbox." Reuse `uniqueWorkspaceSlug`/`isSlugConflict`, the same retry pattern `createWorkspaceForUser` already uses.
4. Delete the now-empty provisional `organizations` row and the provisional `users` row (nothing else references either any more once the reparent lands — `organizations.owner_user_id` and the workspace's `org_id` were the only links).
5. Audit: write `workspace.claimed` to the (now-repointed) workspace via the existing `audit()` helper.

**`mode: "attach"`** — your ask. Fold the sandbox's agent and files into a workspace the caller already owns/administers, instead of keeping it as a separate workspace. Detailed in PART 3.

---

## PART 3 — Feature 2: attach-to-existing-workspace (the merge)

### 3.1 Authorization

`targetWorkspaceId` must resolve, via `findMembershipForWorkspace`, to a role of **`owner` or `admin`** for the calling user — not `reader`. This is a deliberate, narrower bar than "any member," for the reason you stated: the target workspace's *quota* absorbs this, and a reader shouldn't be able to spend somebody else's storage. Never trust a workspace name/ID for authorization purposes from anywhere except this lookup — mirrors `deleteWorkspaceForUser`'s own comment about joining through ownership being the entire check.

### 3.2 Quota check — block the whole merge, never partially merge

```ts
const totals = await sumActiveFiles(db, sandboxWorkspaceId); // bytes, count
assertWithinQuota(targetWorkspace, limitsFor(targetWorkspace), 
  { bytes: totals.bytes, files: totals.count }, now, targetBillingStatus);
```
using the **existing** `assertWithinQuota` from `lib/quota.ts` — don't write a second quota checker. If it throws `LIMIT_EXCEEDED`, refuse the entire merge with that error (tell the human to free up space or upgrade first). **Do not silently merge a subset of files that fit.** A merge that quietly drops files while reporting success is exactly the "false success" defect class this repo's own audit already found and is still working through (`backlog/023`) — don't add a new instance of it.

### 3.3 Collision policy (agent name, folder/file paths)

`agents` is `UNIQUE(workspace_id, name)`; `files`/`folders` are `UNIQUE(workspace_id, path)`. The target workspace almost certainly already has content. Default policy — and the safe one, because silently overwriting the destination owner's existing file of the same name is a correctness bug with real consequences:

- Namespace the merged agent and its files under a disambiguated prefix in the destination: if an agent named `sandbox-agent` already exists in the target, suffix it (`sandbox-agent-2`, `sandbox-agent-3`, …) rather than fail the whole merge over a name clash.
- Rewrite every merged file's `path` to live under `/agents/{finalAgentName}/...` in the destination (matching this product's own folder-as-namespace convention from `02-product-and-mvp-scope.md` §5.2) regardless of what path it held in the sandbox. This can't collide with anything in a workspace that follows the same convention, and if the destination has never used that convention, it still can't collide because the agent name itself was just made unique.
- Offer a `pathPrefix` override in the request body (already in the `mode: "attach"` shape above) for a human who wants to land the files somewhere specific instead — but the auto-namespaced default should require zero decisions from the person claiming.

### 3.4 The actual move — copy before delete, always

For each active file in the sandbox workspace:
1. `GET tenant/{sandboxWorkspaceId}/{fileId}` from R2.
2. `PUT tenant/{targetWorkspaceId}/{newFileId}` — a new file ID, not the reused one, since `objectKey()` validates both IDs and there's no reason to preserve the old one across a tenant boundary.
3. Insert the new `files` row under the target workspace with the rewritten path (3.3), `created_by` preserving that this came from the agent (not silently becoming "created by the claiming human" — provenance matters, per this product's own `FileCell` design-system component built specifically to show agent-vs-human provenance).
4. Only **after** the new object and row exist: delete the old R2 object and the old `files` row.

This ordering is the opposite of `purge.ts`'s delete-object-then-row pattern, and deliberately so — `purge.ts` is discarding data for good, where "object survives briefly with no row pointing at it" is harmless; this is *relocating* data, where the failure to protect against is the source object/row disappearing before the destination copy is confirmed to exist. Do the whole per-file sequence, then the whole batch, inside error handling that leaves the sandbox workspace (and hence the source data) intact and retryable if anything mid-way fails — never leave the merge half-applied and then delete the sandbox anyway.

Update the target workspace's `storage_bytes_used`/`file_count` counters inline as part of this operation (same increment the normal upload path already performs), rather than waiting for the next `reconcileCounters` sweep — a stale counter window here is exactly the kind of gap `backlog/017` already found elsewhere in this product (quota plumbing that's correct in principle but not actually wired into the request path). Don't add another instance of that.

### 3.5 The agent's credential

Repoint the *existing* `api_keys` row — same `id`, same `key_hash`, same raw token the agent already has — rather than revoking it and minting a new one:
```sql
UPDATE api_keys SET workspace_id = ?, agent_id = ?, scopes = ? WHERE id = ?
```
rewriting `scopes.pathPrefix` to the new `/agents/{finalAgentName}` namespace from 3.3. This preserves exactly the UX property `agentstorage.ai` itself promises and this project's own research already flagged as worth keeping: *"the same apiKey never changes... claiming unlocks capability server-side."* The agent's very next call transparently lands in the new workspace under the new paths — no re-authentication, no code change on the agent's side. (If product policy would rather force a fresh credential post-merge for hygiene reasons, that's a one-line change to revoke-and-reissue instead — call it out as an open decision in the PR, don't default to it silently, since it breaks the agent's next call without warning.)

### 3.6 Finish: delete the empty sandbox, audit, respond

Once every file has moved: delete the now-empty sandbox workspace, its org, and its provisional user — reuse `deleteWorkspaceForUser`'s cascade logic (it already handles the FK ordering correctly: files→folders→keys→agents→webhooks→audit_events→memberships→workspace) rather than re-deriving it, but note this path has already moved the keys and files out, so the cascade here is mostly org/user cleanup. Write **one** audit event to the *target* workspace — `agent.claimed_and_merged`, metadata: `{sourceWorkspaceId, agentName: finalAgentName, filesMoved, bytesMoved}` — via `auditAndNotify` so this also reaches webhooks once `backlog/022` is finished. Log the sandbox-org/user deletion the same way `deleteWorkspaceForUser` logs its own destruction (`console.log`, not an audit row — `audit_events` is FK-scoped to a workspace that no longer exists by that point).

Response: which files moved and their new paths, the agent's final name and path prefix, and the target workspace's updated usage — so the claiming human sees the quota impact immediately, not on their next dashboard refresh.

---

## PART 4 — Feature 3: orphan lifecycle (your "cron job" and "limit" asks)

Two separate things, and worth keeping separate because they fail differently if conflated:

### 4.1 A real sandbox cap, tighter than `free`

Today an unclaimed workspace gets the full `free` plan (2 GB / 5,000 files). Introduce a distinct, smaller sandbox tier — `agentstorage.ai`'s own live numbers (50 MB / 500 files / 500 MB egress, blocked from higher-cost operations) are a reasonable starting point, but the exact numbers are a product call, not an engineering one; flag it as an open decision rather than picking for you. Mechanically: add a `"sandbox"` entry to `PLAN_LIMITS` in `lib/plans.ts`, and have `create-workspace.ts` report and enforce that tier (not `PLAN_LIMITS.free`) until `claimed_at` is set. `assertWithinQuota` doesn't need to change — it already takes whatever `PlanLimits` it's handed; `resolvePlan`/`limitsFor` need a branch for "unclaimed" that isn't just "read `workspaces.plan_override`," since sandbox-vs-claimed isn't a plan choice, it's a claim-state fact. Simplest: at every quota-check call site that has the workspace row in hand, pass `workspace.claimed_at === null ? PLAN_LIMITS.sandbox : limitsFor(...)`.

### 4.2 The actual sweep (nothing does this today)

Add a third job alongside `purgeExpiredFiles`/`reconcileCounters` in `jobs/purge.ts` (or a sibling `jobs/sandbox-expiry.ts` if you'd rather keep it out of a file whose header currently promises exactly two jobs — either is fine, just don't silently make it a third undocumented thing purge.ts does):

```ts
export async function expireUnclaimedWorkspaces(
  db: D1Database, files: R2Bucket, now: number, ttlMs = 7 * 24 * 60 * 60 * 1000, limit = 50
): Promise<ExpireResult> {
  const candidates = await db.prepare(
    `SELECT id FROM workspaces WHERE claimed_at IS NULL AND created_at <= ? LIMIT ?`
  ).bind(now - ttlMs, limit).all<{ id: string }>();
  // For each: same R2-prefix-delete + D1 cascade as deleteWorkspaceForUser,
  // run as a system actor (no human confirmation — there is no human to ask).
  ...
}
```
Reuse `workspacePrefix()` from `storage/keys.ts` to list-and-delete the whole tenant prefix in R2 rather than re-selecting `r2_object_key` per file first (both work; the prefix delete is simpler here since there's no restore window to worry about — an unclaimed sandbox never had soft-delete semantics). Wire it into whatever triggers the existing hourly cron alongside the other two jobs — confirm the exact trigger wiring in `index.ts`'s `scheduled` handler before assuming it matches `purge.ts`'s own header comment; that header describes what the jobs do, not necessarily their trigger cadence, and this doc hasn't independently verified the cron wiring in `index.ts`. `idx_workspaces_unclaimed` already exists for this query; if `created_at` filtering shows up as a hot path at scale, that's a follow-up index, not a blocker for v1.

### 4.3 Warning the agent before the cap hits (your third ask)

The quota machinery (`assertWithinQuota`) already throws a hard `LIMIT_EXCEEDED` at 100%. What's missing — and this is the part worth being careful about, because the product already has a cautionary tale here (`backlog/017`: an 80%/95% warning-threshold concept exists in the design docs and dashboard, and turned out to be **UI-only, never wired into the actual request path**, so it lies) — is a *soft* warning delivered to the **agent**, not just the human's dashboard. Add it directly where `assertWithinQuota` is called on the sandbox write path: if the projected usage crosses 80% of the sandbox cap but doesn't exceed it, don't throw — attach a `warning` field to the success response (or an `X-AgentDisk-Quota-Warning` header, cheaper for a caller that isn't inspecting the body) naming the dimension, the percentage, and the claim URL:
```jsonc
"warning": {
  "code": "SANDBOX_QUOTA_WARNING",
  "message": "This unclaimed workspace is at 82% of its storage limit and will be deleted in 3 days if never claimed.",
  "claimUrl": "https://app.agentdisk.io/claim/{token}"
}
```
This does double duty as both the safety warning you asked for and a natural claim-conversion nudge. Because it's computed at the same call site as the hard block (not a separate UI-side calculation), it can't drift out of sync with reality the way the existing 80%/95% dashboard indicators did.

---

## PART 5 — What else this ask was missing (asked for explicitly)

1. **Claim-link leakage.** A claim link is bearer-secret-equivalent to a password reset link — it can end up in agent logs, a chat transcript, a proxy log. Support regenerating it (new token, old one's hash overwritten, old link 404s) without needing to re-provision the whole sandbox.
2. **Double-claim race.** Covered in 2.4's single UPDATE-with-guard — call it out again here because it's the kind of thing that's easy to build correctly on paper and get wrong in a handler that does a `SELECT` then a separate `UPDATE`.
3. **Agent still writing mid-merge.** The sandbox's API key is live and could receive a write while the merge is in flight. MVP-acceptable answer: accept the small race window and let `reconcileCounters` catch any resulting drift, same as this product already tolerates elsewhere — but say so explicitly in the PR rather than silently hoping nobody notices; a stricter answer (briefly flipping the sandbox key to read-only for the duration) is a fine follow-up, not a v1 requirement.
4. **Merge must be all-or-nothing.** Covered in 3.2 — worth restating because it's the single easiest place to accidentally ship a "false success."
5. **Who's allowed to attach.** Owner/admin only on the target, never `reader` — covered in 3.1.
6. **The agent keeps the same key.** Covered in 3.5 — flagged as a decision, not silently assumed, since revoke-and-reissue is the more conservative security posture and some teams will prefer it.
7. **System-wide sandbox exposure, not just per-request rate.** The 10/hour/IP limit bounds *creation rate*; it does not bound *total outstanding unclaimed storage* system-wide before the 7-day sweep catches up. Tightening the sandbox cap (4.1) and actually running the sweep (4.2) together are what close this — neither alone does.
8. **Audit and webhook parity.** Covered in 2.4 and 3.6 — don't let this be the next unaudited mutation `backlog/021` has to catalogue.
9. **Dashboard UX for the choice itself.** Covered in PART 6 below — "create new" vs. "attach to existing" needs to be an explicit, informed choice with a quota-impact preview, not a default nobody reads.
10. **Provenance after merge.** A merged file's `created_by` should keep showing "agent: sandbox-agent," not silently become "created by (the claiming human)" — the whole point of this product's agent/human provenance model (`FileCell`) is that this distinction survives. Covered in 3.4.
11. **Consent framing.** Claiming — especially attaching unverified, agent-written content into an existing paid workspace — is the moment a human takes responsibility for content they haven't reviewed. A one-line acknowledgment on the claim screen ("You're taking ownership of these files") costs little and matches this product's existing pattern of explicit human acknowledgment for consequential actions (the reveal-once API key screen already does this for a lower-stakes case).

---

## PART 6 — Design (for the existing design-system components; no new primitives needed)

**New page: Claim landing (`/claim/{token}`), unauthenticated-safe preview state.**
Centered card, consistent with Login/Signup's layout language. Before sign-in: workspace name, agent name (with `AgentCard`), file count and total size, plan/limit context, and an expiry note if the link is aging. Two large choice cards below the preview — not a dropdown, this is a real fork in what happens to the person's data: **"Create a new workspace"** (secondary detail: "Keeps this agent's files separate, as their own workspace on your account") and **"Add to an existing workspace"** (secondary detail: "Merge this agent and its files into a workspace you already own"). Selecting "add to existing" reveals a workspace picker (reuse the workspace-switcher list component) restricted to workspaces where the signed-in user is owner/admin — a workspace they can only read shouldn't even appear here, not just be disabled, since showing it and then explaining why it's unclickable is a worse experience than not showing it.

**Quota-impact preview, once a target workspace is picked.** Reuse `Meter`/`StatTile`'s existing warning/danger color logic (the real thresholds per `25-theme-fix-verified-pending-deploy.md`: 75%/90%, not the 80%/95% that turned out to be wrong) to show "This will use {size} of your workspace's {limit}. You'll have {remaining} left" — colored amber/red if the merge would push the target near/over its own cap, using the same visual language the dashboard's stat tiles already use elsewhere, so this doesn't introduce a second, inconsistent warning style.

**Confirmation.** A consequential, hard-to-reverse action — reuse `ConfirmModal`, the same component `DELETE /v1/workspaces/:id` and other destructive flows already use, rather than a plain button. Copy: *"Add {agentName} and its {N} files to {targetWorkspaceName}? This can't be undone."* No "type the name to confirm" friction here (unlike workspace deletion) — this is additive, not destructive, to the target workspace, so that specific ritual (borrowed from the deletion flow) would be miscalibrated to this action's actual risk.

**Post-claim.** Redirect into the (now real) workspace's Overview, with a one-time `Toast` or `Alert`: *"{agentName} and {N} files were added to this workspace."* Reuses the existing reveal-once/acknowledgment pattern's visual weight, not its exact copy.

**Sandbox quota warning surfaced to a human, not just the agent.** If a workspace is unclaimed and nearing its sandbox cap, and someone with the claim link *does* eventually land on the claim page, the same 80%-warning data from PART 4.3 should render on the claim landing page too ("This workspace is at 82% of its temporary limit and will be deleted in 3 days if unclaimed") — one fact, shown in both the API response and the page that renders it, rather than two independently-computed copies that can drift, which is the exact failure mode `backlog/017` already documents for this product's *other* quota indicators.

---

## PART 7 — Standalone prompt for Claude Code

Copy-paste this to build the feature. It assumes the repo state described in PART 1 — verify that's still accurate before running it, since this doc was written against a live read of the code on 15 Sept 2026. **Read PART 8 before step 1 below** — two of the changes here (the sandbox cap, the expiry sweep) are retroactive against data that already exists in dev, and PART 8 has the specific guard each one needs before it's safe to deploy.

> Build agent-workspace claiming end to end, against the real state of this repo — not the original design docs where they've drifted (check `docs/design/05-technical-architecture.md` PART 13 for the original intent, but the schema and route tree as they exist today are the source of truth; `CLAUDE.md`'s precedence rule applies).
>
> **Today, `POST /v1/workspaces` (`routes/create-workspace.ts`, via `db/bootstrap.ts`) provisions a sandbox workspace but returns no claim link, and no route anywhere sets `workspaces.claimed_at`.** Build the missing claim flow first, then the attach-to-existing-workspace mode on top of it. Do not treat "claim" as already working.
>
> **1. Migration `0010_workspace_claiming.sql`**: add `claim_token_hash`, `claim_token_expires_at` to `workspaces`, unique-indexed on the hash where non-null. Add a `"sandbox"` entry to `PLAN_LIMITS` in `lib/plans.ts` with tighter numbers than `free` (default proposal: 50 MB storage / 500 files / 500 MB egress per period / same 100 MB max-file-size floor — confirm with product before shipping, these are a placeholder).
>
> **2. `create-workspace.ts` + `db/bootstrap.ts`**: generate a claim token (reuse `lib/keys.ts`'s existing token generation, don't write a second one) in the same D1 batch, return `claimUrl` in the response alongside the existing `apiKey`/`notice`. Report the new `"sandbox"` limits in the response body, not `PLAN_LIMITS.free`.
>
> **3. `GET /v1/workspaces/claim/:token`**: unauthenticated preview — workspace name, agent name, file count, total bytes, sandbox limits, expired/already-claimed state. No auth needed; the token is the only thing that can name this workspace, same trust model as a signed download link.
>
> **4. `POST /v1/workspaces/claim/:token`**: add beside `listWorkspaces`/`createWorkspaceForUser`/`deleteWorkspaceForUser` in `routes/workspaces.ts`, same "outside `withAuth`, still Firebase-authenticated" shape those three already use — follow `index.ts`'s existing wiring for how those three resolve a `UserRow`, don't invent a second auth path. Body: `{mode: "new"} | {mode: "attach", targetWorkspaceId, pathPrefix?}`.
>    - **`mode: "new"`**: single guarded `UPDATE ... WHERE claimed_at IS NULL` (so a race or double-click gets a clean 409, not a duplicate claim); reparent the workspace's `org_id` onto the caller's existing org (one real user = one owned org is an existing invariant elsewhere in this codebase — don't create a second org for the claiming user); re-run the existing `uniqueWorkspaceSlug`/`isSlugConflict` retry loop for the slug in its new org; delete the now-orphaned provisional `organizations`/`users` rows; `audit()` a `workspace.claimed` event. No file movement needed — the R2 key is `tenant/{workspaceId}/...` and the workspace ID doesn't change.
>    - **`mode: "attach"`**: authorize via `findMembershipForWorkspace` — owner/admin only on `targetWorkspaceId`, never reader. Sum the sandbox's active files (bytes, count) and run them through the **existing** `assertWithinQuota` against the target workspace; refuse the whole merge on `LIMIT_EXCEEDED`, never merge a partial subset. Resolve agent-name and path collisions by auto-suffixing the agent name and rewriting every merged file's path under `/agents/{finalName}/...` in the target (this repo's own folder-as-namespace convention — see `02-product-and-mvp-scope.md` §5.2), unless the caller supplied `pathPrefix`. Per file: R2 `GET` from `tenant/{sandboxId}/{fileId}`, `PUT` to `tenant/{targetId}/{newFileId}`, insert the new `files` row (preserve `created_by` as the agent, not the claiming human — this product's `FileCell` component exists specifically to keep that distinction visible), only then delete the old object and row — **copy before delete**, opposite order from `jobs/purge.ts`'s delete-then-row pattern, and for the opposite reason (that job is discarding data for good; this is relocating it, so the destination must exist before the source disappears). Update the target workspace's `storage_bytes_used`/`file_count` inline, not via the next `reconcileCounters` sweep. Repoint the existing `api_keys` row's `workspace_id`/`agent_id`/`scopes.pathPrefix` rather than revoking and reissuing — same token, same hash, agent's next call transparently lands in the new workspace. Then delete the now-empty sandbox workspace/org/user (reuse `deleteWorkspaceForUser`'s FK-ordered cascade, adjusted since files/keys already moved). One `auditAndNotify()` call on the target workspace: `agent.claimed_and_merged`, metadata `{sourceWorkspaceId, agentName, filesMoved, bytesMoved}`.
>
> **5. `jobs/purge.ts` (or a new sibling `jobs/sandbox-expiry.ts`)**: `expireUnclaimedWorkspaces(db, files, now, ttlMs, limit)` — select `workspaces WHERE claimed_at IS NULL AND created_at <= now - ttlMs`, delete each one's R2 objects (via `workspacePrefix()` list-and-delete, no restore window needed since sandboxes never had soft-delete semantics) then its D1 rows (reuse `deleteWorkspaceForUser`'s cascade ordering). Wire it into whatever the existing hourly cron trigger is in `index.ts`'s `scheduled` handler, alongside `purgeExpiredFiles`/`reconcileCounters` — confirm that wiring directly, don't assume it from `purge.ts`'s header comment.
>
> **6. Sandbox quota warning**: at the sandbox write path's existing `assertWithinQuota` call site, when projected usage crosses 80% of the *sandbox* limit without exceeding it, attach a `warning` object to the success response (dimension, percentage, `claimUrl`) rather than throwing. Compute this at the same call site as the hard block — do not add a second, UI-side calculation of the same percentage; this product has an existing bug class (`backlog/017`) of exactly that kind of drift.
>
> **7. Tests, following this repo's existing pattern of driving real HTTP against non-default state rather than hand-constructed fixtures** (per `backlog/017`'s own lesson about why four other limits survived 444 passing tests): a double-claim race (both requests, assert exactly one succeeds); `mode: "attach"` against a target workspace deliberately near its cap (assert refusal, assert nothing partially merged — count files in target before and after); agent-name collision on merge (assert auto-suffix, assert no data loss); the sandbox key's next call after a merge (assert it lands in the new workspace/path with the same token); the expiry sweep against a workspace created just past the TTL vs. just inside it; the 80% warning appearing and disappearing at the correct boundary once `reconcileCounters` next runs.
>
> **8. Design**: build the `/claim/{token}` landing page per the Claim-landing spec in this doc's PART 6 — preview before sign-in, an explicit "new workspace" vs. "add to existing workspace" choice (not a default), a quota-impact preview using the existing `Meter`/`StatTile` warning/danger treatment (75%/90% thresholds, not 80%/95%), and `ConfirmModal` (no "type the name" step — this is additive, not destructive). Do not invent new design-system primitives; everything here composes from what already exists.
>
> **9. Rollout guards (PART 8) — do not skip these:** ship the new `"sandbox"` limit applying only to workspaces created after this deploy, not retroactively to every `claimed_at IS NULL` row (existing unclaimed sandboxes under the old, looser cap must not suddenly start failing writes). Ship `expireUnclaimedWorkspaces` in a log-only mode first — report what it *would* delete, delete nothing — for at least one full TTL window before enabling real deletion, since dev already has old unclaimed sandboxes from earlier testing that would otherwise all be deleted on the very first run. Do not add `"sandbox"` to `PLAN_NAMES`/`isPlanName` in `lib/plans.ts` — keep `PLAN_LIMITS.sandbox` as a separate lookup, not a selectable plan value. Do not route the sweep through `deleteWorkspaceForUser` itself — extract its cascade ordering into a shared helper, since that function's name-confirmation body and last-workspace guard are both wrong for a system-initiated deletion.
>
> Report back explicitly on: whether the sandbox limit numbers in step 1 were kept as proposed or changed, whether `mode: "attach"` preserves the original API key or reissues one (state which, don't leave it ambiguous), the confirmed cron wiring from step 5, and — separately — confirmation that step 9's rollout guards are actually in place before this touches a shared dev environment.

---

## PART 8 — Rollout & compatibility risk

Checked directly against the live code (`index.ts`, `middleware/auth.ts`, `db/api-key-lookup.ts`, `wrangler.toml`) rather than assumed, since "will this break anything" deserves the same evidence standard as the rest of this doc.

**Verified safe — no change needed to how you'd build this:**
- **No route-collision risk.** `index.ts`'s own header states the routing discipline plainly: paths are split into segments and matched structurally, never by string pattern — "a route can never be reached by a URL that merely looks similar." Adding `GET`/`POST /v1/workspaces/claim/:token` cannot shadow or be shadowed by the existing `/v1/workspaces` routes.
- **No stale-cache risk from repointing a key's `workspace_id` in `mode: "attach"` (PART 3.5).** There is no cache in front of API-key resolution. `withAuth` calls `findApiKeyByHash` then `findWorkspaceById` fresh from D1 on **every single request** (`middleware/auth.ts`, `db/api-key-lookup.ts`) — confirmed by reading both, not inferred. The agent's very next call after a merge picks up the new `workspace_id`/`scopes` with nothing to invalidate.
- **The cron already exists and already runs hourly** (`crons = ["17 * * * *"]` in both `env.dev` and `env.prod` in `wrangler.toml`). `expireUnclaimedWorkspaces` (PART 4.2) is a third call inside the existing `scheduled()` handler's `try/catch`-per-job pattern — one job failing already can't block the others (`purgeExpiredFiles` and `reconcileCounters` are already independent try/catches), so adding a third follows an established, safe pattern rather than introducing a new one.
- **No existing route, handler, or repository needs to change.** Every addition in this doc is a new column (nullable, defaulted — same shape as migration `0003`'s own precedent), a new route, or a new job. Nothing in PART 2–4 modifies `files.ts`, `folders.ts`, `agents.ts`, or any of the single-workspace-scoped repositories.

**Real risk — needs an explicit guard, not just careful code:**
1. **Tightening the sandbox cap (PART 4.1) is retroactive unless you guard it.** `assertWithinQuota` compares *current* usage against whatever limit it's handed. Every unclaimed sandbox workspace that already exists today was provisioned under the full `free`-tier cap (2 GB). The moment a smaller `sandbox` tier ships and gets applied to *all* `claimed_at IS NULL` workspaces indiscriminately, any pre-existing sandbox already holding more than the new cap starts failing **every** new write immediately — not a future problem, a the-moment-you-deploy problem. Guard: apply the new sandbox limit only to workspaces created after the migration's rollout, or run a one-time check against dev's current unclaimed workspaces before flipping this on.
2. **The expiry sweep (PART 4.2) will hard-delete old data on its first run if you don't guard it.** This dev environment already has weeks of unclaimed sandbox workspaces sitting around from earlier QA passes (docs `17`–`27`'s testing history). The first time the new cron job fires post-deploy, every unclaimed workspace already older than the 7-day TTL — which is very likely all of them — gets deleted in that one run, with no grace period, because the sweep as specified has no "only workspaces created after this shipped" guard. **This is the single biggest real risk in this whole doc.** Do not enable real deletion on first deploy: ship it logging candidates only (count and list what *would* be deleted) for at least one full TTL window, review that list, then flip deletion on.
3. **Do not literally call `deleteWorkspaceForUser` from the sweep.** PART 3.6 and 4.2 both say "reuse its cascade logic," and that means the FK-ordered delete sequence specifically — not the function itself. `deleteWorkspaceForUser` requires a request body with the workspace's name typed back (there's no human typing anything in a cron) and refuses to delete somebody's *last* workspace (a check that's actively wrong here — an abandoned sandbox being the provisional owner's only workspace is the normal case, not an edge case to protect). Extract the cascade into its own shared helper both call sites use, rather than routing the sweep through the human-facing function.
4. **Keep `"sandbox"` out of `PLAN_NAMES`/`isPlanName` in `lib/plans.ts`.** It's a claim-state-derived pseudo-tier (applies because `claimed_at IS NULL`, not because anyone chose it), not a real billing plan. `PLAN_NAMES` currently gates what's valid in `workspaces.plan_override` and `organizations.plan`, and doc `14` PART 29.6's not-yet-built admin plan editor will eventually read from exactly that union. If `"sandbox"` is added to the same enum instead of kept as a separate constant, it risks becoming a selectable plan in that future admin UI or a valid value Stripe sync could see — neither of which should ever be true. Keep `PLAN_LIMITS.sandbox` as a lookup used only by the claim-state branch in PART 4.1, never merged into `PLAN_NAMES`.
5. **The cross-workspace merge (`mode: "attach"`) must be its own narrow handler, not a loosening of `WorkspaceScopedStorage`.** Nothing today lets a handler hold two workspaces' repositories at once — that's a deliberate tenant-isolation property every other route relies on. The risk isn't to anything *existing* breaking; it's that an implementer under time pressure "simplifies" this by adding an optional second `workspaceId` to the existing scoped classes to reuse them for the merge, which would quietly weaken that guarantee for every other caller of those classes, forever, for the sake of one feature. Open two separate `WorkspaceScopedStorage`/context instances inside the merge handler instead — exactly as PART 3.4 already specifies — and don't touch the constructors.
6. **The merge inherits `backlog/017`'s existing billing-status gap — it doesn't add a new one, but it doesn't fix it either.** `withAuth`'s `billingStatus` defaults to `"active"` unless a route explicitly threads real demand through (`middleware/auth.ts` line ~257), and `backlog/017` already documents that most write routes never do. A `past_due` account can therefore successfully receive an `attach` merge today, the same way it can successfully upload today — call this out in the PR rather than let it look like new, unreviewed behavior.

**Net assessment:** nothing in this doc requires changing code that already ships — every addition is new columns, new routes, or a new job, and the two things checked directly (routing collisions, key-lookup caching) came back clean. The actual risk is entirely in how the two *tightening* changes (sandbox cap, expiry sweep) get rolled out against data that already exists under the old, looser rules — both have a concrete guard above, and neither guard is optional.

## Open product decisions (not engineering calls — flagged, not made for you)

- Exact sandbox plan numbers (storage/files/egress) — PART 4.1's figures are a starting proposal, not a recommendation backed by this product's own cost model.
- Sandbox TTL before auto-delete — 7 days proposed, matching the live competitor; could reasonably be shorter given the tighter cap, or longer to reduce claim-friction complaints.
- Whether a merge should reissue the agent's API key instead of repointing it — PART 3.5 defaults to repointing (better agent UX, matches the competitor's own promise) but flags the more conservative alternative explicitly.