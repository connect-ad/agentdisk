# AgentDisk — UX Architecture & Complete Screen Specification
### PART 7–8 of the AgentStorage-Inspired Platform Design

All content in this document is **PROPOSAL** (original design work, not derived from AgentStorage's visual design — see PART 2 for why: AgentStorage's own UI was not deeply analyzable beyond three routes, and the brief explicitly asks us not to copy it).

---

## PART 7 — UX Architecture

### 7.1 Design Principles

1. **Developer-grade, not toy-grade.** Monospace where data is literal (keys, paths, hashes, JSON). Generous but not wasteful whitespace. No illustration-heavy empty states that waste vertical space a developer wants full of data.
2. **The dashboard is a viewer onto ground truth the API also sees.** Every screen a human sees, an agent could in principle reconstruct via the API — no dashboard-only state.
3. **Destructive actions are never one click.** Delete, revoke, and disconnect always confirm; bulk-destructive actions require typing the resource name.
4. **Secrets are shown once, never again.** API keys are displayed in full exactly once, at creation, then permanently masked to a last-four.
5. **Empty states teach, not decorate.** Every empty state shows the exact command/snippet to fill it, not just an icon and a sentence.
6. **Errors are actionable.** Every error message names what happened, why, and the next concrete step — never a bare status code.

### 7.2 Design System

**Typography**
- Display / headings: **Space Grotesk** (geometric, technical, distinct from AgentStorage's Syne — deliberately different) — weights 500/600/700.
- Body / UI: **Inter** — weights 400/500/600.
- Monospace (code, keys, paths, IDs, JSON, logs): **JetBrains Mono** — weight 400/500.
- Scale: 12 / 13 / 14 (base) / 16 / 18 / 22 / 28 / 36 / 48px, 1.5 line-height for body, 1.2 for headings.

**Color — light mode base tokens**

| Token | Value | Use |
|---|---|---|
| `--bg` | `#FAFAF9` | page background |
| `--surface` | `#FFFFFF` | cards, panels |
| `--surface-raised` | `#FFFFFF` + shadow-sm | modals, dropdowns |
| `--border` | `#E4E4E1` | default border |
| `--border-strong` | `#CFCFCB` | input focus-adjacent, table headers |
| `--text-primary` | `#16160F` | headings, body |
| `--text-secondary` | `#5A5A54` | captions, metadata |
| `--text-tertiary` | `#8B8B84` | placeholders, disabled |
| `--accent` | `#2F6F4F` (deep forest green) | primary actions, links, focus ring |
| `--accent-hover` | `#255A40` | |
| `--accent-subtle` | `#E7F0EA` | selected rows, subtle highlight |
| `--warning` | `#B8752B` | quota-nearing, expiring |
| `--danger` | `#B23B3B` | destructive, errors |
| `--danger-subtle` | `#F7E7E5` | error banners |
| `--success` | `#2F6F4F` | success toasts |
| `--radius` | 8px controls, 12px cards, 6px chips | |
| `--shadow-sm` | `0 1px 2px rgba(0,0,0,.06)` | |
| `--shadow-md` | `0 4px 16px rgba(0,0,0,.08)` | |

Dark mode inverts surfaces to `#131311` / `#1B1B18` / `#242420`, text to `#F2F2EE` / `#B7B7AF` / `#7C7C74`, and shifts accent to a slightly brighter `#48A578` for sufficient contrast on dark surfaces. Accent hue (green) chosen deliberately distinct from AgentStorage's unknown/unverified palette and from generic SaaS-blue — signals "storage/persistence, calm and trustworthy" without copying any researched competitor.

**Why not AgentStorage's palette:** we could not reliably determine AgentStorage's exact production color values from research (only fonts were confirmed: Syne/IBM Plex Sans/IBM Plex Mono), and were instructed not to copy it regardless — the palette above is original.

**Core components** (built once in the design system, reused everywhere): Button (primary/secondary/ghost/danger × sm/md × icon-leading/trailing × loading state), Input (text/number/search, with leading icon slot, inline validation message slot), Select (native-feeling custom dropdown, searchable variant for long lists), Checkbox/Radio/Switch, Table (sticky header, sortable columns, row-hover actions, empty/loading/error slots built in, not bolted on per-screen), Card, Modal (sm/md/lg, focus-trapped), Drawer (right-side, for file details), Toast (top-right stack, 4 variants, auto-dismiss 5s except danger which persists until dismissed), Alert/Banner (inline, 4 variants), Badge/Chip (status, tag), Tabs, Breadcrumb, Tooltip, Skeleton (row/card/text variants matching real layout dimensions, never a generic spinner for list content), Empty State (icon + headline + body + primary action), Code Block (copy button, syntax highlight for JSON/bash/TS/Python), Progress Bar (upload, quota meters — quota meters shift color border→warning→danger at 80%/95%).

### 7.3 Navigation & Information Architecture

Top-level sidebar nav (persists across all authenticated screens), scoped to the currently-selected workspace via a workspace switcher pinned above it:

```
[Workspace switcher ▾]
─────────────────────
  Overview
  Files
  Agent identities
  API Keys
  MCP
  Webhooks           (MVP-1)
  Usage
  Activity           (MVP-1)
─────────────────────
  Settings
    General
    Members           (MVP-1)
    Security
    Billing            (MVP-1)
─────────────────────
  Docs ↗ (external)
```

**URL scheme.** Every screen header below writes its URL as `/w/{workspaceId}/…`; the dashboard actually addresses a workspace by a **readable slug** derived from its name (`/w/my-workspace/files`), with the raw `ws_…` ID still resolving and redirecting to the slug so older links keep working. The ID is unchanged everywhere it is genuinely needed — API calls, MCP config snippets, the Dashboard ID chip and Settings → Workspace ID — because the slug is an address, not an identifier. `CLAUDE.md` carries the invariants that make the two impossible to confuse. A `/w/{segment}` that names nothing the signed-in person can reach renders the 404 of 8.27 instead of the workspace shell — a workspace that does not exist and one they are not a member of are answered identically, so the URL cannot be used to confirm that somebody else's workspace exists.

**MVP-0 nav** hides Webhooks, Activity, Members, and Billing (features not yet built) — the sidebar renders conditionally on feature flags per plan/build stage, not as dead links. "Docs" links to the public docs site in a new tab. A single account-level menu (avatar, top-right) holds Profile, "Create workspace," and Log out.

**Determination of which nav items exist in MVP:** Dashboard/Overview, Files, Agents, API Keys, Usage, Settings/General, Settings/Security → MVP-0. MCP, Webhooks, Activity, Members, Billing → MVP-1. (The brief's candidate list also included a standalone top-level "Workspaces" item and "Documentation" as a nav item; we fold "Workspaces" into the switcher rather than a full page — with one workspace per solo dev in MVP-0, a full page is premature — and keep Docs as an external link rather than an in-app page, since docs content is generated from the OpenAPI/MCP schema and lives on its own subdomain, PART 18.)

### 7.4 Responsive Behavior (applies to all screens unless noted)

- **Desktop** (≥1280px): sidebar fixed-open (240px), main content max-width 1120px centered with padding, tables show all columns.
- **Tablet** (768–1279px): sidebar collapses to icon rail (64px), expandable on hover/tap; tables drop secondary columns (e.g., checksum, created-by) behind a row-expand chevron.
- **Mobile** (<768px): sidebar becomes a bottom-sheet triggered by a hamburger in the top bar; tables become stacked cards (one card per file/agent/key); primary actions move to a sticky bottom action bar. File upload and file browsing remain fully functional on mobile (drag-drop degrades to a tap-to-pick file input); bulk multi-select is available but optimized for fewer simultaneous selections.

### 7.5 Accessibility Baseline (applies to all screens)

WCAG 2.1 AA target: 4.5:1 text contrast minimum (verified for both color modes above), full keyboard operability (tab order follows visual order, modals trap focus and return it on close, Esc closes modals/drawers/dropdowns), visible focus rings using `--accent` at 2px offset, all icon-only buttons carry `aria-label`, all form fields have associated `<label>` (not placeholder-only), live regions (`aria-live="polite"`) for toast notifications and upload-progress updates, skip-to-content link on every authenticated page, and no color-only status signaling (status always paired with text/icon, e.g. a green dot is always accompanied by the word "Active").

---

## PART 8 — Complete Screen Specification

*Each screen follows: Purpose / URL / Layout / Components / Interactions / States / Responsive / Accessibility / Exact copy. MVP phase is noted per screen.*

### 8.1 Landing Page — MVP-0
**Purpose:** Convert a developer landing from search/HN/socials into a signup within one scroll.
**URL:** `/`
**Layout:** Sticky top nav (logo, Docs, Pricing, Sign in, "Get started" button) → Hero (headline, subhead, two CTAs, a live-feeling code snippet showing a curl call and its JSON response side-by-side) → "Built for agents" 3-column feature strip (REST, MCP, Scoped keys) → "How it works" 3-step diagram (Create workspace → Get scoped key → Agent reads/writes) → Use-case grid (6 cards, mirroring validated use cases from PART 2/3: agent memory, content pipelines, automation artifacts, human-in-the-loop approvals, multi-agent sub-keys, webhook automation) → Pricing teaser (3 cards, link to full Pricing) → Final CTA band → Footer (product, resources, legal, socials).
**Components:** Nav, Button, Code Block (auto-cycling between REST/MCP/curl tabs), Card ×9, Footer.
**Interactions:** Code block tab-switcher (REST/MCP/Python/TypeScript) with no page reload; hovering a use-case card reveals a one-line "what it replaces" note.
**States:** Static marketing page — only loading state is initial code-block tab render (skeleton, 200ms max).
**Responsive:** Feature strip and use-case grid collapse 3→2→1 columns at tablet/mobile; code block becomes vertically stacked (request above response) below 640px.
**Accessibility:** Code tabs are a proper ARIA tablist; hero heading is a single `<h1>`.
**Exact copy:**
- H1: "Persistent storage your agents can actually use."
- Subhead: "Files, folders, and metadata for AI agents — over REST and MCP. Scoped credentials, predictable pricing, zero servers to run."
- Primary CTA: "Start building free" · Secondary CTA: "Read the docs"
- How-it-works steps: "1. Create a workspace" / "2. Get a scoped API key" / "3. Your agent reads and writes files"
- Use-case card titles: "Agent memory & journals", "Content pipelines", "Automation artifacts", "Human-in-the-loop approvals", "Multi-agent access control", "Webhook-driven workflows"
- Final CTA band: "No credit card. No servers. Just an API key." → "Create a free workspace"

### 8.2 Pricing — MVP-0 (page ships MVP-0; Team tier features referenced on it may say "coming soon" until MVP-1)
**URL:** `/pricing`
**Layout:** Header + 3-column plan cards (Free / Pro / Team, "Pro" marked "Most popular") → comparison table (expandable "Compare all features") → FAQ accordion → CTA band.
**Components:** Card, Table, Accordion, Badge ("Most popular").
**Interactions:** Monthly/Annual billing toggle (annual shows "2 months free" badge) — toggle is inert/decorative pre-billing-launch and clearly labeled "Annual billing available at launch" if MVP-0 ships before Stripe.
**States:** n/a (static, save for the billing toggle).
**Responsive:** 3 cards stack vertically on mobile, comparison table becomes a per-plan accordion.
**Accessibility:** Plan cards are a `<fieldset>`/`<legend>` semantic group even though not literally a form; toggle is a proper switch with `aria-checked`.
**Exact copy:**
- Section eyebrow: "Simple, hard-capped pricing"
- Section head: "You'll never get a surprise bill." / Sub: "Every plan has clear limits. Hit one, and you'll get a friendly heads-up — never an unexpected charge."
- Plan card CTAs: Free → "Start free", Pro → "Start free trial", Team → "Talk to us" (until self-serve Team checkout ships) or "Start free trial" (once it does)
- FAQ entries include at minimum: "What happens if I hit a limit?", "Can I change plans anytime?", "Is there a free tier forever?", "How is storage measured?", "Do you charge for egress?"

**Superseded note on §8.3–8.7 (Sept 2026):** these five screens' visual layout, copy, and states below are unchanged and still the target design, but the *implementation* behind them moved to Firebase Authentication — see `16-firebase-auth-and-final-launch-prompt.md` PART 30. Concretely: Google and GitHub sign-in ship in MVP-0 alongside email (not staged across MVP-0/1/V2 as originally sequenced, since Firebase makes all of them equally cheap), Forgot Password/Reset Password (§8.5/8.6) are Firebase's hosted or SDK-driven flows rather than a first-party `/forgot-password` endpoint, and Email Verification (§8.4) is Firebase's own verification-email flow. The screens are still AgentDisk-branded (Firebase's UI is embedded/styled to match, not a redirect to a generic Firebase-branded page) — only the backend issuing and verifying the credentials changed.

### 8.3 Signup — MVP-0
**URL:** `/signup`
**Layout:** Centered single-column card (max 400px) on a subtly branded background; logo above card.
**Components:** Input (email), Input (password, show/hide toggle, strength meter), Button (primary, full-width), Divider "or", OAuth buttons for **Google and GitHub** (both ship MVP-0 via Firebase — see the superseded note above), link to Login.
**Interactions:** Inline email-format validation on blur; password strength meter updates live; submit disables the button and shows an inline spinner; successful submit redirects to Email Verification screen.
**States:** Default → Validating → Submitting (button spinner, form disabled) → Error (inline banner above form) → Success (redirect).
**Responsive:** Card remains centered and full-width-minus-margin on mobile; no layout change needed below 400px besides padding.
**Accessibility:** Password field has a visible, not just placeholder, label; strength meter has `aria-live="polite"` text equivalent ("Weak", "Good", "Strong"); error banner is `role="alert"`.
**Exact copy:**
- H1: "Create your workspace"
- Field labels: "Email" / "Password"
- Password helper text: "At least 8 characters, with a number or symbol."
- Submit button: "Create account" (loading: "Creating account…")
- Footer link: "Already have an account? Sign in"
- Legal line under button: "By continuing, you agree to the Terms of Service and Privacy Policy." (both linked)
- Error examples: "That email is already registered. [Sign in instead]" · "Please enter a valid email address." · "Password must be at least 8 characters."

### 8.4 Email Verification — MVP-0
**URL:** `/verify-email`
**Layout:** Centered card, icon (envelope), headline, body, resend action, "change email" link.
**Components:** Button (secondary, "Resend email"), countdown label.
**Interactions:** Resend is rate-limited (60s cooldown, button shows countdown "Resend in 43s"); clicking the emailed link completes verification and auto-redirects to Dashboard with a welcome toast.
**States:** Waiting (default) → Resent (toast "Verification email sent") → Resend rate-limited (countdown) → Verified (auto-redirect) → Expired-link (if user clicks an old link: dedicated inline message with a fresh "Send a new link" action).
**Responsive:** No structural change; single column at all widths.
**Accessibility:** Countdown announced via `aria-live="polite"` at most once per 10s (not every second, to avoid screen-reader spam).
**Exact copy:**
- H1: "Check your inbox"
- Body: "We sent a verification link to **{email}**. Click it to activate your workspace."
- Resend button: "Resend email" / cooldown: "Resend in {n}s"
- Footer: "Wrong email? [Start over]"
- Expired-link message: "This link has expired. Verification links are valid for 24 hours." → "Send a new link"

### 8.5 Forgot Password — MVP-0
**URL:** `/forgot-password`
**Layout:** Centered card, single email input, submit.
**Components:** Input, Button.
**Interactions:** Submits regardless of whether the email exists (no account enumeration — see PART 16) and always shows the same success state.
**States:** Default → Submitting → Sent (identical whether or not the account exists).
**Responsive:** Single column, all widths.
**Accessibility:** Success message is `role="status"`.
**Exact copy:**
- H1: "Reset your password"
- Body: "Enter the email on your account and we'll send a reset link."
- Button: "Send reset link" (loading: "Sending…")
- Success state: "If an account exists for **{email}**, we've sent a password reset link." (deliberately non-committal — see Security)
- Footer: "[Back to sign in]"

### 8.6 Reset Password (from emailed link) — MVP-0
**URL:** `/reset-password?token=…`
**Layout:** Centered card, new-password + confirm-password fields.
**Components:** Input×2 (password, confirm), Button.
**Interactions:** Confirm-match validated inline; expired/used token shows an error state instead of the form.
**States:** Valid-token form → Submitting → Success ("Password updated" → auto-redirect to Login) → Invalid/expired token (dedicated message + "[Request a new link]").
**Responsive:** Single column.
**Accessibility:** Mismatch error is announced via inline `aria-describedby` on the confirm field, not only color.
**Exact copy:**
- H1: "Set a new password"
- Button: "Update password"
- Success toast (on Login screen after redirect): "Password updated. Please sign in."
- Invalid token message: "This reset link is invalid or has expired." → "Request a new link"

### 8.7 Login — MVP-0
**URL:** `/login`
**Layout:** Mirrors Signup — centered card, email + password, OAuth divider (Google + GitHub, both MVP-0 — see the superseded note at §8.3), "Forgot password?" link, link to Signup.
**Components:** Input×2, Button, link.
**Interactions:** Failed login shows a generic error (never "wrong password" vs "no such account" — enumeration protection); 5 failed attempts in 15 minutes trigger a temporary lockout with a countdown and a "reset your password" nudge.
**States:** Default → Submitting → Error (generic) → Locked-out (countdown, distinct message).
**Responsive:** Single column.
**Accessibility:** Error banner `role="alert"`; lockout countdown `aria-live="polite"`.
**Exact copy:**
- H1: "Sign in"
- Button: "Sign in" (loading: "Signing in…")
- Generic error: "That email or password isn't right. [Forgot password?]"
- Lockout: "Too many attempts. Try again in {mm:ss}, or [reset your password]."

### 8.8 Dashboard / Overview — MVP-0
**Purpose:** At-a-glance workspace health the moment you log in.
**URL:** `/w/{workspaceId}`
**Layout:** Header (workspace name, plan badge) → 4 stat tiles (Storage used / Files / Agents / Requests this month, each with a mini quota bar) → "Recent files" table (last 10, all workspaces the user can see if multiple) → "Quick start" panel (curl/MCP snippet with the user's own key redacted) shown only when the workspace has 0 files.
**Components:** Stat Tile ×4, Table, Code Block, Empty-state Quick-start panel.
**Interactions:** Stat tiles link to their respective full pages (Files, Agents, Usage); quota bar tooltip shows exact numbers on hover.
**States:** Loading (skeleton tiles+rows) → Populated → Empty workspace (Quick-start panel replaces Recent Files table) → Quota-warning (tile border shifts to `--warning` at 80%, `--danger` at 95%, with inline "Upgrade plan" link at ≥95%).
**Responsive:** Stat tiles 4→2→1 columns; Quick-start code block stacks.
**Accessibility:** Stat tiles are real `<a>` elements (not div+onclick) so they're keyboard-reachable and show up in link lists.
**Exact copy:**
- Stat tile labels: "Storage used", "Files", "Agents", "Requests this month"
- Quick-start heading: "Nothing here yet" / body: "Create your first agent and give it a key, or drop a file in below." / CTA: "Create an agent" (secondary: "Upload a file")
- Quota warning inline link: "You're at {pct}% of your {plan} plan storage. [Upgrade]"

### 8.9 File Browser — MVP-0
**Purpose:** Primary human file-management surface.
**URL:** `/w/{workspaceId}/files` and `/w/{workspaceId}/files/{folderPath}`
**Layout:** Breadcrumb (workspace root → nested folders) → toolbar (Upload button, New folder button, search input, view toggle grid/list, sort dropdown) → table/grid of folders-then-files → right-side Drawer for file details (opens on row click, doesn't navigate away).
**Components:** Breadcrumb, Table (columns: name/type icon, size, modified, created-by [agent/user badge], actions-menu), Search Input, Dropdown (sort), Drawer, Modal (new folder, delete confirm, rename), Toast, Progress Bar (upload).
**Interactions:** Drag-and-drop upload anywhere in the content area (highlight overlay on drag-enter); multi-select via checkbox column enables a bulk action bar (Move, Download as zip, Delete); right-click / kebab-menu per row (Open, Rename, Move, Download, Copy link, Delete); folder click navigates (breadcrumb updates); search input filters by name/path client-side for the current view instantly, and triggers full server-side metadata search on Enter.
**States:** Loading (row skeletons) → Populated → Empty folder (teaching empty state) → Search-no-results → Upload-in-progress (per-file progress rows appended at top, replaced by the real row on completion, replaced by an error row with "Retry" on failure) → Bulk-delete-confirm (modal requiring typed confirmation if >5 items selected) → Permission-denied for a specific row action (disabled with tooltip, not hidden, when it's informative, e.g. "You don't have permission to delete this file").
**Responsive:** Table → stacked cards on mobile (thumbnail/icon, name, size+date on one line, kebab menu); bulk action bar becomes a sticky bottom bar; drag-drop upload still works, plus an explicit "+" FAB for tap-to-upload.
**Accessibility:** Drag-drop zone has a keyboard-accessible equivalent (the Upload button opens a native file picker); table rows are keyboard-navigable (arrow keys move focus, Enter opens the Drawer, Space toggles selection checkbox); Drawer traps focus and restores it to the triggering row on close.
**Exact copy:**
- Empty folder: "This folder is empty" / "Drag files here, or" → "Upload files"
- Upload button: "Upload"
- New folder modal title: "New folder" / field label: "Folder name" / button: "Create folder"
- Rename modal: "Rename {itemName}" / button: "Save"
- Delete confirm (single): "Delete **{fileName}**? This can't be undone." / buttons: "Cancel" / "Delete"
- Delete confirm (bulk, >5 items): "Delete {n} items? Type **DELETE** to confirm." / disabled "Delete" until input matches
- Upload progress row: "{fileName} — {pct}%" / on failure: "{fileName} — Upload failed. [Retry]"
- Upload success toast: "{n} file(s) uploaded"
- Copy-link toast: "Link copied to clipboard"
- Search no-results: "No files match \"{query}\"" 
- Permission-denied tooltip: "You don't have permission to delete files in this workspace"

### 8.10 File Details (Drawer, not a separate route) — MVP-0
**Purpose:** Inspect one file's metadata without leaving the browser context.
**Layout:** Preview pane top (image/text/PDF-page-1 preview where supported; generic file-type icon otherwise) → metadata list (path, size, MIME, checksum (SHA-256, monospace, copyable), created by [agent/user badge + timestamp], last modified, version count [V2]) → tags editor (chip input) → caption field (inline-editable) → actions row (Download, Copy signed link, Move, Rename, Delete).
**Components:** Drawer, Image/Text preview, Chip Input, Inline-editable text, Code Block (checksum), Button row.
**Interactions:** Caption/tags save on blur with an inline "Saved" micro-confirmation (not a toast, to avoid interrupting flow); "Copy signed link" opens a small popover to choose expiry (1 hour / 24 hours / 7 days / permanent-revocable [MVP-1]) before copying.
**States:** Loading preview (skeleton) → Preview unavailable (icon + "Preview not available for this file type" + Download CTA) → Editing caption/tags → Saved (micro-confirmation, 2s fade).
**Responsive:** Becomes a full-screen sheet (not a side drawer) below 768px.
**Accessibility:** Drawer is `role="dialog"` `aria-modal="true"` with a labelled heading (`aria-labelledby` → file name).
**Exact copy:**
- Metadata labels: "Path", "Size", "Type", "Checksum (SHA-256)", "Created by", "Last modified"
- Caption placeholder: "Add a caption…"
- Tags placeholder: "Add tags…"
- Signed-link popover title: "Copy a link" / options: "Expires in 1 hour", "Expires in 24 hours", "Expires in 7 days", "Permanent (revocable)" [MVP-1]
- Preview-unavailable: "Preview not available for this file type" → "Download"

### 8.11 Create Folder — MVP-0 (modal, covered in 8.9; no separate route)

### 8.12 Upload Flow — MVP-0 (in-context on File Browser, covered in 8.9; large-file behavior: browser requests a presigned multipart URL set from the Worker and streams directly to R2, progress bar reflects real byte progress via `XMLHttpRequest`/`fetch` upload progress events, not a fake timer)

### 8.13 Agent Management (list) — MVP-0
**URL:** `/w/{workspaceId}/agents`
**Layout:** Toolbar ("Create agent" button, search) → table (name, status badge, keys count, last active, actions).
**Components:** Table, Badge (Active/Disabled), Button, Modal (create, disable-confirm, delete-confirm).
**Interactions:** Row click → Agent Details; kebab menu → Disable/Enable, Delete (blocked with explanation if the agent has active keys — must revoke keys first, or a confirm that cascades).
**States:** Loading → Populated → Empty ("No agents yet").
**Responsive:** Table → stacked cards.
**Accessibility:** Status badge pairs color with text ("Active"/"Disabled"), never color alone.
**Exact copy:**
- Empty state: "No agents yet" / "Agents are the identities your AI systems use to access storage." → "Create an agent"
- Create button: "Create agent"
- Delete-blocked message: "This agent has {n} active API key(s). Revoke them first, or [delete anyway] to revoke and delete together."

### 8.14 Create Agent — MVP-0 (modal from 8.13)
**Components:** Input (name), Textarea (description, optional), Button.
**Interactions:** On create, redirects straight into the Create API Key flow for this new agent (an agent with zero keys is inert) with a one-time banner explaining why.
**Exact copy:**
- Title: "Create an agent" / field: "Name" (placeholder "e.g. research-bot") / optional field: "Description"
- Button: "Create agent"
- Post-create banner: "**{agentName}** created. Give it an API key to let it connect."

### 8.15 Agent Details — MVP-0
**URL:** `/w/{workspaceId}/agents/{agentId}`
**Layout:** Header (name, status toggle) → tabs: Overview (recent activity summary, keys list inline, **Danger zone**) · Keys (full list + create) · Activity (MVP-1, filtered audit log for this agent). Delete is a Danger-zone panel at the foot of Overview rather than a header control, matching Settings → General — a destructive action people meet on two screens should not be two different interactions.
**Components:** Tabs, Table (keys), Toggle (active/disabled), Badge.
**Interactions:** Disabling an agent immediately invalidates all its keys (with a confirm modal stating this explicitly) rather than leaving them silently non-functional.
**States:** As 8.13 plus a disabled-agent banner ("This agent is disabled. Its API keys will not authenticate.").
**Responsive:** Tabs become a horizontal scroll or a select dropdown on mobile.
**Accessibility:** Tabs are a proper ARIA tablist with `aria-selected`.
**Exact copy:**
- Disable confirm: "Disable **{agentName}**? All of its API keys will stop working immediately." / buttons: "Cancel" / "Disable agent"
- Delete confirm (type-to-confirm on the agent's exact name): "This will permanently delete **{agentName}** and revoke its {n} live keys. Revoked keys cannot be reactivated." The count is *live* keys only — active plus blocked-while-the-agent-is-disabled — because naming an already-revoked or expired credential in a warning is noise dressed as a warning. `DELETE /v1/agents/:id` cascades the revocation itself and returns `keysRevoked`; the confirmation on the agents list reports **that** number rather than the dialog's estimate, so a key minted between opening the dialog and confirming is accounted for.

### 8.16 API Keys (workspace-level list) — MVP-0
**URL:** `/w/{workspaceId}/keys`
**Layout:** Toolbar ("Create key") → table (name, agent, prefix/last-four, scope summary, created, last used, expires, actions).
**Components:** Table, Badge (scope summary chip, e.g. "Read+Write · /projects/*"), Modal (create, reveal-once, revoke-confirm).
**Interactions:** "Create key" → modal collects name, agent, scope (path prefix + operation checkboxes: read/write/delete/list), optional expiry → on submit, a **Reveal-once** modal shows the full key in a monospace block with a "Copy" button and a persistent warning banner, and cannot be reopened once dismissed.
**States:** List Loading/Populated/Empty → Create-form → Reveal-once (distinct, non-dismissible-by-accident state — requires an explicit "I've copied my key" acknowledgment button, not just an X) → Revoke-confirm.
**Responsive:** Table → stacked cards; reveal-once modal remains full-width on mobile for easy copy.
**Accessibility:** Reveal-once key text is selectable and has an explicit "Copy to clipboard" button (not copy-on-click-of-text, which is not discoverable); focus lands on the Copy button when the modal opens.
**Exact copy:**
- Empty state: "No API keys yet" → "Create your first key"
- Create modal title: "Create API key" / fields: "Name" (e.g. "prod-research-bot"), "Agent" (select), "Permissions" (checkboxes: Read, Write, Delete, List), "Restrict to path" (optional, placeholder "/projects/demo/*"), "Expires" (Never / 30 days / 90 days / Custom)
- Reveal-once headline: "Your API key" / warning: "Copy this now — you won't be able to see it again." / body key block with Copy button / acknowledgment button: "I've copied my key"
- Revoke confirm: "Revoke **{keyName}**? Any agent using this key will immediately lose access." / buttons: "Cancel" / "Revoke key"
- Revoke success toast: "Key revoked"
- Table scope chip pattern: "{ops} · {pathPrefix or 'Full access'}"

### 8.17 Create API Key — MVP-0 (modal, covered in 8.16)

### 8.18 MCP Connection — MVP-1
**URL:** `/w/{workspaceId}/mcp`
**Layout:** Header + status banner (Connected/Not connected — reflects whether any MCP-scoped key exists and has been used) → "Connect" panel with tabbed config snippets (Claude Desktop / Claude Code / Cursor / generic MCP client) showing a ready-to-paste JSON config with a placeholder for the user's own key → "Available tools" reference table (tool name, one-line description, required scope) → recent MCP calls mini-log (last 20, MVP-1).
**Components:** Tabs, Code Block (per-client JSON, copy button), Table, mini Activity list.
**Interactions:** Copy button copies the config with the user's actual key substituted in **only if** a key with `mcp` scope already exists and the user explicitly opts in via a checkbox ("Include my API key in this snippet") — otherwise a placeholder `<YOUR_API_KEY>` is shown, defaulting to the safer option.
**States:** No MCP-scoped key yet (banner nudges "Create a key with MCP access" linking to 8.16 pre-filled) → Connected, never used → Connected, active (shows last-call timestamp).
**Responsive:** Tabs → select dropdown on mobile; code blocks scroll horizontally rather than wrap (preserve copy-paste correctness).
**Accessibility:** Copy-with-key-included checkbox has a clear warning adjacent, not just a tooltip: visible text "Your key will be visible in this snippet. Don't paste it anywhere public."
**Exact copy:**
- Banner (not connected): "No MCP connection yet" → "Create an MCP-scoped key"
- Section head: "Connect your agent" / body: "Paste this into your MCP client's config."
- Tool table columns: "Tool", "Description", "Requires"
- Recent calls empty: "No MCP calls yet. Once your agent connects, you'll see activity here."

### 8.18a Webhooks — MVP-1
**Purpose:** Register and manage outbound event notifications (`05` PART 11.1 `webhooks` table, PART 13 `/v1/webhooks` endpoints) — grouped in the nav next to MCP since both are "how external systems connect to this workspace" surfaces.
**URL:** `/w/{workspaceId}/webhooks`
**Layout:** Toolbar ("Add endpoint") → table (URL, subscribed events as chips, status badge "Active"/"Failing", last delivery timestamp + result icon, kebab menu) → empty state.
**Components:** Table, Badge (Active/Failing), Chip (event names), Modal (create/edit, secret reveal-once, delete-confirm).
**Interactions:** "Add endpoint" opens a modal collecting a URL (validated `https://`-only client-side, re-validated server-side per `06` PART 16.11's SSRF protection) and an event checklist (`file.created`, `file.deleted`, `file.updated`, `transform.completed` [V2], etc.); on save, a **reveal-once modal** shows the signing secret exactly once — identical interaction pattern to the API-key reveal-once flow (8.16), reused rather than reinvented, with the same non-dismissible-without-acknowledgment behavior. A row's kebab menu offers "Send test event" (fires a synthetic payload immediately, useful for verifying the receiving endpoint before relying on real traffic) alongside Edit/Rotate secret/Delete.
**States:** Empty ("No webhooks yet") → Populated → a row in "Failing" status (3+ consecutive delivery failures, per the dead-letter-queue behavior in `09` PART 23.1) shows an inline "View recent failures" expansion with the last few error responses (status code + truncated body, never any request/response header that could contain a secret, per `06` PART 16.18).
**Responsive:** Table → stacked cards; event chips wrap.
**Accessibility:** Status badge pairs color with text; the reveal-once secret modal follows 8.16's accessibility pattern (focus lands on Copy, only dismissible via explicit acknowledgment).
**Exact copy:**
- Empty state: "No webhooks yet" / "Get notified when files change — useful for triggering downstream automation." → "Add endpoint"
- Create modal title: "Add webhook endpoint" / fields: "URL" (placeholder "https://your-service.com/webhooks/agentdisk"), "Events" (checklist)
- Reveal-once headline: "Your signing secret" / warning: "Copy this now — you won't be able to see it again. Use it to verify that deliveries actually came from AgentDisk." / acknowledgment button: "I've copied my secret"
- Failing-status inline label: "Failing — last {n} deliveries didn't succeed" → "View recent failures" / "Rotate secret" / "Delete endpoint"
- Test-event toast: "Test event sent"
- Delete confirm: "Delete this webhook endpoint? AgentDisk will stop sending events to **{url}**." / buttons: "Cancel" / "Delete"

### 8.19 Usage — MVP-0 (basic numbers) / MVP-1 (full history + charts)
**URL:** `/w/{workspaceId}/usage`
**Layout:** Plan summary card (current plan, "Upgrade" CTA) → 4 metered bars (Storage, Assets, Egress, Requests) each with current/limit and days-until-reset → (MVP-1) time-series chart per metric, 30-day view, daily granularity.
**Components:** Progress Bar (quota), Chart (line, MVP-1), Card.
**States:** Normal → Warning (≥80%, amber bar) → Critical (≥95%, red bar + inline upgrade nudge) → Limit hit (bar full, explicit "You've reached your {metric} limit" banner with Upgrade CTA — matches the 429 the API would actually return, so the UI never claims capacity the API would deny).
**Responsive:** Bars stack single-column; chart becomes horizontally scrollable.
**Accessibility:** Progress bars expose `aria-valuenow/min/max` and a text equivalent alongside the visual bar (never bar-only).
**Exact copy:**
- Metric bar labels: "Storage — {used} of {limit}", "Assets — {used} of {limit}", "Egress this period — {used} of {limit}", "Requests this period — {used} of {limit}"
- Reset note: "Resets in {n} days"
- Limit-hit banner: "You've reached your {metric} limit for the {plan} plan." → "Upgrade plan"

### 8.20 Activity / Audit Log — MVP-1
**URL:** `/w/{workspaceId}/activity`
**Layout:** Filter bar (actor: human/agent/all, action type, date range) → paginated event table (timestamp, actor badge, action, resource, result icon).
**Components:** Table, Filter Dropdowns, Date Range Picker, Badge (success/denied).
**Interactions:** Row click expands inline (not a navigation) to show raw event detail (IP, user agent/client string, request id) for support/security use.
**States:** Loading → Populated → Empty (filtered) → Empty (no events at all — new workspace).
**Responsive:** Table → stacked list; filters collapse into a single "Filters" sheet trigger.
**Accessibility:** Expandable rows use `aria-expanded` on the trigger.
**Exact copy:**
- Empty (no events): "No activity yet. Actions your team and agents take will show up here."
- Empty (filtered): "No events match your filters." → "Clear filters"
- Result badges: "Allowed" / "Denied"

### 8.21 Settings → General — MVP-0
**URL:** `/w/{workspaceId}/settings`
**Layout:** Form sections: Workspace name (editable — purely cosmetic, has no effect on URLs or API paths), Workspace ID (read-only, monospace, copyable — this is what both dashboard URLs (`/w/{workspaceId}/...`) and the API use to address the workspace, precisely so renaming a workspace never breaks a bookmarked URL, a saved API script, or an MCP config — PROPOSAL: IDs, not human-editable slugs, in every URL/API path, see PART 11), Danger zone (Delete workspace).
**Components:** Input, Button, Danger-zone Card (bordered `--danger`).
**Interactions:** Delete workspace requires typing the workspace name to confirm, and states explicitly what's destroyed.
**States:** Default → Saving → Saved (inline confirmation) → Delete-confirm.
**Responsive:** Single column at all widths.
**Accessibility:** Danger zone is a distinct landmark (`aria-label="Danger zone"`).
**Exact copy:**
- Danger zone heading: "Danger zone"
- Delete workspace: "Delete this workspace" / body: "This permanently deletes all files, agents, and API keys in **{workspaceName}**. This cannot be undone." / confirm input placeholder: "Type {workspaceName} to confirm" / button: "Delete workspace" (disabled until match)

### 8.22 Settings → Members — MVP-1
**Layout:** Table (member, role, joined, actions) → "Invite member" (email + role select) → pending invites sub-list.
**Interactions:** Role change is immediate; removing a member revokes their session (Firebase-side "log out everywhere" via `users.session_revoked_after`, `16` PART 30.4); owner role cannot be removed if it's the last owner (blocked with explanation, not silently disabled). **Added Sept 2026 — closes a real gap:** the "Remove member" confirmation additionally shows a checkbox, checked by default, "Also revoke every API key {name} created in this workspace" — the removed member's session dies immediately either way, but an API key they minted keeps working after removal *unless* this box is checked, because keys are workspace assets an agent may depend on continuously (deliberately not an automatic cascade — see `06` PART 16.1/15.3 for why). Leaving it checked is the safer default; an admin who knows a given key is genuinely shared team infrastructure (not personal to the departing member) can uncheck it.
**Exact copy:**
- Invite button: "Invite member" / roles: "Owner", "Admin", "Member" with one-line descriptions in the select ("Member: can manage files and agents, can't manage billing or delete the workspace")
- Last-owner block: "A workspace needs at least one owner. Promote someone else first."
- Remove-member confirm: "Remove **{name}** from this workspace? They'll immediately lose access." / checkbox (checked by default): "Also revoke every API key {name} created in this workspace ({n} key(s))" / buttons: "Cancel" / "Remove member"

### 8.23 Settings → Security — MVP-0
**Layout:** Password change form → active sessions list (device/browser, location approx, last active, "Revoke" per session, "Revoke all other sessions") → (MVP-1) SSO placeholder card, disabled, "Available on Team plan."
**Exact copy:**
- Section head: "Active sessions"
- Revoke: "Sign out" per row / "Sign out all other sessions"
- Revoke-all confirm: "This will sign you out everywhere except this device."

### 8.24 Settings → Privacy — MVP-1
**Layout:** Data-processing summary (what's stored, what's sent to which sub-processor — mirrors PART 17's factual claims, rendered, not just linked) → "Export my data" button (async job, emails a download link) → "Delete my account" (separate from delete-workspace; only relevant if the user has no other workspaces they solely own).
**Exact copy:**
- Export: "Export my data" → on request: "We're preparing your export. We'll email you a download link within 24 hours."
- Account delete blocked case: "You're the only owner of {n} workspace(s). Transfer ownership or delete those workspaces first."

### 8.25 Settings → Billing — MVP-1
**Layout:** Current plan card + "Manage billing" (opens Stripe Customer Portal) → invoice history table → plan comparison (reuses Pricing page cards inline).
**Exact copy:**
- No payment method: "Add a payment method to upgrade" 
- Downgrade confirm (if over new plan's limits): "Your current usage exceeds the {plan} plan's limits. You can downgrade, but new uploads will be blocked until you're back under the limit."

### 8.26 Profile — MVP-0
**URL:** `/account/profile`
**Layout:** Avatar, name, email (change-email requires re-verification), connected OAuth accounts (MVP-1).
**Exact copy:**
- Change-email note: "We'll send a verification link to your new email. Your current email stays active until you confirm."

### 8.27 404 Not Found — MVP-0
**Layout:** Centered, minimal — icon, code, message, primary action back to Dashboard (or Landing if signed out).
**Exact copy:** "404 — We couldn't find that page." → "Go to dashboard" / "Go home" (signed out)

### 8.28 403 Forbidden — MVP-0
**Exact copy:** "403 — You don't have access to this." / body: "You might not be a member of this workspace, or your role doesn't allow this action." → "Back to dashboard"

### 8.29 500 Server Error — MVP-0
**Exact copy:** "Something went wrong on our end." / body: "We've logged this and we're looking into it. Try again in a moment." → "Retry" / "Status page ↗" (link to Cloudflare-hosted status page once it exists, MVP-1; omitted in MVP-0 copy until the status page is live)

### 8.30 Maintenance — MVP-1 (only needed once there's a real deploy cadence worth signaling around)
**Exact copy:** "We're doing quick maintenance." / body: "AgentDisk will be back in a few minutes. Your data isn't affected." 

### 8.31 Screens Intentionally Not Built (and why)
- **Standalone "Workspaces" list page:** folded into the sidebar switcher (7.3) — a full page is premature until multi-workspace-per-org usage data justifies it (V2 candidate).
- **Standalone in-app Documentation pages:** docs are generated from the OpenAPI/MCP schema and served from `docs.agentdisk.io` (PART 18), not duplicated inside the dashboard shell — avoids the exact "docs drift from reality" failure mode observed in AgentStorage's own inconsistencies (PART 2.10).
- **Onboarding wizard / multi-step tour:** the Dashboard's context-aware Quick-start panel (8.8) and File Browser's teaching empty states (8.9) serve this purpose inline, following the "empty states teach" design principle (7.1) instead of a separate modal-tour flow that gets skipped and forgotten.
