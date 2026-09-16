# UI layering and the modal contract

Both apps stack overlays. `apps/web` and `apps/admin` are built by different
tracks and must not invent separate ladders, because the two are read side by
side during support and a dialog that behaves differently in one is a bug report
in both. This document is the agreement.

It exists because the customer app shipped a real inversion: a confirmation
dialog opened from the file detail drawer rendered *underneath* it, and its
confirm button could not be clicked.

---

## 1. The scale

One ladder, defined once as tokens in `apps/web/src/app.css`. Never write a bare
`z-index` number in app code again; use the token, and if none fits, add a rung
here first.

| Token | Value | Layer | Why it sits there |
|---|---|---|---|
| `--z-base` | `1` | Sticky table header (`.tbl th`) | Lifts the header off scrolling rows, nothing more |
| `--z-nav` | `30` | Shell tabs, marketing nav, in-context menus | Sticky chrome that page content scrolls under |
| `--z-topbar` | `40` | Shell top bar (`.shell__top`) | Must cover the tabs that stick beneath it |
| `--z-progress` | `50` | Top progress bar (`.tprog`) | A route change must stay visible over all chrome |
| `--z-drawer` | `60` | Drawer (`.dw`) | Above the page and its chrome — but **below** dialogs |
| `--z-modal` | `80` | Scrim and modal (`.scrim`) | A dialog is the most urgent surface; it interrupts a drawer |
| `--z-toast` | `90` | Toasts | Confirms the result of the dialog that just closed, so it must clear it |

**The rule in one line: a modal always covers a drawer, and a toast always
covers both.** A drawer is a place you browse; a dialog is a question you must
answer before anything else continues. Whatever asks a question wins.

### What changed and what did not

Only two rungs moved, and they swapped:

| | Before | After |
|---|---|---|
| Drawer `.dw` | `80` | **`60`** |
| Scrim `.scrim` | `60` | **`80`** |

Everything else keeps its number. That is deliberate: **nothing occupies 61–79**,
so exchanging the two values cannot disturb a third party. Each ordering that
the old scale relied on was checked and still holds:

- top bar `40` > tabs `30` — the bar covers the tabs sticking beneath it ✓
- progress `50` > top bar `40` — route progress stays visible over chrome ✓
- drawer `60` > progress `50` — still true after the drop from 80 ✓
- modal `80` > drawer `60` — **the inversion, now fixed** ✓
- toast `90` > modal `80` ✓

### Two values that are deliberately not on the ladder

`.dz-overlay` (`z-index: 5`, `app.css`) and `.wsx__menu` (`z-index: 30`,
`app.css`) are **local** values inside a positioned ancestor. They do not
compete globally and must not be converted to ladder tokens.

`.wsx__menu` is the one to understand, because it looks like a bug and is not.
The workspace switcher renders into `AppShell`'s `workspaceSlot`, which sits
inside `<header class="shell__top">` — a positioned element with `z-index: 40`,
and therefore **a stacking context**. The menu's own `30` is resolved *within*
that context. It can never paint above anything the top bar itself sits below,
whatever number it is given. Raising it to `100` would change nothing.

That is the correct behaviour: an open switcher menu drops beneath a modal
scrim, because the dialog is the thing demanding an answer.

**The trap this implies:** a `z-index` only ranks siblings within the nearest
stacking context. Before changing a number, find the ancestor chain. An overlay
rendered *inside* the drawer's subtree cannot escape `.dw` by out-numbering it —
it would need a portal. The customer app is safe here only because
`FileBrowser.jsx` renders its `<Modal>` and `<ConfirmModal>` as **siblings** of
`<Drawer>`, not children. Keep it that way, in both apps.

### Toasts are inline-styled, and should not be

`zIndex: 90` is repeated inline in eight route files (`FileBrowser`, `ApiKeys`,
`Agents`, `AgentDetails`, `Settings`, `SettingsTabs` ×2, `Webhooks`). Each is a
copy nothing keeps in step. Neither track has to fix this now, but do not add a
ninth — if you need a toast, add a `.toastdock` class carrying `--z-toast` and
use it.

---

## 2. The modal-scroll contract

Both apps must implement all four points. This is not polish: at a **684px**
viewport the Create API key modal's footer falls below the fold with no internal
scroll and no keyboard submit, so the key cannot be created at all — and that is
step 1 of the product's own Quick start.

**1. A bounded height.** The dialog never exceeds the viewport minus the scrim's
padding. `.modal` already declares `max-height: 100%` inside a `display: grid`
scrim; keep it.

**2. A body that scrolls internally.** `.modal__body` already has
`overflow-y: auto`, which is why this looks fixed and is not. In a flex column a
child's default `min-height: auto` refuses to shrink below its content, so the
body never becomes smaller than its contents, `overflow-y` never engages, and the
column grows past the cap instead — pushing the footer out. **`min-height: 0` on
the scrollable child is the fix**, not `overflow-y`.

**3. A footer that stays reachable.** `.modal__head` and `.modal__foot` must be
`flex: none`. Without it they are shrinkable, and the browser resolves the
overflow by compressing exactly the two parts that must never move.

**4. Enter submits, from any text field.** A single-field dialog that cannot be
completed from the keyboard is broken for the people most likely to be using it.
The dialog's content must be a `<form onSubmit={...}>` with the primary action as
`type="submit"`, so Enter works from any field it contains. `Escape` already
closes; `Enter` must be its counterpart.

Together: the head and footer hold still, the body between them takes whatever
height is left and scrolls, and the primary action is always both visible and
reachable by keyboard.

---

## 3. Where these changes belong

`apps/web/src/main.jsx` imports `styles.css` **then** `app.css`. The local sheet
therefore wins at equal specificity, and this has a useful consequence:

> **The entire layering change is made in the local `app.css`, including the
> `.scrim` override.** No vendored stylesheet edit is required for it.

`.scrim` and `.modal` are defined in `styles.css`, the sheet vendored from the
design-system mirror; `.dw` is local to `app.css`. Rather than editing the
vendored rule, `app.css` re-declares `.scrim`'s `z-index` in its own overlay
block, next to `.dw`, so the whole ladder is legible in one place.

Points 1–3 of the modal contract are CSS and can be handled the same way, from
`app.css`. **Point 4 cannot:** Enter-to-submit needs markup, so it changes
`apps/web/src/components/Modal/Modal.jsx` — a vendored component. That is a
deliberate divergence, recorded in `CLAUDE.md` beside the `AppShell.jsx`
precedent and tracked for the upstream trip as
[backlog/031](../backlog/031-upstream-modal-scroll-contract.md).

`apps/admin` **does not import the design system, by design** — its separate look
is how a support engineer knows which console they are in. Track B therefore
writes its own modal. It follows this document; it does not import a component
from `apps/web`. See `coordination/DEFERRED.md` X-02.

---

## 4. Checking your work

The layering is cheap to verify by hand and expensive to get wrong:

1. Open a file's detail drawer, then trigger delete from inside it. **The
   confirm dialog must cover the drawer, and its confirm button must click.**
2. With that dialog open, confirm the toast that follows covers what remains.
3. Open the workspace switcher, then open any dialog. The menu must fall behind
   the scrim.
4. Resize to **684px tall** and open Create API key. The footer must be visible,
   the body must scroll, and Enter from the name field must submit.
