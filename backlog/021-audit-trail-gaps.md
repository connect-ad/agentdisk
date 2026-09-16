# 021 · Close the audit-trail gaps

**Status:** Open — found by the 8 Sept 2026 audit ([summary.md](../summary.md) F-08)

`audit()` / `auditAndNotify()` cover agent create/update/delete, file
create/delete, key create/revoke, member add/role-change/remove, webhook
create/update/delete, and every MCP tool call. Enumerated by
`grep -rn "audit(ctx\|auditAndNotify(ctx" apps/api/src`, these are **not**
covered:

| Operation | Route | Why it matters |
|---|---|---|
| `DELETE /v1/folders/:id?recursive=true` | `folders.ts:186` | Soft-deletes an entire subtree in one call. No audit row, no webhook, no per-file record. |
| `POST /v1/files/:id/move` | `folders.ts:221` | Changes a path, and therefore which scoped keys can reach the file. |
| `POST /v1/files/:id/copy` | `folders.ts:262` | Duplicates bytes across scope boundaries. |
| `POST /v1/files/:id/restore` | `files.ts:646` | Un-deletes. |
| `PATCH /v1/files/:id` | `files.ts:581` | Metadata and tags. |
| `POST /v1/folders` | `folders.ts:66` | |

The recursive folder delete is the one to fix first. It is the single most
destructive customer-facing operation, it is exactly what a compromised
`delete`-scoped key would reach for, and the Activity screen — which the product
positions as "exactly what an agent did to your files" — shows nothing at all. A
workspace can lose 10,000 files with silence in the log.

Related: nothing purges `audit_events`, while the Privacy tab publishes "Audit
events … Retained 12 months". Either add the retention sweep to the hourly cron
or correct the claim — see [023](023-non-functional-ui-controls.md).
