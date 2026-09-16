# 026 · Upstream the account menu

**Status:** Open — upstream change, then re-import

The sidebar footer's account card was a real `<button>` with a chevron that did
nothing at all: no menu, no navigation, no feedback. Confirmed dead by the
8 Sept 2026 audit against the accessibility tree, not a coordinate miss
([18](../docs/design/18-full-ui-audit-and-fix-prompt.md) §9). Sign out existed
only as a link in the opposite corner of the top bar, which is not where anybody
looks for it, and nothing in the product reached account-level settings.

Fixed the same way [016](016-upstream-workspace-switcher.md) fixed the workspace
card directly above it, and the two should be upstreamed together:

- `AppShell` gained a `userSlot` prop, symmetric with the existing
  `workspaceSlot`. When a host supplies one it replaces the built-in card.
- With neither `userSlot` nor a real menu, the fallback card now renders as a
  `<div>` without a chevron. A chevron on a control that owns no menu state is
  the bug this item exists for; AppShell cannot own that state, so it should
  stop advertising it.
- `components-local/AccountMenu.jsx` is the real control — Profile and Sign out,
  `role="menuitem"`, Escape closes and returns focus to the trigger. Styled with
  `.wsx__*` only, so it is indistinguishable from the workspace switcher.
  `app.css` gained `.wsx__menu--up` (the footer is at the bottom of the viewport,
  so the shared menu's downward drop lands off-screen) and `.wsx__lead`, which is
  `.wsx__plus` named for what it is rather than for one of its uses.

**This is the third deliberate divergence in the vendored `AppShell`**, after
[015](015-rename-in-design-system.md) and [016](016-upstream-workspace-switcher.md).
All three are waiting on the same trip through Claude Design. Covered by
`apps/web/test/qa-fixes.test.jsx`.

**Still open here:** the menu offers Profile and Sign out. `/w/:ws/profile`
renders inside the shell and is protected; the separate `/account/profile` route
in `App.jsx` sits *outside* `RequireAuth` and is not linked from the menu. Decide
whether that second route should exist at all. The top-bar "Sign out" was left in
place deliberately rather than removed — a tester already knows where it is —
which does mean the product now has two.
