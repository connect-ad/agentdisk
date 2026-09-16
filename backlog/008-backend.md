# 008 · Backend — D1, R2, REST API, MCP server

**Status:** Done (Sept 2026) — REST storage core and auth are built and deployed to dev;
MCP and the human-session half remain

Built and live on `api-dev.agentdisk.io`: API keys with the full authorization
chain, the Turnstile-gated workspace bootstrap, and the file and folder surface
from doc 05 PART 13 (`POST /v1/files` inline and presigned, `complete`, list,
get, `download`, `PATCH`, `move`, `copy`, `DELETE`, `restore`, and
`POST`/`GET`/`DELETE /v1/folders`).

Still to build, and each is its own piece of work rather than a loose end:

- **The MCP server** — the actual differentiator, and still entirely unbuilt.
  Doc 05 PART 14's ten tools, sharing the REST authorization core.
- **Human sessions** — login, refresh rotation with `family_id`, CSRF
  double-submit. The `refresh_tokens` table exists (migration 0004); nothing
  writes to it. **Argon2id must be measured on Workers, not assumed** (doc 06
  PART 16.5): it is CPU-bound and Workers caps CPU per request. bcrypt is the
  documented fallback.
- **Multipart upload** (12.7), **signed links** (12.4, needs a `signed_links`
  table), **search** (10.5 level 1), and **the purge queue consumer plus
  reconciliation** (10.8) — deletes are soft, so R2 objects currently survive
  their rows.

Detail and the reasoning behind each deferral live in
[the implementation plan](../docs/IMPLEMENTATION_PLAN.md).

Fully specified already — this is execution, not design:

- [doc 05](../docs/design/05-technical-architecture.md) — D1 schema, R2 object-key
  strategy, full REST API, the 10 MCP tools, D1-vs-Postgres decision
- [doc 06](../docs/design/06-security-privacy-legal.md) — auth, API key model,
  tenant isolation, the full security control list
- [doc 07](../docs/design/07-cloudflare-deployment-and-cost.md) — environments,
  wrangler config, deployment, the monorepo layout `apps/web` already follows
- [doc 08](../docs/design/08-claude-code-prompt.md) — the standalone hands-off
  build prompt. Hand this to Claude Code to start.

The UI already assumes this contract: scopes are `files:read` / `files:write` /
`files:delete`, uploads go direct-to-storage with a distinct *processing* state,
and quota limits surface as a 429 rather than silent failure.
