/**
 * The audit screen — 32 PART 6 (Audit log) and PART 9.
 *
 * Reads `staff_actions`, which is the fleet-wide record of what staff did. It
 * is NOT the same thing as a workspace's own `audit_events` tab: that one shows
 * every actor inside one workspace — the customer's activity log, which staff
 * can also see — while this shows one class of actor across every workspace and
 * outside any. Keeping the two visibly distinct in the API is what stops
 * somebody reading a customer's own activity and believing it is the staff
 * trail, or the reverse.
 *
 * ── Sync History is this, filtered ─────────────────────────────────────────
 * There is no `plan_sync_events` table and there should not be one. Sync
 * History is `action LIKE 'plan.%'` over these rows, which already record who,
 * when, which fields and the result. The dotted vocabulary is what makes that
 * work, and `idx_staff_actions_action` leads on `action` for exactly this
 * prefix match — it is load-bearing, not cosmetic.
 *
 * ── Exporting the accountability log is itself accountable ─────────────────
 * `exportCsv` writes an `audit.export` row before it returns anything. A bulk
 * pull of the record of cross-tenant access is precisely the action that most
 * needs to be in that record.
 */

import { AuditedStaffAccess } from "./audited";

export interface StaffActionRow {
  id: string;
  actorId: string;
  actorEmail: string;
  actorRole: string;
  action: string;
  workspaceId: string | null;
  targetType: string | null;
  targetId: string | null;
  reason: string | null;
  result: string;
  sourceIp: string | null;
  requestId: string | null;
  metadata: string | null;
  createdAt: number;
}

export interface AuditFilter {
  actorId?: string | null;
  /** Exact action, or a prefix ending in `.` such as `plan.` for Sync History. */
  action?: string | null;
  from?: number | null;
  to?: number | null;
  limit?: number;
  /** Cursor: `created_at` of the last row seen. Our API is cursor-based, not offset. */
  before?: number | null;
}

/** One CSV cell, quoted so a reason containing a comma or a newline survives. */
function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  // A leading =, +, - or @ is what spreadsheet software executes as a formula.
  // The reason field is operator-supplied text, so it is exactly the place a
  // payload would be planted for whoever opens the export.
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${guarded.replace(/"/g, '""')}"`;
}

export class StaffAuditAccess extends AuditedStaffAccess {
  private build(filter: AuditFilter): { sql: string; binds: (string | number)[] } {
    const clauses: string[] = [];
    const binds: (string | number)[] = [];

    if (filter.actorId != null && filter.actorId !== "") {
      clauses.push(`actor_id = ?`);
      binds.push(filter.actorId);
    }
    if (filter.action != null && filter.action !== "") {
      if (filter.action.endsWith(".")) {
        // Prefix match, for Sync History and the per-area views. The escape is
        // not optional: an action containing `_` would otherwise match any
        // single character, and `_` is in every action name we use.
        clauses.push(`action LIKE ? ESCAPE '\\'`);
        binds.push(`${filter.action.replace(/[%_\\]/g, c => `\\${c}`)}%`);
      } else {
        clauses.push(`action = ?`);
        binds.push(filter.action);
      }
    }
    if (filter.from != null) {
      clauses.push(`created_at >= ?`);
      binds.push(filter.from);
    }
    if (filter.to != null) {
      clauses.push(`created_at <= ?`);
      binds.push(filter.to);
    }
    if (filter.before != null) {
      clauses.push(`created_at < ?`);
      binds.push(filter.before);
    }

    return {
      sql: clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`,
      binds,
    };
  }

  async list(filter: AuditFilter = {}): Promise<{ rows: StaffActionRow[]; nextBefore: number | null }> {
    await this.requireRole("support", "read the audit log");

    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const { sql, binds } = this.build(filter);

    const rows = await this.db
      .prepare(
        `SELECT id, actor_id AS actorId, actor_email AS actorEmail, actor_role AS actorRole,
                action, workspace_id AS workspaceId, target_type AS targetType,
                target_id AS targetId, reason, result, source_ip AS sourceIp,
                request_id AS requestId, metadata, created_at AS createdAt
           FROM staff_actions ${sql}
          ORDER BY created_at DESC LIMIT ?`
      )
      .bind(...binds, limit + 1)
      .all<StaffActionRow>();

    const all = rows.results ?? [];
    // One more than asked for, so "is there another page" is answered without a
    // COUNT(*) over a table that only grows.
    const page = all.slice(0, limit);
    const nextBefore = all.length > limit ? (page[page.length - 1]?.createdAt ?? null) : null;

    return { rows: page, nextBefore };
  }

  /** The distinct actions present, for the filter dropdown. Cheap; the index leads on action. */
  async actions(): Promise<string[]> {
    await this.requireRole("support", "read the audit log");
    const rows = await this.db
      .prepare(`SELECT DISTINCT action FROM staff_actions ORDER BY action ASC`)
      .all<{ action: string }>();
    return (rows.results ?? []).map(row => row.action);
  }

  /** The staff members who appear in the log, for the actor dropdown. */
  async actors(): Promise<{ actorId: string; actorEmail: string }[]> {
    await this.requireRole("support", "read the audit log");
    const rows = await this.db
      .prepare(
        `SELECT actor_id AS actorId, MAX(actor_email) AS actorEmail
           FROM staff_actions GROUP BY actor_id ORDER BY actorEmail ASC`
      )
      .all<{ actorId: string; actorEmail: string }>();
    return rows.results ?? [];
  }

  async exportCsv(filter: AuditFilter = {}): Promise<string> {
    await this.requireRole("support", "export the audit log");

    const { sql, binds } = this.build(filter);
    const rows = await this.db
      .prepare(
        `SELECT created_at, actor_email, actor_role, action, workspace_id,
                target_type, target_id, reason, result, source_ip, request_id
           FROM staff_actions ${sql}
          ORDER BY created_at DESC LIMIT 10000`
      )
      .bind(...binds)
      .all<Record<string, unknown>>();

    const header = [
      "timestamp_utc",
      "staff_email",
      "staff_role",
      "action",
      "workspace_id",
      "target_type",
      "target_id",
      "reason",
      "result",
      "source_ip",
      "request_id",
    ];

    const lines = [header.join(",")];
    for (const row of rows.results ?? []) {
      lines.push(
        [
          cell(new Date(Number(row["created_at"])).toISOString()),
          cell(row["actor_email"]),
          cell(row["actor_role"]),
          cell(row["action"]),
          cell(row["workspace_id"]),
          cell(row["target_type"]),
          cell(row["target_id"]),
          cell(row["reason"]),
          cell(row["result"]),
          cell(row["source_ip"]),
          cell(row["request_id"]),
        ].join(",")
      );
    }

    // Written AFTER the read, so the export's own row is not in its own output,
    // and before returning, so an export that happened is an export recorded.
    await this.recordFleet({
      action: "audit.export",
      metadata: { rows: rows.results?.length ?? 0, filter: JSON.stringify(filter) },
    });

    return lines.join("\r\n");
  }
}
