---
description: Marketing daily check — read every funnel number, fire the decision rules, append to the log
allowed-tools: Read, Edit, Bash(gh repo view:*), Bash(gh api:*), Bash(curl:*), Bash(npm view:*), Bash(date:*)
---

# mcheck

The daily marketing check for AgentDisk. Reads every number in
`Skill/14 Marketing and Sales.md` §9 from its real source, compares it against
the last log entry, states which decision rule fired, and appends one line to
the log.

Takes about two minutes. **Most days nothing will have moved, and that is the
expected result** — say so plainly rather than manufacturing a narrative.

---

## Procedure

### 1 · Read the plan

Read `Skill/14 Marketing and Sales.md` in full. §7 holds the decision rules and
§10 holds the previous entry. Everything below is measured against those two.

### 2 · Gather the numbers

Run these. A failure is a result, not a blocker — record it and carry on.

```bash
# Distribution
curl -sS https://api.npmjs.org/downloads/point/last-week/agentdisk
curl -sS -o /dev/null -w '%{http_code}\n' https://registry.npmjs.org/agentdisk
curl -sS "https://registry.modelcontextprotocol.io/v0/servers?search=agentdisk"
gh repo view connect-ad/agentdisk --json stargazerCount,description,homepageUrl,repositoryTopics
gh api repos/connect-ad/agentdisk/traffic/views --jq '.count, .uniques'
```

**The funnel** — GA4 property `556215733` via the analytics MCP. Pull last 7
days for `sandbox_created`, `file_stored`, `sign_up`, `purchase`, plus users
and sessions.

If the MCP returns a reauthentication error, say so in one line and tell Karim
to run `gcloud auth application-default login`. Do not guess the numbers and do
not silently skip them — a missing funnel is the single most important thing
on the report.

**Paid** — only while Campaign #1 is enabled. Read the Google Ads overview in
Chrome for impressions, clicks, cost and conversions. Read only; the classifier
blocks writes to the Ads account.

**Revenue** — Stripe MCP, read: active subscriptions and MRR.

### 3 · Fire the rules

Walk §7 top to bottom and name every rule that fired. If none fired, say
"no rule fired" — do not invent one.

Two ratios matter more than any absolute number:

- `file_stored ÷ sandbox_created` — the activation rate. Below 30% stops all
  marketing and sends the work to the product.
- `sign_up ÷ file_stored` — the commitment rate.

Both are meaningless below roughly 20 sandboxes; say "not enough data" rather
than reporting a ratio built on three events.

### 4 · Report

Short. In this order:

1. **Did anything move?** One sentence. "No" is a complete answer.
2. The numbers, as a table, with the change since the last entry.
3. Which decision rule fired, and the action it calls for.
4. Blocked items from §5 that need Karim's hands — npm publish, registry
   submissions, the Ads conversion rule, pausing the campaign. Repeat these
   every day until they are done; they are the critical path.

### 5 · Append to the log

Add one row to §10 of `Skill/14 Marketing and Sales.md`, newest first. One
line: what changed, what moved, what was decided. If nothing moved, write that
— a flat log that is honest is more useful than one that reads well.

Do not rewrite earlier rows. Do not let the log grow unbounded: once past 30
rows, collapse the oldest week into a single summary row.

---

## Rules

- **Never fabricate a number.** A source that failed is reported as failed.
- **Do not act on noise.** One day's movement is noise. The rules in §7 are
  written against weekly figures for that reason.
- **Do not propose new channels during the check.** The check reports and
  acts on the existing plan. Channel changes belong in a conversation, against
  the arithmetic in §2.
- **Keep the critical path visible.** While npm is unpublished and the MCP
  registry entry is missing, nothing else in the plan can work. Say it every
  day until it is fixed.
