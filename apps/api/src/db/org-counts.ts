/**
 * How many of each countable thing a billing account holds right now.
 *
 * The four plan limits that are counted rather than metered - workspaces,
 * agents, API keys and members - are all **per organization**, not per
 * workspace (lib/plans.ts, 17 Sept 2026): "50 workspaces, 50 agents" on Team
 * must not mean 2,500 agents. The workspace-scoped repositories cannot answer
 * an account-wide question by construction, so this is the one place that
 * reads across every workspace on the bill, and it reads nothing but counts.
 *
 * Live rows, not a counter. A deleted workspace, a deleted agent, a revoked
 * key or a removed member frees its slot on the next request with no second
 * bookkeeping step to forget - the same choice `shares.countLive` makes.
 *
 * The organization is bound in the constructor for the same reason every
 * repository here binds its scope: a handler then has no argument through
 * which to count somebody else's account.
 */

export type CountedDimension = "workspaces" | "agents" | "apiKeys" | "members";

export class OrgCounts {
  constructor(
    private readonly db: D1Database,
    readonly orgId: string
  ) {}

  /** Workspaces on the bill that have not been deleted. */
  async workspaces(): Promise<number> {
    return this.count(
      `SELECT COUNT(*) AS n
         FROM workspaces
        WHERE org_id = ?
          AND deleted_at IS NULL`,
      [this.orgId]
    );
  }

  /**
   * Agents across every live workspace. A disabled agent still counts: it
   * keeps its name, its keys and its slot until it is deleted, and disabling
   * is a switch somebody expects to flip back.
   */
  async agents(): Promise<number> {
    return this.count(
      `SELECT COUNT(*) AS n
         FROM agents a
         JOIN workspaces w ON w.id = a.workspace_id
        WHERE w.org_id = ?
          AND w.deleted_at IS NULL`,
      [this.orgId]
    );
  }

  /**
   * Keys across every live workspace that have not been revoked. Disabled
   * keys count for the reason disabled agents do; revoked ones are gone.
   */
  async apiKeys(): Promise<number> {
    return this.count(
      `SELECT COUNT(*) AS n
         FROM api_keys k
         JOIN workspaces w ON w.id = k.workspace_id
        WHERE w.org_id = ?
          AND w.deleted_at IS NULL
          AND k.revoked_at IS NULL`,
      [this.orgId]
    );
  }

  /**
   * People invited into at least one live workspace, counted once each
   * however many workspaces they were invited to.
   *
   * The account owner is not a member. Their row is org-wide (`workspace_id`
   * NULL) and comes with paying for the account, so it is excluded here; the
   * plan's member allowance is how many *other* people may be let in.
   *
   * `excludeUserId` lets an invitation ask "would this person need a new
   * slot" - somebody already invited to one workspace on the bill is not a
   * second member when invited to another.
   */
  async members(excludeUserId?: string): Promise<number> {
    return this.count(
      `SELECT COUNT(DISTINCT m.user_id) AS n
         FROM memberships m
         JOIN workspaces w ON w.id = m.workspace_id
        WHERE m.org_id = ?
          AND m.workspace_id IS NOT NULL
          AND w.deleted_at IS NULL
          AND m.user_id != ?`,
      [this.orgId, excludeUserId ?? ""]
    );
  }

  private async count(sql: string, params: unknown[]): Promise<number> {
    const row = await this.db
      .prepare(sql)
      .bind(...params)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }
}
