# 010 · Test suite

**Status:** Open — `apps/api` is covered at the unit level; `apps/web` now has
its first route-component tests; e2e does not exist

The 8 Sept 2026 audit established what the current shape cannot catch. 444 API
tests passed while four declared limits went unenforced
([017](017-enforce-declared-limits.md)) — because the helpers are tested as pure
functions with hand-passed arguments, and nothing drives a real HTTP request
against a non-default account state (`past_due`, post-period,
`pending`-without-`complete`). Two additions would have caught every finding in
[summary.md](../summary.md): integration tests over those states, and any
component test at all against `apps/web/src/routes/`, which has none.

`apps/api` has 519 tests across 29 files running in the real Workers runtime
against real Miniflare D1 and R2, with every security-critical storage behaviour
mutation-tested. See [Skill/1 Build](../Skill/1%20Build.md) for how to run them
and what mutation testing established.

Migrations are read from the real `.sql` files by `vitest.config.ts` and applied
to that D1, so **a broken migration fails the suite rather than the deploy** —
which is how `0009_workspace_slug.sql` was checked before it ever ran against
dev data.

`apps/web` has a runner — vitest + jsdom + Testing Library, configured in
`apps/web/vitest.config.js` — and 105 tests across six files.
`test/dialog-focus.test.jsx` (6) was added to pin the fix for a focus bug that
made every dialog in the product unusable, and it was checked the only way that
means anything: the pre-fix components were restored and 4 of the 6 went red.
`test/workspace-switcher.test.jsx` (16) covers the sidebar switcher.

`test/qa-fixes.test.jsx` (31) is the first to reach **route components** —
Dashboard, Settings and McpConnection — and its shape is the point, because it
answers this item's own complaint that a suite can pass while the screens lie.
It mocks no further down than `useWorkspace`, so `useResource`, the components
and React are all real and only the API client is a stub; and every fixture is
**paired**, rendering the same element for a workspace with data and one without.
That pairing is what catches hardcoded UI: a fixed string is correct for exactly
one workspace, and a single-workspace test never visits the second. The two
fixtures model the real "My Workspace" and "Abc" the 8 Sept audit compared.

`test/part6-fixes.test.jsx` (23) keeps that pairing and adds two things worth
copying. It renders **the whole app under the real `WorkspaceProvider`** for the
URL tests — resolution and redirection live in two different files, and stubbing
either leaves the only seam that can break untested. And every claim in it was
**checked by breaking the fix**: removing the slug redirect killed exactly the
three redirect tests, counting revoked keys as live killed the blast-radius test,
deleting the reactivation note killed the revoked-row test, and pointing the
Dashboard ID chip back at the URL param killed both chip tests. A test that
passes the moment it is written has proved nothing yet.

Two files were added after that round, both mutation-checked the same way.
`test/security-headers.test.js` (16) covers the CSP and the `_headers` file; it
is the reason `vitest.config.js` matches `.test.{js,jsx}` rather than `.test.jsx`
alone, because a pattern that silently collects nothing is how a test file gets
written, committed and never run. Its assertions are mostly *inclusion* checks
tied to the code that needs each source, since the way a CSP actually breaks is
somebody deleting a directive they cannot see a reason for.
`test/workspace-url-validation.test.jsx` (13) covers `/w/:ws` resolving to a
workspace the signed-in person can reach; its strongest assertions are that
`whoami` and `listFiles` are **not** called, because the bug it pins rendered the
wrong workspace's data rather than the wrong page.

On the API side, `test/auth.test.ts` gained a sweep asserting 401 on **41
authenticated routes** with no credential. The table is written out by hand on
purpose: a route added outside `withAuth` has to be added to it, which is exactly
how the one route that answered 404 escaped notice.

There is still no Playwright e2e layer.
[doc 09](../docs/design/09-test-strategy-and-failure-modes.md) specifies
the strategy in full — unit, integration against Miniflare, Playwright e2e, plus
**21 named security test cases** and a failure-mode table. The named cases have
not been walked one by one against what exists; several are covered
incidentally, but that has not been checked off deliberately.

Worth pulling forward from that doc, because they encode behaviour the UI already
implements and could silently regress:

- Login failure must stay generic — no account enumeration.
- Forgot-password must return an identical response for known and unknown emails.
- A revealed API key must never be retrievable a second time.
- An agent must not be able to call a tool outside its scopes.
- Tenant isolation: no request may read across workspaces.
