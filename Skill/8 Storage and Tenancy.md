# 8 · Storage and Tenancy

How files, workspaces, quotas, sandboxes and keys are kept apart, and the rules
that keep a scoped credential inside its scope.

---

## The model

One billing account (an organization) owns many workspaces; membership is per
workspace, so inviting somebody into one client's workspace does not hand them
the one beside it on the same bill. Roles are **owner / reader**, and no
invitable role can write: writing belongs to the owner and to the API keys they
mint, which is where agent writes came from anyway. "Admin" means an operator of
the internal console and nothing else.

The REST surface covers files (inline upload, presigned upload and download,
inline read up to 1 MB, move, copy, permanent delete with no grace), folders,
search over names, paths, captions and tags, agents, keys, members, share
links, webhooks, activity, billing and workspaces. The MCP server at `/mcp`
exposes eleven tools that call the REST handlers, so the two surfaces cannot
drift. The tool list is mirrored by hand in `Docs.jsx` and
`McpConnection.jsx`, and two tests pin the count, so adding a tool touches
four files. `apps/cli` is a dependency-free Node client for the same API.

## Isolation

- **Scope prefixes match whole segments.** `/agents/bot` must not authorize
  `/agents/bot-evil/secrets.txt`; a plain `startsWith` says it does.
- **A handler never gets a raw `R2Bucket` or a raw D1 binding.**
  `WorkspaceScopedStorage` binds the workspace in its constructor and takes
  file IDs, so there is no argument through which to name another tenant's
  object.
- **One sanctioned cross-tenant operation exists, and its signature is the
  safety property.** `transferObject(source, id, destination, id)` takes two
  already-bound storages and no workspace ID, so a caller can only reach across
  a boundary it has already opened both sides of.
- **Move and copy check both ends.** Write on a source must not buy write on
  a destination; copy needs read on the source.
- **Sizes come from R2, never from the client.** The declared size buys a
  quota decision up front; `complete` asks R2 what it holds and re-checks. An
  upload over the cap is deleted and its row marked failed.
- **R2 bindings cannot presign.** Presigned URLs go through R2's S3 endpoint
  with SigV4 and need the key pair the deploy pushes. **The credential pair
  decides whether presigning is on**, not the count of set variables, and it
  is read only on the routes that presign, so one broken variable cannot take
  down `whoami`.
- **Folder emptiness is decided by path, never by `folder_id`**, because
  folders are created lazily and a file can sit inside one with `folder_id`
  still NULL.
- **Clear inbound foreign keys before deleting a subtree.** SQLite checks
  foreign keys immediately within one statement, so a self-referencing tree
  fails whichever way the DELETE is ordered.
- **A screen computes permissions from the real credential, never a
  fixture.** The MCP page's tool availability comes from the connecting key's
  own scopes, in the vocabulary `read / write / delete / list`.

## Keys

API keys are kept, sealed, and only a signed-in owner can open one. The token
is stored in `api_keys.key_ciphertext`, AES-256-GCM under
`DATABASE_ENCRYPTION_KEY` and bound to the row id, so a copy of the database
is not a copy of the keys. `GET /v1/keys/:id/secret` is the only reader: it
refuses an API key, refuses a reader, refuses a revoked key, answers 409 for a
key minted before keys were kept, and audits every success as `key.revealed`.
Authentication is still by `key_hash`; the ciphertext is never on the request
path.

## Quota

**Storage and file quota belong to the billing account, not the workspace.**
`organizations.storage_bytes_used` and `file_count` are the numbers enforced;
the workspace copies survive for display. Egress and requests stay per
workspace, because they are period counters resetting on the workspace's own
clock. `plan_override` is on the organization too, and the console's quota
bump is addressed by workspace but applied to the whole account. The type is
the guard: `assertWithinQuota` takes `WorkspaceRow & AccountUsage`.

**The hard block and the soft warning are one call.** Every write path calls
`assertQuotaAndWarn`, never `assertWithinQuota` directly, so there is no way to
block without computing the warning from the same row, limits and demand. The
warning is set on the context by the handler and serialized once by `withAuth`.

## Workspaces

- **A slug is an address; the `ws_…` ID is the identifier.** A slug can never
  look like an ID (no underscores survive `slugify`), a slug never changes on
  rename, raw-ID URLs redirect to the slug, and uniqueness is per organization
  with the index as the guarantee, so creation retries a UNIQUE violation.
  A `/w/{segment}` that resolves to nothing, or to a workspace the caller is
  not a member of, renders the 404, identically, so the URL cannot confirm
  another account's workspace exists.
- **Destroying a workspace is a person's act.** `DELETE /v1/workspaces/:id`
  refuses an API key, requires the account owner, requires the workspace's
  name in the body, and refuses the caller's last workspace. R2 objects go
  before D1 rows, because the rows are the only record of which objects exist.
- **Closing an account takes what the person pays for, and only that.**
  `DELETE /v1/me` cascades every workspace under an organization the caller
  owns; where they were a guest, only their membership row goes.
- **The Day-7 erasure notice is sent before the address is released, and a
  failed send holds the release** for `ERASURE_NOTICE_GRACE_MS` (48 h), then
  the release goes ahead anyway. The claim is an atomic UPDATE so the cron and
  the console's Run now cannot both send.

## Sandboxes and claiming

`POST /v1/workspaces` with no credential provisions a sandbox: a one-time API
key, a one-time claim link, and a `nextSteps` list saying where each goes. The
route needs no Turnstile token, because it exists for headless agents; a token
sent by the dashboard's dialog is still verified. Three things bound abuse: the
10-per-hour-per-IP creation limit in KV, a cap of five unclaimed sandboxes per
IP counted over `workspaces.creator_ip` (a claim frees the slot the instant it
is set), and `SANDBOX_LIMITS` itself: 500 MB, 500 MB egress, zero share links,
deleted after three days. Only the anonymous branch is charged; a signed-in
POST routes to `createWorkspaceForUser` first. Every creation carries
`RateLimit-*` headers.

- **An unclaimed sandbox is a claim state, never a plan.** `SANDBOX_LIMITS`
  is deliberately absent from `PLAN_NAMES`, so nobody can be placed on it and
  swept.
- **The sandbox limit is gated on the claim token as well as `claimed_at`**,
  so it cannot apply retroactively to workspaces provisioned before claiming
  existed.
- **A claim link is a bearer secret, so only its SHA-256 is stored.** The
  tokenised link exists only in the provisioning response; the quota warning
  carries the untokenised claim page and the workspace ID.
- `GET /v1/workspaces/claim/:token` previews with no credential; `POST` takes
  ownership, keeping the workspace or merging it into one the caller
  administers. **A merge is all-or-nothing**, checked against the target's
  quota before a byte moves, and it repoints the agent's existing key row so
  the next call lands in the new workspace with no re-authentication.
- **Copy before delete when relocating; delete before row when discarding.**
  The merge writes the destination object and row before removing the source,
  the opposite of the purge job.
- **The unclaimed sweep defaults to reporting.** `SANDBOX_EXPIRY_ENABLED` is
  `"true"` in dev's `wrangler.toml` and `"false"` in prod's.
