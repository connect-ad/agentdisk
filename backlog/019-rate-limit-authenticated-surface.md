# 019 · Rate-limit the authenticated surface

**Status:** Open — found by the 8 Sept 2026 audit ([summary.md](../summary.md) F-06)

`lib/rate-limit.ts` is a competent fixed-window KV limiter, honest about its own
consistency model. It is called in exactly one place:

```
routes/create-workspace.ts:65   await enforce(deps.kv, CREATE_WORKSPACE_RATE_LIMIT, ...)
```

Only the unauthenticated sandbox route is limited. **Every authenticated REST
route and the whole of `/mcp` have no per-key, per-IP or per-workspace limit**,
against doc 06 PART 16.14 which calls for per-key limits.

This compounds with [017](017-enforce-declared-limits.md): the
requests-per-period quota that would have been the backstop is never
incremented, so there is currently **no request-rate control of any kind** on the
authenticated surface.

Practical consequences: unlimited key-guessing against `/v1/whoami` (one SHA-256
plus one indexed D1 read per attempt), unlimited MCP `tools/call` volume, and no
brake on a runaway agent in a retry loop.

Staff login *is* limited — 5 per email per 15 minutes (`routes/staff.ts:53`) — so
the highest-value credential is covered. See
[020](020-staff-console-defects.md) for the DoS that keying on email alone
creates.

**To close:** apply `enforce` in `withAuth`, keyed on the API key ID for a key and
the user ID for a session. 14.3 reserves the Durable Object tier for exact MCP
per-session counts; the KV tier is the right fit for coarse per-key limits and
its slop is acceptable here.
