# 031 · Upstream the modal scroll contract

**Status:** Open — local divergence in a vendored component, then upstream

`Modal` cannot be completed from the keyboard, and at a short viewport it cannot
be completed at all. At **684px** tall the Create API key modal's footer falls
below the fold, the body does not scroll, and there is no Enter-to-submit — so
minting an API key is impossible, which is step 1 of the product's own Quick
start.

The diagnosis is not the obvious one. `.modal__body` already declares
`overflow-y: auto` and `.modal` already declares `max-height: 100%`, which is why
this reads as solved in the stylesheet. In a flex column a child's default
`min-height: auto` refuses to shrink below its content height, so the body never
becomes smaller than its contents, the `overflow-y` never engages, and the column
grows past its own cap — pushing the footer out of view. **`min-height: 0` on the
scrollable child is the fix.** `.modal__head` and `.modal__foot` additionally need
`flex: none`, or the browser resolves the overflow by compressing exactly the two
regions that must never move.

The full four-point contract, and the layering scale it sits inside, are in
[docs/ui-layering.md](../docs/ui-layering.md).

## Why this is a divergence

Points 1–3 are CSS, and `main.jsx` imports `styles.css` before `app.css`, so the
local sheet can carry them without touching the vendored one. **Point 4 cannot
be done in CSS.** Enter-to-submit needs the dialog's content wrapped in a
`<form onSubmit>` with the primary action as `type="submit"`, which changes
`apps/web/src/components/Modal/Modal.jsx` — a vendored component.

That makes this the fourth deliberate divergence in vendored code, after
[015](015-rename-in-design-system.md), [016](016-upstream-workspace-switcher.md)
and [026](026-upstream-account-menu.md) in `AppShell.jsx`. It is recorded in
`CLAUDE.md` beside them.

The upstream target has moved: the 96-file byte-verified mirror was removed in
the design migration, and the authority is now the Claude Design project
`0d71f84d-2555-4ca8-991b-50be0d7fd1d1`. The `.dc.html` artboards are exported by
hand, so this cannot be pushed from here — the change has to be made in Claude
Design and re-exported. Until it is, `Modal.jsx` is knowingly ahead of its
reference.

## Also here

`apps/admin` implements its own modal and must satisfy the same contract. It
deliberately does not import the design system, so the two are separate
implementations on purpose — see `coordination/DEFERRED.md` X-02. Do not
reconcile them by sharing a component.

## Verification

At a 684px-tall viewport, open Create API key: the footer is visible, the body
scrolls, the head and footer hold still, and Enter from the name field submits.
Repeat in `apps/admin` against its own modal.
