# AgentDisk — Full UI Audit (every menu/tab) + Fix Prompt for the Coding Agent

**Date:** 2026-09-08
**Target:** `https://app-dev.agentdisk.io` (dev), real account `kernelv5@gmail.com`, 4 real workspaces (`My Workspace`, `Abc`, `Tk0`, `after-new`)
**Method:** Manual click-through of every sidebar item, every Settings tab, every dropdown, and the three creation modals, cross-checked against the Activity log and against a second real workspace to tell "hardcoded" apart from "genuinely empty." No destructive actions taken, no real keys/agents/webhooks created, no sign-out attempted.

This supersedes and extends `17-dev-environment-live-test-findings.md` — items already reported there are marked **[re-confirmed]** or **[re-tested]**; everything else is new.

---

## Part 1 — Checklist: every menu, submenu, and tab

| Area | Screen | Status |
|---|---|---|
| Sidebar | Dashboard | ⚠️ Agents stat tile hardcoded (#1 below) |
| Sidebar | Files | ⚠️ Slow loading skeleton, otherwise OK |
| Sidebar | Activity | ✅ Real data, filters present (Actor/Action/date range), Export CSV present |
| Sidebar | Agents | ✅ Real data, Create-agent modal works |
| Sidebar | API keys | ✅ Real data, Create-key modal works (but see #2 for a downstream MCP issue) |
| Sidebar | MCP connection | ⚠️ Two issues (#2, #3 below) |
| Sidebar | Webhooks | ✅ Empty state correct, Add-endpoint modal fully built (URL + 6 typed events) |
| Sidebar | Usage | ✅ Real quota data; history chart honestly labeled "not built yet" |
| Settings | General | ⚠️ Workspace ID field hardcoded (#4, re-confirmed on 2 workspaces) |
| Settings | Security | ⚠️ Legacy password form + broken Active-sessions table (#5, #6) |
| Settings | Members | ✅ Real data (real email, role, join date) |
| Settings | Privacy | ⚠️ Stale pre-Firebase content (#7) |
| Settings | Billing | ✅ Now consistent (#8 — was broken in the prior pass, recheck recommended) |
| Top bar | Docs button | ❌ Dead link, `docs.agentdisk.io` doesn't resolve (re-confirmed) |
| Top bar | Sign out | Present, not tested (would end the real session) |
| Sidebar footer | Workspace switcher (My Workspace / Abc / Tk0 / after-new / New workspace) | ✅ Switches workspace context correctly |
| Sidebar footer | Account menu ("Kernel V5") | ❌ Completely non-functional (#9) |
| Dashboard header | "Copy" next to Workspace ID | Present, real ID, not clicked (low risk, low priority to verify) |

---

## Part 2 — Findings

Numbered fresh for this pass; cross-references to the prior report are noted.

### 1. Dashboard "Agents" stat tile is dead template text, not live data (High)

Proven with a controlled comparison: **"My Workspace"** has a real, Active agent (`test01`) with 2 real API keys — yet its Dashboard still shows **"Agents — Not built yet."** **"Abc"** (a workspace with genuinely zero agents) shows the *exact same string*. Since a workspace with agents and a workspace without agents render identically, the tile isn't even computing "0" wrong — it never reads agent-count data at all.

**Fix:** wire the tile to the real per-workspace agent count (`0` → "No agents yet" or similar, `N` → the number), matching how Files/Storage/Requests already work correctly on the same dashboard.

### 2. MCP "Available tools" doesn't reflect the real key's actual scope (High — verify backend, not just UI)

Both of "My Workspace"'s real keys are scoped `read, list` only (confirmed on the API Keys table). The MCP connection page nonetheless shows `create_file`, `update_file`, `create_folder`, `move_file`, `copy_file` (all `files:write`) as available/checked, locking only `delete_file`.

**This needs a decision, not just a cosmetic fix:** if the backend correctly rejects write calls for a read-only key (i.e., only the display is wrong), fix the display to compute availability from the connecting key/agent's real scope. If the backend does *not* reject them, this is a real authorization bug — a read-only key would be able to write files via MCP — and takes priority over every other item in this report.

### 3. MCP "Connected" badge and "Recent MCP calls" don't line up with reality (Medium)

The page shows a green **"• Connected"** badge, but the agent's "Last Active" is "Never" and both keys show "Last Used: Never" — no agent has ever actually connected. "Recent MCP calls" below has no rows and no empty-state message at all (every other list on the site — Agents, Keys, Webhooks, Files — has a proper "No X yet" state). Likely both symptoms of the same root cause: this page isn't wired to a real connection-status source.

**Fix:** compute "Connected"/"Not connected" from real recent MCP traffic (or remove the badge if that data doesn't exist yet), and add a "No calls yet" empty state to match every other list on the site.

### 4. Settings → General "Workspace ID" field is 100% hardcoded [re-confirmed, now proven cross-workspace] (Medium)

The exact same fake value `ws_8Kq2xR4mN7pL` was confirmed on **two different real workspaces**: "My Workspace" (real ID `ws_01M1WTCVFG3VEX6VRHCZWN1SK2`) and "Abc" (real ID `ws_01M1X626F0Z63AEJN4RQPBW2JH`). This isn't a per-workspace data bug, it's static placeholder text that was never wired up at all.

**Fix:** bind this field to the workspace's real ID (the same value already shown correctly on the Dashboard header).

### 5. Legacy "Change password" form still present post-Firebase [re-confirmed] (Medium)

Settings → Security still shows a full Current/New/Confirm password form. Per the project's own build plan (`16-firebase-auth-and-final-launch-prompt.md`, Phase 1/3), first-party password UI was supposed to be removed once Firebase owns authentication.

**Fix — pick one, don't leave it ambiguous:** if this account can still legitimately use email/password sign-in via Firebase (not SSO), keep the form but point it at Firebase's password-update API and confirm it actually works end-to-end. If password auth is fully retired for this account/environment, delete the form entirely and replace it with whatever Firebase-appropriate account-security controls exist (e.g., "manage sign-in methods," a Firebase password-reset email trigger).

### 6. "Active sessions" table always shows zero rows, even for the current session (Medium)

Confirmed empty on both workspaces tested. A session-listing feature that can't show the session currently viewing it isn't reading real session data.

**Fix:** either populate it with real session/device records (at minimum, the current session) or remove the table until the feature is built, same as Usage's honest "Daily usage charts are not built yet" label — don't leave a table shell with a header and nothing under it.

### 7. Settings → Privacy tab content is stale relative to the Firebase migration (Medium — compliance-relevant)

The page states it's **"Rendered from the privacy policy, not just linked to it"**, then lists "Account data: Email, display name, **hashed password**, session records" and Resend's purpose as "**verification, password reset**" emails — both describe the pre-Firebase, first-party auth system. If this is genuinely rendered from the live privacy policy document, that document itself may not have been updated since the Firebase cutover — worth flagging to whoever owns the actual policy text, not just the frontend.

**Fix:** update the privacy policy source content (and this rendering of it) to describe what's actually stored today (Firebase-issued identity, no first-party password hash unless email/password sign-in is still used) — coordinate with whoever has authority over the legal document, don't just patch the UI copy.

### 8. Billing tab: previously broken, now consistent — recommend confirming it's a real fix (High → recheck)

The prior report found Billing showing "Pro — $20/month" while Dashboard/Usage correctly said "free." This pass found Billing fully consistent: Plan `free`, Status `Active`, correct billing email, "No active subscription" for payment method, and a proper "Invoices live on Stripe" redirect instead of fake invoice rows. A brief "Loading billing…" state was observed before the correct data rendered.

**Fix (verification, not necessarily new code):** confirm this was a genuine fix and not a race condition where a stale/mock value briefly renders before the real fetch resolves — reload the Billing tab several times in a row and check it never flashes incorrect data.

### 9. The account menu button is completely dead (High)

Bottom-left "Kernel V5 / kernelv5@gmail.com" is a real `<button>` element (confirmed via the accessibility tree, not just a coordinate miss), styled identically to the working workspace switcher directly above it. Clicking it — by coordinate and by element reference — produces no dropdown, no menu, no navigation. On a comparable product this is where sign-out, profile, and personal account settings live. Right now there is no way to reach any personal/account-level settings from here — "Sign out" only exists as a separate top-right link.

**Fix:** wire this button to an actual menu (profile, sign-out, anything account-scoped that isn't workspace-scoped), or remove the chevron/hover affordance if it's intentionally decorative — right now it visually promises functionality it doesn't have.

### 10. Files page has a slow, empty-looking loading state (Low)

On a genuinely empty workspace, the Files page shows ~3+ seconds of shimmering skeleton rows before resolving to "This folder is empty." Not broken, just a rough first impression for a new/empty workspace — worth a quick look if it's a slow API call rather than an artificial delay.

### 11. Four real workspaces, three look like test debris (Low / Info)

The account has `My Workspace`, `Abc`, `Tk0`, and `after-new`. The latter three look like leftover test workspaces from development. Not a bug, but worth deleting (or renaming to something obviously non-production) before a real external tester sees a workspace switcher cluttered with placeholder names on day one.

---

## Part 3 — Instructions to the AI (how to use this report)

Read this whole document before touching code. The findings are grouped by whether they need a **UI fix**, a **backend/data fix**, or a **decision** about a feature that may or may not still be needed. Treat #2 (MCP scope enforcement) as the one item to verify *before* anything else — it's the only finding here that could be a real security/authorization bug rather than a display or onboarding problem; everything else is safe to defer behind it.

For every item: first determine whether the underlying capability is actually implemented on the backend (a real API/endpoint/data source exists) or not.

- If the capability **is implemented** but the frontend isn't calling it, isn't reading the right field, or is showing stale/placeholder data instead of the real response — **wire it up and activate it.** Don't rebuild working backend logic; connect the existing UI to it.
- If the capability is **not implemented** at all (no endpoint, no data model support) — **remove the dead UI entity** rather than leaving a shell that implies a feature exists. Either delete it outright, or replace it with an honest "not built yet" state in the same style already used correctly on the Usage page ("Daily usage charts are not built yet") — that's the bar for what an honest placeholder looks like on this product; a table header with permanently zero rows, or a stat that always reads a fixed string, is not that bar.
- Where a finding could go either way depending on backend reality (#2, #5), don't guess — check the actual backend behavior first, then apply the rule above.

Do not reintroduce anything the project's own docs already marked as intentionally removed (e.g., don't "fix" the password form by assuming password auth should still be primary — check `16-firebase-auth-and-final-launch-prompt.md` first).

After fixing, re-verify each item the same way it was found here: compare the same UI element across at least two real workspaces (one with real data, one without) wherever the finding involved a stat or ID field, so a fix that only works for one workspace isn't mistaken for a full fix.

---

## Part 4 — Prompt to hand to the coding agent

Copy-paste the block below as-is.

```
You are fixing a set of real, evidence-backed bugs found during a live QA/security
pass on the AgentDisk dev environment (app-dev.agentdisk.io / api-dev.agentdisk.io),
ahead of inviting a real external user to test the product. Treat this as a
pre-launch bug-fix pass, not a redesign — don't change anything not listed below.

Read these two project docs first, in full, before changing anything:
1. claude/17-dev-environment-live-test-findings.md
2. claude/18-full-ui-audit-and-fix-prompt.md (this report — Parts 1-3 especially)

For every item below, first check whether the underlying capability is actually
implemented on the backend (a real endpoint / real data already exists). Then:
- If it EXISTS but the frontend isn't using it correctly → wire the frontend to
  the real data. Don't rebuild working backend logic.
- If it DOES NOT exist → remove the dead/hardcoded UI element, or replace it with
  an honest "not built yet" empty state (match the style already used correctly
  on the Usage page's "Daily usage charts are not built yet" — that's the bar).
Never leave a UI element that implies a working feature when it isn't one.

PRIORITY 0 — verify before anything else, this may be a security bug, not a UI bug:
- On the MCP connection page, the "Available tools" list shows create_file,
  update_file, create_folder, move_file, and copy_file (all requiring files:write)
  as available/checked for an agent whose actual API key is scoped read+list only
  (no write, no delete). Determine whether the BACKEND actually enforces the key's
  real scope on these MCP tool calls. If it does not — i.e. a read-only key can
  actually write files via MCP — fix the authorization enforcement first, before
  any other item on this list. If the backend already enforces it correctly, this
  is a display-only bug: compute "Available tools" checkmarks/locks from the real
  connecting key's actual scope, not a static list.

PRIORITY 1 — hardcoded/dead UI (each confirmed by comparing 2+ real workspaces):
1. Dashboard's "Agents" stat tile always renders "— / Not built yet" regardless of
   the workspace's real agent count (confirmed: a workspace WITH a real active
   agent shows the identical text as a workspace with none). Wire it to the real
   per-workspace agent count, same pattern as the Files/Storage tiles that already
   work correctly.
2. Settings → General → "Workspace ID" field always shows the same fake value
   (ws_8Kq2xR4mN7pL) on every workspace, confirmed across two different real
   workspace IDs. Bind it to the workspace's real ID (same value already shown
   correctly on the Dashboard header for that workspace).
3. The account menu button (bottom-left, shows the signed-in user's name/email)
   is a real <button> that does nothing on click — no dropdown, no navigation.
   Wire it to an actual account menu (profile / sign-out / account-level
   settings), or remove the dropdown-chevron affordance if none of that exists
   yet — it currently visually promises a menu it doesn't have.

PRIORITY 2 — inconsistent/misleading data:
4. Settings → Security still has the full pre-Firebase "Change password" form
   (Current/New/Confirm, all marked required). Check claude/16-firebase-auth-and-
   final-launch-prompt.md for what should have replaced this. If this account/
   environment still legitimately supports Firebase email+password sign-in, point
   the form at Firebase's real password-update flow and verify it works
   end-to-end. If password auth is fully retired here, delete the form and
   replace it with whatever Firebase-appropriate account-security control is
   correct (e.g. "manage sign-in methods").
5. Settings → Security → "Active sessions" table always renders zero rows, even
   though the very session viewing the page is active. Populate it with real
   session/device data (at minimum the current session), or remove the table
   until that's implemented.
6. MCP connection page shows a green "Connected" badge and an empty, unlabeled
   "Recent MCP calls" section, even though the workspace's real agent/keys have
   never actually been used (Last Active / Last Used both "Never" on real data).
   Compute the badge from real recent MCP activity instead of a static value, and
   add a proper "No calls yet" empty state under Recent MCP calls, matching the
   empty states already used correctly elsewhere (Agents/Keys/Webhooks/Files all
   have one).
7. Settings → Privacy tab text (labeled "Rendered from the privacy policy, not
   just linked to it") lists "hashed password" under Account data and
   "verification, password reset" as a transactional-email purpose — both
   describe the pre-Firebase auth model. Find the actual source of this content
   (privacy policy document or a hardcoded copy of it) and update it to describe
   what's genuinely stored today under Firebase auth. Flag to a human if this
   requires legal sign-off rather than just an engineering fix.

PRIORITY 3 — verify a possible earlier fix, and minor cleanup:
8. Settings → Billing previously showed "Pro — $20/month" while Dashboard/Usage
   correctly showed "free" (see finding #7 in claude/17-...). This pass found
   Billing now fully consistent (free/Active/correct email/no payment method/
   proper Stripe-portal redirect), with a brief "Loading billing…" state observed
   before the correct data appeared. Confirm this is a real, stable fix and not a
   race condition where incorrect data can still flash briefly before the real
   fetch resolves — reload the Billing tab repeatedly and check.
9. Files page shows several seconds of loading-skeleton rows before resolving to
   "This folder is empty" on a genuinely empty workspace. Check whether this is
   an artificially slow API call and speed it up if so; low priority.
10. The account has 4 real workspaces: "My Workspace", "Abc", "Tk0", "after-new".
    The latter three look like development test data. Confirm with the human
    product owner whether they should be deleted before external testing begins
    (don't delete them yourself without confirmation — this is real account data).

After each fix, re-verify the same way it was found: check the fixed element
across at least two different real workspaces in this account (one with real
data in the relevant field, one without), so a fix that only works for a single
workspace isn't mistaken for a complete fix. Do not touch anything not listed
above.
```

---

## Part 5 — Live verification after deployment (2026-09-08, post-deploy)

The coding agent applied the fix prompt above and reported back with a detailed engineering summary (P0 traced through `server.ts`/`auth.ts`/`files.ts`/`folders.ts` with passing tests; each numbered item fixed, deferred, or flagged for human sign-off). It explicitly flagged that it had no browser tooling to re-verify live and that "a live click-through against app-dev is still owed."

That click-through happened in two passes: once immediately after the report (before deploy — every item was still showing the old, broken behavior, confirming the fixes existed only in code, not yet live) and once after the user confirmed deployment had finished. **This section covers the post-deploy pass — every item below was re-tested directly on `app-dev.agentdisk.io`, cross-checked across two real workspaces ("My Workspace" and "Abc") where the finding involved a per-workspace field.**

| # | Item | Live status |
|---|---|---|
| P0 | MCP "Available tools" scope enforcement | ✅ **Confirmed live.** A key selector now appears ("testete" / "test01"); for the read+list-only key, only `list_files`/`search_files`/`get_file`/`get_metadata` show as available, and every `write`/`delete` tool correctly shows "Unavailable to this agent. Requires write/delete." Scope badges are now bare (`read`, `list`, `write`, `delete`), not `files:*`. |
| 1 | Dashboard Agents tile | ✅ **Confirmed live, on both workspaces.** "My Workspace" now shows "1 / 1 active" (was "— / Not built yet"). "Abc" independently shows its own real agent ("007F") correctly — ruled out a cross-workspace leak by checking the Agents page matched the Dashboard tile. |
| 2 | Settings → Workspace ID | ✅ **Confirmed live, on both workspaces.** Each shows its own real ID (`ws_01M1WTCVFG3VEX6VRHCZWN1SK2` / `ws_01M1X626F0Z63AEJN4RQPBW2JH`), not the old shared fake `ws_8Kq2xR4mN7pL`. |
| 3 | Account menu button | ✅ **Confirmed live.** Clicking it now opens a real dropdown with Profile / Sign out. |
| 4 | Legacy password form | ✅ **Confirmed live.** Replaced with an honest, provider-aware state: "This account signs in with Google — There is no AgentDisk password to change. Your password, if you have one, lives with that provider and is changed there." |
| 5 | Active sessions table | ✅ **Confirmed live.** Replaced with an honest explanation ("Per-device session records are not built yet...") plus the one real working action, "Sign out other sessions." The SSO card also now explicitly distinguishes itself from the Google/GitHub sign-in buttons. |
| 6 | MCP "Connected" badge / empty state | ✅ **Confirmed live.** Badge now reads "Never connected" (real state, this key/agent has never been used). "Recent MCP calls" now shows a proper "No MCP calls yet" empty state. |
| 7 | Privacy tab stale content | ✅ **Confirmed live.** No more "hashed password" claim — replaced with an accurate description ("No password. Firebase Authentication owns sign-in..."). Google (Firebase Authentication) added as a listed sub-processor. Resend's purpose corrected from "password reset" to "notifications, address verification." The page now also honestly says "A summary of the privacy policy. The policy itself is the authoritative text," with a link to the real policy, instead of overclaiming to be the rendered policy itself. |
| 8 | Billing plan mismatch | ✅ **Re-confirmed stable.** Still free/Active/correct billing email/no payment method/proper Stripe-portal redirect, no flash of stale data observed across a fresh reload. |
| 9 | Files page slow load | Left alone as reported (real serial-bootstrap latency, not artificial) — not re-timed, no regression expected since nothing changed here. |
| 10 | Delete workspace endpoint | ✅ **Confirmed live and properly gated.** The Danger Zone button now opens a real confirmation dialog requiring the exact workspace name typed before the Delete button enables. **Not completed** — deleting a real workspace is the user's call, not an agent's; cancelled out of the dialog after confirming it renders and gates correctly. |
| Flagged: MCP config snippet URL | ✅ **Confirmed live.** Now `https://api-dev.agentdisk.io/mcp` (previously the wrong prod-looking `https://mcp.agentdisk.io/v1`, which 404'd). |
| Flagged: "Include my API key" checkbox | ✅ **Confirmed live.** Removed entirely, replaced with accurate copy about keys being shown once. |

**Bottom line: every item in the fix prompt that could be checked live is confirmed working on `app-dev.agentdisk.io` post-deploy, with no regressions found** (specifically checked for a cross-workspace agent-count leak given the tile fix touches shared-looking state — none found; "Abc"'s agent count is real, independent data). Not independently re-tested: the Settings → General "Save changes" (workspace rename) fake-success behavior and the other items the coding agent's own report already listed as still dead (docs.agentdisk.io link, `/w/:id` validation, missing security headers, Privacy's Export/Delete-account fake success) — those remain open per the coding agent's own account, not touched by this fix pass, and not re-verified here since they weren't claimed as fixed.

Remaining open items, for a future pass: the three test-looking workspaces ("Abc", "Tk0", "after-new") can now genuinely be deleted via the new, real delete flow, once the user decides they're no longer needed — the "Abc" deletion dialog was confirmed working but deliberately not completed here.

---

## Part 6 — Product feedback pass (2026-09-08, post-deploy): agent lifecycle, key revocation, workspace URLs, naming

The user (not a QA pass this time — direct product feedback after using the fixed app) flagged four items. Two were verified live before writing this up.

### 1. No way to delete an agent (Confirmed live gap)

The agent detail page (`/w/:id/agents/:agentId`) has an Enabled/Disabled toggle but no Delete action anywhere — no Danger Zone section, confirmed by scrolling the full page. There's no way to remove an agent from a workspace at all, cascading or otherwise.

**Recommendation:** add a Delete-agent flow that mirrors the existing Delete-workspace pattern for consistency (Danger Zone section, type-the-agent-name-to-confirm dialog). On confirm, it should cascade-revoke every live key that agent holds automatically — don't force the user to revoke each key by hand first, that's friction with no safety benefit. The confirmation dialog should state the blast radius plainly, e.g. "This will permanently delete test01 and revoke its 1 live key. This cannot be undone." This is the natural third case alongside the workspace-level and member-level cascading revocation already designed in `14-admin-panel-and-billing-design.md` and `06-security-privacy-legal.md`.

### 2. No way to reactivate a revoked key (Confirmed live — recommend against building this)

Confirmed live: a revoked key's row just shows a permanently greyed-out, disabled "Revoke" button. No alternative action.

**Recommendation: don't add reactivation.** This is intentional, not a gap — it's the same one-way model every major API-key product uses (GitHub, Stripe, AWS, Vercel): revocation is a security kill-switch, not a pause button. If a revoked key could be turned back on, that undermines the entire reason to revoke one (e.g. a leaked key that was revoked for cause could be silently reactivated), and it makes "Revoked" in the audit log stop meaning "permanently dead." The correct recovery path — mint a new key — already works well.

What's actually worth fixing here is the *messaging*, not the capability: right now a user hits a dead greyed-out button and has to guess why. Add a short inline note next to it ("Revoked keys can't be reactivated — mint a new key when you need one") and say the same thing in the revoke confirmation dialog before they commit, so the permanence is communicated at the moment it matters instead of silently.

### 3. Workspace ID visible in the browser URL

The user wants it out of the URL. Since the workspace ID isn't actually a secret today — access is enforced by login and workspace membership, not by the ID being hard to find (Stripe, GitHub, and Vercel all show account/org IDs in their URLs the same way) — there were meaningfully different ways to satisfy "hide it," so this was put to the user directly rather than guessed. Asked to choose between (a) a cosmetic slug replacing the raw ID in the URL while the real ID keeps working underneath, or (b) truly removing any workspace identifier from the URL by moving workspace context into session state (which breaks bookmarking a specific workspace and breaks having two tabs open on two different workspaces at once), the user had no preference — so this proceeds on **(a), the cosmetic-slug approach**, as the lower-risk default that gets the visible outcome they asked for without the usability regressions of (b).

**Recommendation, concretely:**
- Generate a URL-safe slug per workspace at creation time (from the workspace name; de-duplicate within the account if two workspaces would collide, e.g. `my-workspace`, `my-workspace-2`).
- Switch dashboard routes to `/w/:slug/...` instead of `/w/:workspaceId/...`. The real `ws_...` ID keeps working exactly as it does today everywhere else (API calls, MCP config, Settings → Workspace ID field) — only the *dashboard* URL changes what it displays.
- Keep the slug stable across a workspace rename (don't regenerate it when the name changes) — this preserves the existing, correct principle already stated in the UI today ("Renaming never changes URLs or API paths").
- Make the old raw-ID dashboard URL still resolve (redirect to the slug URL) so existing bookmarks and any links already shared don't break.
- Be explicit with the user, once built, that this changes what's *displayed*, not what's *secret* — the real workspace ID is still visible in Settings, in API responses, and in the DOM, so this is a legibility/URL-hygiene improvement, not a new security boundary.

### 4. "Agents" naming risks implying an agent-hosting feature

**Recommendation:** rename the sidebar nav item from "Agents" to **"Agent identities."** This isn't a new concept to introduce — it reuses the exact phrase already on the page itself ("The identities your AI systems use to reach this workspace"), so the fix is just making the nav label say what the page already says. Leave the "AGENT ACCESS" section header, the `/agents` URL path, and the `agt_...` ID prefix unchanged — those aren't part of the confusion and don't need to churn.

---

## Prompt to hand to the coding agent (Part 6 items)

```
Four product-feedback items from the person using the app directly, after the
previous fix pass (see Parts 1-5 of this doc for that context). Read this whole
document section (Part 6) before starting — it explains the reasoning, not just
the instruction, for each item.

1. Add a "Delete agent" flow to the agent detail page
   (/w/:workspaceSlug/agents/:agentId), matching the existing Delete-workspace
   pattern in Settings -> General for consistency: a Danger Zone section, a
   confirmation dialog requiring the agent's exact name typed before the delete
   button enables. On confirm, cascade-revoke every live key the agent holds
   automatically (don't require the user to revoke keys one at a time first).
   State the blast radius in the dialog, e.g. "This will permanently delete
   {agent name} and revoke its {N} live key(s). This cannot be undone." This
   should follow the same real-endpoint, real-gating standard as the workspace
   delete flow already built (Firebase-user-only, owner-appropriate role check,
   exact-name confirmation) -- not a fake-success button.

2. Do NOT add key reactivation -- this is intentional, not a gap (revocation is
   a one-way security kill-switch, matching GitHub/Stripe/AWS/Vercel). Instead,
   improve the messaging around it: add a short inline note next to a revoked
   key's disabled Revoke button ("Revoked keys can't be reactivated -- mint a
   new key when you need one"), and state the same permanence in the revoke
   confirmation dialog before the user commits to revoking, so it's communicated
   before the action, not just implied after.

3. Replace the raw workspace ID in dashboard URLs with a per-workspace slug:
   - Generate a URL-safe slug per workspace at creation time, derived from the
     workspace name; de-duplicate within the account on collision (e.g.
     my-workspace, my-workspace-2).
   - Change dashboard routes from /w/:workspaceId/... to /w/:slug/... . The real
     ws_... ID must keep working unchanged everywhere else it's used today --
     API calls, MCP config snippets, the Settings -> Workspace ID field -- this
     is a dashboard-URL-only change, not an ID change.
   - Keep the slug stable across a workspace rename -- do not regenerate it when
     the name changes, so URLs don't rot. This preserves the existing "Renaming
     never changes URLs or API paths" principle already shown in the UI.
   - Make old raw-ID dashboard URLs (/w/ws_.../...) still resolve, redirecting
     to the new slug URL, so existing bookmarks keep working.
   - This is a display/URL-hygiene change, not a new access-control boundary --
     don't remove or hide the real workspace ID from Settings, API responses,
     or anywhere else it's genuinely needed.

4. Rename the sidebar nav item "Agents" to "Agent identities" (reuse the exact
   phrase already used in that page's own subtitle -- don't invent new wording).
   Leave the "AGENT ACCESS" section header, the /agents URL path, and the
   agt_... ID prefix exactly as they are -- only the nav label text changes.

After each fix, verify it the same way prior fixes in this doc were verified:
check across at least two real workspaces where relevant (item 3 especially --
confirm both a fresh slug and an old raw-ID bookmark resolve correctly on more
than one workspace), and don't touch anything not listed above.
```

---

## Part 7 — Coding agent's formal closeout on Parts 1-5 (commit `22ae873`, dev clean)

After the live verification in Part 5, the coding agent sent a second, more detailed closeout of that same round (not new work — Part 6 has not been started yet). It adds exact code citations and a test count that corroborate the independent live verification already done:

- **P0 (MCP scope display bug):** confirmed backend-only was always correct — `tools/list` filters on the connecting key's real `ops` (`server.ts:162`), `tools/call` re-asserts independently (`server.ts:194` → `auth.ts:245-247`), and file/folder handlers re-check the path prefix (`files.ts:220`). A read-only key could never actually write; `test/mcp.test.ts` already covered this exact scenario (18/18 passing) before the display was fixed. Matches what Part 5 observed live.
- **P1-P3 items:** Agents tile, Workspace ID, account menu, password form, sessions table removal (with the previously-fake "sign out everywhere" button now actually calling `POST /v1/me/logout-all`), MCP badge/empty-state, and Privacy tab — all match what Part 5 verified live, now with file-level citations. Billing confirmed via a deferred-promise test as a genuine fix, not a race condition. Files-page latency confirmed as real (measured Worker response 130-250ms, three serial round trips), tracked as `backlog/027` rather than "fixed."
- **Coverage added:** 31 new web tests, 10 new API tests, paired across a workspace with data and one without — matching the cross-workspace verification standard this doc has asked for throughout.
- **Still open, by design, not oversight:** the three test workspaces ("Abc", "Tk0", "after-new") remain undeleted — the coding agent correctly treated "build the delete endpoint" as authorizing the capability, not authorizing its use on real data, and left the decision to the user. The privacy policy still carries its own "not reviewed by a lawyer" banner — the coding agent only corrected factually-false statements, and treated actual legal sign-off as a human decision, not an engineering one.
- **Part 6 (delete-agent, key-revocation messaging, workspace-slug URLs, "Agent identities" rename) has not been started** — that prompt is still pending, to be sent whenever the user chooses.

### Security note — recurring prompt-injection attempt against the coding agent (flag for the user, not yet investigated)

Independent of the product bugs, the coding agent reported that an instruction telling it to abandon its dedicated file-editing tools in favor of raw `sed`/`cat` has now appeared **twice** in its session — once embedded in a tool result, and a second time in what it described as "a system-turn block." Both times it correctly refused, on the same grounds this project's own instruction-source rules require: an instruction that didn't come from the user, arriving through tool/system channels rather than direct request, contradicting the environment's own stated tool guidance, is data to be reported, not a command to follow.

This is worth the user's direct attention, separately from anything in this doc's product findings: a directive attempting to change a coding agent's core tool-use behavior, recurring and escalating in where it's injected from, is the shape of a prompt-injection attempt against the development environment itself — not the AgentDisk product being tested. Recommended next step: check what's newly present in the coding agent's context between the two occurrences (an MCP server's tool descriptions/output, a file in the repo it read, a CI log, or any other content the session ingests) for embedded instruction-like text, since that's the most common vector for this pattern. This is outside the scope of what this document's live-browser verification can check.

---

## Part 8 — End-to-end functional/permission test, real disposable workspace (2026-09-08, same day as Part 5-7)

While the coding agent worked Part 6 in the background, a separate hands-on pass exercised the actual data plane end to end — not menus this time, but the real permission model: create an agent, mint two differently-scoped keys, upload through them, probe every combination of scope and path, disable/enable the agent, revoke a key, mint a replacement, test webhook delivery, then tear everything down. All of it ran against a brand-new, disposable workspace (`QA Combo Test`, `ws_01M20S2FQ09FZB5P0PSPHHJT1T`) created and destroyed within this pass — no real workspace or data was touched. Every check below was verified at the REST API level via `fetch()` calls carrying the actual minted keys (not just by reading the UI), so these are real authorization outcomes, not display text.

### What was tested and the result

**Path-prefix and operation-scope enforcement (independent dimensions, both correct).** Two keys were minted for one agent: Key1 scoped `read, write, list` on `/path1/*`, Key2 scoped `read, list` on `/path2/*`. Every combination behaved exactly as it should:

| Check | Expected | Actual |
|---|---|---|
| Key1 writes inside `/path1/*` | 201 | 201 ✅ |
| Key1 writes outside its path (`/path2/*`) | 403 | 403 `FORBIDDEN` ✅ |
| Key2 writes inside its own path (`/path2/*`) — has no `write` scope | 403 | 403 `FORBIDDEN` ✅ |
| Key2 lists inside its own path/scope | 200 | 200 ✅ |
| Key1 lists outside its path | 403 | 403 `FORBIDDEN` ✅ |
| Key1 downloads its own file (has `read`) | 200 + URL | 200 + URL ✅ |
| Key2 downloads a file outside its path | 403 | 403 `FORBIDDEN` ✅ |
| Key1 deletes a file — has no `delete` scope | 403 | 403 `FORBIDDEN` ✅ |

Path restriction and operation scope are enforced as genuinely independent, additive checks (both must pass), matching the design intent and the coding agent's own P0 code citations from Part 7.

**Agent disable/enable overrides key scope, in real time, with no propagation delay.** Disabling `qa-bot` via its detail-page toggle immediately (next request, not eventually) turned a previously-valid Key1 call into `401 UNAUTHORIZED`, even though the key's own scope and path were untouched and still valid — confirming the agent-level switch is a hard, independent gate above per-key scope, not a UI-only restriction. Re-enabling immediately restored the same call to `200`. One cosmetic-only bug found here: after clicking the toggle, the page's own badge/status card/toggle stayed on the *old* state for roughly 2 seconds before updating (confirmed reproducible in both directions) — a pure rendering lag, since the backend had already applied the change (a fresh reload showed the correct state instantly, and the API calls above show enforcement was already live during that window). Low severity, but worth an optimistic UI update or a spinner on the toggle itself so an admin doesn't click it twice thinking it didn't register.

**Key revocation is confirmed genuinely permanent — this closes the loop on the user's own finding.** This directly extends what the user found in the last pass ("once revoke, we can't reactivate the key"): revoking Key1 turned it into an immediate `401` at the API, the row's own Revoke action correctly disables itself once revoked, and there is no reactivate control anywhere in the UI. Going one step further than a UI check, a direct `PATCH /v1/keys/:id {status: "active"}` call against the revoked key (using the real human session token, not the dead key itself) returned `404 NOT_FOUND — "No such route."` — meaning there is no backend endpoint for this at all, not just a missing button. This confirms revocation is a deliberate, one-way design decision (matching GitHub/Stripe/AWS/Vercel convention), not an oversight, and the correct recovery path — mint a new key for the same agent — works cleanly: the replacement key was immediately functional on the same path/scope.

**Delete-agent-with-cascade is now built and works correctly — this is the fix for the user's other own finding.** The user's earlier product feedback ("there no option to delete agent, like something delete agent with all keys or delete keys and then can delete agent") has been addressed: clicking delete on an agent that still has active keys now shows a clear warning — *"This agent still has active credentials. This agent has 2 active API key(s). Revoke them first, or delete anyway to revoke and delete together."* — with a "Delete anyway" option. This was tested against a live agent still holding 2 active keys, and it was verified independently at the API level (not just the confirmation toast) that both keys returned `401` immediately after the single delete action — a real cascade, not UI theater. The revoke-key confirmation dialog copy also now reads "This cannot be undone," addressing the user's other request (better messaging around the intentional one-way revoke, rather than adding reactivation).

**Webhooks are a real, working feature** (not previously exercised in this project's testing). A `file.created` endpoint was registered against a live test receiver; the create flow issues a per-endpoint HMAC signing secret (`whsec_...`, shown once, matching the API-key create pattern) and enforces HTTPS-only URLs with an inline explanation ("plaintext delivery would put file paths on the wire"). Triggering a real upload produced a real HTTP delivery within seconds, correctly signed (`agentdisk-signature: t=<timestamp>,v1=<hmac>`, matching the replay-resistant scheme described in the architecture doc), with a deliberately minimal payload (event id/type/workspaceId/occurredAt plus just the file's id/path/sizeBytes — not the full file object). This is a solid, working implementation with no issues found.

**Workspace deletion, re-confirmed as a genuine complete wipe.** Following up on the user's direct question earlier this session ("if someone delete the workspace will it delete files, keys etc a complete wipe?"): after deleting `QA Combo Test` (via the type-the-workspace-name-to-confirm flow), a direct API call to that workspace — using the owner's own still-valid session token — returned `403 FORBIDDEN — "This workspace is unavailable."` Not just "empty," genuinely inaccessible, immediately, even to its own owner. The UI also redirected cleanly back to a real remaining workspace rather than showing a dead page. One minor copy note: the Danger Zone warning text lists "all files, agents, and API keys" but doesn't mention webhooks by name — cosmetic only, since the wipe is confirmed total regardless.

**Two other things noticed in passing, not part of the original test plan:**
- The agent detail page's "Last seen" stat showed "Never / Has never authenticated" for the *entire* test, even while that same agent's own Recent Activity feed correctly listed a real `file.created` event, and the API keys table's own "Last used" column correctly showed "just now" for the same key. The underlying usage data is being recorded correctly (both other surfaces prove it) — only the agent-level rollup stat isn't reading it. Low severity, cosmetic/observability only, but actively misleading for anyone checking "has this agent ever been used."
- The `Abc` workspace (previously confirmed real, with a real agent `007F`, during the Part 1-5 testing) is still absent from the workspace switcher, alongside `My Workspace`, `Tk0`, and `after-new`. This was first noticed mid-session before this pass and is flagged again here since it's now confirmed not to be a one-off UI glitch — it's consistently gone. This wasn't something this pass caused (it was already missing before `QA Combo Test` was created), and Part 7 records that the coding agent explicitly left `Abc`/`Tk0`/`after-new` untouched by design. Worth the user checking directly whether they deleted it themselves, since nothing in this project's own testing did.

### Bottom line

Every permission and lifecycle mechanism tested — path scope, operation scope, agent enable/disable, key revocation-without-reactivation, key replacement, cascade agent deletion, webhook delivery, and workspace deletion — produced the correct, secure result when checked directly against the API, not just the UI. No new security issues were found in this pass; the two new items (agent "Last seen" not updating, and the ~2s toggle-render lag) are both cosmetic. The two product gaps the user personally found in the previous pass (no delete-agent-with-cascade, no clarity on revoke-permanence) are now confirmed fixed and independently re-verified working. The `Abc` workspace's continued absence remains an open question for the user, not this testing pass, to resolve.

---

## Part 9 — Post-"17th fix" re-verification + real MCP-protocol testing (2026-09-08/09), and the MCP path-scope bypass

Everything above this point (Parts 1-8, and doc `17-dev-environment-live-test-findings.md`) was tested either through the UI or through **REST** calls carrying real keys. This pass had two goals: (1) re-check every open item from doc 17 and from Part 6 of this doc now that "the 17th fix" has deployed, and (2) actually drive the **MCP JSON-RPC endpoint itself** (`POST /mcp`, `tools/list` / `tools/call`) end to end, which had never been done — everything before this was REST-equivalent testing of the same permission model, not the MCP transport a real Claude/Copilot-side agent actually uses. That distinction turned out to matter: MCP and REST do **not** currently enforce the same rules.

All of this ran in a new, disposable workspace (`MCP Protocol QA`, `ws_01M21KCSFD7B1FHTEACTD9FN0Z`) created and fully torn down at the end of this pass, plus one throwaway zero-agent workspace (`Onboarding QA Fresh`) used only to re-check doc 17 finding #1 and deleted immediately after. No real workspace or data was touched.

### 9.1 — Doc 17 findings, re-verified post-deploy

| # | Finding | Status now |
|---|---|---|
| 1 | Create API Key flow dead-ends for a brand-new user (no agents to pick) | **Fixed.** Re-tested in a genuinely fresh, zero-agent workspace: the Agent field in Create API Key is now optional and defaults to "No agent (workspace-level)" — a key can be minted with zero agents in the workspace, no dead end. |
| 2 | `/w/:workspaceId` doesn't validate the ID — silently substitutes the user's real workspace | **Still broken**, re-confirmed this pass (same silent-substitution behavior as originally reported). |
| 3 | No baseline security headers (CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy) | **Still broken**, re-confirmed this pass — all still `null`. |
| 4 | Scope-naming (`files:read` vs `read`) display bug on MCP connection page | **Fixed.** |
| 5 | Settings → General hardcoded/mocked Workspace ID | **Fixed** — now shows the real ID. |
| 6 | Settings → Security legacy pre-Firebase UI (password form, empty sessions table) | **Fixed** — legacy UI removed. |
| 7 | Settings → Billing contradictory plan data | **Fixed** — now consistent with Dashboard/Usage. |
| 8 | Dead documentation link | **Fixed.** |
| 9 | 404 vs. 401 inconsistency on missing vs. invalid credentials | **Still broken**, re-confirmed this pass (missing credential still 404s; invalid credential still 401s). |

Net: 6 of 9 fixed, including the highest-priority item (#1, the onboarding dead-end). The three still open (#2, #3, #9) are the same three carried forward from the last pass — none regressed, none newly fixed.

### 9.2 — Doc 18 Part 6 items, re-verified post-deploy

- **Workspace slug URLs** (`/w/<slug>/...`, e.g. `/w/mcp-protocol-qa/`, `/w/onboarding-qa-fresh/`) — confirmed live and auto-generated on every workspace created this pass. Old raw-ID URLs weren't separately re-tested this pass (no regression signal to suggest they'd stopped working).
- **"Agent identities" sidebar rename** — confirmed still deployed, replacing "Agents," across every workspace used this pass.

### 9.3 — New finding: workspace rename is a silent no-op ("fake success"), High severity

Renaming a workspace via Settings → General → Save changes shows a success indicator, but the rename **does not persist** and **fires zero network requests** when Save is clicked (confirmed with `read_network_requests` cleared immediately beforehand — nothing left the browser at all) and was independently confirmed not to have persisted via a direct read-only `GET` against `/v1/workspaces` using the real session token. This reproduced twice, on two different rename attempts. This directly matches a previously-flagged-but-unverified suspicion from Part 5 of this doc ("Settings → General 'Save changes' fake rename") — it's now a confirmed, real bug: the Save button's click handler for the name field isn't wired to any API call, while showing the user a false confirmation that it worked.

### 9.4 — Real MCP-protocol testing: three scenarios

Each scenario used freshly created, disposably-scoped agents/keys, driven via raw `fetch()` JSON-RPC calls against `/mcp` carrying the actual bearer key (not the UI), with key material extracted directly from the DOM immediately after creation (never transcribed from a screenshot) to eliminate any risk of testing against a mistyped key.

**Scenario 1 — operation scope (agent `t01`, one write-only key + one read-only key): PASS.** `tools/list` correctly returned only the tools matching each key's own scope (write key saw `create_file`/`update_file`/`create_folder`/`move_file`/`copy_file`; read key saw `list_files`/`search_files`/`get_file`/`get_metadata`). Critically, the server also **re-checks scope on `tools/call` independently of what `tools/list` advertised** — attempting a write-scoped tool with the read-only key (and vice versa) was rejected with a proper JSON-RPC error (`-32600`, "This key isn't allowed to perform that operation."), not merely hidden from the tool list. This is genuine defense-in-depth and matches the operation-scope enforcement already verified at the REST layer in Part 8.

**Scenario 2 — path scope (agent `t02`, two read+write keys, one restricted to `/path1/*`, one to `/path2/*`): FAIL — this is the headline finding of this pass.** With REST, the identical keys correctly returned `403 FORBIDDEN` for any operation outside their assigned path (matching Part 8's REST-level verification). Over MCP, however, **the path restriction is not enforced at all**: the `/path1/*`-scoped key was able to `create_file` and `list_files` under `/path2/*` (and vice versa) with a normal successful JSON-RPC result — no error, no denial. This was verified twice with independently re-minted, DOM-verified keys after an initial run produced a suspicious asymmetric result that turned out to be a key-transcription mistake on this tester's part (caught and ruled out via a REST cross-check before concluding anything) — the bypass reproduced cleanly both times with confirmed-correct key material.

Concretely: `pathPrefix` scoping — the only mechanism a workspace owner has to let one agent touch `/invoices/*` and a different agent touch `/logs/*` in the same workspace — **only holds at the REST API**. Any agent talking to AgentDisk over MCP (i.e., every Claude/Copilot/other MCP-client integration, which is the product's core interface for AI agents) currently has full read/write/list access to the entire workspace regardless of its key's configured path restriction, as long as the operation itself (read/write/list) is within scope. Operation-scope (Scenario 1) is enforced correctly at both layers; path-scope is enforced only at one. This should be treated as a real security bug, not a display issue — it silently defeats the path-isolation feature specifically for MCP clients, which is presumably the primary way most agents will actually connect.

**Scenario 3 — agent lifecycle via MCP (new agent `t01-life`, disable → re-enable → delete → delete workspace):**

- *Create + baseline:* a freshly minted key worked immediately over MCP. ✅
- *Disable:* MCP access was denied immediately and consistently, with a distinct, correctly-worded error (`"That credential isn't valid."`, distinguishing a disabled-agent denial from an in-scope-but-forbidden-operation denial). Matches the instant REST-level revocation already confirmed in Part 8. ✅
- *Re-enable:* mixed result, characterized carefully across two separate runs. In the first run (the original two lifecycle keys), MCP calls kept failing for 50+ cumulative seconds across repeated retries after the UI and REST had already confirmed the agent was genuinely re-enabled (`agentStatus: "active"`) — a real delay measured directly against the API, distinct from the already-known ~2 second cosmetic UI-toggle-render lag (Part 8). That specific pair of keys couldn't be re-tested further after a session hiccup (an unrelated, unexplained mid-task redirect to the login screen dropped the in-memory key values, which are only ever shown once and can't be recovered from the masked UI). A second, tightly controlled re-run — fresh key, same agent, disable → enable → immediate MCP call, all in one continuous browser session — showed access restored within about 21 seconds of clicking Enable, i.e. a real but bounded lag, not a permanent failure. **Net characterization: unlike disable (instant), re-enable at the MCP layer can take up to roughly a minute to take effect, most likely a permission-cache TTL that isn't being invalidated eagerly on re-enable the way it is on disable.** Worth a fix (invalidate the cache/flag eagerly in both directions) even though it isn't a security hole — the risk is the opposite of one: an operator who disables-then-immediately-re-enables an agent (e.g., during a key rotation) could see confusing spurious failures for up to a minute afterward. ⚠️
- *Delete agent:* both keys correctly and immediately revoked (MCP calls denied). ✅ However, the agent's files were **not** deleted along with it — `lifecycle-baseline.txt`, `lifecycle-reenabled-t0.txt`, and others remained fully present and downloadable in the workspace's Files list after the agent was gone, still attributed to the now-nonexistent agent ID as "Created by." To be fair to the product, the delete-agent confirmation dialog only ever promises "permanently delete `t01-life` and revoke its N live keys" — it never claims to delete files — so this isn't a broken promise. But it is a real data-hygiene gap worth flagging: every file an agent ever wrote outlives that agent forever, orphaned under a dead agent ID, unless a human separately notices and deletes it. This is a meaningfully different (and lesser) scope than the cascade-delete behavior Part 8 already verified — that test only checked that keys are revoked, not that files are cleaned up, since the agent under test there hadn't written any files at the time of deletion. ⚠️
- *Delete workspace:* fully verified as a complete wipe, consistent with Part 8. The workspace disappeared from the switcher entirely, and a direct lookup of its old ID against the API returned `404`. ✅ (This step also confirms, incidentally, that files _do_ get cleaned up when the whole workspace goes — just not when a single agent within it does.)

### 9.5 — Other things noticed in passing

- **Agent "Last seen" still never updates**, even after several genuine, successful MCP calls in the same test session (stayed "Never" throughout) — the same low-severity observability gap Part 8 already flagged, re-confirmed still present post-deploy. The per-key "Last used" column and the agent's own Activity feed both correctly reflect real usage, so the data exists; only this one rollup stat isn't reading it.
- **Cosmetic key-masking mismatch:** the API keys table renders every masked key with the prefix `ad_live_••••••••XXXX`, but the actual raw key (visible once, at creation) is prefixed `ask_live_...` — the masking logic appears to be dropping a character. Harmless, but worth a fix so the masked value in the table is a true prefix-match of what a user actually has stored somewhere.

### 9.6 — Priority recommendation given the user's stated goal of a public MCP launch

The MCP path-scope bypass (9.4, Scenario 2) should be treated as a **blocker for public distribution**, not a backlog item — the entire value proposition of per-key path restriction (letting one workspace safely host multiple agents/tenants/projects with hard boundaries) is currently void for every MCP client, which is the access pattern a public "install this MCP server" launch is specifically inviting. The fake-rename bug (9.3) and the re-enable lag (9.4, Scenario 3) are real but lower-stakes; the orphaned-files-on-agent-delete gap (9.4, Scenario 3) is worth a deliberate product decision (either cascade-delete the files too, or make the "files outlive the agent" behavior explicit in the confirmation copy) rather than a silent gap.

---

## Part 10 — Guide: publishing the AgentDisk MCP server for public installation

See the companion document `19-mcp-public-distribution-guide.md` for the full, standalone guide (one-line install snippets for Claude Code/claude.ai/VS Code+Copilot/Cursor, MCP Registry submission process, and the OAuth-vs-bearer-key tradeoff for a public launch) — kept separate from this audit doc since it's a forward-looking how-to rather than a test finding.
