# 018 · Reclaim abandoned uploads

**Status:** Open — found by the 8 Sept 2026 audit ([summary.md](../summary.md) F-04)

A file row created by `POST /v1/files` sits in `status = 'pending'` with
`size_bytes = 0` until `complete` runs. **Nothing ever cleans up a `pending` row,
and nothing ever deletes its R2 object.**

`purgeExpiredFiles` selects only `status = 'deleted'` (`purge.ts:61`).
`reconcileCounters` sums only `status = 'active'` (`purge.ts:143`).

So bytes uploaded to a presigned URL whose `complete` never fires are real,
billable storage that is invisible to `storage_bytes_used`, to reconciliation, to
the quota check on the next upload, and to every sweep. Using only documented
calls: declare 1 byte, PUT 100 MB, never call `complete`, repeat. The per-file cap
does not help — `assertFileSizeAllowed` checks the **declared** size
(`files.ts:245`), and the real size is only ever learned in `complete`.

The design got the hard half right: refusing to trust the declared size, and
deleting over-cap bytes at `complete`. The gap is only the case where `complete`
never runs — which `apps/web/src/lib/upload.js` already identifies in its own
header ("a PUT that succeeds and a `complete` that never fires leaves an object in
the bucket that nothing accounts for"). The client-side mitigation exists; the
server-side reaper does not.

**To close:** extend the hourly sweep to expire `pending` rows older than the
presigned URL's TTL — delete the object, then the row, in that order, matching
the existing purge. Note that the honest failure (a browser tab closed
mid-upload) and the hostile one produce identical rows, so there is no signal to
alert on and the reaper is the only defence.
