# 016 · Upstream the workspace switcher into the design system

**Status:** Open

The dashboard used to talk about workspaces in three places at once: an inert
card in the sidebar with a chevron that did nothing, a raw `<select>` in the
topbar that only appeared once you already had two workspaces, and a "New
workspace" button beside it. Between them they showed the same fact twice and
hid the way to act on it — the only route to a second workspace sat next to a
control that was invisible until you had one.

All three are now
[`apps/web/src/components-local/WorkspaceSwitcher.jsx`](../apps/web/src/components-local/WorkspaceSwitcher.jsx),
in the sidebar, in the place the card used to be. Design-system tokens only
(`.wsx__*` in `app.css`), `role="menu"` with `menuitemradio` + `aria-checked` for
the current workspace, Escape closes and returns focus to the trigger, a click
outside dismisses. Covered by `apps/web/test/workspace-switcher.test.jsx`.

**Two things now live outside the mirror because of it.**

1. **A local edit to the vendored `AppShell`.** It gained one additive prop,
   `workspaceSlot`, which replaces the workspace card with a caller-supplied
   node; without it, `workspace={{name, meta}}` behaves exactly as before. This
   is the second deliberate divergence in that file — the first is the
   `AgentDrive` → `AgentDisk` wordmark, see [015](015-rename-in-design-system.md).
   Both should go upstream together.

2. **A menu the design system cannot express.** `Menu` renders
   `role="menuitem"`, which is right for a list of actions and wrong for "pick
   the current one out of a set". It also types its trailing slot as
   `shortcut?: string`, styled as a mono keycap, so the tick could not go there.
   A selection menu — `menuitemradio`, `aria-checked`, a checked affordance — is
   a genuine gap, not just this app's preference.

**To close:** add the switcher (or at minimum a selection-capable `Menu`) and
the `workspaceSlot` prop to the Claude Design project `agent-storage-mcp`,
re-import via the design-sync flow, then delete `components-local/WorkspaceSwitcher.jsx`
and switch `App.jsx` to the barrel.

**Deliberately not done here:** the trigger shows your role in the workspace
("Owner"), not its plan. `GET /v1/workspaces` returns `{id, name, role}` only,
so a plan badge per row would need an API change — see
[`apps/api/src/routes/workspaces.ts`](../apps/api/src/routes/workspaces.ts).
