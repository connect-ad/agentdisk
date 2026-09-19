# Auth rebuild to the Claude Design spec — phase 2b

Status: built, measured, not yet on `dev`
Design source: `AgentDisk Auth.dc.html` (413 lines), Claude Design project
`0d71f84d-2555-4ca8-991b-50be0d7fd1d1`
Supporting: `agentdisk-logo.png` (already in `apps/web/public/`), `support.js`
(the canvas runtime — `DCLogic`, `sc-if`, `sc-for`; harness, not product code)

**The byte-exact reference is not in `design-system/` yet.** The other four
`.dc.html` files were exported from Claude Design by hand, and the design MCP
reads files into a model context rather than onto disk, so a local copy written
from a transcript would be a re-typed reference — the one artifact worth less
than none, because a later pass would diff the live page against it and
"correct" the drift the wrong way. Export it beside the other four before the
next auth pass; every number this document quotes came from the remote file and
is reproduced here so the work is reviewable without it.

## What the reference draws

One sheet, `1100 x 660` minimum, `1px` edge, `14px` corner, on a stage padded
`36/24`. Split `minmax(0,1fr) 480px`: brand panel on the fluid side, form in
the fixed column. Its Mobile frame (390) drops the brand panel and puts the
wordmark over the form. Four states on one artboard: `signup`, `login`,
`login_error`, `signup_busy`.

Every px below is the reference's own, against a 16px root. The app serves a
125% root (`styles.css:348`), so the live value is 1.25x each — the same rule
the dashboard shell and the Logo mark already follow, and the reason the type
scale is authored in rem at /16.

| Region | Reference |
|---|---|
| Brand panel | `--surf2`, right edge `--bd`, pad `40/38`, column, space-between, gap `36` |
| Wordmark | Outfit 600, `17`, `-0.02em`; logo tile `30`, corner `8` |
| Brand heading | Outfit 600, `28`, `-0.03em`, `1.15`, margin-bottom `14` |
| Brand body | `14 / 1.65`, `--tx2`, measure `330`, margin-bottom `26` |
| Points | gap `13`; chip `18` corner `5` `--accSoft` on `--accBd`, tick 3px stroke; title `13` 600; note `12.5 / 1.5` |
| Footer card | corner `11`, pad `14`, `--surf` on `--bd`; label mono `9.5 / 0.11em`; code mono `12 / 1.7`, `pre` |
| Form panel | pad `40/44` (mobile `30/22/38`), centred; measure `372` |
| Segment | `--surf2` on `--bd`, corner `10`, pad `3`; button `34` tall, corner `7`, `13`, on = `--surf3` |
| Heading | Outfit 600, `25`, `-0.025em`, margin-bottom `7` |
| Sub | `13.5 / 1.55`, `--tx2`, margin-bottom `24` |
| Provider button | `42` tall, corner `9`, `--surf2` on `--bd2`, gap `11`, pad `0 14`, label `13.5` 500; icon `17` |
| Divider | gap `11`, margin-bottom `20`; label mono `9.5 / 0.1em` |
| Field | `42` tall, corner `9`, `--surf2` on `--bd2`, pad `0 12`; group margin-bottom `14`, password group `10` |
| Micro-label | mono `9.5 / 0.11em`, `--tx3`, margin-bottom `7` |
| Validity mark | `15`, `--okTx`, 2.8px stroke; error row `13` mark + `12` `--dngrTx`, gap `7` |
| Strength | 4 bars, `4` tall, pill, gap `4`; tag mono `9` 600 `0.07em`, pad `2/6`, corner `4` |
| Checkbox | `17`, corner `5`; on = `--acc` filled, off = `1.5px --bd2` |
| Submit | `46` tall, corner `10`, `--acc` on `--accInk`, `14.5` 600; spinner `13` |
| Foot | `12 / 1.6`, `--tx3`, centred, margin-top `16` |
| Tail | `--bd` rule, margin-top `24`, pad-top `18`, gap `7`; `12.5`, link 600 `--acc` |

Four type steps were not on the scale and are now named rather than rounded —
`--t-14-5`, `--t-17`, `--t-25`, `--t-28` (`styles.css`). The reference's
palette needed nothing: `styles.css` already aliases the design's own
vocabulary (`--tx`, `--surf2`, `--bd2`, `--acc`, `--okTx`, `--dngrTx`, …) onto
the token names, so the CSS reads as the reference writes it.

## Content: where the reference and the product disagree

The standing rule is layout from the design, content from the codebase. The
Auth file is a mockup and invents freely, so most of the list is a correction,
not a preference.

| Reference says | Reality | Done |
|---|---|---|
| "5 GB and 50,000 requests a month" | `plans.ts` free tier is 2 GB / 100,000 | corrected |
| "$ adk auth login / ✓ workspace ws_8f3ac21d9e4b" | no `adk` CLI exists | replaced with the three real post-signup steps |
| login panel: "3 workspaces · Kessler Labs, Nightshift Research, Personal sandbox", "4 agent identities", "7 active keys" | account data for somebody not signed in | replaced with three statements true before anyone authenticates |
| "LAST SESSION · 15 Sep 2026, 18:22 UTC · Berlin, DE · Chrome 141" | invented; no session-location record exists | replaced with the REST and MCP endpoints, read from `api.js`'s `BASE_URL` so they cannot name the wrong environment |
| "Sessions expire in 12 hours", "device-bound" | Firebase keeps the browser signed in until sign-out; the ID token refreshes hourly | replaced with what actually happens |
| "Keep me signed in for 30 days" checkbox | nothing honours it | omitted — a control reporting an unhonoured choice is the `backlog/023` defect |
| "Continue with SAML SSO" | not built | omitted |
| "Email me product updates, at most monthly" | no backend | omitted |
| "After five failed attempts we pause sign-in for 15 minutes" | the lockout is Firebase's `auth/too-many-requests`, threshold unpublished | replaced with a statement that does not invent a number |
| "14 characters, mixed case, one symbol" under a live meter | a fixed caption under a live control | computed from the password in the field |
| "Two attempts left" on the password error | no such counter | dropped |

Two states cannot be built as drawn at all:

1. **`login_error` puts "No account found for this address" under the email
   field.** That is the oracle doc 06 PART 16 forbids and `describeAuthError`
   exists to prevent — it answers "does this address have an account here" to
   anyone who asks. A failed sign-in marks both fields and shows one generic
   message: the same visual weight, without the disclosure.
2. **Its "Forgot password?" navigates to `login_error`.** A canvas affordance
   for flipping frames, not a flow. It links to `/forgot-password`.

Kept although the reference has no slot for it, because it is built and doc 16
PART 30 names it: **email-link sign-in**, a text action under the submit button.

Three screens have no artboard — 8.4 verify, 8.5 forgot, 8.6 reset. They take
the same sheet with a brand panel written for that moment, and no segment: none
of the three is a choice between signing up and signing in.

## What changed in the code

| File | Change |
|---|---|
| `apps/web/src/routes/Auth.jsx` | rebuilt to the split sheet; all five screens |
| `apps/web/src/app.css` | `.auth__*` replaced; the old centred card is restated under `.auth--card` |
| `apps/web/src/routes/Sandbox.jsx` | takes `.auth--card` — 8.9 has no artboard here and keeps its 25rem card |
| `apps/web/src/styles.css` | four half-step type tokens |
| `apps/web/src/lib/auth.jsx` | `signUpWithPassword` takes an optional `displayName`, so the reference's FULL NAME field is wired rather than decorative |
| `apps/web/src/lib/api.js` | exports `BASE_URL` for the endpoints card |
| `apps/web/src/components-local/Logo.jsx` | 8px corner at size 30 |

The controls are drawn in CSS rather than taken from the vendored `Input` and
`Button`: the reference's 42px field under a 9.5px mono micro-label is not a
variant either component has, which is the same reason `.mk__*` and `.err__*`
exist beside the barrel.

## Verification

`npm run build` clean (126 modules). `npm test` 126 passed, 8 files.

Geometry measured in headless Chromium against the built stylesheet rather than
asserted from source — 60 checks, all passing: every height, measure and type
size in the table above at its reference value times 1.25; Outfit on the
headings and IBM Plex Mono on the micro-labels; the strength meter lighting
four bars and captioning the password actually typed; submit gated on consent
and armed by a label click; the mockup strings absent and the enforced numbers
present; the segment marking the current route; the Mobile frame hiding the
brand panel with no horizontal overflow at 390; and the dark and light palettes
resolving to the design's own `--surf2`, `--tx` and `--acc` values.

Not yet done: the screens are not on `dev`, so `app-dev.agentdisk.io` still
serves the previous centred card until this is pushed.
