# AgentDisk — Authentication, Security, Privacy & Legal Copy
### PART 15–17 of the AgentStorage-Inspired Platform Design

All content is **PROPOSAL** unless marked otherwise. PART 17's Privacy Policy and Terms of Service are **first drafts requiring qualified legal review before publication** — this is stated explicitly again at the top of each document and is not legal advice.

---

## PART 15 — Authentication & Authorization

### 15.1 Authentication Design

**Superseded (Sept 2026) — human authentication now runs on Firebase Authentication, not a first-party password/session system.** Everything in this subsection below the line is kept as the historical record of the original design; see `16-firebase-auth-and-final-launch-prompt.md` PART 30 for the authoritative current model. Summary of what changed and why: the product owner asked for SSO (Google, GitHub) alongside email sign-in for the customer-facing dashboard, and rather than building OAuth app-registration/callback handling and a second SSO code path on top of the already-custom password/session system, human auth moved to Firebase Authentication entirely — it provides email/password, email-link (magic-link), Google, and GitHub sign-in as one product, is free for these methods at any volume (Firebase's Spark/Blaze pricing has no per-MAU charge for standard email or federated OAuth sign-in; only phone/SMS auth and enterprise SAML/OIDC beyond a free quota cost anything), and a Cloudflare Worker can verify its ID tokens with nothing more than cached JWKS + Web Crypto — no Node-only Firebase Admin SDK needs to run inside the Worker. **Agent authentication is completely unaffected**: agents still never touch Firebase, never get a session, and use API keys only, exactly as designed below.

*Original MVP-0 design (superseded, kept for history):* Human authentication was originally scoped as email + password (Argon2id-hashed) plus a passwordless magic-link option, both shipping in MVP-0, with GitHub OAuth deferred to MVP-1 and Google OAuth treated as a V2-only candidate pending signup-funnel demand. Session security was a short-lived (15-minute) signed JWT access token plus a longer-lived (30-day) httpOnly refresh-token cookie with rotation, tracked in a first-party `refresh_tokens` D1 table to back the Active Sessions UI (`03` §8.23). **All of this — the password hashing, the OAuth sequencing, the refresh-token table and rotation logic — is replaced by Firebase**, which now owns password/SSO/session issuance for every provider (email, Google, and GitHub all ship together rather than being staged across MVP-0/1/V2, since Firebase makes them equally cheap to enable). See PART 30 (in `16`) for the replacement design, including how "log out everywhere" still works without a `refresh_tokens` table.

**Agent authentication: API keys only, always.** Agents never get a session cookie, never go through an OAuth flow, and never have a password. This is a deliberate, hard line: an autonomous, non-human caller gets exactly one credential type, and it's the type designed from the ground up to be scoped, inspectable, and revocable (15.3). AgentStorage's own no-auth-required workspace-bootstrap pattern (PART 2.3/4.3) is adopted for the *initial* sandbox key an agent gets when self-provisioning a trial workspace, but every other agent credential (production keys, sub-keys) requires an authenticated human action to mint.

### 15.2 Authorization Model

Two parallel models, deliberately kept simple and separate:

- **Human role-based access**, at the org and workspace level: `owner` (full control including billing/deletion), `admin` (manage members, agents, keys, settings — not billing/org deletion), `member` (manage files/agents/keys within the workspace — cannot manage members or delete the workspace). Three roles, not a general permission-matrix system — a fourth or fifth role is a V2 conversation only if real customers ask for finer granularity than this covers.
- **Scoped, capability-based access for API keys** (both agent keys and any future service keys): a JSON `scopes` blob (PART 11.1 `api_keys.scopes`) of `{ ops: ["read","write","delete","list"], pathPrefix: "/some/prefix/*" }`. A key's effective permission is the intersection of what its creator was allowed to grant and what's explicitly listed — a sub-key can never exceed its parent key's scope (enforced at mint time, mirroring AgentStorage's own sound design, PART 2.6/4.3).

**Authorization middleware runs before business logic, always — no exceptions.** Every request (REST or MCP — the same chain, since both share the same Worker fleet, `05` PART 14.1) passes through, in order: (1) authenticate (resolve a Firebase ID token or an API key to an identity — PART 15.1/`16` PART 30 for the human path, 15.3 unchanged for agents), (2) load the identity's effective scope (role or key scopes), (3) resolve the target resource's `workspace_id`, (4) check the identity's scope against the requested operation and path, (5) check **workspace access** — quota, `workspaces.status` (a `suspended` or `deleted` workspace rejects every request here, for a human *or* an agent key, with a clear `WORKSPACE_SUSPENDED`/`WORKSPACE_DELETED`-shaped error, not a generic 403; `14` PART 27.4's staff `suspendWorkspace` action is exactly what flips this), and `billing_status` (`14` PART 29.4) — and only then (6) invoke the handler. **This is the step that answers "what happens to an agent's API key when the workspace behind it is suspended or shut down": the key itself is untouched (`revoked_at` stays NULL), but step 5 rejects every call against it the instant `workspaces.status` changes — no separate step is needed to hunt down and individually revoke every key in a suspended workspace, and un-suspending a workspace doesn't require re-minting any of them.** Every handler function receives an already-authorized, already-workspace-scoped context object — a handler is structurally unable to query outside the caller's workspace, because it never receives a raw, unscoped database client (PART 16.4 shows the concrete pattern).

### 15.3 API Key Design — Exact Model

**Format:** `ask_live_<32 random base62 chars>` for production keys, `ask_test_<32 chars>` for a workspace's test/sandbox-mode keys (mirrors Stripe's well-understood live/test prefix convention, adapted with AgentStorage's own `ask_` prefix choice since it's a sensible, brandable convention worth keeping — not proprietary or copyrightable). The prefix (`ask_live_` + first 8 secret chars) is stored in cleartext for display and lookup-narrowing (`key_prefix` column); the full secret is **never stored** — only `SHA-256(secret)` (`key_hash`, unique-indexed for O(1) lookup). Last-four is stored separately for UI display (`ask_live_••••3f2a`) so the UI never needs to touch the hash or a partially-decoded secret.

**Generation:** `crypto.getRandomValues` (Web Crypto API, available natively in Workers) — never `Math.random()` — producing 24 bytes (192 bits) of entropy, base62-encoded. Verification on every request is a `SHA-256` hash-and-compare against the stored hash, using a constant-time comparison at the final byte-compare step (though SHA-256 hash comparison is inherently far less timing-sensitive than raw secret comparison, this is still done for defense in depth).

**Fields (see PART 11.1 for the full DDL):** id, workspace_id, agent_id (nullable — null means a human-issued personal/CI key), name, key_prefix, key_last_four, key_hash, scopes (JSON), created_by_user_id, parent_key_id (nullable, set for sub-keys), expires_at (nullable), last_used_at, revoked_at (nullable — soft revoke, so a revoked key's audit history remains intact), created_at.

**Revocation is one-way, and that is a decision rather than a missing feature (Sept 2026).** There is no un-revoke and none is planned: a kill switch that can be undone is not a kill switch, and GitHub, Stripe, AWS and Vercel all take the same position on their own credentials. What was missing was never the control — it was saying so *before* the commitment, so the dashboard now states the permanence in the revoke confirmation itself and puts a short note beside the disabled Revoke button on an already-revoked key, where somebody hunting for a reactivate control will actually find it. A disabled button with no explanation reads as an unfinished feature; recovery is minting a new key, and the UI has to say that out loud.

**Revocation:** setting `revoked_at` is checked on every authentication (KV cache for the hash→key-record lookup is invalidated immediately on revoke — a revoked key must stop working within seconds, not up to a cache-TTL window later; the revoke handler explicitly busts the KV entry rather than waiting for TTL expiry). **Expiration:** `expires_at` checked the same way; an expiry sweep (part of the hourly reconciliation job, PART 10.8) proactively evicts expired keys' KV cache entries so an expired key can never authenticate even from a stale cache in the worst case.

**Cascading invalidation — three distinct scenarios, three distinct (deliberate) behaviors, added Sept 2026 to close a real gap:**
- **The workspace is suspended or deleted** (by staff, `14` PART 27.4/27.5, or by billing failure, `14` PART 29.4): every key in it stops authenticating immediately, without touching any individual key row — PART 16.1's step 5 (workspace-status/billing check) rejects the call before the key's own `revoked_at`/`expires_at` are even relevant. This is the correct behavior for "the account was terminated" at the workspace/org level.
- **The human who created a key is removed from the workspace, or their own account is disabled:** **not** an automatic cascade, by design — an API key is a workspace asset an agent may depend on running continuously, and if removing one team member silently broke every agent whose key they happened to mint, that's a serious, surprising availability hazard for everyone else still in the workspace (the same reasoning Stripe/AWS/GitHub apply to their own API keys, which stay bound to the account/project rather than to the creating human's ongoing status). What *is* provided: an explicit, opt-out-by-default bulk action — "revoke every key this person created" — surfaced at the moment of removal (`03` §8.22) for self-service, and as a parallel staff action (`14` PART 27.5, alongside `force-logout`) for an abuse-response or for-cause termination where every credential that person ever touched genuinely should die.
- **The creating user's Firebase account itself is disabled or deleted (not just logged out):** confirmed (Firebase's own behavior, Sept 2026) that this does **not** retroactively invalidate that user's already-issued Firebase ID token — an old token keeps passing verification for up to its remaining ~1-hour lifetime regardless, the same underlying limitation already documented in `16` PART 30.4 for ordinary "log out everywhere." This has no bearing on the agent's API key either way (an API key was never derived from or dependent on the creator's Firebase session), but it does mean a just-disabled human could still act on the dashboard for up to an hour unless staff also sets that user's `session_revoked_after` (`05` PART 11.1) — which, notably, is a **better** answer than Firebase's own native tooling would give here, since it's a free, first-party check already run on every request rather than Firebase's Admin-SDK-only, per-request-network-call `checkRevoked` path.

---

## PART 16 — Security Model

### 16.1 Multi-Tenancy & Tenant Isolation

**The core invariant:** every single database query that touches `folders`, `files`, `agents`, `api_keys`, or `audit_events` is parameterized with the caller's `workspace_id`, and that parameter comes from the authenticated identity's resolved scope — **never** from a client-supplied field (a request body's `workspaceId`, if present at all, is used only to disambiguate which of the *caller's own* workspaces they mean when a session spans several — it is validated against membership, never trusted as an access grant on its own).

**Enforcement pattern (concrete, not just a stated principle):**
```ts
// A handler never receives a raw D1 binding. It receives a pre-scoped repository.
class WorkspaceScopedFiles {
  constructor(private db: D1Database, private workspaceId: string) {}
  async list(pathPrefix: string) {
    return this.db
      .prepare(`SELECT * FROM files WHERE workspace_id = ? AND path LIKE ? AND deleted_at IS NULL`)
      .bind(this.workspaceId, pathPrefix + '%')
      .all();
    // workspace_id is bound from the constructor, not from any request input —
    // structurally impossible for a handler to accidentally omit it.
  }
}

// Middleware constructs this once per request, after authorization succeeds:
async function withAuth(req: Request, env: Env, handler: Handler) {
  const identity = await authenticate(req, env);           // 1. who is this?
  const scope    = await resolveScope(identity, env);       // 2. what can they do?
  const workspaceId = await resolveTargetWorkspace(req, scope); // 3. which workspace?
  authorize(scope, req.method, req.url, workspaceId);        // 4. allowed? throws 403 if not
  await checkQuota(env, workspaceId, req);                   // 5. within limits? throws 429 if not
  const ctx = { files: new WorkspaceScopedFiles(env.DB, workspaceId), identity, scope };
  return handler(req, ctx);                                  // 6. business logic, pre-scoped
}
```
This directly prevents the three cross-tenant scenarios the brief calls out:
- **User A → User B's files:** User A's session resolves only to workspaces User A is a member of (step 3); no request can name a `workspaceId` User A isn't a member of and have it accepted.
- **Agent A → Agent B's workspace:** an agent's API key is bound to exactly one `workspace_id` at mint time (immutable — a key cannot be re-scoped to a different workspace after creation); step 3 resolves straight from the key row, never from client input.
- **Workspace A → Workspace B:** structurally impossible — every query is bound to a single `workspace_id` sourced server-side; there is no code path that accepts a second, comparison, or wildcard workspace ID.

### 16.2–16.3 Authentication & Authorization Summary
Covered in full in PART 15. **Superseded note:** `/login`, `/signup`, and `/forgot-password` are no longer AgentDisk-hosted endpoints — Firebase's own client SDK and hosted flows handle sign-in/sign-up/password-reset directly against Firebase's servers (which have their own brute-force throttling and generic, non-enumerating error behavior built in), and AgentDisk's Worker never sees a raw password or reset attempt at all. The one AgentDisk-hosted endpoint in this area is first-time-user provisioning (creating the `users`/`organizations` rows the moment a *new* Firebase UID is seen) — that endpoint is authenticated (a valid Firebase ID token is required to call it) rather than being an open, rate-limit-sensitive auth endpoint itself, so credential-stuffing/enumeration concerns don't apply to it the way they did to a first-party `/login`.

### 16.4 API Key Security
Covered in full in PART 15.3. Additional control: keys are **never accepted in a query string** (only the `Authorization` header) — query strings leak into server logs, browser history, and referrer headers, a real, common secret-leakage vector this explicitly closes off.

### 16.5 Password Security
**Superseded (Sept 2026).** Password storage/hashing is now Firebase's responsibility entirely — AgentDisk's backend never receives, hashes, or stores a customer password (see PART 15.1, `16-firebase-auth-and-final-launch-prompt.md` PART 30). *Original design, kept for history:* Argon2id with a per-password random salt and ~250ms verification cost, an 8-character minimum, a 256-character cap to prevent hashing-cost DoS, and HaveIBeenPwned range-API breach-checking flagged as a V2 candidate. None of this needs building now; Firebase's own password-strength and breach-detection features (if enabled in the Firebase console) cover the same intent.

### 16.6 Session Security
**Superseded (Sept 2026).** There is no first-party session cookie or refresh-token cookie any more — the Firebase client SDK holds its own refresh token (browser-local, managed entirely by the Firebase SDK, never seen by AgentDisk) and attaches a short-lived (1-hour) ID token as a bearer `Authorization` header on every request; the Worker verifies that token's signature against Google's cached JWKS on each call rather than trusting a cookie. "Log out everywhere" is implemented as a first-party `users.session_revoked_after` timestamp (`05` PART 11.1) checked against the token's `iat` claim on every request — see `16-firebase-auth-and-final-launch-prompt.md` PART 30.4 for exactly why this is cheaper and more immediate than Firebase's own `revokeRefreshTokens`/`checkRevoked` mechanism (which is Admin-SDK-only and, per Firebase's own docs, too expensive to check on every request). *Original design, kept for history:* a 15-minute JWT access token plus a 30-day httpOnly refresh-token cookie scoped to the API's own domain, rotated on every use.

### 16.7 CSRF
**Simplified (Sept 2026) by the Firebase change.** Since human dashboard requests now carry a Firebase ID token as a bearer `Authorization` header (PART 15.1/16.6) rather than relying on an ambient httpOnly session cookie, the classic CSRF threat model — a malicious page riding the browser's automatically-attached cookie — mostly doesn't apply: there's no cookie for a cross-origin page to ride, and attaching the right bearer header requires JavaScript that CORS (16.8) already restricts to the real dashboard origin. The double-submit CSRF-token design originally specified here is no longer needed. *Original design, kept for history:* a random CSRF token in a readable cookie, mirrored into an `X-CSRF-Token` header on every mutating request, checked against each other by the Worker. **Agent/API-key-authenticated requests were, and remain, exempt from CSRF checks** for the same underlying reason — a bearer token in a header, never a cookie.

### 16.8 CORS
**Correction (Sept 2026): the domain below was a placeholder (`agentdrive.dev`) from before the real domain (`agentdisk.io`, `12-deployment-roadmap-agentdisk-io.md`) was chosen, and it was found still hardcoded — or matched against — in a live deployment, which is very likely why the dev environment's CORS checks were silently failing every request (no origin ever matches a domain that isn't real).** The rule itself doesn't change, only the domain and the implementation guidance: the dashboard origin (`app.agentdisk.io` in production, `app-dev.agentdisk.io` in development — `12`'s naming standard) is the only origin allowed to make cookie-authenticated cross-origin requests to the API; `Access-Control-Allow-Credentials: true` is set only for that exact origin, never a wildcard. Bearer-token (API key) requests are **not** subject to the browser's CORS-credentialed restriction in the same way, but CORS headers for the public API still default to `*` for `GET` requests without credentials (so a developer can call the API from a browser-based tool using their own key) while any cookie-based request from an unrecognized origin is rejected outright.

**Implementation requirement, not just policy:** the allowed origin must be read from an environment-scoped binding (e.g. `env.DASHBOARD_ORIGIN`, set per environment in `wrangler.toml`/Terraform — `07` PART 18.2, `12`'s naming standard) — never hardcoded as a literal string in application code, and never copy-pasted from this document's domain examples. This class of bug (a hardcoded or stale-placeholder origin that no real request's `Origin` header will ever match, silently failing every preflight) is exactly what happens when a domain string in a design doc gets treated as the literal value to ship rather than as an example to parameterize. **CORS preflight (`OPTIONS`) must also be handled explicitly before the authentication middleware runs** — a preflight request carries no `Authorization` header by design, so if `OPTIONS` is routed through the same auth-first middleware chain as every other request (PART 16.1's `withAuth`), it will be rejected as unauthenticated before it ever reaches the point where CORS headers would be attached, which independently breaks every cookie-authenticated cross-origin call regardless of whether the origin string is correct.

### 16.9 XSS
No user- or agent-supplied string (file names, captions, tags, workspace names) is ever rendered as raw HTML — the dashboard frontend uses a framework with default output-escaping (React/similar) and the codebase bans `dangerouslySetInnerHTML`-equivalents outside of a single, explicitly reviewed component (if any is ever needed, e.g. a Markdown-preview renderer, which sanitizes via an allowlist-based sanitizer, never raw `innerHTML`). API responses set `Content-Type: application/json` strictly (never letting a browser guess and render a JSON response as HTML). A strict `Content-Security-Policy` header on the dashboard disallows inline scripts by default.

### 16.9a Document security headers — as shipped

The dashboard's five document headers (`Content-Security-Policy`,
`Strict-Transport-Security: max-age=31536000; includeSubDomains`,
`X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: strict-origin-when-cross-origin`) come from a `_headers` file
that a Vite plugin writes into `dist/` at build time, generated by
`apps/web/scripts/security-headers.js` — one source shared by the build, the
unit tests and the post-deploy smoke test. `apps/web` is an assets-only Worker
with no `main`, so Cloudflare's asset server applies the rules and no
request-path code runs to set them.

Three concessions, each deliberate and pinned by a test so that undoing one is a
decision rather than a tidy-up:

- **`script-src` is tight** — `'self'` plus Turnstile and `apis.google.com`, with
  no wildcard, no `'unsafe-inline'`, no `'unsafe-eval'`. This is the directive
  doing the security work and the only one asserted for tightness.
- **`style-src` requires `'unsafe-inline'`.** 41 source files style elements with
  React's `style={{…}}`, which lands as an inline style attribute that no hash or
  nonce covers. Bounded — inline style cannot execute — but it means removing it
  is a refactor, not an edit.
- **`Cross-Origin-Opener-Policy` is deliberately absent.** `same-origin` severs
  `window.opener`, which Firebase's `signInWithPopup` depends on (PART 30).

`connect-src` and `frame-src` carry sources that appear in no grep of the built
bundle and so have nothing to justify them later: Firebase's
`identitytoolkit`/`securetoken` endpoints, which the SDK assembles at runtime,
and `https://*.r2.cloudflarestorage.com`, the presigned-PUT target whose account
ID never reaches a web build. Deleting the first breaks sign-in; deleting the
second breaks every upload over 1 MB. The API origin and Firebase auth domain
are compiled from the same `VITE_*` values as the bundle, so the policy cannot
describe a different backend than the app calls.

### 16.10 SQL Injection
Not applicable in the traditional sense to hand-written string concatenation, because **every** D1 query in the codebase uses parameterized `?` bindings (16.1's code pattern is the enforced norm, not an exception) — code review and a lint rule reject any D1 `.prepare()` call built via string interpolation of user input. No raw/dynamic SQL is ever constructed from request data.

### 16.11 SSRF
The one place the system makes outbound requests based on user input is **webhook URLs** (PART 11.1 `webhooks.url`). Mitigations: the URL is validated to be `https://` only, resolved and checked against a blocklist of private/internal IP ranges (RFC1918, loopback, link-local, and Cloudflare's own internal ranges) **at both registration time and at delivery time** (DNS can change between registration and delivery — re-checking at send time closes the classic "DNS rebinding" SSRF bypass), and webhook delivery happens from a dedicated Queue-consumer Worker with no access to any internal service bindings (defense in depth — even a bypassed URL check can't reach internal infrastructure because the delivering Worker has none of those bindings).

### 16.12 Path Traversal
**Never trust a client-supplied path as a filesystem or R2 key.** Every incoming `path`/`newPath` is normalized server-side (Unicode-normalized, `..` segments rejected outright — not resolved-and-collapsed, which is the classic bug class, but rejected as `VALIDATION_ERROR` the moment a `..` segment is present), required to start with `/`, capped at a maximum depth and length, and never concatenated directly into the R2 object key (12.1's key strategy — `tenant/{workspaceId}/{fileId}` — means a path-traversal string in a client-supplied `path` can *only* ever affect the `path` column used for display/listing, never the actual storage location, which is an opaque server-generated ID; this is a structural mitigation, not just input validation, and is one of the strongest arguments for the ID-based key strategy chosen in PART 12.1). A request for `/v1/files?path=../../private-file` is rejected with `VALIDATION_ERROR` before it ever reaches a query.

### 16.13 File Upload Attacks
**Malicious filenames:** filenames are stored and displayed as opaque strings (HTML-escaped on render, 16.9), never interpreted as paths on any real filesystem (there is no server-side filesystem in this architecture — R2 is pure object storage), and never used to construct a shell command or file-system path anywhere in the codebase (a lint/review rule explicitly bans string-built shell invocations from any user-controlled string, full stop — there should be no code path that shells out based on a filename at all). **MIME spoofing:** client-declared `mimeType` is stored but never trusted for execution or security decisions (16.9's escaping applies regardless of declared type; a `.txt` file claiming to be `text/html` is still served with the stored MIME type but the dashboard never renders arbitrary HTML content inline regardless — file previews for HTML-family types show a text/code view, never a live-rendered iframe of user content, closing the classic "upload an HTML file, get stored XSS on your own domain" vector). **Oversized files:** enforced at three layers — presigned-URL generation refuses to issue a URL for a declared size exceeding the plan's per-file cap (PART 6.5/19), R2 itself rejects a PUT exceeding what the presigned URL was scoped for, and the `complete` step re-validates actual size server-side against both the per-file cap and remaining workspace quota before marking the file active. **Zip bombs / decompression attacks:** not applicable in MVP-0/1 because the system never server-side-decompresses an uploaded archive; if archive extraction is ever added as an AI-processing feature (PART 10.6, V2+), it must run in an isolated, resource-capped context with output-size limits — flagged explicitly as a requirement for that future feature, not solved today because the feature doesn't exist today.

### 16.14 Abuse Prevention & Rate Limiting
Full mechanism and trade-offs in PART 10.9; concrete limits are in the PART 13 API table. Trade-off summary: Cloudflare WAF rate-limiting rules are free and require zero Worker CPU but are coarser (IP/route-pattern based) — used for the no-auth-required endpoints and login/signup. KV-counter-based limits are cheap and globally available but only eventually consistent (a determined attacker distributing requests across Cloudflare PoPs could theoretically exceed a KV-based limit briefly before it catches up) — used for the bulk of per-key/per-session limits where this slop is acceptable. Durable-Object-backed strict counters are the only strongly-consistent option but cost more (a DO instance per counted entity, billed for duration) — used narrowly for MCP per-session tool-call throttling (PART 14.3) where a misbehaving agent loop is a real, high-value risk to close tightly.

### 16.15 Replay Attacks
**API requests:** `Idempotency-Key` (PART 13) makes accidental client retries safe (same key → same result returned, not a duplicate resource) but is a client-safety feature, not primarily an attack defense. **Webhook payload replay:** every webhook delivery is HMAC-signed (`X-AgentDisk-Signature`, matching the sound pattern AgentStorage itself uses, PART 2.8) over a payload that includes an `eventId` and a `timestamp`; the receiving side is instructed (in our own docs, and we follow the same rule for any webhook-like callback we ourselves consume) to reject signatures older than 5 minutes and to de-duplicate by `eventId` — closing replay even if a signed payload is intercepted and resent later.

### 16.16 Signed URLs, Expired URLs
Covered in PART 12.4. Security-relevant detail: presigned R2 URLs used for direct client upload/download are scoped to a single object key and a single HTTP method, with a short default expiry (12.2/12.3), and are never logged in full (PART 16.18) — only the fact that one was issued, to whom, and when.

### 16.16a Encryption at Rest for Application Secrets (Webhook Signing Secrets)
Most secrets in this system never need to be recovered in plaintext — passwords and API keys are hashed one-way (16.4/16.5) and the hash alone is sufficient to verify a future presented value. **Webhook signing secrets are the one exception**: the value stored in `webhooks.secret` (PART 11.1) must be readable in plaintext by the delivery Worker at send time, because HMAC-signing an outgoing payload requires the actual secret, not a hash of it. Storing it as cleartext in D1 would mean a database-read-level compromise directly exposes every workspace's webhook secret. Instead, `webhooks.secret` is stored **application-level encrypted** (AES-256-GCM) using a key derived from the `DATABASE_ENCRYPTION_KEY` secret (provisioned per environment via `wrangler secret put`, PART 18.2) — decrypted only in-memory, only inside the Queue-consumer Worker that signs and sends a delivery, and never logged or returned by any API response (a webhook's `secret` field is write-only: returned once at creation exactly like an API key, PART 15.3, then never re-displayed, only re-generatable). This is one layer on top of, not a replacement for, Cloudflare's own infrastructure-level encryption at rest for D1 — defense in depth specifically for the one column in the schema that has to remain reversible.

### 16.17 Secret Leakage
API keys, password hashes, session tokens, webhook secrets, and OAuth tokens are never included in: log lines (structured logging redacts any field named/matching a secret pattern before it's written, PART 16.18), error messages returned to clients (an internal exception referencing a secret is caught and replaced with a generic `INTERNAL_ERROR` before serialization), or Sentry/observability breadcrumbs (PART 18's observability design explicitly scrubs `Authorization` headers and any field matching `*secret*|*password*|*token*|*key_hash*` before any event is sent to a third-party observability tool).

### 16.18 Logging Sensitive Data
**Never logged, anywhere, under any circumstance:** file contents, plaintext passwords, plaintext API keys/secrets, full `Authorization` header values, webhook secrets. **Logged (structured, for observability and audit):** request ID, route, method, status code, latency, workspace ID, actor ID (user or agent — the ID, not any secret), IP (for abuse investigation — see PART 17's Privacy Policy for retention), truncated/hashed identifiers where full values aren't needed. The `audit_events.metadata` JSON column (PART 11.1) is explicitly documented in code comments and the schema as "never put a raw secret or file content here" — reviewed as part of any PR touching audit logging.

---

## PART 17 — Privacy & Legal Copy

### 17.1 Cookie Consent

**Does this product need a cookie banner?** **PROPOSAL, reasoned:** MVP-0/1 uses exactly two categories of cookie — a **strictly necessary** session/refresh-token cookie and a strictly necessary CSRF cookie (PART 16.7) — both required for the dashboard to function and both exempt from consent requirements under GDPR's ePrivacy rules (strictly-necessary cookies don't require opt-in consent, only disclosure). **We recommend not adding any analytics or marketing cookie in MVP-0/1** (no need for the friction and legal overhead of a consent-gated analytics stack before there's a marketing/growth function that would use it) — if/when analytics is added (V2), we recommend a **privacy-friendly, cookieless analytics tool** (e.g., one that doesn't set any client-side identifier cookie at all, such as Cloudflare's own Web Analytics) specifically so the "no cookie banner needed" state can persist even longer. **If and only if** a future cookie-based analytics or marketing tool is added, a consent banner becomes required, with this exact behavior: **default = off** for anything non-essential (no pre-ticked consent), a "Manage preferences" link always available in the footer, and a record of consent choice stored (timestamp + choice) for compliance evidence.

**Banner copy (held in reserve for if/when non-essential cookies are added — not shown in MVP-0/1 since there is nothing to consent to):**
- Headline: "We use cookies"
- Body: "We use essential cookies to keep you signed in. With your permission, we'd also like to use analytics cookies to understand how AgentDisk is used — never to sell your data."
- Buttons: "Accept all" / "Essential only" / "Manage preferences"
- Preferences panel toggles: "Essential (always on)" (disabled toggle, always on) / "Analytics" (off by default)
- Footer link (persistent): "Cookie preferences"

### 17.2 Privacy Policy (First Draft — Requires Legal Review Before Publication)

> **This is a first draft prepared to accompany a product design document. It is not legal advice, has not been reviewed by a lawyer, and must not be published as-is. A qualified privacy/data-protection attorney should review this against the jurisdictions AgentDisk actually operates in and the sub-processors actually in use before launch.**

**AgentDisk Privacy Policy**
*Last updated: [DATE] — Draft, pending legal review*

**1. Introduction.** This Privacy Policy explains how AgentDisk ("we," "us") collects, uses, and shares information when you use our website, dashboard, API, and MCP server (together, the "Service"). It applies to human account holders and to information generated by AI agents acting under an account holder's authorization.

**2. Information We Collect.** We collect information you provide directly (account details, files you or your agents upload, support requests), information collected automatically (log data, device/client information, usage metrics), and information from third parties only where you've connected them (e.g., GitHub, if you sign in with GitHub OAuth).

**3. Account Information.** When you create an account, we collect your email address and, if you choose password authentication, a securely hashed (never plaintext) password. If you use GitHub OAuth, we receive your GitHub account's public profile identifier and the email address you've made available to OAuth apps.

**4. Files and Content.** Files you or your agents upload are stored on your behalf using Cloudflare R2 object storage. **We do not access, view, or process the contents of your files except: (a) as strictly necessary to operate the Service (e.g., computing a checksum, generating a presigned URL, enforcing storage quotas by measuring byte size), (b) where you've explicitly opted a workspace into optional AI processing features (PART 10.6 — text extraction, summarization, tagging), in which case file content is sent to the specific processor disclosed in Section 11, or (c) where required to investigate abuse, a security incident, or a valid legal request.** We do not claim our architecture makes it cryptographically impossible for us to ever access your data — R2 storage is not end-to-end encrypted by us in a way that excludes our own infrastructure from being able to read it, and this policy does not represent otherwise.

**5. API Usage.** We log API and MCP requests (endpoint, method, status, latency, the identity that made the call) for security, billing, quota enforcement, and debugging. We do not log request or response bodies containing file content or secrets (see Section 7).

**6. Agent Data.** Information about the agents you create (names, descriptions, activity timestamps) is account information under Section 3's protections. Files an agent creates or modifies are treated identically to files a human uploads (Section 4) — we do not apply different retention or access rules based on whether a human or an agent was the actor.

**7. Logs.** We retain structured request logs (Section 5's fields) for [90 days, PROPOSAL — confirm against actual operational/compliance needs] for security and debugging, after which they are deleted or aggregated into non-identifying metrics. Audit events (PART 11.1 `audit_events`) visible in your workspace's Activity log are retained for the life of the workspace plus a grace period, so you retain your own audit trail even if we've rotated raw infrastructure logs.

**8. IP Addresses.** We collect IP addresses for rate limiting, abuse prevention, and approximate geolocation shown in the "active sessions" security screen (PART 8.23). IP addresses in security-relevant logs follow the retention in Section 7.

**9. Cookies.** See our Cookie Policy (Section 17.1 of the design document this policy is drafted alongside) for full detail. In summary: we use strictly necessary session and security cookies; we do not currently use analytics or marketing cookies, and will update this policy and request consent before we do.

**10. Analytics.** [Placeholder — MVP-0/1 uses no analytics cookie; if/when added, this section names the tool, what it collects, and links to the consent mechanism in Section 9.]

**11. AI Processors.** For workspaces that opt into AI document processing (text extraction, OCR, summarization, embeddings — PART 10.6), file content or extracts are sent to [the specific AI provider(s) actually integrated — Cloudflare Workers AI and/or a named third-party model provider — **to be finalized and named here before this policy is published**]. This processing is opt-in per workspace and is disclosed here specifically because it is the one case where file content leaves our direct storage/compute boundary to a model provider.

**12. Storage & Infrastructure Providers.** We use Cloudflare, Inc. (Workers, R2, D1, KV, Queues) as our infrastructure provider for compute, object storage, database, caching, and async processing. We use [email delivery provider — to be named] to send verification, password-reset, and notification emails. We use [Stripe, once billing ships] to process payments — we do not store your full payment card number ourselves.

**13. Data Retention.** Account and file data is retained for as long as your account/workspace is active. Deleted files enter a recoverable state for 24 hours (PART 12.5/12.6) before being permanently purged from object storage. Deleted workspaces and their contents are permanently purged within [30 days, PROPOSAL] of deletion, except where retained longer to comply with a legal obligation or resolve an active dispute.

**14. Data Deletion.** You can delete individual files, folders, agents, API keys, or an entire workspace at any time from the dashboard or API (PART 8.21, PART 13). Deleting your account (Settings → Privacy, PART 8.24) is blocked only if you are the sole owner of other workspaces, so that other members' data isn't orphaned or destroyed without your explicit workspace-level action first.

**15. Data Export.** You can request an export of your account and workspace data (Settings → Privacy, PART 8.24); we will provide a downloadable export within 24 hours of request, in a structured, machine-readable format (JSON metadata plus your original files).

**16. Security.** We describe our security architecture in detail in a public SECURITY.md (PART 25) and summarize key measures here: encryption in transit (TLS) for all traffic, encryption at rest as provided by Cloudflare R2/D1's infrastructure-level encryption, hashed (never plaintext) passwords and API keys, scoped credentials, and tenant-isolated data access (PART 16.1). No system is perfectly secure, and we do not claim otherwise.

**17. International Transfers.** Cloudflare operates a global network; your data may be processed in data centers outside your home country. [This section requires legal review to state accurate transfer mechanisms — e.g., Standard Contractual Clauses — once the company's actual legal entity and target markets are finalized.]

**18. Children's Privacy.** The Service is not directed to, and we do not knowingly collect information from, anyone under 16. If we learn we've collected information from a child under 16, we will delete it.

**19. Your Rights.** Depending on where you live, you may have rights to access, correct, delete, or export your data, and to object to or restrict certain processing. Sections 14–15 describe how to exercise deletion and export directly in-product; for any other request, contact us at the address in Section 21. [This section requires jurisdiction-specific legal review — e.g., explicit GDPR Article 15–22 or CCPA-specific language once target markets are finalized.]

**20. Changes to This Policy.** We'll post material changes here with an updated "Last updated" date and, for significant changes, notify account owners by email.

**21. Contact.** Questions about this policy: [privacy@agentdisk.io — placeholder]. **[Legal review required: confirm the correct legal entity name, registered address, and any required Data Protection Officer designation before publication.]**

### 17.3 Terms of Service (First Draft — Requires Legal Review Before Publication)

> **This is a first draft prepared to accompany a product design document. It is not legal advice, has not been reviewed by a lawyer, and must not be published as-is. A qualified attorney should review this — especially the liability, warranty, and termination sections — against the company's actual legal entity, jurisdiction, and insurance posture before launch.**

**AgentDisk Terms of Service**
*Last updated: [DATE] — Draft, pending legal review*

**1. Acceptance.** By creating an account or using the Service (including via an API key or MCP connection), you agree to these Terms.

**2. Acceptable Use.** You may not use the Service to store, transmit, or process: content that is illegal in your jurisdiction; malware or content designed to exploit or attack systems (including ours); content that infringes another party's intellectual property rights; content involving the sexual exploitation of minors, which we report to appropriate authorities without exception; or content intended to harass, threaten, or facilitate violence against real people. **[Legal review: confirm this list against the company's actual risk tolerance and applicable law.]**

**3. Your Responsibility for Content.** You (and any agent acting under your account) are solely responsible for the files and data you store. We do not pre-screen content but may review, remove, or restrict access to content that violates these Terms or applicable law, and may suspend accounts for repeated or severe violations.

**4. Prohibited Content — Detail.** In addition to Section 2: you may not upload content you don't have the right to store or share; you may not use the Service as a general-purpose content-distribution network for the public (this is storage for your own agents and team, not a public CDN); you may not attempt to circumvent storage or rate-limit quotas through automated account creation.

**5. API and Automated Agent Use.** The API and MCP server are intended for use by AI agents and automated systems acting on your behalf under credentials you control. You are responsible for the actions your agents take using your API keys, exactly as you would be for actions you take yourself. You must not share API keys across unrelated parties or resell access to the Service without our prior written agreement.

**6. Rate Limits and Fair Use.** We enforce rate limits and quotas as described in our documentation (PART 6.5, PART 13, PART 25) to keep the Service reliable for everyone. We may throttle or temporarily suspend access that we reasonably believe is abusive, degrading Service reliability for others, or circumventing these limits.

**7. Storage Limits.** Your plan defines storage, file count, egress, and request limits (see our Pricing page). We will notify you as you approach a limit; exceeding a hard limit may block further writes until you upgrade, free up space, or your usage period resets, as described in-product.

**8. Account Suspension.** We may suspend or terminate accounts that violate these Terms, pose a security risk to the Service or other users, or where required by law. Where practical, we will provide notice and an opportunity to export your data (Section 15 of our Privacy Policy) before permanent deletion, except where immediate action is required for security or legal reasons.

**9. Your Right to Delete.** You may delete your files, workspaces, or account at any time, as described in Section 14 of our Privacy Policy. Deletion is subject to the recovery/grace-period behavior described there.

**10. Billing.** Paid plans are billed in advance on a recurring basis through our payment processor. Fees are non-refundable except as required by law or as we expressly state at time of purchase. Downgrading a plan while over its limits may restrict new writes until usage is brought within the new plan's limits, as described in-product (PART 8.25). **[Legal review: confirm refund policy language against actual business decisions before launch.]**

**11. Intellectual Property.** You retain all rights to the content you store. You grant us only the limited rights necessary to store, process, transmit, and display that content back to you (and your authorized agents/team members) in order to operate the Service. We retain all rights to the Service itself — our software, design, trademarks, and documentation.

**12. Third-Party Services.** The Service relies on third-party infrastructure and, for opted-in features, third-party AI processors, as disclosed in our Privacy Policy Sections 11–12. We are not responsible for the availability or acts of third-party services outside our control, though we select and monitor them as part of operating the Service responsibly.

**13. Warranties.** THE SERVICE IS PROVIDED "AS IS" WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT, EXCEPT AS EXPRESSLY STATED IN THESE TERMS OR REQUIRED BY LAW. **[Legal review required — standard disclaimer language, must be finalized by counsel for the operating jurisdiction.]**

**14. Limitation of Liability.** TO THE MAXIMUM EXTENT PERMITTED BY LAW, WE ARE NOT LIABLE FOR INDIRECT, INCIDENTAL, SPECIAL, OR CONSEQUENTIAL DAMAGES, OR FOR LOST DATA, PROFITS, OR REVENUE, ARISING FROM YOUR USE OF THE SERVICE. **[Legal review required — this is placeholder language, not a finished liability clause; must reflect actual insurance coverage and jurisdiction-specific enforceability limits.]**

**15. Termination.** You may stop using the Service and delete your account at any time. We may terminate or suspend your access for breach of these Terms, as described in Section 8. Upon termination, Sections 11, 13, and 14 survive.

**16. Changes to These Terms.** We may update these Terms; for material changes we'll notify account owners by email in advance of the change taking effect.

**17. Governing Law.** **[Legal review required — must specify the actual governing jurisdiction based on where the operating entity is incorporated.]**

**18. Contact.** [legal@agentdisk.io — placeholder].

### 17.4 Error Message Catalogue (Human-Readable, Cross-Referenced to API Error Codes)

| Code | HTTP | Human-readable message shown in dashboard | When it fires |
|---|---|---|---|
| `VALIDATION_ERROR` | 400 | "That doesn't look right — check the highlighted field and try again." (field-specific message shown inline where possible, e.g. "File names can't contain \| or a leading /.") | Malformed input |
| `UNAUTHORIZED` | 401 | "Your session has expired. Please sign in again." | Missing/invalid/expired credential |
| `FORBIDDEN` | 403 | "You don't have permission to do that." (+ specific reason when known, e.g. "This API key doesn't have access to this folder.") | AuthZ denial |
| `NOT_FOUND` | 404 | "We couldn't find that. It may have been deleted or moved." | Missing resource |
| `CONFLICT` | 409 | "Something with that name already exists here." | Duplicate path/name |
| `PAYLOAD_TOO_LARGE` | 413 | "That file is larger than your plan allows ({limit})." | Per-file size cap |
| `LIMIT_EXCEEDED` | 429 | "You've reached your {metric} limit for the {plan} plan. [Upgrade]" | Quota/rate limit |
| `INTERNAL_ERROR` | 500 | "Something went wrong on our end. We've logged it and we're looking into it." | Unhandled server error |

This table is the single source of truth referenced by both the dashboard's error-rendering component and the MCP tool error responses, so a human and an agent hitting the same underlying error code always get a semantically identical explanation, just formatted for their respective medium (rendered UI vs. JSON-RPC error text).
