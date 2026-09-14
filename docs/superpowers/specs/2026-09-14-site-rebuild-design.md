# Site rebuild to the Claude Design spec — phase 1

Status: awaiting review
Design source: `AgentDisk Site.dc.html` (967 lines), Claude Design project
`0d71f84d-2555-4ca8-991b-50be0d7fd1d1`
Supporting: `AgentDisk Design System.dc.html` (palette and type, already
implemented as tokens), `AgentDisk Patterns.dc.html` (state catalogue, phase 3)

## Why this exists

The theme migration (commits `c30d819`..`a138587`) replaced the palette, type,
radii and the dashboard shell, and left every page's **structure and copy**
untouched. That was a deliberate reading of "presentation-only", and it is why
the landing page is the old page wearing new colours: different headline,
different section count, a six-card use-cases block the design does not have,
and a tabbed code panel where the design draws a terminal transcript.

This phase rebuilds the Site pages to the design. Phase 2 is the dashboard
screens; phase 3 is the Patterns catalogue.

## Decisions already taken

Confirmed with the author before writing this:

| # | Decision |
|---|---|
| 1 | Match layout exactly; **real data flows through it**, not the design's mockup values |
| 2 | Pricing uses the design's **layout**, the app's **real numbers** from `plans.ts` |
| 3 | Accent stays violet `#6D28D9` / `#B592FF`. **Correction:** an earlier note called the Dashboard file's indigo a drift. It is not — that file carries a configurable accent with four presets, defaults to `#7C3AED`, and overrides it to exactly `#6D28D9` / `#B592FF`. The indigo is the base-palette placeholder the accent system overwrites. All three files agree. |
| 3b | The four accent presets (violet, indigo, teal, blue) ship as a user preference beside the light/dark toggle |
| 4 | **Adopt the design's copy** across the marketing pages |
| 5 | **Delete** the six-card "What people actually build with it" section |
| 6 | Build **all ten** error pages as real routes |
| 7 | **Skip** the persistent stats band (phase 2; needs a usage fetch per route) |
| 8 | Site first, verify, then Dashboard, then Patterns |
| 9 | Logo: author supplies `agentdisk-logo.png`; code tolerates its absence |
| 10 | `AI-Shoot Prototype.dc.html` and `ChatSidebar.dc.html` are a different product — ignored |

## Accent presets

`AgentDisk Dashboard.dc.html` defines four accents and applies the chosen one
over the base palette:

| Preset | Light | Soft | Border | Dark | Dark soft | Dark border |
|---|---|---|---|---|---|---|
| Violet (default) | `#6D28D9` | `#F3EDFE` | `#D7C4FB` | `#B592FF` | `#1E1533` | `#452F6E` |
| Indigo | `#4F46E5` | `#EEF0FE` | `#C6CCFA` | `#8B98FF` | `#181C33` | `#333C6B` |
| Teal | `#0D7A70` | `#E9F8F6` | `#A9DFD8` | `#5EDBCB` | `#0C2321` | `#1F4F49` |
| Blue | `#2563EB` | `#EBF1FE` | `#BBD1FB` | `#7EA8FF` | `#0F1B33` | `#2A3E6E` |

Implemented the same way as the colour mode: a `data-accent` attribute on
`<html>` with a block per preset redefining only `--accent`, `--accent-soft`
and `--accent-line`. Everything downstream — `--acc`, `--accSoft`, `--accBd`,
the ring, the focus outline — follows through `var()` with no further change.
Stored alongside the theme in `lib/theme.jsx`; default violet, so a reader who
never touches it sees exactly what ships today.

**Testing note:** this doubles the palette surface. The suite checks the
default only; a smoke check confirms each preset resolves and that no preset
leaves `--accent` undefined.

## Approach

Rebuild the route files in place, composing existing design-system components
and new token-based CSS. Rejected alternatives:

- **Porting the `.dc.html` markup with its inline styles.** Fastest pixel
  match, but every element carries raw hex and px, which
  `_adherence.oxlintrc.json` forbids; it discards the component layer, and it
  breaks dark mode, because an inline literal cannot follow a token.
- **Building a marketing component library first.** Most of these pieces occur
  once. YAGNI.

Pieces that genuinely repeat are extracted to `src/components-local/`; the rest
stays inline in its route file.

## Components to extract

| Component | Used by | Notes |
|---|---|---|
| `Logo` | nav, footer, auth | `<img src="/agentdisk-logo.png">` with an `onError` fallback to the "A" monogram, so the page is correct whether or not the asset has landed |
| `TerminalPanel` | landing hero | Traffic-light dots, caption, `<pre>` transcript with per-line tone |
| `FeatureCard` | landing | Mono kicker, `h3`, body |
| `StepCard` | landing | Numbered badge, title, body, code block |
| `PlanCard` | pricing | Kicker, price, unit, tick list, CTA; `featured` variant carries the `MOST TEAMS` badge |
| `ErrorPage` | ten error routes | Code chip, family, title, body, fact box, optional spinner note, two CTAs, related-links panel |

`ErrorPage` is the one that earns its keep: ten routes differing only by data.

## Page specifications

### Landing (`/`)

1. **Hero** — status badge (dot + `MCP SERVER · GENERALLY AVAILABLE`), `h1`
   "Storage your agents can actually reason about.", lead, two CTAs ("Start
   free — 5 GB" with arrow, "Read the docs"), three mono tags
   (`NO CARD REQUIRED`, `S3-COMPATIBLE`, `EU + US REGIONS`), and `TerminalPanel`
   on the right at `minmax(0,460px)`.
2. **Feature grid** — four `FeatureCard`s: SCOPED, PERSISTENT, MCP NATIVE,
   AUDITED. Four columns desktop, two tablet, one mobile.
3. **Three steps** — bordered panel, `h2` "Three steps to a working agent
   workspace", three `StepCard`s.
4. **CTA band** — accent-soft panel, `h2` "Give an agent a disk in four
   minutes.", body, "Create a workspace" button.

**Removed:** the six-card use-cases section, and the four-tab code panel
(curl / MCP / Python / TypeScript) which the terminal transcript replaces.

### Pricing (`/pricing`)

`h1` "Pay for storage and requests. Nothing else.", lead, three `PlanCard`s,
then a "Metered above plan limits" table.

**Three sources disagree, and one of them does not exist.** Checked while
writing this spec:

| | Free tier | Middle tier | Top tier |
|---|---|---|---|
| Design | FREE · $0 · 5 GB | **TEAM** · $49 · 50 GB | SCALE · $249 · 500 GB |
| Live page | Free · $0 | Pro · $20 | Team · $80 |
| `plans.ts` (enforced) | free · **2 GB** | pro · 50 GB | **team** · 500 GB |

Two problems, both material:

1. **The names collide.** The design's `TEAM` is the 50 GB tier; the code's
   `team` is the *500 GB* tier. Adopting the design's names would label a
   500 GB customer "Scale" while every API response and audit row calls them
   `team`. It would also advertise 5 GB free where the enforced limit is 2 GB —
   a promise the storage quota refuses at upload time.
2. **Prices are not data anywhere.** `plans.ts` carries limits only; there are
   no dollar amounts and no overage rates in the codebase. The only prices that
   exist are hardcoded strings in `Marketing.jsx`. `backlog/024` records that
   there is also no purchase path.

Therefore, pending the author's answer to the open question below, this spec
builds the pricing page as:

- **Limits** read from `plans.ts` — the only enforced numbers
- **Names** from `plans.ts` (Free / Pro / Team), *not* the design's
  FREE / TEAM / SCALE, because the design's names mislabel the tiers relative
  to what the API enforces
- **Prices** carried in one exported constant in the web app, commented as the
  sole price source and as needing to match Stripe, holding today's live values
  ($0 / $20 / $80) rather than the design's
- **The metered-overage table omitted**, because no overage rate exists to put
  in it and inventing four is how `backlog/024` started

This is the one place the rebuild deliberately does **not** match the design,
and it is a money question rather than a design one.

### Docs (`/docs`)

Three-column grid: `212px | minmax(0,1fr) | 176px` desktop, `196px | 1fr`
tablet, single column mobile.

- **Left** — a styled but inert search affordance, then three TOC groups:
  GETTING STARTED, AGENTS, REFERENCE.
- **Centre** — breadcrumb, `h1`, lead, accent callout, sections 1/2/3 plus
  Troubleshooting, with copy-able code blocks and the five-row MCP tool table.
- **Right** — "ON THIS PAGE" rail with a left rule.

The TOC entries and prev/next controls are presentational in this phase: the
docs site is one page today and nothing in the backlog creates the others. They
render as drawn and do not navigate. **This is the one place the rebuild
knowingly ships something inert**, recorded here so it is a decision rather
than an oversight.

### Auth (`/login`, `/signup`, `/forgot-password`, `/verify-email`)

The design's card: 14px radius, 26px padding, `h1` at 24px Outfit, sub, then
provider buttons, divider, fields, submit, footer note, alt-action link.
`verify-email` gains the six-box OTP row.

**Every existing handler is preserved verbatim** — `signInWithPassword`,
`signUpWithPassword`, the provider popups, the email-link flow,
`describeAuthError`, the password-strength meter. This is a re-layout of the
markup around them, not a rewrite of the flow. The suite's auth specs are the
check.

### Error pages (ten routes)

`ErrorPage` driven by a table keyed on code. Four exist (`403`, `500`,
`/maintenance` → 503, `*` → 404); six are new (`301`, `304`, `400`, `401`,
`410`, `429`).

Each carries code, family (REDIRECT / CLIENT / SERVER), tone (info / warn /
danger), title, body, CTA labels, a two-row fact box, three related links and
an optional spinner note. Tone selects the chip's colour trio.

Fact-box content is per-code static text from the design. Where a real value is
available it is used — 500 shows a real request ID if one is in scope;
otherwise that row is omitted rather than displaying an invented reference.

### Footer

Logo, wordmark, a mono region line, then links and a cookie-preferences button.

**Deliberate deviations:** `Status` and `Security` have no routes and none are
planned, so they are omitted rather than linked to nothing. The region line is
static in the design and renders as static text, claiming no live status. The
cookie-preferences button is omitted — see below.

## Explicitly out of scope

- **Cookie consent bar and preferences modal.** The design includes both, with
  three categories and a toast. Consent UI that gates nothing is worse than
  none: it is a promise the product does not keep. There is also nothing to
  gate — the only analytics on the site is Cloudflare's beacon, which the CSP
  blocks. **This needs a product decision, not an implementation.**
- **The marketing popup** in the design's control bar. Same reasoning: it
  collects an address nothing consumes.
- **Dashboard screens** — phase 2.
- **Patterns catalogue** — phase 3.

## Risk and testing

Risk here is lower than phase 2: these pages carry no workspace data and few
actions. The real exposure is the auth screens, where a markup mistake locks
everyone out.

The gate is `regression-tests/`:

1. Baseline is `baseline/app-dev-post-theme.json` (66 tests, 63 passing).
2. New tests for the six new error routes, following `error-pages.spec.js`.
3. Landing and pricing assertions updated for the design's copy — the current
   ones assert the old headline and **will fail by design**. Each such change
   carries a comment naming the decision above that authorised it, so a copy
   change never reads as a silently weakened test.
4. `npm test` in `apps/web` stays at 105/105.
5. Merge only when `compare` reports no regressions.

Assertions stay on roles, accessible names and destinations — never on
screenshots or class names. That is what caught the sign-out regression in the
theme migration, which looked perfect on screen.

## Acceptance

- Landing, pricing, docs, four auth screens and ten error routes match the
  design's structure and copy
- Both colour modes correct on all of them
- Every pricing limit comes from `plans.ts`; prices live in exactly one
  constant and nowhere else
- Regression suite: no regressions against `app-dev-post-theme.json`
- `apps/web` unit tests 105/105, build clean, adherence lint clean
- Keyboard: every new interactive control reachable, Escape closes what opens

## Open questions for the author

### 1. Pricing — names and prices

The table in the pricing section shows three disagreeing sources. The spec's
default is to keep the app's names and prices and take only the design's
layout. The alternatives:

- **Adopt the design's tiers wholesale** (FREE/TEAM/SCALE at $0/$49/$249, 5 GB
  free). This needs `plans.ts` changed to match, because otherwise the page
  advertises quota the API refuses. That is a billing change, not a design one.
- **Rename the code's plans** to the design's vocabulary. Touches stored rows,
  audit history and any Stripe mapping.
- **Keep as specced** — app names and prices, design layout.

Nothing here is safe to guess at, because every option that moves a number
either changes what customers are charged or what the API lets them store.

### 2. Cookie consent

The **cookie consent** decision above is the only other thing in the design
this spec declines to build. If the intent is to ship consent for a real analytics
product that is coming, say so and it moves into phase 1 with the categories
wired to something. If not, it should come out of the design file so the two
stop disagreeing.
