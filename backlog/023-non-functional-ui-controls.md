# 023 · Replace the non-functional UI controls

**Status:** Open — found by the 8 Sept 2026 audit ([summary.md](../summary.md) §4).
A second pass on **16 Sept 2026** closed most of what remained; see
"16 Sept 2026 pass" at the foot of this file.
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

---

## 16 Sept 2026 pass

Wired, each now calling an endpoint that already existed and had never been
invoked from the dashboard:

- **Delete file**, single and bulk. Both set a "Deleted" toast and sent no
  request. Bulk reports partial failure; nothing is removed optimistically.
- **Create folder.** The confirm button was `onClick={() => setDialog(null)}`.
- **Download.** Neither button in the detail drawer had a handler, and `api.js`
  had no download method. One call per click — egress is billed when the URL is
  issued.
- **Rename workspace.** Flashed "Saved" and called nothing, because no
  `PATCH /v1/workspaces/:id` existed. It does now, and the slug does not move.
- **The empty state's "Upload files"**, to the input the toolbar already used.

Removed, because no endpoint exists and none is planned: the per-row ⋮ menu,
bulk Move, Download as zip, Copy signed link (`/sign` answers 404) and Activity's
Export CSV.

Disabled with a stated reason rather than removed, because the privacy policy
grants them and they will be built: **Export my data** and **Delete my account**.
Both previously reported success — one promised an email within 24 hours, the
other said "Account deletion scheduled" — for work with no mechanism behind it.

Also corrected: the delete dialog's "trash for 30 days" (the grace period is 24
hours and there is no trash screen), the masked key prefix (`ad_live_`, which
this API has never issued), the Quick-start curl's `contentType`, the Resend
sub-processor row, and the `EU-CENTRAL-1` residency badge.

**What remains is the work that needs endpoints that do not exist**: a real data
export, account deletion, and full-text search inside files.

`apps/web/test/file-browser-wiring.test.jsx` and `privacy-tab.test.jsx` pin the
wired controls by asserting the API was *called* — a test that only checked for
the toast would have passed against every one of these bugs.
