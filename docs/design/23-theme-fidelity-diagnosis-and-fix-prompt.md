# Theme Fidelity Diagnosis — Why "colors match, theme doesn't" — and a Fix Prompt for Claude Code

*Written after a live, evidence-based comparison of the deployed dev site (`app-dev.agentdisk.io/w/metesting/agents`) against the actual Claude Design project (`AgentDisk Design System.dc.html`, `AgentDisk Dashboard.dc.html`, `AgentDisk Patterns.dc.html`, `AgentDisk Site.dc.html`) — not a guess. Findings below were confirmed by reading computed styles out of the live page's DOM (`getComputedStyle`, `document.fonts`), not just by eyeballing screenshots.*

---

## 1. What actually happened (root cause, confirmed)

Claude Code's implementation is **not** a shallow "grabbed one color" job — it's closer than it looks. What transferred correctly and what didn't breaks down cleanly:

**Transferred correctly (verified):**
- The neutral palette: Canvas `#0B0D11`, Surface `#12151B`, Border `#252B35`, Ink `#E9ECF1` — pixel-exact on the live site.
- The primary accent purple.
- Typography — this is the one place first instincts are wrong, so it's worth stating plainly: **the fonts are fine.** `document.fonts` on the live page shows `Outfit` (weight 600) loaded and applied to headings and stat figures, `IBM Plex Sans` applied as the body/UI font, and `IBM Plex Mono` applied to IDs/quota numbers — exactly per the Design System's Typography section. Don't spend time re-importing fonts; that's not the gap.
- Border radius and card/tile structure.

**Did not transfer (confirmed by inspecting the DOM directly):**
- **The categorical/semantic color layer.** The Design System and the dashboard-shell brief (project doc `20`) both call for each of the four stat tiles — Storage, Files, Agents, Requests — to carry its **own distinct hue** (a small categorical palette), with warning/danger colors taking over near quota limits, plus success-green delta indicators (e.g. "+1,204 this period"). I checked this directly: on the live site, three of the four stat tiles reuse **the exact same single lavender/purple value** (`rgb(181, 146, 255)`) for their only colored element, and the Agents tile has **no colored element at all**. There is currently exactly one accent color on this entire page. This is the single biggest reason it reads as "matches some color but not the theme" — the neutral shell is right, but the layer that makes the Claude Design mockup feel alive (color coding by metric, amber-at-80%/red-at-95% quota states, green positive deltas) simply isn't wired up.
- **Badge/Chip fill.** The Design System's "Active" badge is a bold solid-fill green pill. The live "Active" badge is a much more muted soft-tint version (dark desaturated green background, bright green text) — a valid design pattern in general, but not what's specified, and it reads as washed-out next to the reference.
- **Content gap, not just style:** the Layer 1 workspace info strip is missing the **Plan** field. The spec (doc `21`, and the Dashboard file itself) calls for Owner | Workspace ID | Plan; the live strip only shows Owner | Workspace ID.
- Likely also missing (not fully confirmed live, since the test workspace has all-zero data so these states never trigger): the amber/red quota-threshold styling on the progress bars themselves, the Alert/Banner component for "Storage is at N% of your plan limit," and the small delta/trend indicators next to Files/Requests.

## 2. Why this happens with AI-coded theme imports generally

Worth understanding so this doesn't recur on the next pass: a coding agent implementing a design file tends to reliably pick up whatever is a **single, explicit, static value** — a hex code on a CSS variable, a font-family string — because those transfer almost mechanically. What it tends to under-implement is anything that's a **pattern or a rule** rather than a value: "give each of these four things its own color," "shift this color at 80% and again at 95%," "this badge is solid-fill, that one is soft-tint depending on state." Those require the agent to notice the rule buried in the design file and then apply conditional logic across multiple components, rather than copy a token once. That's exactly the class of gap found here.

## 3. What to do

This does **not** need a redo — the foundation (neutrals, primary accent, typography, structure) is solid. It needs a second, narrower pass focused specifically on the semantic/categorical color layer and the couple of content gaps above. Hand the prompt below to Claude Code as a scoped follow-up to the work it already did.

---

### Copy-paste prompt for Claude Code

> You previously implemented the AgentDisk Claude Design theme (project `0d71f84d-2555-4ca8-991b-50be0d7fd1d1`, files `AgentDisk Design System.dc.html`, `AgentDisk Dashboard.dc.html`, `AgentDisk Patterns.dc.html`, `AgentDisk Site.dc.html`) into the live app. A design review found that the neutral palette, primary accent, typography (Outfit / IBM Plex Sans / IBM Plex Mono), and layout structure all transferred correctly — **do not touch those.** What's missing is the semantic/categorical color layer and two content fields. Specifically:
>
> 1. **Re-open `AgentDisk Design System.dc.html`'s Colour section (part 01)** and extract the full semantic palette beyond the four neutrals (Canvas/Surface/Border/Ink) and the primary accent — the success/warning/danger swatches, and any categorical set intended for per-metric color coding (see also project doc `20-dashboard-shell-redesign-prompt.md`, Layer 2, which explicitly calls for Storage/Files/Agents/Requests to each get "its own hue from a real categorical palette... rather than reusing the single product accent"). Add these as proper CSS custom properties if they aren't already defined — check, because right now nothing in the rendered page uses them even if they exist in code.
> 2. **Wire the categorical colors into the four Layer-2 stat tiles.** Each tile's accent/progress-bar color should default to its own hue, not all reuse the single primary accent. Confirm this by checking that the Storage, Files, Agents, and Requests tiles render with four *visually distinct* colors, not one.
> 3. **Wire in the warning/danger quota-threshold rule**: per doc `20`, a quota-bearing tile (Storage, Requests) should shift its color toward `--warning` at 80% used and `--danger` at 95% used, overriding its default categorical hue. Test this by setting mock data at 78% and 97% (matching the Design System's own example numbers) and confirming the tile visibly changes color.
> 4. **Add the missing Alert/Banner component** for the quota-warning message ("Storage is at N% of your plan limit...") shown in `AgentDisk Dashboard.dc.html`'s Overview state — it should appear when a quota crosses its warning threshold and is currently absent from the live page.
> 5. **Add delta/trend indicators** where the Dashboard file shows them (e.g. "+1,204 this period" in green with an up-arrow on the Files tile) — currently absent.
> 6. **Fix the Badge/Chip component fill.** The Design System specifies a bold solid-fill pill for state badges (e.g. "Active" = solid green background, dark text). The live badge currently renders as a soft/muted tint instead. Match the Design System's actual fill style, or if a soft-tint variant is intentional for some other reason, confirm that decision explicitly rather than leaving it as an unflagged deviation.
> 7. **Add the missing "Plan" field to the Layer 1 workspace info strip.** Per doc `21`/`20` and the Dashboard file itself, Layer 1 should read Owner | Workspace ID | Plan. It currently only shows Owner | Workspace ID.
> 8. Once done, do a side-by-side pass **by component category, not by page** — open the Design System file's Components section (03) next to the live app and check off: Button, Input/Select, Checkbox/Radio/Switch, Badge/Chip, Stat tile, Alert/Banner, Table row states, Tooltip/Dropdown — since color/pattern drift like this hides inside shared components, not page layout, and a page-by-page pass tends to miss it.
> 9. This project has a regression-testing suite from an earlier theme migration (`regression-tests/`, see doc `22-theme-migration-prompt-and-test-plan.md`). Re-run it after this pass — these are color/state changes only, so functionality should be unaffected, but it's a cheap confirmation.
>
> Do not change the neutral palette, typography, fonts, spacing, or layout structure — those are already correct and out of scope for this pass.

---

## 4. Verification checklist (do this yourself, or ask Claude Code to report against it)

- [ ] Storage, Files, Agents, and Requests tiles show four distinct colors (not one accent reused four times).
- [ ] Setting a workspace's storage/requests usage to ≥80% turns that tile's indicator amber; ≥95% turns it red.
- [ ] The quota-limit Alert/Banner appears when a threshold is crossed.
- [ ] "Active"/state badges render as solid-fill pills matching the Design System swatch (or the muted variant is a confirmed, deliberate choice).
- [ ] Layer 1 info strip shows Owner, Workspace ID, **and** Plan.
- [ ] Files/Requests tiles show a delta indicator where the Dashboard file specifies one.
- [ ] Regression suite (`regression-tests/`) still passes after the color/content changes.
