# AgentDisk — Live Dev Environment Test Findings

**Date:** 2026-09-07
**Target:** `https://app-dev.agentdisk.io` (dev), API at `https://api-dev.agentdisk.io`
**Method:** Real browser session (Claude in Chrome), authenticated as the real logged-in account (`kernelv5@gmail.com`), workspace `ws_01M1WTCVFG3VEX6VRHCZWN1SK2` ("My Workspace"). No destructive actions were taken — no workspace deletion, no real API keys/agents created, no sign-out attempted (would have required completing a real login on the user's behalf, which is out of scope for the tester).

This is a point-in-time QA pass against the deployed dev environment, not a code review. Each finding below is evidence-backed (network trace, DOM inspection, or screenshot) rather than inferred.

---

## Findings, most important first

### 1. Create API Key flow dead-ends for a brand-new user (High)

The "Create API key" modal has a **required** `Agent` dropdown. On a fresh workspace this dropdown has **zero options** (confirmed via DOM: `<select id=":r1:" class="select__el"></select>` — no `<option>` children at all), and the modal offers no inline "create an agent" action. Meanwhile, the Dashboard's own **Quick start** panel tells a new user to *"Mint an API key, then have an agent write its first file"* — it never mentions that an **Agent** identity has to be created first, on a separate page (`Agents` in the sidebar).

Net effect: a first-time user who follows the product's own onboarding copy literally (API keys → Create key) hits a required field with nothing to select and no way to proceed, unless they happen to discover the unlinked Agents page on their own. The Agents → "Create an agent" flow itself works fine (just Name + optional Description) once found — this is purely a sequencing/discoverability gap, not a broken feature.

**Suggested fix:** either add an inline "+ Create new agent" option inside the Agent dropdown, or update the Quick Start copy to say "Create an agent, then mint a key for it."

### 2. `/w/:workspaceId` doesn't validate the ID — silently falls back instead of 404ing (High)

Navigating to a syntactically-plausible but nonexistent workspace ID (`/w/ws_00000000000000000000000000`) does **not** produce a "workspace not found" error. Network trace during that navigation:

```
GET /v1/workspaces                                              → 200
GET /v1/whoami?workspaceId=ws_01M1WTCVFG3VEX6VRHCZWN1SK2         → 200   (the REAL workspace ID)
GET /v1/files?limit=5&workspaceId=ws_01M1WTCVFG3VEX6VRHCZWN1SK2  → 200   (the REAL workspace ID)
```

The browser's address bar still shows the bogus ID, but the app silently queries and renders the user's actual default workspace instead — labeled generically as **"Workspace"** (not "My Workspace," which is the real workspace's actual name), with all-zero stats matching the real (empty) account.

The same behavior occurs with an HTML/script-injection-style path segment (`/w/%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E`) — no reflected-XSS execution was observed (good), but it falls back the same silent way rather than erroring.

For contrast, a genuinely unknown **top-level** route (`/this-route-does-not-exist-zz9`) renders a correct, clean 404 page ("404 — We couldn't find that page" + "Go to dashboard"). So the app has a working 404 mechanism — it's just not applied inside the `/w/:workspaceId` segment.

This isn't a cross-tenant data leak (it only ever shows the authenticated user's own data), but it's a real correctness/trust issue: a stale bookmark, a typo, or a link to a workspace that was since deleted silently and invisibly redirects the user's session to a *different* workspace's data while the URL still shows the wrong ID. In an account with multiple workspaces, this is exactly the kind of silent-substitution bug that makes a destructive action land somewhere the user didn't intend.

**Suggested fix:** validate the `:workspaceId` path param against the user's workspace membership before rendering; show the same 404 (or a "workspace not found/no access" variant) when it doesn't match, rather than silently substituting another workspace.

### 3. No baseline security headers on the main document (High)

`fetch(location.origin)` from within the authenticated page returned **null** for every one of the following:

| Header | Value |
|---|---|
| `Content-Security-Policy` | null (no header, no `<meta>` tag either) |
| `Strict-Transport-Security` | null |
| `X-Frame-Options` | null |
| `X-Content-Type-Options` | null |
| `Referrer-Policy` | null |

No clickjacking protection, no CSP-based XSS mitigation, no MIME-sniffing protection, and no HSTS. Worth closing before public launch — these are typically a few lines in the Worker's response headers.

### 4. Scope-naming conflict is confirmed real but narrower than previously flagged (Medium)

Good news first: the actual **Create API Key** modal uses the correct bare scope names — checkboxes labeled `Read`, `Write`, `Delete`, `List` — matching the REST/MCP spec exactly. The permission model itself is right.

The `files:read` / `files:write` / `files:delete` naming previously flagged as a "Hard Gate" is confirmed to be a **display-only** bug, confined to the **MCP connection** page's scope badges. Still worth a quick fix for consistency (a badge showing `files:read` next to a key that was actually minted with bare `read` will confuse anyone comparing the two screens), but it's cosmetic, not a functional/security issue.

### 5. Settings → General shows a hardcoded/mocked Workspace ID (Medium)

The "Workspace ID" field in Settings displays `ws_8Kq2xR4mN7pL` — confirmed via DOM inspection to be a real, disabled input `value` (not a placeholder) — which doesn't match the real workspace ID (`ws_01M1WTCVFG3VEX6VRHCZWN1SK2`) used everywhere else (URL, all API calls). Dead/mock data that was never wired up.

### 6. Settings → Security still shows pre-Firebase legacy UI (Medium)

A full legacy "Change password" form (Current/New/Confirm) and an empty per-device "Active sessions" table (Device/Location/Last Active columns) are still present. The Firebase cutover plan (`16-firebase-auth-and-final-launch-prompt.md`, Phase 1/3) explicitly called for removing first-party password UI once Firebase owns auth — this wasn't cleaned up. There's also a "Single sign-on... available on Team plan" card, which is likely a legitimate, distinct concept (enterprise SAML SSO, per the original §8.23 design) rather than a leftover — but worth a one-line clarification in the UI so it isn't confused with the new Google/GitHub Firebase login buttons.

### 7. Settings → Billing shows contradictory plan data (Medium)

Billing tab reports **"Current plan: Pro — $20/month"** with a real-looking next-invoice date, while Dashboard and Usage both correctly report **plan = free**. Compounding this, the same Billing tab shows **"Payment method: Not set up"** alongside the supposedly-active paid plan — a strong signal the Billing tab is still fully mocked/hardcoded and was never wired to real `organizations.plan` / Stripe data.

### 8. Dead documentation link (Low)

The sidebar's "Documentation" link points to `docs.agentdisk.io`, which does not resolve (confirmed twice: "Frame with ID 0 is showing error page").

### 9. 404 vs. 401 inconsistency on missing credentials (Low)

```
GET /v1/workspaces  (no Authorization header)        → 404 {"code":"NOT_FOUND","message":"No such route."}
GET /v1/workspaces  (garbage/invalid bearer token)    → 401 {"code":"UNAUTHORIZED","message":"That credential isn't valid."}
```

Both cases are "you're not allowed in" and should probably both be 401 for consistency — a missing credential and an invalid one are the same class of problem from the caller's point of view. Worth noting the things that *are* working correctly here: the non-enumerating error message design, and the CORS/auth-gate ordering fix (the originally-reported production bug) both check out.

---

## What passed clean

- No reflected XSS: an HTML/script-tag-shaped workspace ID in the URL was not executed or rendered unescaped anywhere on the page.
- Unauthenticated and invalid-token requests are correctly rejected rather than leaking any data.
- A genuinely unknown top-level route renders a proper, clean 404 page.
- Cold dashboard load is clean: no console errors, all observed API calls succeeded (200s), and all domains in network traffic correctly use `agentdisk.io` (no leftover `agentdrive.dev` placeholders).

---

## Suggested priority order for fixes

1. Create API Key onboarding dead-end (#1) — blocks the entire "test as a real solution" path for a new user.
2. Workspace-ID route validation (#2) and missing security headers (#3) — both are pre-launch trust/security gaps.
3. Billing tab mock data (#7) and Workspace ID mock data (#5) — both are visible, embarrassing "half-wired" bugs if a real user pokes around Settings.
4. Legacy Security-tab cleanup (#6), scope-badge naming (#4), dead docs link (#8), 404/401 consistency (#9) — lower severity, quick cleanup items.
