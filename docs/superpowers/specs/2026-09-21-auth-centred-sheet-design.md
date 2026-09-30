# Auth: one centred card, scaled to the screen

Status: built, on `dev`
Replaces: the split sheet of `2026-09-16-auth-rebuild-design.md`, built to
`AgentDisk Auth.dc.html`
Design source: **none in Claude Design.** This is the first auth layout the
repository carries that was not taken from a design file. It was drawn here,
against the brief below, and this document is its record; if it is ever
redrawn upstream, that file becomes the reference and this one its history.
Screens: `/signup`, `/login`, and the three that share the shell —
`/verify-email`, `/forgot-password`, `/reset-password`. `/sandbox` keeps its
own card and is untouched.

## Why

Two facts, both measured on the live page on 21 Sept 2026 rather than
assumed.

The split sheet was taller than a laptop. Its brand panel had nothing to do
with the height — the form column set it — but the reference's 660px sheet
was authored at a 16px root and this app serves 125%, so the floor was 825
real px before its 90px gutter, and Sign up's own column ran to 893 with
nothing typed and 1033 with the strength checklist open. A 1920×1080 Chrome
with a bookmarks bar offers about 915. Two rounds of tightening the whitespace
(commits `cfcca5f`, `41e4f00`) got Log in inside that and Sign up inside it
at rest; nothing short of shrinking the controls was going to fit the typing
state, and a 1366×768 screen was never in reach.

And the brand panel's copy was a second account of the product, kept by hand.
It had already drifted once — the free tier's numbers — and had been rewritten
once to remove account data for a person not yet signed in. The owner asked
for it to go.

## The brief

Remove the brand panel. Centre the form. Fit any desktop or laptop screen
with no scrollbar, adapting on its own rather than at a couple of fixed
breakpoints. Make it distinct.

## What is drawn

One card, 600 wide at full scale, centred on the page, the wordmark small
above its left edge. Inside, top to bottom:

| Region | Full-scale px | Note |
|---|---|---|
| Tabs | 13.5 / 500, current 600, `2px` accent rule on the card's divider | links to `/signup` and `/login`, `aria-current` on the current one; absent on verify / forgot / reset |
| Title | Outfit 600 `25`, `-0.025em`, `1.2` | sub-line only where it explains the screen (forgot, reset, verify); Sign up and Log in have none |
| Providers | two tiles, `42` tall, corner `9`, `--surf2` on `--bd2`, side by side | stack under 560px |
| Divider | mono `9.5 / 0.1em`, hairline either side | |
| Field | `42` tall, corner `9`, `--surface` on `--bd2` | label mono `9.5 / 0.11em` **in the top border**, on a slip of `--surface`; focus turns edge and label `--acc` together, an error turns both `--dngrTx` |
| Forgot password? | `12` / 500, `--acc`, in the same border, right end | Log in only |
| Strength | five `4px` bars + mono `9` verdict tag on one row; the five rules as chips `11.5` in a wrapping row below | replaces the three-row list; `short` labels from `lib/password.js` |
| Consent | `17` box, corner `5`; text `12.5 / 1.5` | Sign up only |
| Submit | `46` tall, corner `10`, `--acc` on `--accInk`, `14.5` / 600 | |
| Small print | `12 / 1.5`, `--tx3`, centred | |
| Tail | `12.5`, prompt `--tx2` + link 600 `--acc` | no rule above it any more |
| Card | corner `14`, `--surface` on `--line`, `--sh-3`, pad `28 / 36 / 26` | one `ad-valuein` on mount; nothing else moves |
| Platter | five rings, `1px` `--line`; one sector of the third ring `2px` `--acc` at 55% | fixed layer behind the card, centre 19vmax right and 9vmax up of the page centre, `aria-hidden`, no motion |

Every label still sits in a real `<label for>`; every tab and link is a real
route. Focus is visible on everything: the ring on fields, a 2px outline on
tabs, tiles, the reveal and the submit.

## Two idioms

**Labels live in edges.** The field's name is in the field's top border and
"Forgot password?" in the same border at the other end, so no label costs a
row. Three fields at 26px of label row each was 80px of Sign up. It is also
the thing a person remembers the page by.

**The decoration is the product.** The platter rings are a disk, because that
is what AgentDisk sells, and they are the only decoration: no glow, no
gradient, no illustration. Hairline in `--line` so they are texture in both
themes; the accent appears once, in one sector.

## How it fits every screen

`.auth` takes its font-size from the viewport's height —
`clamp(0.85rem, 2.65dvh, 1.25rem)` — and every length in the block is an em
of that. Full size, a quarter over the root, from about 945px of viewport
height; the 0.85rem floor from 640 down. (Raised from a 1rem ceiling at 2.5dvh
on the owner's call the same day: the sheet read too small. The px in the
table above are the 1em = 20px figures it was drawn at; at full size every
one is 1.25× that.)
The block is therefore written in em, not in the rem tokens the rest of
`app.css` uses: a token is a fixed length, and a fixed length is exactly what
cannot fit a 1366×768 laptop and a 1440p monitor with the same rule. Each em
names the px it mirrors; colour, weight, tracking, motion and the focus ring
are still tokens.

Box sizes are set on boxes and text sizes on text, never both on one element,
so a 42px control stays `2.1em` of the sheet whatever its label's size is.

| State | Full size (1.25rem) | At the floor (0.85rem) |
|---|---|---|
| Sign up, nothing typed | ~810px of page | ~555 |
| Sign up, strength chips open | ~890 | ~605 |
| Log in | ~750 | ~510 |

Between the two the unit is 2.65dvh, so the sheet is ~94% of the viewport
at every height and never more. The pages fit from about 600px of viewport
height up. Below that they
scroll — a 768p screen under several toolbars, or a browser zoomed in — and
no readable sign-up form fits in less. The figures are computed from the CSS
by the same model that was checked against the live Log in page to within 2%
before the split sheet was retired; they have not yet been measured on the
new page.

## What was dropped, and where it went

| Was | Now |
|---|---|
| Brand headline, body, three points, footer card, per screen | gone; the product's case is made on `/` |
| Sign up sub-line "Free forever on the starter tier. No card required." | gone; the foot's "We never charge without an explicit purchase" already said it |
| Log in sub-line "Logging in never charges your card." | gone; the foot's "You stay signed in on this device until you sign out" is the useful sentence |
| ENDPOINTS card on Log in (`BASE_URL`) | gone; `/docs` prints them |
| Strength note "Still needs …" under the bars | gone from the meter; the chips say it, and the submit handler still names the unmet rules on a submit that reaches it |
| The rule above the tail row | gone |
| `.auth__mobilebrand`, the 1150px mobile frame | gone; one layout at every width, providers stack under 560px |

`lib/password.js` gains a `short` label per rule for the chips; `label` is
unchanged and still feeds the Settings hint, the Firebase rejection and the
submit error.

## What this does not settle

- **The numbers above are computed, not measured.** Measure `/signup` at
  1080p and at 768p and correct this table.
- **`docs/design/03` cannot be updated** — `docs/design/` is not in the
  tree (last tracked at `bc1b283`), though `CLAUDE.md` still routes to it.
- The card's `ad-valuein` and the vendored `Alert` inside it use rem, so the
  alert does not scale with the sheet. Acceptable; it appears on failure only.
- There is no artboard. If the layout is redrawn in Claude Design, export the
  `.dc.html` beside the other four and make this document its history.
