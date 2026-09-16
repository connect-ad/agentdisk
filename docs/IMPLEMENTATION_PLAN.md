# AgentDisk — Implementation Plan

Planning artifact for `docs/design/08-claude-code-prompt.md`. Short by design;
updated as phases complete. The design documents remain the authority — this
only records task breakdown and status.

**Note on doc numbering:** `11-backend-implementation-prompt.md` does exist,
alongside doc 08 which covers the same ground under its original number. Nothing
is missing.

---

## Status

| Phase | Scope | Status |
|---|---|---|
| 0 | Foundation | **Done** — superseded by the infra work |
| 1 | Data layer — schema, scoped repositories, isolation tests | **Done** |
| 2 | Authentication — Firebase for humans, API keys for agents | **Done** |
| 3 | Storage core — R2 presigned upload/download, file/folder CRUD | **Done** — round-trip proven |
| 4 | REST API — files, folders, agents, keys, members, webhooks, activity, billing, search | **Done** except signed links and multipart |
| 5 | MCP server — 10 tools over the same services | **Done** |
| 6 | Dashboard wiring — replace mock data with the real API | **Done** — no fixtures remain |
| 7 | Security hardening pass | **Done** — CORS, audit trail, scope escalation tests |
| 8 | Testing completion | **370 tests across 25 files** |
| 9 | Production deploy | **Not started** — prod has never been applied |
| 10 | Production hardening — observability | Not started |

Still open, in dependency order: webhook **delivery** (registration works,
nothing is sent), the admin panel and the editable plans that depend on it,
multipart upload, signed permanent links, `openapi.yaml`, and the production
cutover.

**Roadmap step 27 is met.** A 2 MB file round-tripped through
`agentdisk-dev-files` via a presigned PUT and GET on 7 September 2026, SHA-256
identical in and out. See [STATUS.md](STATUS.md) for how everything else was
verified, and [USER_TESTING_GUIDE.md](USER_TESTING_GUIDE.md) for the walkthrough
a person can follow.

### Phase 0 — Foundation (done)

Delivered by the infra/CI work rather than by this prompt, and its definition of
done is met: `npm run build`/`test` pass and a Worker answers `/v1/healthz` — at
`https://api-dev.agentdisk.io`, on real infrastructure, which is stronger than
the "deploys to preview" the phase asked for.

Two deviations from doc 08's Phase 0 text, both deliberate:

- **No `packages/config` or npm workspaces yet.** `apps/api` is self-contained.
  The existing `apps/web` has its own lockfile and a clean build; converting the
  repo to workspaces risks breaking it for no current benefit. Revisit when
  Phase 6 needs types shared between the two.
- **CI is built, and differs from doc 09/10's sketch.** It follows
  `12-deployment-roadmap-agentdisk-io.md`, which is newer and environment-aware.

### Phase 1 — Data layer (done)

1. Migration `0002` — the full PART 11.1 schema: organizations, users,
   memberships, workspaces, agents, api_keys, folders, files, file_tags,
   audit_events, webhooks, with every index as specified.
2. `src/db/` — one `WorkspaceScoped*` repository per workspace-owned table.
   `workspace_id` is bound in the constructor, never accepted as an argument, so
   a handler cannot omit it even by mistake.
3. Repositories for non-workspace-scoped tables (users, organizations,
   memberships) kept separate and explicitly named, so the distinction is
   visible rather than implied.
4. ULID generation as a local utility — monotonic, crypto-random. No dependency:
   it is ~50 lines against Web Crypto, which the runtime already provides.
5. Tenant-isolation tests against **real D1** via `@cloudflare/vitest-pool-workers`,
   not mocks: a repository scoped to workspace A must not read, update, or delete
   workspace B's rows even when explicitly asked for them by ID.

**Done.** 22 tests pass against real D1 in the Workers runtime; migration 0002
applied to the remote `agentdisk-dev-db` through the pipeline (27 commands).

The isolation tests were mutation-checked: removing the workspace filter from
`getById` fails exactly the two tests asserting it. A security test that cannot
fail is not evidence, so this check is worth repeating whenever they change.

### Phase 2 — Authentication (API keys done, sessions next)

Order within the phase: **API-key auth first**, then human sessions. Agent keys
are what the file round-trip in roadmap step 27 actually needs, and the key path
is the simpler of the two to get right.

**Done — the API-key half.**

1. `src/lib/keys.ts` — `ask_live_`/`ask_test_`, 32 base62 characters from
   `crypto.getRandomValues` with rejection sampling (a modulo fold of 0–255 into
   62 would over-represent the first eight alphabet characters by a third), the
   raw secret returned once and never written, SHA-256 of the *whole* token
   stored so a live and a test key can never be the same credential.
2. `src/auth/scopes.ts` — the `{ ops, pathPrefix }` model, parsed fail-closed:
   an unreadable or partly-unknown blob grants nothing rather than falling back
   to a default. Prefix matching is segment-aware, so `/agents/bot` does not
   authorize `/agents/bot-evil/secrets.txt`.
3. `src/middleware/auth.ts` — the six-step chain from 06 PART 16.1, in order.
   A handler receives an `AuthContext` carrying scoped repositories and **no
   `env`**, so it cannot reach a raw D1 binding even deliberately.
4. `src/lib/plans.ts` / `src/lib/quota.ts` — the 07 PART 19.0 limits table and
   the checks that run at step 5, resolving anything unrecognised to the
   tightest plan.
5. `GET /v1/whoami` behind the chain, plus the 05 PART 13 error envelope with a
   request ID on every response.

**83 tests pass.** Seven deliberate mutations were each killed by the tests:
plain-`startsWith` prefix matching, workspace taken from the query string,
distinguishable revoked/expired errors, silently accepting a query-string
credential, skipping the expiry check, ignoring an unknown scope op, and
letting a disabled agent's key through.

**Deferred deliberately, with reasons.**

- **No KV cache on the key lookup yet** (06 PART 15.3 describes one). The cache
  is only safe alongside the revoke handler that busts it, and that handler is
  Phase 4's `DELETE /v1/keys/:id`. A cache without its invalidation is a
  security regression sold as an optimization, so the cache lands with the
  handler. The lookup is a single unique-index probe in the meantime.
- **`last_used_at` is written at most once a minute per key**, off the response
  path via `waitUntil`. Writing it per request would put a D1 write in the hot
  path of every authenticated call to learn a number the dashboard reads to
  the nearest minute.

**Done — the bootstrap.** `POST /v1/workspaces`, built to 05 PART 13 rather
than behind a temporary gate: Turnstile verified server-side, plus the stated
10/hour/IP limit on KV counters. It provisions org, provisional owner, workspace,
agent and the first key in **one D1 batch**, so a half-provisioned workspace
cannot exist. The key is returned once and only its SHA-256 is stored.

The rate limit is checked *before* the Turnstile round trip, so a flood costs one
KV read rather than a network call. Turnstile fails closed on every path —
non-200, unparseable body, timeout, unreachable. If Turnstile is down we stop
issuing sandbox workspaces; any other behaviour turns an outage into an open gate.

Migration `0003` adds two columns PART 11.1 does not have, because PART 13
specifies a claim endpoint and a claim only makes sense if an unclaimed state
exists: `workspaces.claimed_at` and `users.is_provisional`. The second cannot be
inferred from a null `password_hash` — an OAuth user has one of those too, and
MVP-1 adds GitHub OAuth.

**118 tests pass.** Eighteen deliberate mutations were each killed, eleven of
them on the new gates: a failed challenge treated as a pass, truthiness instead
of strict equality on `success`, an unreachable siteverify failing open, a
trusted non-200, skipped hostname pinning, an off-by-one in the limiter, a
corrupt counter read as unlimited, the endpoint running with no secret
configured, the verification result ignored, the limiter moved after Turnstile,
and the sandbox key granted `keys:create`.

**Two things running the tests taught us, that reading the docs would not.**

- **D1 enforces foreign keys**, and a batch rolls back on violation — verified,
  not assumed. But `organizations.owner_user_id` carries no `REFERENCES` clause:
  05 PART 11.1 deliberately leaves it unconstrained, so it is the one parent
  link the database will not enforce. An earlier version of the atomicity test
  used exactly that column and therefore proved nothing.
- **zod applies `.trim()` before `.regex()`**, so `"  bot  "` is a valid agent
  name that gets stored tidy rather than a rejection. That ordering is the whole
  difference between two defensible behaviours and is invisible in the schema,
  so it now has its own test.

**Deferred, with reasons.**

- **`Idempotency-Key` is not honoured yet** (05 PART 13 asks for it on every
  creating POST). It wants to be one shared middleware over every such route;
  building it for the only one that exists today invites a second, divergent
  implementation when the rest arrive in Phase 4.

**Still to do — the human half.** Sessions, refresh rotation, CSRF
double-submit. **Argon2id remains unresolved and must be measured, not assumed**
(06 PART 16.5): it is CPU-bound and Workers caps CPU per request. bcrypt is the
documented fallback. This blocks password login only, not API keys, so it does
not block the round-trip.

### Decisions taken here (flagged, not silent)

- **Validation: Zod.** Doc 08 requires picking one library and staying with it.
  Zod works in the Workers runtime, and its inferred types remove the
  schema-vs-type drift a hand-rolled validator invites.
- **ULID: hand-rolled.** Doc 08 says prefer runtime built-ins over dependencies.
  Web Crypto covers it.
- **Argon2id: unresolved, and must not be assumed.** Doc 06 PART 16.5 requires
  confirming at implementation time whether the Workers runtime has a viable
  Argon2id. It is CPU-bound and Workers caps CPU per request, so this needs
  measuring, not guessing. Phase 2 decision; bcrypt is the documented fallback.
- **A credential in the query string is rejected, not ignored.** 06 PART 16.4
  says keys are never *accepted* there. Ignoring one would satisfy that
  literally, but by the time we see it the key is already in Cloudflare's
  access logs and the caller's shell history — it is burned either way, and
  only a loud failure gets it rotated.
- **Zod is in, as the recorded choice.** Added at the first route that parses a
  body (`POST /v1/workspaces`), not before. It costs ~120 KB gzipped in the
  bundle, which is comfortably inside the Worker size limit.
- **The bootstrap was built fully rather than behind a temporary gate.** The
  alternative considered was a secret-gated stand-in until Turnstile landed.
  Building it properly means the endpoint is the one 05 PART 13 specifies, and
  the product's own headline onboarding flow — an agent self-provisioning a
  trial workspace — is exercised now rather than first tried in anger later.
- **`TURNSTILE_SECRET_KEY` is optional in CI, deliberately.** The route refuses
  to run without it, so a missing secret disables exactly that endpoint and
  nothing else. Making CI require it would mean the whole API cannot ship until
  the widget exists — trading a working deploy for a check the code already
  makes. CI warns loudly instead.

---

## Phase 3 — Storage core (done)

The file and folder surface from 05 PART 13 is built and deployed:
`POST /v1/files` in both modes, `complete`, list, get, `download`, `PATCH`,
`move`, `copy`, `DELETE`, `restore`, and `POST`/`GET`/`DELETE /v1/folders`.

**The Worker is never in the byte path**, except for the inline path (10.4) for
files at or below 1 MB, where a presigned round trip costs more than the write.
That exception is also what lets dev prove a real upload today, before the R2
signing credential exists.

### Deferred, with the reason

- **Multipart upload** (12.7, files above 100 MB). The single-PUT path is what
  the round-trip needs, and multipart is a distinct protocol - part URLs,
  ETag tracking, `CompleteMultipartUpload` - that deserves its own change
  rather than being smuggled in beside single-part.
- **`POST /v1/files/:id/sign` and `GET /v1/dl/:token`** (12.4). Permanent-
  revocable links need the `signed_links` table, which does not exist yet.
- **`GET /v1/search`** (10.5 level 1). Cheap on top of what is here, but it is
  its own route with its own scope-filtering story.
- **The purge queue consumer.** Deletes are soft, and the R2 object survives
  until a consumer removes it. The consumer and the reconciliation job (10.8)
  are one piece of work: both exist to make the D1/R2 pair converge.
- **Egress accounting is at URL issuance, not at fetch.** R2 does not call back
  on a GET, so this is the only moment the Worker can observe. 19's assumptions
  already record it as a deliberate over-count.

### Blocking the presigned round-trip

`R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` are absent in dev, so those two
routes refuse while everything else works. It needs a human decision, and the
decision is a security one rather than a convenience one —
[backlog 014](../backlog/014-r2-signing-credential.md) holds both options and
what each costs.
