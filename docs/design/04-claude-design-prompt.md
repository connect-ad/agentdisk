# Claude Design — Standalone Build Prompt for AgentDisk
### PART 9 of the AgentStorage-Inspired Platform Design

*This file is meant to be copy-pasted directly into Claude Design as-is. It is self-contained — it does not assume Claude Design has read the other documents in this set, though it is derived from and consistent with `03-ux-architecture-and-screens.md`.*

---

## Prompt

You are designing the complete UI for **AgentDisk**, a serverless file-storage platform built specifically for AI agents. It gives every AI agent a scoped, persistent workspace for files, folders, and structured metadata, accessed over a REST API and an MCP (Model Context Protocol) server. Humans manage it through a web dashboard. Think "S3 meets a developer dashboard, purpose-built for AI agents" — not a consumer file-sharing app, not an enterprise content-management suite.

**Audience:** primarily individual AI developers and small technical teams. The product should feel like it was built by and for people who live in terminals and IDEs, but who still want a clean, fast, trustworthy web UI for the 10% of the time they're not in the API.

**Tone:** modern, technical, trustworthy, clean, minimal, professional. Not playful, not enterprise-corporate, not consumer-cute. Think Linear, Vercel, Cloudflare's own dashboard, Stripe's dashboard — that register, not Notion or Dropbox's.

**Do not copy any existing product's visual design**, including agentstorage.ai (a smaller competitor in this space) or any of the products named below. This is an original visual system.

### Design Principles (apply to every screen)

1. Developer-grade, not toy-grade: monospace for literal data (keys, paths, hashes, JSON, IDs); generous whitespace but nothing decorative that wastes vertical space a developer wants full of real data.
2. The dashboard is a viewer onto ground truth an API also exposes — no dashboard-only state, no screen that implies capability the API doesn't have.
3. Destructive actions are never a single click. Delete/revoke/disconnect always confirm; bulk-destructive actions (more than 5 items) require typing the resource name to confirm.
4. Secrets (API keys) are shown in full exactly once, at creation, in a distinct non-dismissible-by-accident modal, then permanently masked to a last-four everywhere else.
5. Empty states teach: every empty state shows the exact next action or snippet to fill it, not just an icon and a vague sentence.
6. Errors are actionable: every error names what happened, why, and the concrete next step. Never show a bare HTTP status code to a human.

### Design System — Already Built. Use It. Do Not Rebuild It.

> **Corrected 2026-09-05.** When this prompt was first written, no design system
> existed and this section asked Claude Design to build one. It has since been
> built. This section now describes the system **as it exists** and instructs you
> to compose from it. Two things changed from the original draft: the accent is
> **deep indigo**, not forest green, and the sans is **Public Sans**, not Space
> Grotesk + Inter. The built system is the source of truth.

The AgentDisk design system is a Claude Design design system:

- Project: **`agent-storage-mcp`** — `d311bfd0-9751-4a9b-84f4-b33e7a09378e`
- 32 components on `window.AgentStorageMcp_d311bf`, 98 CSS tokens, 26 preview cards.

Bind it to your project and load it once:

```html
<link rel="stylesheet" href="_ds/<folder>/styles.css">
<script src="_ds/<folder>/_ds_bundle.js"></script>
```

```js
const { AppShell, PageHead, Panel, DataTable, Button, FileCell } = window.AgentStorageMcp_d311bf;
```

**Rules, not suggestions**

1. Compose screens from these components. Do not re-implement a Button, a Table, or a Modal.
2. Style only with `var(--*)` tokens from the linked stylesheet. **No raw hex. No hardcoded px.** Both are lint errors — see `_adherence.oxlintrc.json`, which also forbids importing component internals (import from `index.js`).
3. Do not invent colours, type, spacing, or components not grounded in the system.

**Visual direction** — infrastructure-grade, not consumer-grade: a light cool-neutral
ground, hairline rules instead of shadows, small radii (3–8px), dense 13–14px type,
and exactly one accent. A single dark surface exists for code and config; **the app
itself is never dark.**

**Typography** — **Public Sans** (`--font-sans`) for anything a person wrote.
**JetBrains Mono** (`--font-mono`) for anything a machine reads or a user must copy
exactly: keys, paths, scopes, endpoints, MIME types, agent slugs, event names. This
split is a rule — it is how a human tells an agent's actions from their own.
Scale `--t-10` … `--t-52`, base 14px.

**Colour** — all `oklch()`, cool neutrals at hue 262, one accent:

```
--paper --surface --surface-2 --surface-3          page ground → pressed
--line --line-2 --line-3                           hairline → strong edge
--ink --ink-2 --ink-3 --ink-4                      heading → disabled
--accent --accent-hover --accent-active            deep indigo oklch(0.475 0.168 262)
--accent-ink --accent-soft --accent-soft-2         links, selected nav, agent chip
--accent-line --on-accent                          tinted border, text on accent
--ok --warn --danger  (+ -soft / -line tints)      status; ALWAYS paired with a word
--dark --dark-2 --dark-ink --dark-accent …         code and config surfaces ONLY
```

Indigo means "the system did this on your behalf" — primary actions, active nav,
anything an agent touched. Never decorative. Colour never carries meaning alone.

**Space / radius / elevation / motion** — space `--s-1`…`--s-13` on a 4px base;
radius `--r-1` 3px chips · `--r-2` 5px controls · `--r-3` 8px panels · `--r-4` 12px
modals; shadows `--sh-1`…`--sh-4` only for things that genuinely float; motion
`--d-1` 90ms · `--d-2` 150ms · `--d-3` 240ms. Layout: `--nav-w` 236px,
`--topbar-h` 52px, `--measure` 68ch.

**The 32 components**

*Primitives* — `Icon` (44 glyphs), `Button`, `IconButton`, `Input`, `Select`,
`Checkbox` (pass `radio` for a radio), `Switch`, `Badge`, `Skeleton`.

*Structure* — `AppShell` (sidebar nav + workspace switcher + sticky top bar +
mobile drawer), `PageHead`, `Panel`, `DataTable`, `StatTile`, `Meter`, `Tabs`,
`Breadcrumb`, `Menu`.

*Feedback* — `Alert`, `Toast`, `Modal`, `ConfirmModal`, `EmptyState`.

*Developer* — `CodeBlock`.

*AgentDisk-specific — these carry the product thesis, use them* — `FileCell`,
`AgentCard`, `ApiKeyDisplay`, `PermissionSelector`, `UploadDropzone`,
`UploadItem`, `McpToolList`, `ActivityRow`.

Note the renames from the original draft: **Card → `Panel`**, **Progress Bar →
`Meter`**, **Radio → `Checkbox radio`**.

**Not in the library — handle explicitly**

- **Drawer** — does not exist. §8.10 File Details was specced as a right-side drawer; either build one or use `Modal`. Decide before designing that screen.
- **Tooltip** — a `.tip` CSS class exists for styling, but there is no positioning/trigger component.
- **Dark mode** — not supported and deliberately descoped. Do not add a light/dark toggle. The `--dark-*` tokens are for code/config surfaces only.

### Global Layout / Navigation

Authenticated shell: left sidebar (240px desktop, collapses to a 64px icon rail on tablet, becomes a bottom-sheet triggered by a hamburger on mobile) containing, top to bottom: a workspace switcher (dropdown showing workspace name + plan badge), then nav items **Overview, Files, Agents, API Keys, MCP, Webhooks, Usage, Activity** (Webhooks and Activity are MVP-1 — hide them until those features exist rather than showing a dead link), then a divider, then **Settings** (expandable: General, Members, Security, Billing), then a divider, then an external-link "Docs ↗". Top bar (inside the main content area, not the sidebar) holds breadcrumb/page title on the left and an account menu (avatar) on the right containing Profile, "Create workspace," theme toggle, Log out.

Unauthenticated shell (landing, pricing, auth screens): simple sticky top nav — logo left, "Docs / Pricing / Sign in" center-right, a prominent "Get started" button far right.

### Responsive Rules (apply everywhere)
- Desktop ≥1280px: sidebar open, content max-width 1120px centered.
- Tablet 768–1279px: sidebar as icon rail; tables drop secondary columns behind a row-expand chevron.
- Mobile <768px: sidebar as bottom-sheet; tables become stacked cards; primary page actions move to a sticky bottom action bar; drag-and-drop upload zones still work but pair with a visible tap-to-upload button.

### Accessibility Rules (apply everywhere)
WCAG 2.1 AA. Minimum 4.5:1 text contrast in both color modes. Full keyboard operability — tab order matches visual order, modals/drawers trap focus and restore it to the trigger on close, Esc closes any overlay. Visible 2px focus ring using `--accent`, offset from the element. Every icon-only control has `aria-label`. Every form field has a real `<label>`, not a placeholder standing in for one. Toasts and live status text use `aria-live="polite"`; error banners use `role="alert"`. Status is never color-only — always paired with text or an icon+text combination (e.g., a colored dot next to the word "Active", not the dot alone).

### Screens to Design — Build Every One, With Every State Listed

For each screen below, produce: the default/populated state, loading state (skeleton, matching real layout), empty state (with its exact copy), and error state, plus any screen-specific states called out. Use the exact microcopy given — do not invent placeholder text, do not leave "TODO" or "Lorem ipsum" anywhere.

**1. Landing (`/`)** — Sticky nav → Hero with H1 "Persistent storage your agents can actually use." and subhead "Files, folders, and metadata for AI agents — over REST and MCP. Scoped credentials, predictable pricing, zero servers to run." with primary CTA "Start building free" and secondary "Read the docs", next to a tabbed code block (REST / MCP / Python / TypeScript, switch without reload) showing a real-looking request/response pair → 3-up "Built for agents" feature strip → 3-step "How it works" (numbered: "1. Create a workspace" / "2. Get a scoped API key" / "3. Your agent reads and writes files") → 6-card use-case grid ("Agent memory & journals", "Content pipelines", "Automation artifacts", "Human-in-the-loop approvals", "Multi-agent access control", "Webhook-driven workflows") → 3-card pricing teaser linking to Pricing → final CTA band "No credit card. No servers. Just an API key." with button "Create a free workspace" → footer (Product / Resources / Legal / Social columns). Mobile: feature strip and use-case grid collapse to 1 column; code block stacks request above response.

**2. Pricing (`/pricing`)** — Header "Simple, hard-capped pricing", "You'll never get a surprise bill." → monthly/annual toggle → 3 plan cards (Free / Pro "Most popular" / Team) each with price, a short limit list, and a CTA ("Start free" / "Start free trial" / "Talk to us") → expandable full comparison table → FAQ accordion (at minimum: "What happens if I hit a limit?", "Can I change plans anytime?", "Is there a free tier forever?", "How is storage measured?", "Do you charge for egress?") → final CTA band.

**3. Signup (`/signup`)** — Centered card ≤400px. H1 "Create your workspace". Email input, password input (show/hide toggle + strength meter with helper text "At least 8 characters, with a number or symbol."), primary button "Create account" (loading: "Creating account…"), divider "or", GitHub OAuth button (omit entirely rather than disabled — do not show a dead control), footer link "Already have an account? Sign in", legal line "By continuing, you agree to the Terms of Service and Privacy Policy." with both as links. Error states inline above the form: "That email is already registered. [Sign in instead]", "Please enter a valid email address.", "Password must be at least 8 characters."

**4. Email Verification (`/verify-email`)** — Centered card, envelope icon, H1 "Check your inbox", body "We sent a verification link to **{email}**. Click it to activate your workspace.", button "Resend email" (60s cooldown showing "Resend in {n}s"), footer "Wrong email? [Start over]". Expired-link variant: "This link has expired. Verification links are valid for 24 hours." with "Send a new link".

**5. Forgot Password (`/forgot-password`)** — Centered card, H1 "Reset your password", email input, button "Send reset link" (loading "Sending…"). Success state is identical whether or not the account exists: "If an account exists for **{email}**, we've sent a password reset link." Footer "[Back to sign in]".

**6. Reset Password (`/reset-password`)** — Centered card, H1 "Set a new password", new-password + confirm-password inputs with inline mismatch validation, button "Update password". Invalid/expired token state replaces the form: "This reset link is invalid or has expired." → "Request a new link".

**7. Login (`/login`)** — Mirrors Signup layout. H1 "Sign in", email + password, "Forgot password?" link, button "Sign in" (loading "Signing in…"), OAuth divider (GitHub, MVP-1+), footer link to Signup. Generic failure message only (never reveal which field was wrong): "That email or password isn't right. [Forgot password?]". After 5 failed attempts in 15 minutes, a lockout state with countdown: "Too many attempts. Try again in {mm:ss}, or [reset your password]."

**8. Dashboard / Overview (`/w/{workspace}`)** — Page header shows workspace name + plan badge. Four stat tiles in a row ("Storage used", "Files", "Agents", "Requests this month"), each a clickable card with a value, a thin quota bar underneath (colors shift default→amber at 80%→red at 95%), and a hover tooltip with exact numbers. Below: a "Recent files" table (last 10). If the workspace has zero files, replace the table with a Quick-start panel: headline "Nothing here yet", body "Create your first agent and give it a key, or drop a file in below.", primary button "Create an agent", secondary "Upload a file". At ≥95% of any quota, show an inline warning under that tile: "You're at {pct}% of your {plan} plan storage. [Upgrade]".

**9. File Browser (`/w/{workspace}/files/...`)** — Breadcrumb trail → toolbar (Upload button, New folder button, search input, grid/list toggle, sort dropdown) → content area: folders listed before files, each row shows type icon, name, size, modified date, created-by badge (agent icon+name or user avatar+name), kebab menu (Open, Rename, Move, Download, Copy link, Delete). Drag-and-drop anywhere in the content area shows a full-area highlight overlay on drag-enter. Checkbox column enables multi-select and a sticky bulk-action bar (Move, Download as zip, Delete). Clicking a file row opens a right-side Drawer (see screen 10) without navigating away. Empty folder: "This folder is empty" / "Drag files here, or" → "Upload files". Uploading shows per-file progress rows at the top of the list ("{fileName} — {pct}%"), replaced on success by the real row, or on failure by an error row "{fileName} — Upload failed. [Retry]". New Folder is a small modal: "New folder" / field "Folder name" / button "Create folder". Delete confirm (single item): "Delete **{fileName}**? This can't be undone." Bulk delete >5 items requires typing DELETE to enable the confirm button. Search-no-results: "No files match \"{query}\"". Mobile: table becomes stacked cards with a thumbnail/icon, name, size+date, and kebab menu; bulk bar sticks to the bottom; add a floating "+" upload button.

**10. File Details Drawer** (opens from File Browser, not a separate route) — Preview pane at top (image thumbnail / text snippet / generic type icon when unsupported, with "Preview not available for this file type" + Download button), then a metadata list ("Path", "Size", "Type", "Checksum (SHA-256)" in monospace with a copy icon, "Created by", "Last modified"), an inline-editable caption field (placeholder "Add a caption…", saves on blur with a small 2-second "Saved" fade — not a toast), a tag chip-input (placeholder "Add tags…"), and an actions row (Download, Copy signed link, Move, Rename, Delete). "Copy signed link" opens a small popover with expiry choices: "Expires in 1 hour", "Expires in 24 hours", "Expires in 7 days", "Permanent (revocable)". On mobile this becomes a full-screen sheet, not a side drawer.

**11. Agents List (`/w/{workspace}/agents`)** — Toolbar with "Create agent" button and search → table (name, status badge "Active"/"Disabled", key count, last active, kebab menu). Empty: "No agents yet" / "Agents are the identities your AI systems use to access storage." → "Create an agent". Create is a modal: "Create an agent" / field "Name" (placeholder "e.g. research-bot") / optional "Description" / button "Create agent" — on success, redirect straight into the Create API Key flow with a banner: "**{agentName}** created. Give it an API key to let it connect." Delete blocked while active keys exist: "This agent has {n} active API key(s). Revoke them first, or [delete anyway] to revoke and delete together."

**12. Agent Details (`/w/{workspace}/agents/{id}`)** — Header with name, an active/disabled toggle, edit/delete actions. Tabs: Overview (recent activity summary + inline keys list), Keys (full table + create), Activity (filtered audit log for this agent, MVP-1). Disabling shows a confirm: "Disable **{agentName}**? All of its API keys will stop working immediately."

**13. API Keys (`/w/{workspace}/keys`)** — Toolbar "Create key" → table (name, agent, key prefix + last four e.g. `ask_live_••••3f2a`, scope chip like "Read+Write · /projects/*", created, last used, expires, kebab menu). Empty: "No API keys yet" → "Create your first key". Create modal: "Create API key" / fields "Name", "Agent" (select), "Permissions" (checkboxes Read/Write/Delete/List), "Restrict to path" (optional, placeholder "/projects/demo/*"), "Expires" (Never / 30 days / 90 days / Custom) / button "Create key". On submit, transition to a distinct **Reveal-once modal** (not dismissible via backdrop click or Esc, only via the explicit acknowledgment): headline "Your API key", warning text "Copy this now — you won't be able to see it again.", a monospace key block with a "Copy" button (focus lands here automatically), and an "I've copied my key" button that's the only way to close it. Revoke confirm: "Revoke **{keyName}**? Any agent using this key will immediately lose access." Revoke success toast: "Key revoked".

**14. MCP Connection (`/w/{workspace}/mcp`)** — Status banner reflecting connection state ("No MCP connection yet" → CTA "Create an MCP-scoped key", or "Connected" with last-call timestamp). "Connect your agent" panel with client tabs (Claude Desktop / Claude Code / Cursor / Generic MCP client) each showing a ready-to-paste JSON config in a Code Block; a checkbox "Include my API key in this snippet" (off by default) with adjacent warning text "Your key will be visible in this snippet. Don't paste it anywhere public." toggles between a placeholder `<YOUR_API_KEY>` and the real key. Below: an "Available tools" reference table (Tool, Description, Requires-scope columns) and a "Recent MCP calls" mini-log (empty: "No MCP calls yet. Once your agent connects, you'll see activity here.").

**14a. Webhooks (`/w/{workspace}/webhooks`, MVP-1)** — Toolbar "Add endpoint" → table (URL, subscribed-event chips, status badge "Active"/"Failing", last delivery + result icon, kebab menu: Send test event / Edit / Rotate secret / Delete). Empty: "No webhooks yet" / "Get notified when files change — useful for triggering downstream automation." → "Add endpoint". Create modal: "Add webhook endpoint" / fields "URL" (placeholder "https://your-service.com/webhooks/agentdisk"), "Events" (checklist) → on save, the same reveal-once modal pattern as screen 13's API key ("Your signing secret" / "Copy this now — you won't be able to see it again..." / acknowledgment button "I've copied my secret"). A "Failing" row (3+ consecutive failures) shows an inline "View recent failures" expansion. Delete confirm: "Delete this webhook endpoint? AgentDisk will stop sending events to **{url}**."

**15. Usage (`/w/{workspace}/usage`)** — Plan summary card with "Upgrade" CTA → four quota bars ("Storage — {used} of {limit}", "Assets — {used} of {limit}", "Egress this period — {used} of {limit}", "Requests this period — {used} of {limit}") each with "Resets in {n} days" and default→amber(80%)→red(95%) coloring; at 100%, an explicit banner: "You've reached your {metric} limit for the {plan} plan." → "Upgrade plan". MVP-1 adds a 30-day line chart per metric below the bars.

**16. Activity / Audit Log (`/w/{workspace}/activity`, MVP-1)** — Filter bar (actor: human/agent/all; action type; date range) → table (timestamp, actor badge, action, resource, result badge "Allowed"/"Denied"). Row click expands inline to show IP, client string, request ID. Empty (no events ever): "No activity yet. Actions your team and agents take will show up here." Empty (filtered): "No events match your filters." → "Clear filters".

**17. Settings → General (`/w/{workspace}/settings`)** — Workspace name field, workspace ID display (read-only, monospace, copyable — not an editable "slug," to avoid breaking API-facing URLs), a visually distinct bordered "Danger zone" card containing "Delete this workspace" with body "This permanently deletes all files, agents, and API keys in **{workspaceName}**. This cannot be undone." and a confirm input "Type {workspaceName} to confirm" gating a disabled-until-match "Delete workspace" button.

**18. Settings → Members (MVP-1)** — Table (member, role, joined, actions) → "Invite member" (email + role select, each role with a one-line description, e.g. "Member: can manage files and agents, can't manage billing or delete the workspace") → pending invites sub-list. Last-owner protection: "A workspace needs at least one owner. Promote someone else first."

**19. Settings → Security** — Password change form → "Active sessions" list (device/browser, approximate location, last active, per-row "Sign out", plus "Sign out all other sessions" with confirm "This will sign you out everywhere except this device.") → SSO placeholder card (disabled, "Available on Team plan.") for MVP-1+.

**20. Settings → Privacy (MVP-1)** — A rendered (not just linked) plain-language summary of what's stored and which sub-processors data is sent to → "Export my data" button (on click: "We're preparing your export. We'll email you a download link within 24 hours.") → "Delete my account" (blocked state if sole owner of other workspaces: "You're the only owner of {n} workspace(s). Transfer ownership or delete those workspaces first.").

**21. Settings → Billing (MVP-1)** — Current plan card + "Manage billing" (opens external Stripe portal) → invoice history table → inline plan comparison. No-payment-method state: "Add a payment method to upgrade". Over-limit downgrade confirm: "Your current usage exceeds the {plan} plan's limits. You can downgrade, but new uploads will be blocked until you're back under the limit."

**22. Profile (`/account/profile`)** — Avatar, name, email (change requires re-verification, note: "We'll send a verification link to your new email. Your current email stays active until you confirm."), connected OAuth accounts list (MVP-1).

**23. 404** — Centered, minimal. "404 — We couldn't find that page." → "Go to dashboard" (or "Go home" if signed out).

**24. 403** — "403 — You don't have access to this." / "You might not be a member of this workspace, or your role doesn't allow this action." → "Back to dashboard".

**25. 500** — "Something went wrong on our end." / "We've logged this and we're looking into it. Try again in a moment." → "Retry" (add "Status page ↗" once a status page exists).

**26. Maintenance (MVP-1+)** — "We're doing quick maintenance." / "AgentDisk will be back in a few minutes. Your data isn't affected."

### Explicit Non-Goals for This Design Pass
Do not design: a standalone "Workspaces" list page (a switcher dropdown in the sidebar covers this until usage data justifies more), in-app documentation pages (docs live on a separate generated docs site), or a multi-step onboarding tour/wizard (the Dashboard's Quick-start panel and File Browser's empty states cover first-run guidance inline).

### Deliverable
A complete, consistent design system plus every screen above in its default, loading, empty, and error states at desktop, tablet, and mobile breakpoints, using the exact copy given. Where a decision isn't specified above, make the most consistent, developer-tool-appropriate choice and note the assumption rather than leaving a placeholder.
