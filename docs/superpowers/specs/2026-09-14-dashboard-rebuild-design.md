# Dashboard rebuild to the Claude Design spec — phase 2

Status: awaiting review
Design source: `AgentDisk Dashboard.dc.html` (1,488 lines)
Depends on: phase 1 (Site), which lands the accent-preset mechanism

## What is already done

The theme migration shipped the shell: top bar, workspace info strip, sticky
tab bar, colour toggle, and ten tabs carrying real hrefs. Layers 0, 1 and 3 of
the design are in place. This phase is the content of Layer 4 — the screens.

Layer 2, the persistent stats band across every screen, stays out: it needs a
usage fetch on every route, which worsens the first-paint problem
`backlog/027` tracks, and the stats already exist on Overview.

## The split that governs this phase

Checked screen by screen against the API. **Eight screens are restyling. Four
are designs for features that do not exist.**

| Screen | Backend | Work |
|---|---|---|
| Overview | exists | Restyle |
| Files | exists | Restyle (table, sort, selection, bulk bar, drawer) |
| Activity | exists | Restyle (filter chips, actor pills) |
| Agents | exists | Restyle |
| API keys | exists | Restyle + created-key modal |
| MCP connection | exists | Restyle + client picker |
| Webhooks | exists | Restyle |
| Usage | exists | Restyle (meters) |
| Settings → General, Members | exists | Restyle |
| Settings → Security | **none** | 2FA enforcement, IP allowlist, rotation warnings, session length are all unenforced (`backlog/017`) |
| Account | **partial** | Only `POST /v1/me/logout-all` exists. No session list, no per-device revoke, no photo upload, no delete-account |
| Billing → invoices | **none** | No invoice-list API; only Stripe webhook handling |
| Support | **none** | No endpoint of any kind |

## Policy for controls with no backend

Confirmed with the author: build the UI, wire what exists, visibly disable the
rest. That is only safe with a strict rule, because the failure mode it invites
is precisely the one `backlog/023` tracks — controls that report success for
work that never happened.

**The rule, and it admits no exceptions:**

1. A control with no API is rendered `disabled` with `aria-disabled="true"` and
   a visible "Not available yet" note adjacent to it. It is never merely styled
   to look inactive.
2. It **never** no-ops silently, and **never** reports success.
3. A list with no data source (sessions, invoices) renders an explicit empty
   state saying the data is not available yet. **It never renders the design's
   mockup rows.** Four invented invoices with amounts and refund statuses would
   be indistinguishable from real billing history.
4. Every disabled control gets a regression test asserting it is disabled, so
   the day an API lands, the test fails and points at the screen to finish.

Rule 3 is the one that matters most. The design's Account screen shows three
devices with per-row REVOKE, and its Billing screen shows four paid invoices.
Rendering either as drawn would be fabricating account history.

## Screen specifications

Each screen keeps its existing data fetching, mutations and error handling
untouched. This is a re-layout of the markup around them.

- **Overview** — four stat cards (label, flag, figure, unit, meter, limit),
  quick-start panel, recent activity. Stat figures use Outfit per the design's
  `stat/figure` role.
- **Files** — toolbar (new folder, upload, sort), table with a 7-column grid,
  checkbox selection with an accent-soft selected row, agent-vs-human dot on
  the "by" column, bulk-action bar on selection, and the file details drawer.
- **Activity** — actor filter (All / People / Agents), action filter, time
  range, rows with mono timestamp, actor pill coloured by agent-vs-human,
  action, target path, source IP.
- **Agents / Keys / Webhooks** — card or table layouts per the design, each
  with its existing create dialog re-laid-out.
- **Keys** additionally: the created-key modal — mono key, COPY, a warn-toned
  scope reminder, Done and "Use it in MCP setup".
- **MCP** — client picker, config block, tool list with per-tool scope badges.
  Tool availability keeps coming from the connecting key's real `scopes.ops`;
  CLAUDE.md is explicit that a screen must not compute permissions from a
  fixture.
- **Usage** — four meters with percentage and limit, history panel.
- **Settings** — five sub-tabs. General and Members restyle; Security renders
  per the design with every control disabled under the rule above.
- **Account / Billing / Support** — built to the design, with sessions,
  invoices and ticket submission showing the "not available yet" empty state.

## Accent presets

Phase 1 lands `data-accent` and the four presets. This phase adds the picker
to the top bar beside the colour toggle, matching the design's control group.

## Risk and testing

Higher risk than phase 1: these screens carry real data and real mutations,
and the create/delete paths are where a markup slip does damage.

1. Baseline: whatever phase 1 leaves green.
2. Every existing authed spec must stay green — they assert screens render,
   destinations are reachable, create dialogs open with a field in them,
   dialogs accept continuous typing and close on Escape.
3. New tests: one per disabled control asserting `disabled`, and one per
   no-data list asserting the empty state rather than rows.
4. No test may be weakened to accommodate a re-layout. If an assertion on an
   accessible name breaks, the name changed, and that is a finding.
5. `apps/web` unit tests stay green; adherence lint clean.

## Acceptance

- Eight backed screens match the design and keep every existing behaviour
- Four unbacked screens match the design with every unbacked control visibly
  disabled and every unbacked list showing an empty state, never mockup rows
- Accent picker works across all four presets in both colour modes
- Regression suite: no regressions
- Keyboard: drawer, modal and both menus trap nothing, close on Escape, and
  return focus to their trigger
