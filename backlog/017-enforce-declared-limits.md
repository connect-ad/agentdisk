# 017 · Enforce the limits the product already declares

**Status:** Open — found by the 8 Sept 2026 audit ([summary.md](../summary.md) F-01, F-02, F-03)

Four limits are declared, displayed to the user, and never enforced. Each is a
correct, tested helper that nothing on the request path calls with real data.

**1. The billing write-block never fires.** `withAuth` only reads the org's
billing status when `requirement.demand` says the request intends to write —
and **no route in `index.ts` ever sets `demand`**, so `billingStatus` is always
the hardcoded literal `"active"` (`middleware/auth.ts:253`). The three
route-level `assertWithinQuota` calls that do carry a real write demand omit the
argument entirely and take the `"active"` default (`files.ts:246`, `files.ts:360`,
`folders.ts:283`). A `past_due` or `canceled` account uploads freely while
`GET /v1/billing` returns `writesBlocked: true` and the dashboard shows
"New uploads are paused".

`test/billing.test.ts:217` passes `"past_due"` to `assertWithinQuota` by hand, so
it goes green. Nothing drives a real `POST /v1/files` against a `past_due`
workspace.

**2. Usage periods never reset.** `workspaces.period_reset_at` is written once at
creation and only ever read. Nothing advances it, and nothing zeroes
`egress_bytes_period`. Once it passes, `periodCounter` (`quota.ts:44`) returns 0
forever, so the egress cap stops being enforceable roughly one period after each
workspace is created — permanently. `whoami` keeps reporting the raw column,
which grows monotonically, so Usage eventually renders a red "you've reached your
egress limit" banner that is false.

**3. `requests_period` is never incremented.** `WorkspaceScopedCounters.apply`
handles `bytes`, `files` and `egressBytes` only (`workspace-scoped.ts:741`). The
request cap has never been enforced, and Dashboard/Usage present the
permanently-zero counter as a live metric with a meter.

**4. `PLAN_LIMITS.agents`, `.apiKeys` and `.members` are never read.**
`grep -rn "limits\.\(agents\|apiKeys\|members\)" apps/api/src` returns nothing.
Free advertises 3 agents / 10 keys / 1 member; all three are unlimited.

**To close:** decide for each whether to enforce it or stop advertising it. They
are grouped here because they share one root cause — the plumbing that would
carry a real value into `assertWithinQuota` was never finished — and because
fixing one without the others leaves the Usage screen still lying.

Any fix needs an integration test that drives real HTTP against a non-default
account state. That absence is what let all four survive 444 passing tests.
