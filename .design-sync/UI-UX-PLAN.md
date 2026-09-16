# AgentDisk — remaining UI/UX work (sequential)

**Written:** 2026-09-05 16:25 local (08:25 UTC)
**Instruction from user:** finish ALL UI/UX work, strictly sequentially, even where
steps do not block each other. Do NOT start backend/API work until UI/UX is done.

Update the **Progress log** at the bottom after each step so a fresh session can
resume without re-reading everything.

---

## Ground truth (already done — do not redo)

- Design system imported and byte-verified: `design-system/` — 96 files, 280 KB.
  32 components, 26 preview cards, 98 tokens, `_ds_bundle.js` (2083 lines).
- Claude Design project: `agent-storage-mcp`
  `d311bfd0-9751-4a9b-84f4-b33e7a09378e`
- Specs live in `docs/design/00..10-*.md`. Screen spec is **doc 03 PART 8**
  (32 `### 8.x` headings). Doc 04 is the standalone Claude Design prompt.

## Known defect to fix first

The built system and the written spec disagree on brand:

| | Spec (docs 03 §7.2, 04) | As-built (`design-system/styles.css`) |
|---|---|---|
| Accent | forest green `#2F6F4F` | indigo `oklch(0.475 0.168 262)` |
| Display/heading | Space Grotesk | Public Sans |
| Body/UI | Inter | Public Sans |
| Mono | JetBrains Mono | JetBrains Mono (agrees) |

**Decision: as-built indigo wins.** It is implemented, coherent, and its
"infrastructure-grade, exactly one accent" rationale is stronger. The docs get
corrected to match reality — never the reverse (do not restyle 96 verified files).

---

## Step 1 — Reconcile the spec drift

1. `docs/design/03-ux-architecture-and-screens.md` §7.2 Design System — replace the
   colour token block and type stack with the as-built values read from
   `design-system/styles.css` (do not retype from memory; read the file).
2. `docs/design/04-claude-design-prompt.md` §"Design System — Build This First" —
   same correction.
3. Add a short dated note in each explaining the change and pointing at
   `design-system/styles.css` as the source of truth.
4. Do NOT touch `design-system/**` — it is byte-verified against the remote.

**Done when:** no occurrence of `2F6F4F`, `Space Grotesk`, or `Inter` remains in
docs 03/04 as a *prescription*. Verify with grep.

## Step 2 — Scaffold `apps/web`

Follow the structure doc 07 §18.6 prescribes:

- `apps/web/package.json` (Vite + React 18 + react-router-dom), `vite.config.js`,
  `tsconfig.json`, `index.html`, `src/main.jsx`.
- Move `design-system/components/**` → `apps/web/src/components/`.
  Keep `styles.css` reachable and imported once in `main.jsx`.
- Write `apps/web/src/components/index.js` — a barrel re-exporting every component.
  This is required: `_adherence.oxlintrc.json` forbids importing component
  internals and mandates importing from `index.js`.
- Keep a copy of the untouched import at `design-system/` OR record clearly in
  NOTES.md that it moved. Do not silently orphan it.

**Done when:** `npm install && npm run build` succeeds in `apps/web`.

## Step 3 — MVP-0 screens (doc 03 PART 8)

Build as React routes under `apps/web/src/routes/`, composing ONLY components
imported from `src/components/index.js`, styled ONLY with `var(--*)` tokens.
Every state listed in the spec must exist (empty / loading / error), because the
spec calls those out explicitly and the components already support them.

Order: 8.8 Dashboard → 8.9 File Browser → 8.10 File Details drawer →
8.13 Agents → 8.14 Create Agent → 8.15 Agent Details → 8.16 API Keys →
8.19 Usage → 8.21 Settings General → 8.23 Settings Security → 8.26 Profile →
8.7 Login → 8.3 Signup → 8.4 Email Verification → 8.5 Forgot Password →
8.6 Reset Password → 8.1 Landing → 8.2 Pricing → 8.27 404 → 8.28 403 → 8.29 500

(App screens first — they exercise the design system hardest and surface gaps
early. Auth and marketing last: they are the most self-contained.)

## Step 4 — MVP-1 screens

8.18 MCP Connection → 8.18a Webhooks → 8.20 Activity Log →
8.22 Settings Members → 8.24 Settings Privacy → 8.25 Settings Billing →
8.30 Maintenance

Skip anything doc 03 §8.31 lists as intentionally not built — read it first.

## Step 5 — Verify and report

- `npm run build` clean.
- Every route reachable from the router.
- No raw hex colours and no hardcoded px in screen code (the adherence config
  flags both) — grep for them.
- Update `.design-sync/NOTES.md` with what was built and anything deferred.
- Report honestly: which screens are done, which are not, and why.

---

## Working rules for the unattended run

- **Sequential.** Finish and verify each step before starting the next.
- **Never fabricate progress.** If a step fails, record the real error in the
  progress log and continue to the next independent step rather than stopping.
- Read source files before editing; do not reconstruct content from memory.
- Prefer the Write tool over large bash heredocs (Bash fails past ~8-10 KB here).
- Watch for literal `\uXXXX` escape sequences when copying any file content, and
  never use `sed` for non-ASCII substitution on this machine (see NOTES.md).

---

## Progress log

| Step | Status | Notes |
|---|---|---|
| 1 — Spec reconcile | **DONE** | docs 03 §7.2 + 04 rewritten to as-built indigo/Public Sans. Recorded 3 gaps: Drawer, Tooltip, dark-mode. design-system/ untouched (96/96 byte-exact). |
| 2 — Scaffold apps/web | **DONE** | Vite 6 + React 18.3.1 + router. 64 component files copied (card.html left upstream), styles.css, generated barrel (32 comps + 3 data exports). `npm run build` clean: 65 modules. |
| 3 — MVP-0 screens | **DONE** | All 24 MVP-0 screens built: 8.1-8.17, 8.19, 8.21, 8.23, 8.26-8.29. Drawer gap closed with a local component (components-local/Drawer.jsx). Build clean throughout. |
| 4 — MVP-1 screens | **DONE** | 8.18 MCP, 8.18a Webhooks, 8.20 Activity, 8.22 Members, 8.24 Privacy, 8.25 Billing, 8.30 Maintenance. |
| 5 — Verify | **DONE** | Build clean (81 modules). No raw hex, no hardcoded px, no barrel bypass. Every nav item resolves to a route. design-system/ still 96/96 byte-exact. |
