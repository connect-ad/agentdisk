# Deferred cross-track items

Append-only. If a change belongs to the other track's files, do not make it —
record it here and continue. Worked after both tracks merge.

## Format
### <ID> · <one-line title>
- Raised by: Track A | Track B
- Date:
- Files involved:
- Why it is blocked:
- Proposed change:
- Trigger: after Track A merge | after Track B merge | after both
- Verification:

## Known in advance
### X-01 · index.ts route registration
Track 0 extracted the staff block to routes/staff-router.ts. If either track still
needs an edit to the dispatch chain itself, record it here rather than editing it.
Trigger: after both.

### X-02 · Modal primitives are implemented twice
Track A fixes the design-system modal; Track B writes its own for apps/admin,
because apps/admin does not import design-system/ by design. Both follow
docs/ui-layering.md. If they drift, reconcile after both merge — do not share a
component across the two apps, the separation is deliberate.
Trigger: after both.

### X-03 · Email integration blocks three features
Data export, account-deletion notices and staff force-password-reset all depend on
an email channel that does not exist. All three ship disabled until it does.
Single follow-up, not three.
Trigger: after both.

### X-04 · Email now exists — X-03 is partly discharged
Amendment 4 was reversed mid-Track-B. `apps/api/src/lib/email.ts` is built and
generic: `sendEmail({to, subject, html, text})` plus per-template functions, no
staff assumptions and no imports from `staff/` or `auth/`. Staff
force-password-reset consumes it and is live.

The other two features named in X-03 — data export and account-deletion notices —
are still unbuilt, but are no longer blocked on a channel. Whoever picks them up
imports `sendPasswordResetEmail`'s neighbours rather than writing a second sender.
Do not add a second transport.
Trigger: after both.

### B-01 · Env additions in index.ts
Track B added two optional fields to the `Env` interface in `apps/api/src/index.ts`
— `MAILERSEND_API_TOKEN` and `FIREBASE_SERVICE_ACCOUNT_JSON` — and one prefix
(`staffAction: "sac"`) to `apps/api/src/lib/ids.ts`. Both are outside the files
Track B was scoped to, and both are additive: no existing field, route or prefix
changed. The staff-router extraction landed while this was in flight and merged
cleanly, so X-01's dispatch-chain concern did not materialise.
- Raised by: Track B
- Files involved: apps/api/src/index.ts, apps/api/src/lib/ids.ts
- Why it is blocked: nothing — recorded because it is out of scope, not because
  it is unresolved.
- Verification: `apps/api` typecheck, lint and 550 tests are green with it.
Trigger: after both.

### B-02 · FIREBASE_SERVICE_ACCOUNT_JSON does not exist yet
Staff password reset needs two credentials, and only one of them is real.
MAILERSEND_API_TOKEN exists as a repository secret and its path to the Worker is
wired. The service-account key that generates the reset link does not exist in
any environment, so the route refuses on dev until somebody creates it. See the
Track B report for what the key needs and why the Web API key will not do.
- Raised by: Track B
- Trigger: before the staff console ships password reset to real support staff.

### B-03 · The console's modal primitives exist (X-02 is now live on both sides)
`apps/admin/src/components/Overlay.jsx` — Modal, ConfirmModal, ToastDock — plus
`apps/admin/src/app.css`, which re-declares the seven ladder rungs from
docs/ui-layering.md with the same values `apps/web` uses. Duplicated on purpose,
not shared: the console does not import the design system, and coupling the two
apps to keep seven integers in step would reintroduce the separation X-02 exists
to protect.

Verified two ways, because neither is sufficient alone:
- `apps/admin/test/overlay.test.jsx` (16 tests, in `npm test`) — focus lands on
  the field not Close, focus does not move while typing, Enter submits, Escape
  closes, Tab stays inside, the confirm gate is exact-match, the reason is
  mandatory, `destructive` defaults true.
- `apps/admin/test/verify-layout.mjs` (13 checks, `npm run verify:layout`) — a
  real browser at 1366x768 and at the 684px viewport where the customer app's
  Create API key modal is unusable. Asserts the footer is on screen, that
  `elementFromPoint` actually hits it, that clicking it submits, and that Enter
  submits with the button off screen. Deliberately outside `npm test`: it needs
  a browser binary, and it resolves Playwright from regression-tests/ rather
  than adding a second copy.

If the two apps' ladders drift, ui-layering.md is the source; change it there
first. Do not share a component across the apps.
Trigger: after both.

### X-05 · Two Track 0 commits contain other tracks' in-flight work
Track 0 staged with `git add -A` while Track A and Track B were already writing
in the same working directory, so two commits carry files their messages do not
mention. The content is correct and was always destined for this branch; the
defect is attribution only.

- `f71633d` ("Agree one overlay ladder...") also contains `lib/email.ts`,
  `lib/ids.ts`, `routes/staff.ts`, `staff/access.ts`, migration
  `0011_staff_actions.sql`, `.github/workflows/backend.yml` and the restored
  `docs/design/` (22 files).
- `7da4a48` ("Extract the staff dispatch...") also contains
  `test/staff-password-reset.test.ts` and `vitest.config.ts`.

**Deliberately not rewritten.** Nothing was pushed, so a rebase was available,
but HEAD was moving under two agents still committing into it — rewriting shared
history beneath them risks far more than a wrong commit message explains. The
record here is the fix.

Anyone reading `git log` for the provenance of those files should look here
first. `git log --follow <path>` will name a Track 0 commit for work Track A or
Track B did.

**Staging rule, now in force for all three sessions: stage explicit paths only.
Never `git add -A` or `git add .`** while another track is live.
- Raised by: Track 0
- Date: 2026-09-16
- Trigger: after both — no action needed beyond not being confused by it.
- Verification: none required; this is a record, not a task.

### X-06 · CLAUDE.md is owned by Track 0
**Tracks A and B must not edit `CLAUDE.md` directly.** Route the change through
Track 0: record it here, or ask, and Track 0 makes the edit.

It is the one file every track wants and no track owns. It carries the
information route, the "rules that bite" list and the status block, so
simultaneous edits collide on a file whose whole purpose is to be the thing you
trust when the code and your memory disagree. It was not extracted the way
`index.ts` was, because it cannot be — a single narrative is the point of it.

This is already live rather than hypothetical: Track A corrected the status
block to 558/31 and 171 in `9e99a1a` while Track 0 was preparing the same edit.
No harm done — the numbers were independently measured and agree — but the
second writer would have clobbered the first.

Note the counts move under you. 539/30 and 114 at the start of Track 0, 550/31
mid-session, 558/31 and 171/14 by its end. Treat any figure in the status block
as a snapshot, and re-measure after both tracks merge rather than trusting it.
- Raised by: Track 0
- Date: 2026-09-16
- Files involved: CLAUDE.md
- Trigger: in force now, not after merge.
- Verification: `git log --oneline -- CLAUDE.md` shows Track 0 as the only
  author of new commits touching it from here.
