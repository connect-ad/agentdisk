# AgentDisk — External Code Audit

**Auditor's report · 8 September 2026**
Repository: `agent-storage-mcp` · branch `dev` @ `f4736a3` · working tree clean

> **Standing of this document.** This is an independent read of the codebase by an
> external reviewer. It reports what the code *does*, measured against what the
> documentation, the UI and the marketing site *say* it does. **No file in this
> repository was modified.** Every claim cites a file and line; every "verified"
> statement names the command that produced it.

---

## Table of contents

1. [Method and scope](#1-method-and-scope)
2. [How the system works — functions and their relationships](#2-how-the-system-works)
3. [The authorization chain, end to end](#3-the-authorization-chain-end-to-end)
4. [UI entities that are non-functional, dummy, or hardcoded](#4-ui-entities-that-are-non-functional-dummy-or-hardcoded)
5. [What is pending, per `docs/*`](#5-what-is-pending-per-docs)
6. [Security review](#6-security-review)
7. [Adversarial scenarios — cross-examination](#7-adversarial-scenarios--cross-examination)
8. [Verification log](#8-verification-log)
9. [Findings register](#9-findings-register)

---

## 1. Method and scope

Everything under `apps/api`, `apps/web`, `apps/admin`, `apps/api/migrations`,
`.github/workflows`, and the `docs/` and `backlog/` trees was read directly.
`design-system/` was treated as an upstream mirror and read but not judged,
except where the dashboard vendors from it and the vendored content is factually
wrong about the product.

Three things were run, not inferred:

| Command | Where | Result |
|---|---|---|
| `npx vitest run` | `apps/api` | **444 passed / 444**, 28 files, 22.2 s |
| `npx tsc --noEmit` | `apps/api` | **clean**, exit 0 |
| `npx vitest run` | `apps/web` | **22 passed / 22**, 2 files |

The API suite is genuinely good — it runs inside the real Workers runtime against
Miniflare-backed D1 and R2 using the same migration files the deploy applies,
which rules out a whole class of false confidence that mocked query layers
create. It is also the reason several findings below survived: **the tests prove
the helpers correct in isolation while the integration that would call them is
dead code.**

### The auditor's posture

I did not accept a comment as evidence of behaviour. This codebase is unusually
well commented — the prose explains *why* almost every decision was made, and it
is frequently excellent. It is also, in a handful of places, describing an
intent the code no longer implements or never did. **Where a comment and the code
disagree, this report follows the code.**

---

## 2. How the system works

### 2.1 Shape

One Cloudflare Worker (`apps/api`) serves two protocol surfaces from one
codebase; two static SPAs consume it.

```
                     ┌────────────────────────────────────────┐
  browser ──────────▶│  apps/web   (customer dashboard SPA)   │
  (Firebase ID token)└────────────────┬───────────────────────┘
                                      │
  staff browser ────▶ apps/admin ─────┤  (separate origin, staff session token)
  (staff session)                     │
                                      ▼
  agent / SDK ──────────▶  ┌────────────────────────────────────┐
  (ask_live_… API key)     │       apps/api — ONE Worker        │
                           │                                    │
                           │   fetch()      REST /v1/* + /mcp   │
                           │   scheduled()  hourly purge        │
                           │   queue()      webhook delivery    │
                           └────┬───────────┬───────────┬───────┘
                                │           │           │
                            D1 (SQL)    R2 (bytes)   KV (JWKS, rate limits)
```

The single most important structural decision in the repository: **MCP tools do
not reimplement anything.** `apps/api/src/mcp/tools.ts` builds a synthetic
`Request` and calls the same REST handler function —
`viaHandler(ctx, createFile, jsonRequest("POST", "/v1/files", args))` — so the
two surfaces cannot drift in what they permit. All ten tools do this. It holds.

### 2.2 The module graph — who depends on whom

**Entry point** — `apps/api/src/index.ts`
Hand-written router. It splits the path into segments *once* and matches
structurally rather than by string prefix, which is what stops `/v1/filesX` from
reaching the files handler (`index.ts:513`). Exports `fetch`, `scheduled`, `queue`.

**Identity resolution** — `apps/api/src/auth/`

| Function | File:line | Job | Called by |
|---|---|---|---|
| `authenticateApiKey` | `authenticate.ts:51` | Hash the bearer token, look it up, check revoked / expired / scopes | `withAuth` |
| `assertAgentEnabled` | `authenticate.ts:128` | Re-read the agent's `status` on **every** request | `withAuth` |
| `verifyFirebaseToken` | `firebase.ts:204` | RS256 verify against cached JWKS; check `iss`, `aud`, `exp`, `iat` | `resolveVerifiedUser` |
| `resolveVerifiedUser` | `authenticate.ts:172` | The above + resolve/provision the user row + check `session_revoked_after` | `authenticateFirebaseUser` and the two workspace-less routes |
| `authenticateFirebaseUser` | `authenticate.ts:194` | The above + the per-workspace membership check | `withAuth` |
| `parseScopes` / `assertScope` | `scopes.ts:60,119` | Fail-closed scope parsing; segment-boundary prefix match | everywhere |
| `scopeForRole` | `roles.ts:40` | Express a human role in the **same** `{ops, pathPrefix}` shape an agent key carries | `authenticateFirebaseUser` |

`scopeForRole` returning the identical shape an API key carries is the quiet
design win: a read-only human and a read-only agent traverse one check, not two
that can diverge.

**The chain** — `apps/api/src/middleware/auth.ts`
`withAuth` is the only path an authenticated request takes. It builds an
`AuthContext` and hands it to the handler. The handler signature is the whole
point: **a handler receives `AuthContext` and never `Env`**, so it has no route
to a raw D1 or R2 binding and cannot *express* a cross-tenant query.

**Tenant isolation** — `src/db/workspace-scoped.ts` + `src/storage/workspace-scoped.ts`
Seven repository classes plus one storage class, all extending a base whose
constructor throws on a blank workspace ID. **No method anywhere accepts a
`workspaceId` argument.** Every `getById` is
`WHERE workspace_id = ? AND id = ?`, so asking for another tenant's row by its
exact ID returns nothing rather than that row. `insert` additionally re-checks
`row.workspace_id === this.workspaceId` and throws — defence in depth against a
caller that built the row wrong.

`WorkspaceScopedStorage` applies identical discipline to R2: every method takes a
*file ID* and derives the key itself via `objectKey(this.workspaceId, fileId)`.
There is no argument through which to name another tenant's object. **This is the
strongest part of the codebase and I could not find a way around it.**

**The deliberate exception** — `src/staff/access.ts`
`StaffScopedAccess` takes `workspaceId` as a *method* argument on purpose,
because support must be able to see any customer. It is one class, in one file,
constructed in exactly one place (`routes/staff.ts`), and every method appends an
audit row — including reads. The containment is real and deserves credit.

### 2.3 Data model and lifecycle

`organizations` (billing account, Stripe customer, plan) → `workspaces` (1:N,
carrying denormalized usage counters) → `agents` → `api_keys`.
`workspace_members` is per-workspace, not per-org — so inviting somebody into one
client's workspace does not hand them the one beside it on the same bill.

**The file lifecycle is the core loop, and it is well built:**

```
POST /v1/files ─┬─ ≤1 MB: base64 inline → storage.put() → markActive() → counters +=
                │
                └─ >1 MB: row inserted as `pending`, size_bytes = 0
                          presigned PUT returned (15 min, one key, one method)
                             │
                          client PUTs bytes DIRECTLY to R2 (Worker not in byte path)
                             │
                   POST /v1/files/:id/complete
                             │
                          storage.head()  ← THE REAL SIZE, from R2
                          re-check quota; on failure delete + markFailed
                          markActive(head.size) → counters +=
```

The invariant that makes this safe: **the declared size buys a quota decision up
front, and `complete` re-derives the truth from R2.** A client that declares 1 KB
and uploads 1 GB is caught and the bytes deleted rather than left orphaned. That
is right — *provided `complete` is called*. See **[F-04](#f-04)**.

Two further invariants hold correctly throughout:

- **The client's `path` is metadata and never reaches the R2 key.** Keys are
  `tenant/{workspaceId}/{fileId}` built from server-generated ULIDs. A traversal
  string can dirty a listing; it cannot escape the tenant prefix. `..` is
  *rejected*, never collapsed (`paths.ts:60`) — collapsing is the bug class that
  turns a hostile path into a plausible one and hides the intent.
- **Folder emptiness is decided by path, never `folder_id`.** Folders are created
  lazily, so `folder_id` is an optimisation and `path` is the truth
  (`workspace-scoped.ts:393`). Asking the `folder_id` question would call a
  populated folder empty and orphan live files.

### 2.4 Background work

`scheduled` (hourly, `17 * * * *`) runs two jobs from `jobs/purge.ts`:

- **`purgeExpiredFiles`** — deletes the R2 object, *then* the row, for files
  soft-deleted more than 24 h ago. That order is deliberate: the reverse strands
  bytes nothing points at, which is the one failure the job could never later
  detect. Batch of 100.
- **`reconcileCounters`** — recomputes `storage_bytes_used` and `file_count` from
  the rows and logs drift as a warning rather than silently fixing it. Correct
  instinct: a job that quietly fixes symptoms hourly hides their cause.

`queue` consumes webhook deliveries. Each message is acked or retried
*individually* rather than via `retryAll()`, so one dead endpoint in a batch of
ten does not cause the other nine to be delivered twice. Deliveries are
HMAC-signed over `timestamp.body` in Stripe's header shape, with the timestamp
*inside* the signed material so a captured delivery cannot be replayed later.

---

## 3. The authorization chain, end to end

`withAuth` (`middleware/auth.ts:200`) executes six steps in a fixed order.

| # | Step | What happens | Where |
|---|---|---|---|
| 0 | Reject query credential | Any `?token=` / `?api_key=` / any value carrying the key prefix → 400 **naming the key as burned** | `authenticate.ts:42` |
| 1 | Authenticate | Told apart **by token shape**, not by header. `ask_live_`/`ask_test_` → API key path; anything else → Firebase verifier | `auth.ts:229` |
| 2 | Resolve scope | Key row's `scopes` blob, or `scopeForRole(role)` — arrives *with* the identity, so there is no second lookup to get wrong | `auth.ts:241` |
| 3 | Resolve workspace | **From the key row, full stop.** A client may *name* one; a mismatch is 403, never a silent substitution | `auth.ts:117` |
| 4 | Authorize | `assertScope(scope, op, path)` | `auth.ts:245` |
| 5 | Quota | `assertWithinQuota(...)` | `auth.ts:260` |
| 6 | Handler | Runs with an already-scoped `AuthContext` | `auth.ts:306` |

Step 0 is a good judgement call worth naming. The spec only requires that keys
are never *accepted* in a URL. Silently ignoring one would satisfy that to the
letter — but by the time the Worker sees it the key is already in Cloudflare's
access logs and the caller's shell history. It is burned either way, and only a
loud, specific failure gets it rotated. The code says exactly that to the caller.

Step 1's shape-based dispatch is also right. Deciding "API key or user token?"
by *which header it arrived in* would be a downgrade vector; deciding by the
token's own fixed prefix is not forgeable into the other branch, because anything
that isn't the prefix is handed to a verifier that demands a genuine RS256
signature for this exact Firebase project.

**Step 5 is where the chain has a hole.** See **[F-01](#f-01)**.

---

## 4. UI entities that are non-functional, dummy, or hardcoded

This section answers the brief directly. `docs/STATUS.md` claims:

> | 19 arrays of fixture data in the dashboard | **None. Every screen reads the API or says it isn't built** |

**That claim is false.** Fixture arrays remain, and worse, several controls do
not "say it isn't built" — they *report success for work that never happened*.

I classify these in three tiers, because they are not equally serious.

### Tier 1 — Controls that falsely report success (most serious)

These are worse than a missing feature. A user performs a destructive or
security-relevant action, receives an explicit success confirmation, and nothing
happened. The user's mental model of the system is now wrong in a way they have
no way to detect.

| # | Control | File:line | What it does | What the user is told |
|---|---|---|---|---|
| 1 | **Delete workspace** | `routes/Settings.jsx:163` | `onClick={() => setDialog(null)}` — closes the modal | Type-to-confirm the workspace name, then the dialog closes as if it worked |
| 2 | **Delete my account** | `routes/SettingsTabs.jsx:335` | `onConfirm` → toast only | Toast: **"Account deletion scheduled"** |
| 3 | **Export my data** | `routes/SettingsTabs.jsx:291` | Opens a modal; no request | Alert: **"We're preparing your export. We'll email you a download link within 24 hours."** |
| 4 | **Sign out all other sessions** | `routes/Settings.jsx:187` | `onConfirm` → toast only | Toast: **"Other sessions signed out"** |
| 5 | **Delete file(s)** | `routes/FileBrowser.jsx:402, 418` | Clears selection, shows toast | Toast: **"Deleted"** — the file is still there on reload |
| 6 | **Create folder** | `routes/FileBrowser.jsx:384` | `onClick={() => setDialog(null)}` | Dialog closes as if the folder was created |
| 7 | **Save workspace name** | `routes/Settings.jsx:84` | `setSaved(true)` then clears after 2 s | A green **"Saved"** indicator |
| 8 | **Sign out (one session)** | `routes/Settings.jsx:57` | `onClick={() => setToast('Session signed out')}` | Toast: "Session signed out" |

Items 2, 3 and 4 are the ones I would escalate first. Two of them are GDPR-shaped
promises (erasure and portability) rendered as completed actions, and one is a
security control. **Item 4 is especially unfortunate because the real endpoint
exists and works** — `POST /v1/me/logout-all` is implemented, routed
(`index.ts:289`), and correctly refuses API keys. The UI simply never calls it.

Item 1 and item 6 have no backing endpoint at all: there is no
`DELETE /v1/workspaces/:id`, no `PATCH /v1/workspaces/:id`, and `POST /v1/folders`
exists but the dialog never calls it.

### Tier 2 — Hardcoded and fixture data presented as live

| # | Entity | File:line | Reality |
|---|---|---|---|
| 9 | **Workspace ID field** | `routes/Settings.jsx:18` | `const WORKSPACE_ID = 'ws_8Kq2xR4mN7pL'` — a **fake ID**, displayed in a disabled input whose own hint reads *"This is what dashboard URLs and the API use to address the workspace."* Copy it into a script or an MCP config and nothing works. The real ID is available two lines away from `useWorkspace()`. |
| 10 | **MCP endpoint URL** | `routes/McpConnection.jsx:19` | `const ENDPOINT = 'https://mcp.agentdisk.io/v1'`. The real endpoint is `/mcp` or `/v1/mcp` on the API host (`index.ts:410`); the deployed host is `mcp-dev.agentdisk.io`. **The config snippet the screen exists to hand the user is wrong in both host and path.** |
| 11 | **MCP connection status** | `routes/McpConnection.jsx:34` | `function McpConnection({ state = 'connected-active' })` — a hardcoded default prop. The screen never queries anything. It renders a pulsing green **"Connected"** badge unconditionally, even with no keys. |
| 12 | **"Include my API key"** | `routes/McpConnection.jsx:21` | `const REAL_KEY = ''`. Ticking the box produces `"Authorization": "Bearer "` and an alert warning *"This snippet now contains a live credential."* It contains nothing. |
| 13 | **Recent MCP calls** | `routes/McpConnection.jsx:32` | `const RECENT = []`, commented *"The MCP server is not built."* It **is** built. Because `active` is hardcoded true, the panel renders `[].map(...)` — an empty box with not even an empty-state. |
| 14 | **Available MCP tools** | `routes/McpConnection.jsx:53` | `mcpTools.map(t => ({...t, enabled: t.scope !== 'files:delete'}))` — enablement hardcoded, not read from the key's scopes. Worse, the fixture's scope vocabulary (`files:read`, `files:write`, `files:delete`) **does not exist in this product**; the real ops are `read, write, delete, list, keys:create` (`scopes.ts:21`). |
| 15 | **Agents stat tile** | `routes/Dashboard.jsx:176` | `value="—"` / `sub="Not built yet"`. `GET /v1/agents` is built, works, and is called by the Agents screen on the next tab. |
| 16 | **Active sessions table** | `routes/Settings.jsx:21` | `const SESSIONS = []`. Firebase exposes no device inventory, so the table can never populate — but the full table, columns and per-row "Sign out" button ship anyway. |
| 17 | **Sole-owner guard** | `Settings.jsx:151` → `SettingsTabs.jsx:265` | `<PrivacyTab soleOwnerOf={0} />` is hardcoded. The "you are the only owner of N workspaces, transfer ownership first" block is **unreachable**, and the Delete-account button is therefore always enabled. |
| 18 | **Sub-processors table** | `routes/SettingsTabs.jsx:259` | Lists **Resend** for transactional email. There is no Resend integration anywhere in the repo — the only email is Firebase's own verification. A published sub-processor list naming a processor you do not use is a compliance-document error. |
| 19 | **Requests-this-period tile / meter** | `Dashboard.jsx`, `Usage.jsx` | Reads `usage.requests.used` ← `workspaces.requests_period`, a column **nothing ever increments** (see [F-03](#f-03)). It is permanently `0`. |

### Tier 3 — Dead controls and stale copy

| # | Entity | File:line | Note |
|---|---|---|---|
| 20 | **"Upload files"** (empty state) | `FileBrowser.jsx:201` | No `onClick`. Dead button — and the only affordance offered on an empty folder. |
| 21 | **"Download as zip"** | `FileBrowser.jsx:269` | No `onClick`. No such endpoint exists. |
| 22 | **"Download"** ×2 | `FileBrowser.jsx:339, 352` | No `onClick`. `GET /v1/files/:id/download` **is** implemented and returns a presigned URL. |
| 23 | **"Change password"** | `Settings.jsx:122` | `<Button>Change password</Button>` — no handler at all, above three password inputs. |
| 24 | **Annual-billing toggle** | `Marketing.jsx:240` | `annual` state is set and **never read**. Prices do not change. A "2 months free" badge sits beside it. |
| 25 | **Search copy** | `FileBrowser.jsx:195` | *"Search covers filenames, paths and extracted text"* — the API explicitly does **not** search contents and says so in its own response (`searchedFields`). |
| 26 | **"Configure SSO"** | `Settings.jsx:143` | Disabled button under *"SSO is available on the Team plan."* Nothing implements SSO on any plan. |

### 4.1 The pricing page is wrong in every number

`routes/Marketing.jsx:202` hardcodes a `PLANS` array. `apps/api/src/lib/plans.ts`
is what the API actually enforces. **They agree on nothing.**

| | Marketing says | Code enforces | Ratio |
|---|---|---|---|
| Free — storage | 1 GB | **2 GB** | 2× |
| Free — files | 1,000 | **5,000** | 5× |
| Free — requests | 10,000 / mo | **100,000** | 10× |
| Free — agents | 1 agent | **3** | 3× |
| Pro — storage | 10 GB | **50 GB** | 5× |
| Pro — files | 10,000 | **100,000** | 10× |
| Pro — requests | 100,000 / mo | **2,000,000** | 20× |
| Pro — agents | "Unlimited" | **20** | — |
| Team — storage | 100 GB | **500 GB** | 5× |
| Team — files | 100,000 | **1,000,000** | 10× |
| Team — requests | 1M / mo | **20,000,000** | 20× |

Two of these are the *dangerous* direction: **"Unlimited agents" on Pro is
contradicted by a limit of 20**, and Team's "SSO (coming soon)" and "Audit export"
are features with no implementation. The rest under-sell the product, which is
merely embarrassing.

The FAQ on the same page adds two more contradictions:

- *"Deleted files stop counting once they leave the **30-day** trash window."*
  The grace period is **24 hours** (`files.ts:40`), and quota is released
  **immediately** on delete (`files.ts:621`), not after any window.
- *"Downgrading below your current usage keeps your data readable but **blocks new
  writes**."* The write block is not enforced — see [F-01](#f-01).

There is also **no purchase path**. All three plan CTAs link to `/signup`
regardless of plan, and the billing API offers only
`billingPortal.sessions.create` — there is no Stripe Checkout session anywhere.
A customer cannot subscribe to Pro or Team through this product at all.

### 4.2 Where the UI is genuinely good

To be fair, and because it sharpens the contrast — these screens are fully and
correctly wired to the live API:

- **Members** (`SettingsTabs.jsx:36`) — invite, change role, remove with the
  `revokeKeys` checkbox, all real, with proper error surfacing and reload.
- **Billing** (`SettingsTabs.jsx:352`) — real, owner-gated, honest about the card
  living on Stripe rather than guessing.
- **Agents / Agent detail** (`AgentDetails.jsx:169`) — enable/disable really calls
  `PATCH /v1/agents/:id`.
- **API keys** (`ApiKeys.jsx`) and **Webhooks** (`Webhooks.jsx`) — real create and
  revoke/delete against the API.
- **Profile** (`Profile.jsx:28`) — real Firebase `updateDisplayName`.
- **File upload** (`lib/upload.js`) — genuinely excellent. Correctly picks inline
  vs presigned on size, computes SHA-256 before the PUT so a corrupted transfer is
  rejected, uses XHR purely for progress, and **tags the failure with which step
  failed** (`err.step = 'create' | 'put' | 'complete'`) so "retry" and "you have
  an orphan" are distinguishable.
- **Sandbox** (`Sandbox.jsx:110`) — real Turnstile-gated `POST /v1/workspaces`.

The pattern is clear: **the screens built or rewired during the API-integration
pass are real; the screens from the original design-mock pass were never
revisited.** `FileBrowser` is the visible seam — its upload path was rewired and
is excellent, while the delete, download and folder controls sitting beside it
are untouched mock handlers.

---

## 5. What is pending, per `docs/*`

### 5.1 Declared pending — `docs/STATUS.md` "What is not built"

| Item | Consequence as stated | Auditor's note |
|---|---|---|
| Editable plans and pricing | Console lists plans, cannot change one or push a price to Stripe (14 PART 29.6) | Confirmed. Compounded by §4.1 — there is also no *purchase* path, which STATUS.md does not mention. |
| Staff provisioning in-product | `POST /v1/staff/users` is 501 **by design**; accounts come from `scripts/provision-staff.mjs` | Confirmed and the design reasoning is sound. `test/staff-crypto.test.ts` pins the script's literal output against the Worker's verifiers, which is the right mitigation for a build-time gap between two PBKDF2/AES-GCM/base32 implementations. |
| Multipart upload | Files above ~5 GB cannot be uploaded in one part | Confirmed. Note the Team plan's `maxFileBytes` is exactly 5 GB, so the cap and the gap coincide. |
| Signed permanent links | `POST /v1/files/:id/sign` needs a `signed_links` table | Confirmed; no such route or table. |
| Full-text search inside files | Needs an index; the API names the fields it searched | Confirmed and handled honestly by the API (`searchedFields` in the response). **But the UI copy contradicts it** — item 25, and the MCP tool fixture, item 14. |
| `openapi.yaml` | No generated client or docs site | Confirmed absent. |
| Production | Never applied | Confirmed. `prod` workspace empty; gated behind a PR to `main` plus required reviewer. |

### 5.2 Declared pending — `backlog/`

| # | Item | Status in file | Verified |
|---|---|---|---|
| 006 | Upstream the Drawer | Open — design-system gap | Yes |
| 007 | Browser-verify the screens | Open — 4 of 31 rendered, no state variants | Yes — **and this is the item that would have caught most of §4** |
| 010 | Test suite | Open — API covered, web has "a runner and one file" | Yes; web is now 2 files / 22 tests, still **zero coverage of any route component** |
| 011 | Rename `Worlflow.md` | Open — trivial | Yes, typo still present |
| 015 | Rename in the design system | Open — `design-system/` still says "AgentDrive" | Yes |
| 016 | Upstream the workspace switcher | Open | Yes |

Items 001–005, 008, 009, 012, 013, 014 are marked Done and the code supports
that, **with the exception of 009 ("Wire screens to the API — Done — no fixture
data remains")**, which §4 contradicts.

### 5.3 Undeclared gaps — pending, but not written down anywhere

These are the ones an external auditor is for. None appear in `STATUS.md`,
`CLAUDE.md`, or the backlog.

| Gap | Impact |
|---|---|
| **Billing write-block never fires** | The single most consequential. See [F-01](#f-01). |
| **No usage period ever resets** | Egress and request caps stop being enforceable ~30 days after each workspace is created, permanently. See [F-02](#f-02). |
| **`requests_period` is never incremented** | The request cap is unenforceable from day zero; the metric shown to users is permanently 0. See [F-03](#f-03). |
| **Abandoned uploads are never reclaimed** | Unbounded free storage, invisible to quota and billing. See [F-04](#f-04). |
| **No rate limiting on any authenticated route** | `enforce()` is called in exactly one place. See [F-06](#f-06). |
| **Plan limits `agents`, `apiKeys`, `members` are declared but never checked** | `grep -rn "limits.agents\|limits.apiKeys\|limits.members" src/` returns nothing. Free plan says 3 agents / 10 keys / 1 member; all three are unlimited in practice. |
| **Staff fleet search is broken** | Reachable from the admin console UI. See [F-05](#f-05). |
| **`staff.user.force_logout` violates a foreign key** | See [F-07](#f-07). |
| **Webhook secrets stored in plaintext** | The migration comment claims otherwise. See [F-09](#f-09). |
| **4 of 6 subscribable webhook events are never emitted** | `file.updated`, `file.restored`, `folder.created`, `folder.deleted` are offered in `WEBHOOK_EVENTS` (`webhooks.ts:29`) and in the UI, but no code path calls `auditAndNotify` for them. A customer subscribes and waits forever. |
| **Destructive operations are unaudited** | See [F-08](#f-08). |
| **No audit-event retention job** | The Privacy tab publishes "Audit events … Retained 12 months." Nothing deletes them; the table grows without bound. |
| **`reconcileCounters` only ever sees 200 workspaces** | `ORDER BY id LIMIT 200` with no cursor (`purge.ts:133`). Workspace 201+ never has its counters corrected. |
| **`purgeExpiredFiles` caps at 100/hour** | 2,400 files/day platform-wide. One customer deleting 50,000 files stalls every other customer's purge for three weeks, and they keep paying for the bytes. |
| **`Docs.jsx` contradicts `STATUS.md`** | The in-product docs page says MCP "is not built yet" and `mcp-dev.agentdisk.io` "does not answer tool calls today." `STATUS.md` says all ten tools ship and were exercised live. One of them is wrong and a customer reads the first one. |

---

## 6. Security review

### 6.1 What is genuinely well built

I want to state this plainly before the findings, because the security posture is
better than most codebases of this size and the good parts are load-bearing.

| Control | Assessment |
|---|---|
| **Tenant isolation** | **Strong.** Structural, not procedural. Workspace ID bound in constructors; no method takes one; handlers never see a raw binding. I could not construct a cross-tenant read or write through any customer route. |
| **Credential storage** | **Strong.** Only SHA-256 of the whole token (prefix included, so `ask_live_X` ≠ `ask_test_X`) reaches D1. Base62 via rejection sampling from `crypto.getRandomValues` — no modulo bias, no `Math.random`. Shown once, no recovery path. |
| **Auth-failure uniformity** | **Strong.** Unknown, revoked, expired, forged, disabled-agent and corrupt-scopes all return one identical `UNAUTHORIZED` body; the reason goes to `internalReason` and the log only. This is the difference between an error and an oracle, and it is applied consistently. |
| **Scope prefix matching** | **Correct.** `scopeAllowsPath` matches whole segments, so `/agents/bot` does not authorize `/agents/bot-evil/secrets.txt`. A plain `startsWith` says it does; that is the entire bug class and it is closed. |
| **Fail-closed everywhere** | **Consistent.** Unparseable scopes grant nothing. Unknown role grants nothing. Unknown plan → `free` (tightest). Missing Turnstile secret → refuse rather than serve ungated. Missing `DATABASE_ENCRYPTION_KEY` → staff login refuses. JWKS unreachable → refuse. Unreadable webhook subscription → grants nothing. |
| **JWT verification** | **Correct.** `alg` pinned to RS256 (closes algorithm confusion incl. `alg:none`), `iss` and `aud` both checked against the configured project, `exp` with **no** skew tolerance, `iat` with 60 s. Unknown `kid` earns exactly *one* forced JWKS refetch — so a garbage `kid` cannot be used to hammer Google's endpoint through this Worker. |
| **Presigned URLs** | **Correct.** `aws4fetch` rather than hand-rolled SigV4 (right call — canonicalization bugs here either fail silently or over-authorize). Scoped to one key, one method, short TTL, hard 7-day cap. Never logged in full — `redactPresigned` strips the query string, because the signature *is* the capability. |
| **CORS** | **Correct.** Exact string equality against a per-environment allowlist, never a suffix check (`endsWith("agentdisk.io")` would accept `evil-agentdisk.io`). `Vary: Origin` on **every** response including errors — without it a cache turns a per-origin allowlist into a wildcard. |
| **SQL** | **Correct.** Every statement uses bound parameters. `escapeLikePattern` prevents `%`/`_` in a user path from widening a prefix query. `file_tags` has no `workspace_id` of its own, so every write re-proves ownership with `WHERE EXISTS (... workspace_id = ?)` rather than trusting the caller looked it up through a scoped repository. |
| **Stripe webhook** | **Correct.** Signature verified over the **raw body** before a single field is read. |
| **Staff auth** | **Strong.** Separate table, separate token shape, separate code path. TOTP mandatory every login, no exceptions. 4-hour sessions. Session tokens stored as SHA-256. Disabled account kills live sessions immediately. Timing-equalized login (a missing account still runs a PBKDF2 verify). Lockout counter cleared **only on full success**, so knowing the password does not buy unlimited TOTP guesses. `sessionStorage` not `localStorage` in the console. |
| **Secrets hygiene in CI** | **Good.** `terraform output -json` is written to `$RUNNER_TEMP` and `rm -f`'d immediately (`backend.yml:228`); the frontend pipeline reads only named outputs and never the JSON form. `.gitignore` covers `.dev.vars`, `.tfstate`, `*secret*.tfvars`, `backend.hcl`. No secrets are committed. |

### 6.2 Findings

<a name="f-01"></a>
#### F-01 — The billing write-block is dead code · **HIGH**

**The product's stated behaviour, in three places, is not implemented.**

`docs/STATUS.md` says *"`past_due` blocks writes and leaves reads working."*
`GET /v1/billing` returns `writesBlocked: true` (`billing.ts:50`). The dashboard
renders a banner reading *"New uploads are paused"* (`SettingsTabs.jsx:391`).
The marketing FAQ repeats it.

The enforcement path:

```ts
// middleware/auth.ts:253-260
const demand = requirement.demand ?? {};
const intendsWrite =
  (demand.bytes !== undefined && demand.bytes > 0) ||
  (demand.files !== undefined && demand.files > 0);
const billingStatus = intendsWrite
  ? ((await findOrgForWorkspace(...))?.billingStatus ?? "active")
  : "active";
assertWithinQuota(workspace, limits, demand, now, billingStatus);
```

**No route in `index.ts` ever populates `requirement.demand`.** Verified:

```
$ grep -rn "demand" apps/api/src --include=*.ts
middleware/auth.ts:99    demand?: QuotaDemand;     ← declared
middleware/auth.ts:253   const demand = ...        ← read
lib/quota.ts:...                                   ← consumed
(no route sets it)
```

Therefore `intendsWrite` is **always false**, so `billingStatus` is **always the
hardcoded literal `"active"`**, so `assertBillingAllowsWrite` returns at its first
line every time.

The three route-level calls that *do* carry a real write demand omit the argument
entirely, falling back to the default `billingStatus = "active"` (`quota.ts:84`):

- `files.ts:246` — `createFile`
- `files.ts:360` — `completeFile`
- `folders.ts:283` — `copyFile`

**Net effect: a `past_due` or `canceled` organization can upload, complete and
copy files without limit, while its own dashboard tells it uploads are paused.**

**Why the test suite did not catch it.** `test/billing.test.ts:217` reads:

```ts
it("blocks a write while past_due", () => {
  expect(() => assertWithinQuota(workspace, limits, { bytes: 100, files: 1 }, NOW, "past_due"))
    .toThrow(...)
});
```

It calls the helper **as a pure function, passing `"past_due"` by hand**. Nothing
drives a real `POST /v1/files` against a `past_due` workspace. The helper is
correct; the wiring that would ever hand it a non-`"active"` value does not exist.
The file's own header comment even opens with *"…a `past_due` account that can
still…"*, which reads now as an unfinished thought.

---

<a name="f-02"></a>
#### F-02 — Usage periods never reset; egress and request caps expire permanently · **HIGH**

`workspaces.period_reset_at` is written **once**, at creation
(`bootstrap.ts:92`, `user-lookup.ts:219`, `workspaces.ts:90`), as
`now + PERIOD_LENGTH_MS`. It is then only ever **read** — by `quota.ts:44` and
`whoami.ts:63`. Verified: `grep -rn "period_reset_at" src/` shows three writes
(all inserts) and two reads. Nothing advances it. The hourly cron
(`index.ts:598`) runs only `purgeExpiredFiles` and `reconcileCounters`, neither of
which touches it, `egress_bytes_period`, or `requests_period`.

The period guard is:

```ts
// quota.ts:44
function periodCounter(value, workspace, now) {
  return now >= workspace.period_reset_at ? 0 : value;
}
```

The intent is sound — a stale counter must read as zero so a workspace is not
locked out past the end of the month. But because `period_reset_at` never
advances, **once it passes, `periodCounter` returns 0 forever.**

Consequences, all permanent, all beginning roughly one period after each
workspace is created:

1. The **egress cap is never enforced again.** A workspace on Free (10 GB/period)
   can generate unlimited download URLs.
2. The **request cap is never enforced again** — though it never was; see F-03.
3. `whoami.usage.egressBytes.used` reports the raw column, which grows
   monotonically forever and is never zeroed. The Usage screen will eventually
   render *"Egress this period — 4.2 TB of 10 GB · 100%"* and a red
   **"You've reached your egress limit"** banner (`Usage.jsx:91`) that is false —
   the API will happily serve the next request.
4. The subtitle *"Resets in N days"* counts down to 0 and stays there.

So the UI progressively converges on claiming a limit is enforced at precisely
the moment it stops being enforceable.

---

<a name="f-03"></a>
#### F-03 — `requests_period` is never incremented · **MEDIUM**

`WorkspaceScopedCounters.apply` (`workspace-scoped.ts:741`) handles exactly three
deltas — `bytes`, `files`, `egressBytes`. There is no `requests` delta and no
other writer. Verified: `grep -rn "requests_period" src/` returns the type
definition, the quota read, and the `whoami` read. **No write.**

`quota.ts:90` therefore always compares `0 >= limits.requestsPerPeriod`, which is
never true. The request cap — 100,000/month on Free, advertised on the pricing
page — has never been enforced.

The file's own header is candid about this pattern (*"Until those writers exist
the checks pass trivially, which is correct… What this file must not do is
pretend to enforce a dimension nobody is measuring"*). The check is honest; the
**UI is not**, because `Dashboard.jsx` and `Usage.jsx` present the permanently-zero
counter as a live metric with a progress meter.

---

<a name="f-04"></a>
#### F-04 — Abandoned uploads are never reclaimed: unbounded free storage · **MEDIUM–HIGH**

`purgeExpiredFiles` selects **only** `status = 'deleted'` (`purge.ts:61`).
`reconcileCounters` sums **only** `status = 'active'` (`purge.ts:143`).

A file row created by `POST /v1/files` sits in `status = 'pending'` with
`size_bytes = 0` until `complete` runs. **Nothing ever cleans up a `pending` row,
and nothing ever deletes its R2 object.**

The abuse path, using only documented API calls:

```
1. POST /v1/files  { "path": "/x1", "sizeBytes": 1 }
      → quota checked against the DECLARED 1 byte  (files.ts:245-246)
      → row inserted `pending`, size_bytes = 0
      → presigned PUT returned
2. PUT <presigned url>  with a 100 MB body
      → R2 accepts it. A SigV4 query-signed URL does not bind Content-Length.
3. Never call /complete.
4. Repeat.
```

Every one of those objects is real, billable-to-Cloudflare storage that is:
- invisible to `storage_bytes_used` (never incremented — `markActive` never ran),
- invisible to `reconcileCounters` (which only counts `active`),
- invisible to the quota check on the *next* upload,
- and never purged.

The per-file size cap does not help: `assertFileSizeAllowed(declaredSize, ...)`
at `files.ts:245` checks the **declared** size. The real size is only ever learned
in `complete`, which the attacker declines to call.

**The codebase knows about this.** `lib/upload.js` says, in its header: *"a PUT
that succeeds and a `complete` that never fires leaves an object in the bucket
that nothing accounts for."* The client-side mitigation (reporting which step
failed) exists. The server-side reaper does not.

Note the asymmetry that makes this worse than a normal orphan problem: the
**honest** failure mode (a browser tab closed mid-upload) and the **hostile** one
produce identical rows, so there is no signal to alert on either.

---

<a name="f-05"></a>
#### F-05 — Staff fleet search throws a SQLite error · **MEDIUM** (availability, staff-facing)

`staff/access.ts:200`, inside a **double-quoted JS string**:

```ts
"WHERE w.name LIKE ? ESCAPE '\\\\' OR o.name LIKE ? ESCAPE '\\\\'"
```

Four source backslashes → JS unescapes to **two** → the SQL text reads
`ESCAPE '\\'`. SQLite does not process backslash escapes inside string literals,
so that is a **two-character** string. `ESCAPE` requires exactly one character;
SQLite raises *"ESCAPE expression must be a single character."*

Contrast `db/workspace-scoped.ts:61`, inside a **template literal**:
`ESCAPE '\\'` → two source backslashes → JS unescapes to **one** → SQL reads
`ESCAPE '\'`. Correct.

Measured directly rather than reasoned about:

```
RUNTIME staff SQL : WHERE w.name LIKE ? ESCAPE '\\' OR o.name LIKE ? ESCAPE '\\'
RUNTIME ws    SQL : WHERE workspace_id = ? AND path LIKE ? ESCAPE '\' ...
staff ESCAPE arg length = 2   ← SQLite requires 1
ws    ESCAPE arg length = 1
```

The unsearched listing (`q` absent) omits the clause entirely and works, which is
why this is invisible in casual use. **The admin console does pass `q`**
(`apps/admin/src/api.js:83`), so any staff search fails. No test covers it —
`grep -n "search\|listFleet" test/staff.test.ts` returns nothing.

*Not* an injection risk: the term itself is bound as a parameter. This is
availability and staff-tooling only.

---

<a name="f-06"></a>
#### F-06 — No rate limiting on any authenticated route · **MEDIUM**

`lib/rate-limit.ts` is a competent fixed-window KV limiter, honest about its own
consistency model. It is called **exactly once**:

```
$ grep -rn "enforce(\|consume(" apps/api/src
lib/rate-limit.ts:38   export async function consume(
lib/rate-limit.ts:69   export async function enforce(
lib/rate-limit.ts:75     const result = await consume(...)
routes/create-workspace.ts:65   await enforce(deps.kv, CREATE_WORKSPACE_RATE_LIMIT, ...)
```

Only the unauthenticated sandbox route is limited. **Every authenticated REST
route and the entire MCP endpoint have no per-key, per-IP or per-workspace
limit.** Doc 06 PART 16.14 calls for per-key limits; combined with F-03 (the
request-count quota that would have been the backstop is never incremented),
there is **no request-rate control of any kind** on the authenticated surface.

Practical consequences: unlimited key-guessing against `/v1/whoami` (each attempt
is a SHA-256 plus one indexed D1 read — cheap for the attacker, cheap but
unbounded for the platform), unlimited MCP `tools/call` volume, and no protection
against a runaway agent in a retry loop.

Staff login *is* limited (5 per email per 15 min), so the highest-value credential
is covered.

---

<a name="f-07"></a>
#### F-07 — Staff force-logout succeeds, then 500s, and leaves no audit trail · **MEDIUM**

`routes/staff.ts`:

```ts
const workspaceId = url.searchParams.get("workspaceId") ?? "";
const done = await access(staff, deps).forceLogout(userId, workspaceId);
```

`StaffScopedAccess.forceLogout` (`access.ts:255`) performs the `UPDATE users SET
session_revoked_after = ...` **first**, then calls `this.record(workspaceId, ...)`,
which inserts into `audit_events`. That table declares:

```sql
workspace_id TEXT NOT NULL REFERENCES workspaces(id)   -- migrations/0002:140
```

An empty string satisfies `NOT NULL` but fails the foreign key. D1 enforces
foreign keys, so the insert throws, the exception propagates, and the caller
receives a 500 — **after the sessions have already been revoked.**

Three problems compound:

1. The action succeeded but is reported as failed. A support engineer will retry.
2. The audit row — the entire point of `StaffScopedAccess`, whose contract is
   *"every method appends an audit event, unconditionally, including reads"* — is
   never written. **The one staff action most likely to be questioned later
   leaves no record.**
3. `apps/admin/src/api.js:89` builds `?workspaceId=${workspaceId}` with no guard,
   so an undefined argument sends the literal string `undefined`, which fails the
   same foreign key.

The `await` here is deliberate and correct in principle (`access.ts:157` explains
that a staff action which could not be recorded should not be reported as having
happened) — but the ordering inverts the intent: the write happens *before* the
record, so the failure produces the worst of both.

---

<a name="f-08"></a>
#### F-08 — The most destructive operation in the product is unaudited · **MEDIUM**

`audit()` / `auditAndNotify()` are called for: agent create/update/delete, file
create/delete, key create/revoke, member add/role-change/remove, webhook
create/update/delete, and every MCP tool call.

**Not audited, verified by enumerating every call site:**

| Operation | Route | Why it matters |
|---|---|---|
| `DELETE /v1/folders/:id?recursive=true` | `folders.ts:186` | **Soft-deletes an entire subtree in one call.** No audit row, no webhook, no per-file record. A workspace can lose 10,000 files with nothing in the activity log but silence. |
| `POST /v1/files/:id/move` | `folders.ts:221` | Changes a file's path — and therefore which scoped keys can reach it. |
| `POST /v1/files/:id/copy` | `folders.ts:262` | Duplicates bytes across scope boundaries. |
| `POST /v1/files/:id/restore` | `files.ts:646` | Un-deletes. |
| `PATCH /v1/files/:id` | `files.ts:581` | Metadata and tags. |
| `POST /v1/folders` | `folders.ts:66` | |

The recursive folder delete is the one I would fix first. It is the single most
destructive customer-facing operation, it is exactly what a compromised
`delete`-scoped key would reach for, and the Activity screen — which the product
positions as *"exactly what an agent did to your files"* — will show nothing at
all.

---

<a name="f-09"></a>
#### F-09 — Webhook signing secrets stored in plaintext, contrary to the schema comment · **LOW–MEDIUM**

`migrations/0002_core_schema.sql:156` states:

```sql
-- Webhooks (MVP-1). secret is stored encrypted at rest (06 PART 16.16a).
```

`WorkspaceScopedWebhooks.insert` (`workspace-scoped.ts:663`) binds
`row.secret` directly, and `createWebhook` (`webhooks.ts:125`) sets
`secret: generateSecret()` — the raw `whsec_…` value. No encryption anywhere.
`DATABASE_ENCRYPTION_KEY` is used **only** for staff TOTP secrets
(`staff/crypto.ts`); no other call site exists.

Impact is bounded — the secret authenticates *us to the customer*, so disclosure
lets an attacker forge deliveries **to that customer's endpoint**, not act on
AgentDisk. But it is a live credential at rest in plaintext, and the schema
comment asserts otherwise, which means anyone auditing by reading the migration
will reach the wrong conclusion.

The handling elsewhere is correct: never returned by any read (`toResource`
omits it), never logged, shown once at creation.

---

<a name="f-10"></a>
#### F-10 — Agent API keys can read the billing account, including the owner's email · **LOW–MEDIUM**

`index.ts:434`:

```ts
if (segments[2] === undefined && request.method === "GET") {
  return await authed({ op: null }, (authCtx) => getBilling(authCtx, billingDeps));
}
```

`op: null` means *any valid credential, no capability required*. `getBilling`
(`billing.ts:36`) performs **no identity check** — its comment reads *"Safe for
any member to read"*, but an agent API key is not a member.

So the most narrowly-scoped credential in the system — say
`{ops: ["read"], pathPrefix: "/agents/bot"}` — can call `GET /v1/billing` and
receive the org's plan, billing status, subscription state, and
**`ownerEmail`**: the human owner's address, which appears nowhere else on the
agent-facing surface.

The neighbouring routes get this right and show the intended pattern:
`createPortalSession` checks `ctx.identity.kind !== "firebase_user"` **and**
`role !== "owner"` (`billing.ts:66-71`); `members.ts:65` has a `requireHuman`
helper with the comment *"Members is a human surface; an agent key has no
business reading the roster."* Billing has no equivalent.

Realistic impact: a prompt-injected agent, or a leaked scoped key, harvests the
account owner's email for a targeted phish that can cite the real plan and real
billing status.

---

<a name="f-11"></a>
#### F-11 — Lower-severity observations

| # | Observation | Note |
|---|---|---|
| a | **Staff lockout is a denial-of-service primitive** | `staff:login:${email}` (`staff.ts:57`) is keyed on email alone. Anyone who knows a staff address can send 5 bad passwords every 15 minutes and keep that engineer locked out indefinitely — including during the incident their access exists for. Consider keying on `email+IP`, or exempting a correct password+TOTP from the lockout. |
| b | **Webhook delivery follows redirects** | `deliverOnce` (`webhook-delivery.ts:108`) uses `fetch` with default `redirect: "follow"`. HTTPS is correctly enforced at *registration* (`webhooks.ts:42`), but a registered endpoint can 302 anywhere, defeating that check at delivery time. Blast radius in Workers is limited (no cloud metadata service), but the signed payload and its headers follow the redirect. `redirect: "manual"` would close it. |
| c | **`rejectQueryCredential` does not cover staff or Stripe routes** | It runs inside `withAuth` (`auth.ts:213`), which staff routes and `POST /v1/webhooks/stripe` bypass. A staff token in a URL would not trigger the "treat this as burned" warning. |
| d | **Presigned PUT URLs are replayable within their 15-minute window** | The URL authorizes PUT on one key for 15 min, so it can overwrite the object repeatedly. Bounded by `complete` re-heading the real size — except where `complete` is never called (F-04). |
| e | **Quick-start snippet uses the wrong field name** | `Dashboard.jsx:24` sends `"contentType"`; the schema expects `mimeType` (`files.ts:54`). Zod is non-strict, so the key is silently dropped and every file uploaded from the documented snippet gets `application/octet-stream`. |
| f | **ULID monotonic state is module-global** | `lastTime` / `lastRandom` (`ids.ts:15`) are shared across concurrent requests in one isolate. The `bumpRandom` path handles it; noted for awareness only. |
| g | **`agents.status` accepts any string at the repository layer** | `WorkspaceScopedAgents.update` (`workspace-scoped.ts:518`) takes `status?: string`. The route's Zod enum (`agents.ts:44`) is the only guard. Since `assertAgentEnabled` refuses anything `!== "active"`, this fails safe — but the type should carry the constraint. |

### 6.3 Security posture, summarised

The **authentication and isolation core is strong** and shows real security
engineering — the fail-closed defaults, the uniform auth failures, the
segment-boundary prefix matching, and the constructor-bound scoping are all
things that are easy to get wrong and are right here.

The weaknesses are **not in that core**. They cluster in one specific place:
**controls that were designed and written but never connected to the request
path.** F-01, F-03 and F-06 are all the same shape — a correct, tested helper
that nothing calls with real data. F-02 and F-04 are the same shape one step
removed: a lifecycle with no closing step.

That is a recognisable and reassuring failure mode. It means the hard thinking
was done; the wiring was not finished, and the test strategy — unit-testing
helpers in isolation — was precisely the strategy that could not detect it.

---

## 7. Adversarial scenarios — cross-examination

I put the code to a set of real situations. Each is answered from the source, not
from the documentation.

---

**Scenario 1 — "A customer's card expires. Two weeks later they're still uploading. Are we billing correctly?"**

**No.** Stripe fires `invoice.payment_failed`; `stripe-webhook.ts:182` correctly
sets `billing_status = 'past_due'`. The dashboard shows the banner and the API
reports `writesBlocked: true`. **But uploads continue to work** — F-01. The
account accrues storage cost with no payment and no enforcement, and the customer
has been told in writing that uploads are paused, so they will not connect their
growing bill to their own activity. **The billing state machine is correct; the
consequence is not attached to anything.**

---

**Scenario 2 — "Our biggest customer says they deleted 8,000 files by accident. Can we prove what happened?"**

**Partly, and possibly not at all.** If they deleted the files one at a time via
`DELETE /v1/files/:id`, there are 8,000 audit rows naming the actor — good. If
they deleted a parent folder with `?recursive=true`, there is **nothing**: no
audit row, no webhook, no per-file record (F-08). The Activity screen will show a
gap. You can still see the rows are `status='deleted'` with a `deleted_at`
timestamp, so you know *when* — but not *who*, not from *where*, and not with
which credential. Restore is possible only within 24 hours, and only file by
file: there is no bulk restore endpoint.

---

**Scenario 3 — "An agent's API key leaks in a public GitHub repo. What can the finder do before we revoke it?"**

Depends entirely on the key's scope, and the scoping genuinely works. With
`{ops:["read"], pathPrefix:"/agents/bot"}` the finder can read that subtree and
nothing else — `/agents/bot-evil/...` is refused by segment matching, and every
repository call is workspace-bound.

Three things they can do that you might not expect:

1. **Read the billing account, including the owner's email** (F-10) — enough to
   build a credible targeted phish citing the real plan and status.
2. **Hammer the API at unlimited rate** (F-06) — no per-key limit exists.
3. **Consume storage invisibly** (F-04) if they hold `write`.

They **cannot** mint a more powerful key: `isSubsetScope` (`keys.ts:148`) is
enforced, and `keys:create` is its own op, so a `write` key cannot mint at all.
Revocation is immediate — `revoked_at` is checked on every authentication, with
no cache to invalidate (`keys.ts:250` notes this explicitly).

---

**Scenario 4 — "A tenant claims they can see another tenant's file. Possible?"**

**I could not construct it, and I tried hard.** Every read is
`WHERE workspace_id = ? AND id = ?`; every repository binds the workspace in its
constructor; no method accepts a `workspaceId`; handlers never receive a raw
binding. `?workspaceId=` in the URL is compared to the key's own workspace and a
mismatch is 403, not a substitution. Searching applies the scope prefix *inside*
the same SQL statement rather than filtering afterwards — which matters, because
post-filtering still leaks existence through counts, pagination and timing.
On the R2 side, keys are derived from the bound workspace, so `copy` cannot cross
a boundary in either direction.

The one cross-tenant path is `StaffScopedAccess`, which requires a staff session
(separate table, separate token shape, mandatory TOTP) and records every use.
**The far likelier explanation for such a report is F-01 or F-02 confusing the
user about their own account, not a real isolation breach.**

---

**Scenario 5 — "We're at 500 workspaces. What silently degrades?"**

Three things, none of which raise an alarm:

1. **`reconcileCounters` covers only the first 200 workspaces** —
   `ORDER BY id LIMIT 200`, no cursor (`purge.ts:133`). Since IDs are ULIDs and
   sort by creation, **workspace 201 onward is never reconciled.** Counter drift
   in newer accounts becomes permanent. They are billed on a drifted number.
2. **`purgeExpiredFiles` caps at 100/hour** = 2,400/day platform-wide, oldest
   first. One customer deleting 50,000 files monopolises the queue for three
   weeks; every other customer keeps paying for bytes they deleted.
3. **Every workspace older than one period has no egress or request cap** (F-02),
   so the accounts most likely to be heavy users are the ones with no ceiling.

All three fail quietly. The `reconcile` job logs drift it *corrects*, but logs
nothing about the workspaces it never examined.

---

**Scenario 6 — "A user clicks 'Delete my account' under GDPR. What actually happens?"**

**Nothing.** `SettingsTabs.jsx:335` closes the dialog and shows *"Account deletion
scheduled."* No request is made; no endpoint exists. Same for **"Export my
data"** (`:291`), which promises *"a download link within 24 hours"* — there is
no export job and **no email integration at all** (verified: the only email in the
repo is Firebase's own verification; the Privacy tab's named sub-processor
**Resend** is not integrated anywhere).

Additionally, the "you are the sole owner of N workspaces, transfer first" guard
is hardcoded to `soleOwnerOf={0}` (`Settings.jsx:151`), so it never fires and the
button is always enabled.

This is the finding I would escalate first on non-technical grounds. It is a
documented data-subject right, rendered as a completed action, with a stated
fulfilment deadline the product cannot meet by any mechanism.

---

**Scenario 7 — "A developer follows our own docs to connect Claude Desktop over MCP. Do they succeed?"**

**No, twice over, and the two answers contradict each other.**

They will first read the in-product docs page (`Docs.jsx:153`), which says MCP
*"is not built yet"* and `mcp-dev.agentdisk.io` *"does not answer tool calls
today"* — so they stop. That is wrong: all ten tools are implemented and routed.

If they instead use the MCP Connection screen, they get a config pointing at
`https://mcp.agentdisk.io/v1` (`McpConnection.jsx:19`) — **wrong host, wrong
path**; the real endpoint is `/mcp` or `/v1/mcp` on the API host. If they tick
"include my API key", they get `Bearer ` with an empty string (`REAL_KEY = ''`)
under a warning that the snippet now contains a live credential.

The screen will meanwhile show a pulsing green **"Connected"** badge, because
`state` defaults to `'connected-active'` and nothing is ever queried; the tool
list is a design-system fixture whose scope names (`files:read`, `files:write`)
do not exist in this product; and "Recent MCP calls" renders an empty box.

**A working, well-designed MCP server is unreachable through the product's own
two documentation surfaces, both of which are wrong in different directions.**

---

**Scenario 8 — "Could a hostile agent run up our Cloudflare bill without exceeding its quota?"**

**Yes, and it is straightforward** (F-04). Declare 1 byte, PUT 100 MB to the
presigned URL, never call `complete`, repeat. The quota check ran against the
declared byte; the real size is only ever learned in `complete`; the row stays
`pending`; `reconcileCounters` counts only `active`; `purgeExpiredFiles` collects
only `deleted`. **The bytes are real, billable, and invisible to every counter and
every sweep.**

Two things make it worse than a typical orphan problem: there is **no rate limit**
to slow the loop (F-06), and the hostile pattern is byte-identical to a browser
tab closed mid-upload, so there is no signal to alert on.

Note the near-miss: the design got the *hard* half right — refusing to trust the
client's declared size, deleting over-cap bytes at `complete`. The gap is only
the case where `complete` never runs, which is the case the client library's own
header comment already identifies in writing.

---

**Scenario 9 — "Support suspends an abusive workspace. Does it stop immediately?"**

**Yes, and this is well designed.** `staffSetWorkspaceStatus` sets
`workspaces.status = 'suspended'`. Step 5 of the chain reads that column on
**every** request (`auth.ts:136`), so every key in that workspace fails on its
next call without any key being touched — and un-suspending restores them just as
cleanly. `test/staff.test.ts` covers exactly this ("refuses the key on its very
next call, and leaves `revoked_at` alone"). A reason string is mandatory
(`staff.ts:213`) and is recorded. Correct on every axis.

**But if the same engineer then force-logs-out the workspace's user, that call
500s and writes no audit row** (F-07) — and if they try to *find* the workspace by
searching for it in the console first, the search throws a SQLite error (F-05).
The suspension mechanism is excellent; the tooling around it is not.

---

**Scenario 10 — "A junior engineer adds a new endpoint. How likely are they to break tenant isolation?"**

**Very unlikely, and this is the codebase's best property.** They would receive an
`AuthContext` and have no way to reach a raw D1 or R2 binding. Every repository
method they can call is already workspace-bound, and no method accepts a
workspace ID to get wrong. To break isolation they would have to import
`StaffScopedAccess` — one class, one file, currently one import site, and
therefore reviewable by reading rather than grepping.

The realistic mistakes are elsewhere, and F-01 is the proof: **the thing a new
endpoint is most likely to get wrong is forgetting to declare `requirement.demand`
or to pass `billingStatus`** — a quota and billing concern, not an isolation one.
That is a much better place to have your sharp edges, but the sharp edge is real
and has already cut once.

---

## 8. Verification log

| Claim in this report | How it was established |
|---|---|
| 444 API tests pass, typecheck clean | `npx vitest run` and `npx tsc --noEmit` in `apps/api` |
| 22 web tests pass, 2 files | `npx vitest run` in `apps/web` |
| `demand` never populated by a route | `grep -rn "demand" apps/api/src --include=*.ts` — declaration + read only |
| Billing block untested end-to-end | Read `test/billing.test.ts:217-241`; helper called directly with a literal |
| `period_reset_at` never advanced | `grep -rn "period_reset_at" src/ migrations/` — 3 inserts, 2 reads, 0 updates |
| `requests_period` never incremented | `grep -rn "requests_period" src/` — no write outside migrations |
| Plan sub-limits unenforced | `grep -rn "limits\.(agents\|apiKeys\|members)" src/` → no matches |
| Rate limiter used once | `grep -rn "enforce(\|consume(" apps/api/src` |
| Staff `ESCAPE` is 2 chars | Extracted both literals from source and evaluated them; measured `.length` |
| `audit_events.workspace_id` is `NOT NULL REFERENCES` | `migrations/0002_core_schema.sql:140` |
| Audit call sites enumerated | `grep -rn "audit(ctx\|auditAndNotify(ctx" apps/api/src` |
| Webhook secret unencrypted | Read `webhooks.ts:125` → `workspace-scoped.ts:663`; `DATABASE_ENCRYPTION_KEY` used only in `staff/crypto.ts` |
| No email integration | `grep -rniE "resend\|sendgrid\|postmark\|nodemailer\|mailgun\|smtp"` across `apps/*/src` |
| API methods the UI actually calls | Extracted every `api.<method>(` in `apps/web/src` and diffed against `lib/api.js` |
| Plan-limit mismatch | `Marketing.jsx:202-215` against `lib/plans.ts:31-62`, value by value |
| No committed secrets | `git ls-files | grep -iE "\.env|secret|\.tfvars|\.pem|key"` — source files only |

---

## 9. Findings register

| ID | Finding | Severity | Where |
|---|---|---|---|
| [F-01](#f-01) | Billing write-block never executes; `past_due`/`canceled` accounts write freely while the UI says uploads are paused | **HIGH** | `middleware/auth.ts:253`, `files.ts:246,360`, `folders.ts:283` |
| [F-02](#f-02) | Usage periods never reset; egress and request caps permanently unenforceable after one period; UI shows a false limit banner | **HIGH** | `quota.ts:44`, `bootstrap.ts:92`, `index.ts:598` |
| [F-04](#f-04) | Abandoned `pending` uploads never reclaimed — unbounded storage invisible to quota, billing and reconciliation | **MED–HIGH** | `purge.ts:61,143`, `files.ts:245` |
| [F-03](#f-03) | `requests_period` never incremented; request cap never enforced; permanently-zero metric shown as live | **MEDIUM** | `workspace-scoped.ts:741`, `quota.ts:90` |
| [F-05](#f-05) | Staff fleet search emits a 2-char `ESCAPE`; every search throws in SQLite | **MEDIUM** | `staff/access.ts:200` |
| [F-06](#f-06) | No rate limiting on any authenticated route or on MCP | **MEDIUM** | `rate-limit.ts`, one call site |
| [F-07](#f-07) | Staff force-logout succeeds then 500s on an FK violation, writing no audit row | **MEDIUM** | `staff/access.ts:255`, `migrations/0002:140` |
| [F-08](#f-08) | Recursive folder delete — the most destructive operation — is unaudited, as are move/copy/restore/patch | **MEDIUM** | `folders.ts:186` |
| [F-09](#f-09) | Webhook signing secrets stored in plaintext despite the schema comment claiming encryption | **LOW–MED** | `workspace-scoped.ts:663`, `migrations/0002:156` |
| [F-10](#f-10) | Agent API keys can read billing, including the account owner's email | **LOW–MED** | `index.ts:434`, `billing.ts:36` |
| [F-11](#f-11) | Seven lower-severity observations (staff-lockout DoS, webhook redirect-following, and others) | **LOW** | various |
| §4 | 26 UI entities non-functional, dummy or hardcoded — 8 of which **falsely report success** | **HIGH** (as a class) | `Settings.jsx`, `SettingsTabs.jsx`, `FileBrowser.jsx`, `McpConnection.jsx`, `Marketing.jsx`, `Dashboard.jsx` |
| §4.1 | Every number on the public pricing page contradicts enforced limits; "Unlimited agents" vs. a limit of 20; no purchase path exists | **HIGH** | `Marketing.jsx:202` |

### Closing assessment

**The backend core is well engineered.** Tenant isolation is structural rather
than procedural and I could not defeat it. Credential handling, JWT verification,
CORS, SQL parameterisation, presigning and the staff-access exception are all
done to a standard above what the size of this codebase would predict. The
commentary explaining *why* each decision was made is a genuine asset.

**The gap is between what is built and what is connected.** F-01, F-03 and F-06
are the same defect three times: a correct, tested helper that nothing on the
request path ever calls with real data. F-02 and F-04 are lifecycles missing
their closing step. And §4 is the same pattern in the frontend — screens designed
as mocks, some rewired to the API during the integration pass and excellent, the
rest left in place and now indistinguishable, to a user, from working software.

**The highest-value corrective action is not a fix; it is a test-strategy
change.** Every finding in this report would have been caught by two additions:
integration tests that drive real HTTP requests against non-default account
states (`past_due`, post-period, `pending`-without-`complete`), and any component
test at all against the route files in `apps/web`, which currently have none.

Backlog item **007** ("Browser-verify the screens — 4 of 31 rendered") is, on this
evidence, the most under-prioritised item in the project. Walking those 31 screens
in a browser would have surfaced the entire Tier-1 list in an afternoon.

*Prepared without modifying any file in the repository.*
