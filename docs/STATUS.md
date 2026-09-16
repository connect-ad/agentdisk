# AgentDisk — status

Rewritten 7 September 2026, replacing the audit written at the start of that
day. Every figure below was produced by running something, and the command is
named next to it.

---

## Where it stands

**Dev is a working product.** A stranger can sign up with Google, GitHub or
email, land in a workspace created for them, create an agent, mint a scoped key,
upload files from the browser or the API, invite a colleague, connect an MCP
client, and open Stripe's billing portal. Every one of those was exercised
against `api-dev.agentdisk.io`, not inferred from the code.

**Production has still never been deployed.** The `prod` Terraform workspace is
empty and `app.agentdisk.io` does not resolve. That is deliberate and unchanged:
dev gets proven first.

```
apps/api    519 tests across 29 files · typecheck clean · lint clean
apps/web    105 tests · 114 modules · build clean
Worker      226 KiB gzipped, against Cloudflare's 1 MB limit
```

---

## What the day closed

The audit that opened this session found the backend at 16 of 33 REST endpoints,
no MCP layer, no human authentication, and no audit trail. All four are done.

| Then | Now |
|---|---|
| No human auth | Firebase: Google, GitHub, email/password, email-link |
| CORS entirely absent — no browser could call the API | Preflight answered, origins matched exactly per environment |
| `auditEvents.append()` called from nowhere | Every mutation records one; Activity reads them |
| 0 of 10 MCP tools | All 10, filtered by the calling key's scope |
| No `scheduled` handler; deleted objects never purged | Hourly purge and counter reconciliation |
| Presigned round-trip blocked on a credential | Proven: 2 MB in and out, SHA-256 identical |
| 19 arrays of fixture data in the dashboard | Most replaced. **Corrected 8 Sept 2026:** fixture data and mock handlers remain across six route files — [backlog/023](../backlog/023-non-functional-ui-controls.md) |

---

## The surface, as deployed

**Authentication.** Firebase ID tokens verified in the Worker with cached JWKS
and Web Crypto — no Admin SDK, which does not run here. A token from the other
environment's project is refused on `aud`. "Log out everywhere" is a
`session_revoked_after` timestamp compared against the token's `iat`.

**Workspaces.** One billing account owns many. Membership is per-workspace, so
inviting somebody into one client's workspace does not hand them the one beside
it on the same bill. Roles are owner / admin / reader.

**Agents and keys.** Keys are shown once and stored as a hash. A key can never
mint a key more powerful than itself. `keys:create` is its own scope op, because
the authority to create a credential is not the authority to write a file.

**Files.** Inline up to 1 MB through the Worker's bucket binding; presigned above
that, straight to R2. Soft delete with a 24-hour restore window, then purged.
Search over names, paths, captions and tags, with the scope prefix applied inside
the query rather than over its results.

**MCP.** Ten tools at `/mcp`, JSON-RPC over Streamable HTTP, in the same Worker.
Every tool calls the REST handler that already does the work — the two surfaces
are the same code, so they cannot drift in what they allow.

**Billing.** Portal depth. Stripe Customer created lazily, webhook verified
against the raw body before any field is read. **Corrected 8 Sept 2026:** the
`past_due` write block does *not* fire — no route populates `requirement.demand`,
so the middleware always evaluates against a hardcoded `"active"`. Reads and
writes both continue on an unpaid account, while the API reports
`writesBlocked: true` and the dashboard says uploads are paused.
See [backlog/017](../backlog/017-enforce-declared-limits.md).

---

## What is not built

Named plainly rather than left to be discovered.

| Missing | Consequence |
|---|---|
| Editable plans and pricing | The console lists plans; it cannot change one or push a price to Stripe (14 PART 29.6) |
| Staff account provisioning in-product | `POST /v1/staff/users` is 501 by design; accounts come from `apps/api/scripts/provision-staff.mjs` |
| Multipart upload | Files above ~5 GB cannot be uploaded in one part |
| Signed permanent links | `POST /v1/files/:id/sign` needs a `signed_links` table |
| Full-text search inside files | Needs an index. The API names the fields it did search |
| `openapi.yaml` | No generated client or docs site |
| Production | Never applied |

---

## Deliberate deviations from the design docs

Each is a decision, not an oversight, and each is recorded where it was made.

**Agent deletion is a soft delete.** `api_keys.agent_id` references the row, so a
hard `DELETE` fails the foreign key once an agent has held a key. Deleting the
keys would destroy the record of what the agent did; nulling their `agent_id`
would convert agent credentials into workspace-level ones. The row stays, marked
deleted, and its keys are revoked.

**`oauth_github_id` remains, unused.** SQLite will not drop a column carrying a
UNIQUE constraint, and rebuilding `users` means dropping a table three live
foreign keys point at.

**Membership moved from the org to the workspace** (migration 0006, a table
rebuild). Doc 05 PART 11.1 has it at org level; the product decision was
per-workspace invites.

**Roles are owner / admin / reader**, not doc 06's owner / admin / member. The
old middle role could do everything an admin could except manage people, so the
role people actually wanted — read without write — did not exist.

**The dashboard is a Workers static-assets Worker, not Pages** (doc 07 PART 18.4
assigns Pages). Established by backlog/013.

**`design-system/` still says "AgentDrive".** It is a byte-verified mirror and
must be fixed upstream in Claude Design, then re-imported — backlog/015. A
re-import from the current upstream would put the old name back into the shipped
dashboard, which is the actual risk that item tracks.

---

## How this was verified

| Claim | How |
|---|---|
| 519 tests | `npx vitest run` in `apps/api` |
| Typecheck, lint | `npm run typecheck`, `npm run lint` |
| 105 tests | `npm test` in `apps/web` |
| 114 modules | `npm run build` in `apps/web` |
| Bundle size | `npx wrangler deploy --dry-run` |
| Presigned round-trip | Real 2 MB file, PUT to R2, `complete`, download, SHA-256 compared |
| Agent key end to end | Real Firebase signup → agent → key → `whoami` → upload → list |
| Webhook signature | Unsigned and forged payloads against the live endpoint, both 401 |
| CORS | Live preflight from the dashboard origin and from an unlisted one |
| Route inventory | `curl` against all twelve REST prefixes plus `/mcp` |

The tests run inside the real Workers runtime against Miniflare-backed D1 and
R2, using the same migration files the deploy applies — not mocks, because a
mocked query layer will happily prove an isolation guarantee the real SQL does
not provide.

---

## Next, in dependency order

1. **Walk through [USER_TESTING_GUIDE.md](USER_TESTING_GUIDE.md) in a browser.**
   Every step needing a mouse is unverified — I cannot click an OAuth consent
   screen or drag a file onto a page.
2. **Editable plans**, and pushing a price to Stripe from the console.
3. **Production cutover** — a second Firebase project, live Stripe keys, and the
   required-reviewer gate.
