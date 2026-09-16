# design-sync notes

- 2026-09-05: Ran `/design-sync` with the working directory
  `c:\Users\admin\Documents\agent-storage-mcp` completely empty (0 files, no git
  repo, no package.json). Created the Claude Design project `agent-storage-mcp`
  (pinned in config.json) at the user's request, but **no design system was
  imported** — there was no source to convert.
- Shape detection was NOT run and `"shape"` is deliberately absent from
  config.json. The next run must detect it against real source.
- The project is empty and therefore un-anchored (no `_ds_sync.json`), which is
  the documented safe state: the next sync verifies and uploads everything.
- Nearby candidates were checked and rejected as design systems: `ai-shoot`,
  `ai_mobile_app/admin_panel`, `ai_mobile_app/user_web` — all `private: true`
  apps with no library entry point (no `main`/`exports`) and no Storybook. No
  `.storybook/` or `storybook/` config exists anywhere under `Documents`
  (searched to depth 5).
- 2026-09-05 (2nd run): Repo now contains content, but it is a **specification
  package**, not a design system: `Worlflow.md` + `docs/design/00..10-*.md`
  (AgentDisk — serverless AI-agent storage platform). Still NO `package.json`,
  no lockfile, no source, no `dist/`, no `.storybook/`, no `*.stories.*`.
- `/design-sync` therefore cannot run: the converter bundles a repo's compiled
  `dist/`, and nothing here is built. Shape detection remains unrun; `"shape"`
  stays absent from config.json deliberately.
- The design system is SPECIFIED (not built) in:
  - `docs/design/03-ux-architecture-and-screens.md` §7.2 (Design System) — tokens
  - `docs/design/04-claude-design-prompt.md` §"Design System — Build This First"
    — full token set (light+dark) and ~20-component inventory.
  - Fonts specified: Space Grotesk (display), Inter (UI), JetBrains Mono (code).
  - Accent is deep forest green `#2F6F4F` light / `#48A578` dark.
- Repo's own documented intent (00-INDEX.md): hand `04-claude-design-prompt.md`
  to Claude Design directly — i.e. have the agent BUILD the UI, which is a
  different flow from syncing an existing library.
- Pinned project `agent-storage-mcp`
  (d311bfd0-9751-4a9b-84f4-b33e7a09378e) verified this run:
  PROJECT_TYPE_DESIGN_SYSTEM, canEdit=true, still empty/un-anchored.
- 2026-09-05 (3rd run, `--project <pinned url>`): Target re-confirmed (same
  project already pinned). Repo re-checked: STILL 12 .md files, zero code.
- Exhaustive search for a built component library on this machine found NONE:
  - `Documents` depth 7 -> only apps: ai-shoot, ai_mobile_app/{admin_panel,
    user_web,Infrastructure/serverside/workers}, ComfyUI rgthree-comfy plugin.
  - `C:\Users\admin` depth 6 for `.storybook/` or `*.stories.*` -> no matches
    anywhere in the user profile.
  - `OneDrive` depth 6 -> ai-gateway (root/backend/frontend), bc-gaming-platform.
    `ai-gateway/frontend` = private Vite app (Cloudflare Pages deploy target),
    `bc-gaming-platform` = "airdrop-interface" Next.js app. Neither exports a
    library: no `main`/`module`/`types`/`exports`/`files`.
  - Common dev roots (~/source, ~/dev, ~/src, ~/projects, ~/repos, C:\dev,
    C:\src, C:\projects, C:\repos) do not exist. `Documents/GitRepository` empty.
  => No design system exists on this machine to sync. Source must come from
     elsewhere (another machine/drive or a git URL), or be built from the spec.

## 2026-09-05 — Reverse import (Claude Design -> repo)

The design system now EXISTS: it was built inside the Claude Design project
`agent-storage-mcp` (d311bfd0-9751-4a9b-84f4-b33e7a09378e), not in this repo.
Pulled it down into `design-system/` via the claude_design MCP read tools.

- **96 of 97 project files imported, every one byte-identical** to the remote
  (verified file-by-file against `list_files` sizes).
- Not imported: `.thumbnail` (5584 B) — generated binary preview image, and the
  only remote entry absent from the requested file list.
- Layout mirrors the Claude Design project exactly, so paths inside the files
  (`../../styles.css`, `../../_ds_bundle.js`) resolve unchanged.
- Landed in `design-system/` rather than repo root to keep the docs repo clean.
  Doc 07 §18.6 prescribes `apps/web/src/components/` for these components, but
  that monorepo skeleton does not exist yet (no package.json/apps/) — scaffolding
  it is doc 08's Claude Code build job, not this import. Move is trivial later.

### Transfer gotchas (hit these again on any future import)
- MCP `read_file` returns bodies HTML-entity-escaped. Decode `&lt;` and `&gt;`
  FIRST, then `&amp;` last — that order also handles nested `&amp;lt;` correctly.
- Babel/JS sources contain LITERAL `\uXXXX` escape sequences (e.g. `\u2019`,
  `\u2022`, `\u00b7`, `\u2014`, `\u2318`, `\u2026`). Writing them as real
  characters silently shortens the file. Byte-size comparison catches it.
- `sed` on Git Bash MANGLES multibyte characters and eats `\u` in replacements.
  Use a small node script for any non-ASCII substitution.
- The Bash tool fails with "unexpected EOF" on heredocs past roughly 8-10 KB.
  Use the Write tool for large files; assemble very large ones from chunks.
- `_ds_manifest.json` and `_adherence.oxlintrc.json` have NO trailing newline.

### Verified after import
- `node --check _ds_bundle.js` passes.
- `@ds-bundle` header parses: namespace `AgentStorageMcp_d311bf`, 32 components,
  32 sourceHashes — and all 32 referenced .jsx source paths exist locally.
- `_ds_manifest.json` and `_adherence.oxlintrc.json` both parse as valid JSON.
- No stray HTML entities anywhere in the tree.

## 2026-09-05 — UI/UX build complete (Steps 1-5 of UI-UX-PLAN.md)

All 31 buildable screens from doc 03 PART 8 are implemented in `apps/web`.
Backend deliberately untouched, per the user's "finish UI/UX first, sequentially".

### What exists now
- `apps/web` — Vite 6 + React 18.3.1 + react-router-dom. `npm run build` clean,
  81 modules, ~1.3 MB dist. 15 route files, ~3,150 lines of app source.
- `apps/web/src/components/` — vendored copy of the design system (64 .jsx/.d.ts).
  `card.html` previews stay upstream in `design-system/`.
- `apps/web/src/components/index.js` — GENERATED barrel (32 components + iconNames,
  mcpTools, permissionPresets). Regenerate from `_ds_manifest.json`; never hand-edit.
- `design-system/` remains the byte-verified upstream mirror — still 96/96 exact.

### Decisions worth remembering
1. **Docs bend to code, not the reverse.** The spec's forest-green/Space Grotesk
   brand was corrected to the as-built indigo/Public Sans in docs 03 §7.2 and 04.
   The 96 verified design-system files were never touched.
2. **Doc 04 was repurposed.** It used to say "build this design system"; it now
   says "the system exists — bind and compose from it", with the load snippet.
3. **Drawer was a real gap.** §8.10 requires a right-side drawer; the design system
   has none. Built `apps/web/src/components-local/Drawer.jsx` (tokens only, focus
   trap, restores focus, full-screen sheet <768px). **Should be upstreamed into
   the Claude Design system** so the design agent can use it too.
4. **Tooltip and dark mode stay descoped.** `.tip` gives styling but no behaviour;
   dark mode is deliberately absent ("the app itself is never dark").
5. **Docs nav is external** (docs.agentdisk.io) per §8.31 — not an in-app route.
6. `state` props on screens keep every spec'd state (loading / empty / error /
   quota-warn / lockout / no-results) reachable before the API exists. Delete the
   prop when wiring real data.

### Security behaviours built into the UI (doc 06)
- Login failure is generic; 5 failures trigger a visible lockout countdown.
- Forgot-password shows an identical result whether or not the account exists.
- API key + webhook secret both use reveal-once: no dismiss-by-accident, explicit
  acknowledgment required. Masked to last-four everywhere else.
- MCP config snippet defaults to `<YOUR_API_KEY>`; embedding the real key is
  opt-in with visible (not tooltip) warning text.
- Webhook failure detail shows status + truncated body, never headers.
- Bulk delete of >5 items requires typing DELETE.

### Verified
- `npm run build` clean. No raw hex colours, no hardcoded px, no imports bypassing
  the barrel — the three things `_adherence.oxlintrc.json` flags.
- Every sidebar nav item resolves to a real route; workspace index route present.

### NOT done (deliberate)
- No backend. No API client — every screen uses local mock data.
- No automated tests and no browser-rendered visual verification: the screens are
  build-verified and spec-checked, not screenshot-verified.
- `.thumbnail` still not imported (binary, not in the requested file list).

## 2026-09-07 — First write back UP to Claude Design

`components/Modal/Modal.jsx` was fixed in the design system and pushed upstream
via `finalize_plan` + `write_files` (etag `1788566234313045` ->
`1788779763462064`, 1808 -> 2862 bytes). All three copies are byte-identical
again: Claude Design, `design-system/`, `apps/web/src/components/`.

- **`write_files` needs a `plan_token` from this transport.** Calling it bare
  returns "available only through the native Claude Design tool". Declare the
  paths with `finalize_plan` first; it hands back both the token and the current
  `base_etags` to pass as `if_match`.
- **`_ds_bundle.js` was NOT regenerated and is now stale for Modal.** It carries
  a Babel-compiled copy of every component plus a `sourceHashes` map
  (`components/Modal/Modal.jsx` -> `49ddc570606a`, computed by Claude Design's
  build, not reproducible here). Hand-editing it would produce a bundle whose
  declared hash disagrees with its own contents, which is worse than a stale
  one. Nothing in `apps/web` reads the bundle — the app imports the .jsx sources
  through `src/components/index.js` — so only the Claude Design preview surface
  still runs the old Modal, until the project rebuilds.
- **Every design-system `.jsx` is pure ASCII.** Verified across all 32 before
  writing; the fix keeps that, which also sidesteps the entity/escape mangling
  recorded above. Match it in anything written upstream.
