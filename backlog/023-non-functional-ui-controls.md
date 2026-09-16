# 023 · Replace the non-functional UI controls

**Status:** Open — found by the 8 Sept 2026 audit ([summary.md](../summary.md) §4).
A 8 Sept pass against
[18](../docs/design/18-full-ui-audit-and-fix-prompt.md) closed the whole of
Tier 2 and part of Tier 1; the inventory below is annotated with what remains.

**Closed by that pass.** Tier 1: delete workspace (a real
`DELETE /v1/workspaces/:id` now exists and the dialog calls it); sign out all
other sessions (calls `POST /v1/me/logout-all`); sign out one session (the
per-device table is gone — Firebase exposes no such inventory, so the honest UI
is the single action, per doc 16 Phase 2). Tier 2: the fake workspace ID, the
entire MCP Connection screen (real endpoint, real scope-derived tool list, the
`REAL_KEY` checkbox removed, the `state` prop deleted), and the Agents stat tile.
Tier 3: "Change password", now backed by Firebase re-authentication and shown
only to accounts that have a password provider.

**Still open.** Tier 1: delete my account, export my data, delete file(s),
create folder, save workspace name (still no `PATCH /v1/workspaces/:id`). Tier 2:
`soleOwnerOf={0}`. Tier 3: the four Download/Upload buttons, the "extracted text"
search copy, and `Docs.jsx:153` still telling customers MCP is not built.


[009](009-wire-screens-to-api.md) was marked done on the grounds that no fixture
data remained. It does. 26 entities across six route files are non-functional,
dummy, or hardcoded — and **eight of them report success for work that never
happened**, which is worse than a missing feature: the user's mental model of the
system is now wrong and they have no way to detect it.

Full inventory with file:line in [summary.md](../summary.md) §4. The tiers:

**Tier 1 — controls that falsely report success.** Delete workspace
(`Settings.jsx:163`, closes the dialog after type-to-confirm); Delete my account
(`SettingsTabs.jsx:335`, toast "Account deletion scheduled"); Export my data
(`SettingsTabs.jsx:291`, alert promising a download link within 24 hours); Sign
out all other sessions (`Settings.jsx:187`); Delete file(s)
(`FileBrowser.jsx:402,418`, toast "Deleted"); Create folder
(`FileBrowser.jsx:384`); Save workspace name (`Settings.jsx:84`, green "Saved");
Sign out one session (`Settings.jsx:57`).

Escalate the middle three first. Two are GDPR-shaped promises — erasure and
portability — rendered as completed actions, one with a stated 24-hour fulfilment
deadline the product cannot meet by any mechanism (**there is no email
integration at all**; the Privacy tab's named sub-processor Resend is not wired
anywhere). The third is a security control whose real endpoint,
`POST /v1/me/logout-all`, exists and works and is simply never called.

Delete-workspace and create-folder have no backing endpoint at all: there is no
`DELETE` or `PATCH /v1/workspaces/:id`.

**Tier 2 — hardcoded data presented as live.** A fake workspace ID
(`Settings.jsx:18`) shown in a field whose own hint says it is what the API uses
to address the workspace. The entire MCP Connection screen: wrong endpoint
(`https://mcp.agentdisk.io/v1` at `McpConnection.jsx:19` — the real one is `/mcp`
on the API host), a hardcoded `state = 'connected-active'` default prop so a
pulsing green "Connected" badge shows unconditionally, `REAL_KEY = ''` so the
"include my key" checkbox emits `Bearer ` under a warning that it now contains a
live credential, and a tool list from a design-system fixture whose scope
vocabulary (`files:read`, `files:write`) does not exist in this product. The
Agents stat tile still says "Not built yet" (`Dashboard.jsx:176`) though
`GET /v1/agents` works. The sole-owner guard is hardcoded to `soleOwnerOf={0}`
(`Settings.jsx:151`), so it never fires.

**That default `state` prop is item 3 of [009](009-wire-screens-to-api.md)'s own
acceptance criteria**, which required deleting it from every screen.

**Tier 3 — dead controls and stale copy.** Three Download buttons and one Upload
button with no `onClick` (`FileBrowser.jsx:201,269,339,352`) — `GET
/v1/files/:id/download` is implemented. "Change password" with no handler above
three password inputs. Search copy claiming "extracted text" is searched, which
the API explicitly does not do.

`Docs.jsx:153` also tells customers MCP "is not built yet" and that
`mcp-dev.agentdisk.io` "does not answer tool calls today". All ten tools are
built and routed.

**The pattern:** screens rewired during the API-integration pass are real and
good — Members, Billing, Agents, API keys, Webhooks, Profile, Sandbox, and the
upload path in `lib/upload.js`. Screens from the original design-mock pass were
never revisited. `FileBrowser` is the visible seam: its upload was rewired and is
excellent, while the delete, download and folder controls beside it are untouched
mock handlers.

**To close:** wire what has an endpoint, remove what does not, and stop any
control from reporting success it cannot verify. Then reopen
[007](007-browser-verify-screens.md) — walking the 31 screens in a browser would
have surfaced the whole Tier-1 list in an afternoon, and remains the most
under-prioritised item in the project.
