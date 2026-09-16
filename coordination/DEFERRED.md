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
