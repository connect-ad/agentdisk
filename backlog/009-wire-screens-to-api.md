# 009 · Wire the screens to the API

**Status:** Reopened (8 Sept 2026) — was Done; the audit found step 3 unmet and
fixture data still present. Tracked in [023](023-non-functional-ui-controls.md).

Every screen currently runs on local mock data. There is no API client.

**To close:**

1. Add `apps/web/src/lib/api.js` — a typed client over the REST surface in doc 05.
2. Replace each screen's module-level mock constant with a real fetch.
3. **Delete the `state` prop** from every screen. It exists only so the spec'd
   states stay reachable without a backend; once data is real, loading and empty
   derive from the request instead.
4. Keep the states themselves — they are specified behaviour, not scaffolding.

Screens with mock constants to replace: Dashboard, FileBrowser, Agents,
AgentDetails, ApiKeys, Usage, Settings, SettingsTabs, McpConnection, Webhooks,
ActivityLog.

`routes/Sandbox.jsx` is already wired to the real API and is not on that list.
It has to be: it calls the Turnstile-gated `POST /v1/workspaces`, which is the
only way to obtain a first credential.

## Unresolved: the two halves disagree about scope names

The UI says `files:read` / `files:write` / `files:delete`
(`components/McpToolList/McpToolList.jsx`). The API implements bare
`read` / `write` / `delete` / `list` / `keys:create` plus a `pathPrefix`
(`apps/api/src/auth/scopes.ts`). Verified in both trees; they cannot both be
right, and a client written against either one breaks against the other.

Not resolvable inside this repository, which is why it is recorded rather than
fixed. `McpToolList` is a **design-system component**, and `design-system/` is a
byte-verified read-only mirror — changing the UI side means changing the Claude
Design project upstream and re-importing (the same shape of problem as
[006](006-upstream-drawer.md)). Changing the API side means renaming scopes that
are already minted into live keys in dev.

Decide before writing the API client, not after: whichever way it goes, the
loser needs a migration, and doc 05 PART 14's MCP tool spec has to agree with
it too.

**Decided 8 Sept 2026: the API's bare names win, and no migration was needed.**
Nothing had to be renamed because nothing was ever *stored* as `files:*` — the
spelling lived only in the `mcpTools` fixture exported beside `McpToolList`, and
a fixture is not an interface. `routes/McpConnection.jsx` now builds its own tool
list from the real backend ops and passes it in, so the component renders
whatever scope vocabulary its host uses and the screen agrees with the Create-key
modal and the API Keys table. The stale fixture is still in the mirror and should
be corrected on the next upstream trip, alongside
[026](026-upstream-account-menu.md); until then, do not import `mcpTools`.

Step 3 above is also now done for `McpConnection` — its `state` prop is gone.
The remaining screens with one are tracked in
[023](023-non-functional-ui-controls.md).
