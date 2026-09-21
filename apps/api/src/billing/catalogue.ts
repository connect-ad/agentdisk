/**
 * The plan catalogue: D1 over the `lib/plans.ts` floor, field by field.
 *
 * ── What this replaces ──────────────────────────────────────────────────────
 * `limitsForWorkspace` used to answer straight out of a hardcoded table, which
 * meant a pricing change was a deploy. 14 PART 29.6 asks for the opposite: an
 * admin edits a plan, Stripe is the record, and the request path follows
 * without shipping code. The `plans` table is that record's local mirror.
 *
 * ── Why the floor stays ─────────────────────────────────────────────────────
 * Because a read can fail, and the interesting question is what happens then.
 *
 * amardrive - the reference this borrows its shape from - answers a user with
 * no subscription row by granting a hardcoded 15 GB, against a free tier of
 * 5 GB. Its failure mode is *generous*: lose the data, grant triple. That is
 * the wrong direction for the same reason `resolvePlan` already resolves an
 * unrecognised plan name to `free` rather than to whatever was asked for - a
 * typo, a half-run migration or a half-finished sync must never be the thing
 * that widens somebody's quota.
 *
 * So every field falls back to the hardcoded value **for that same tier**. Pro
 * falls back to Pro's floor, not to Free's. The fallback can therefore only
 * produce what the code already believed that plan was worth; it can never
 * invent an allowance nobody agreed to.
 *
 * ── Field by field, not row by row ──────────────────────────────────────────
 * The fallback is per-field on purpose. A row-level fallback - "if anything
 * looks wrong, use the floor" - sounds safer and is weaker: it means one bad
 * column silently discards every good one, so an admin who correctly raised
 * Pro's storage would see it ignored because a later migration added a column
 * the sync had not learned to write yet. Per-field, that admin's change lands
 * and only the unwritten column falls back.
 *
 * ── Three states per column ─────────────────────────────────────────────────
 * Mirrors migration 0012, and the distinction is load-bearing:
 *
 *   NULL   the row did not say  -> the floor for this tier
 *   -1     unlimited            -> UNLIMITED
 *   >= 0   the limit            -> that number
 *
 * NULL cannot also mean unlimited, or "nobody wrote this column" and "no
 * ceiling" become the same fact, and the first silently becomes the second.
 */

import {
  PLAN_LIMITS,
  SANDBOX_LIMITS,
  UNLIMITED,
  isPlanName,
  isSandboxWorkspace,
  type ClaimState,
  type PlanLimits,
  type PlanName,
} from "../lib/plans";

/** A row of `plans`, as migration 0012 leaves it. */
export interface PlanRow {
  id: string;
  package_id: string | null;
  name: string;
  description: string | null;
  amount_cents: number;
  currency: string;
  interval: string;
  stripe_product_id: string | null;
  stripe_price_id: string | null;
  storage_bytes: number | null;
  file_count: number | null;
  egress_bytes_period: number | null;
  requests_period: number | null;
  max_file_bytes: number | null;
  agents: number | null;
  members: number | null;
  workspaces: number | null;
  api_keys: number | null;
  share_links: number | null;
  priority_support: number;
  is_public: number;
  is_default: number;
  sort_order: number;
}

export type Catalogue = ReadonlyMap<string, PlanRow>;

/**
 * One catalogue read per isolate per minute.
 *
 * The table has four rows and the request path already makes several D1 calls,
 * so this is not rescuing a slow query - it is avoiding a pointless one on
 * every single authenticated request.
 *
 * A minute, and no invalidation hook, because there is no way to invalidate
 * across isolates without another network call, which would cost more than the
 * query it saved. The consequence is bounded and worth stating plainly: after
 * an admin changes a plan, some isolates enforce the old numbers for up to a
 * minute. For a quota that is a non-event; for anything where it would not be,
 * this is the wrong cache.
 */
const CACHE_TTL_MS = 60_000;

let cache: { at: number; catalogue: Catalogue } | null = null;

/** Drop the cached catalogue. Called after a sync or a webhook rewrites plans. */
export function invalidateCatalogue(): void {
  cache = null;
}

export async function loadCatalogue(db: D1Database, now: number): Promise<Catalogue> {
  if (cache !== null && now - cache.at < CACHE_TTL_MS) return cache.catalogue;

  const { results } = await db.prepare(`SELECT * FROM plans`).all<PlanRow>();
  const catalogue = new Map<string, PlanRow>();
  for (const row of results) catalogue.set(row.id, row);

  cache = { at: now, catalogue };
  return catalogue;
}

/**
 * The plan somebody lands on with no subscription, read from the data.
 *
 * Never the literal `"free"`. amardrive hardcoded its free-tier id, the real
 * ids turned out to carry a product prefix, the lookup returned null and the
 * account page rendered blank for everybody on it. That this product's default
 * *is* currently called `free` does not make hardcoding it correct - it makes
 * the bug invisible until somebody renames a plan.
 *
 * The `"free"` below is the last resort for a catalogue that is empty or has no
 * default at all, which is a broken deployment rather than a configuration. It
 * resolves to the tightest limits, which is the right way to be wrong.
 */
export function defaultPlanId(catalogue: Catalogue): string {
  for (const row of catalogue.values()) {
    if (row.is_default === 1) return row.id;
  }
  return "free";
}

/**
 * Which plan applies: the workspace's override, else the organization's, else
 * the catalogue's default.
 *
 * A name is accepted if the catalogue knows it OR `PLAN_NAMES` does. Requiring
 * both would mean an empty `plans` table downgraded every paying customer to
 * the default; requiring neither would let any string through.
 */
export function resolvePlanId(
  catalogue: Catalogue,
  planOverride: string | null,
  orgPlan: string
): string {
  const known = (value: string | null): value is string =>
    value !== null && value !== "" && (catalogue.has(value) || isPlanName(value));

  if (known(planOverride)) return planOverride;
  if (known(orgPlan)) return orgPlan;
  return defaultPlanId(catalogue);
}

/**
 * The hardcoded tier a plan id falls back to.
 *
 * A catalogue-only plan - one an admin created that `PLAN_NAMES` has never
 * heard of - gets Free's floor. That is deliberately the tight answer: the code
 * has no opinion about what "enterprise" is worth, so an unwritten column on it
 * must not inherit Team's allowance just because it sorts last. Such a plan can
 * still grant whatever it likes; it simply has to say so explicitly.
 */
function floorFor(planId: string): PlanLimits {
  const tier: PlanName = isPlanName(planId) ? planId : "free";
  return PLAN_LIMITS[tier];
}

/**
 * One column, resolved. See the three states in the file header.
 *
 * `Number.isFinite` rather than a null check alone: D1 hands back whatever is
 * in the column, and a TEXT value written by hand into an INTEGER column comes
 * back as a string. SQLite does not stop that - column types are affinities,
 * not constraints - so "unparseable" is a real state and it takes the floor.
 */
function field(raw: unknown, floor: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return floor;
  if (raw < 0) return UNLIMITED;
  return raw;
}

/** Turn a catalogue row into enforceable limits, falling back per field. */
export function limitsFromRow(row: PlanRow, floor: PlanLimits): PlanLimits {
  return {
    storageBytes: field(row.storage_bytes, floor.storageBytes),
    fileCount: field(row.file_count, floor.fileCount),
    egressBytesPerPeriod: field(row.egress_bytes_period, floor.egressBytesPerPeriod),
    requestsPerPeriod: field(row.requests_period, floor.requestsPerPeriod),
    maxFileBytes: field(row.max_file_bytes, floor.maxFileBytes),
    agents: field(row.agents, floor.agents),
    apiKeys: field(row.api_keys, floor.apiKeys),
    members: field(row.members, floor.members),
    workspaces: field(row.workspaces, floor.workspaces),
    shareLinks: field(row.share_links, floor.shareLinks),
  };
}

/** The plan-only lookup: what does this plan grant, catalogue included. */
export function limitsForPlan(
  catalogue: Catalogue,
  planOverride: string | null,
  orgPlan: string
): PlanLimits {
  const planId = resolvePlanId(catalogue, planOverride, orgPlan);
  const floor = floorFor(planId);
  const row = catalogue.get(planId);
  return row === undefined ? floor : limitsFromRow(row, floor);
}

/** What the workspace the resolver was handed may actually do. */
export type WorkspacePlanState = ClaimState & {
  plan_override: string | null;
  org_plan: string;
};

/**
 * The limits actually enforced for a workspace — the function the
 * authorization chain calls.
 *
 * The sandbox check comes first and short-circuits everything. An unclaimed
 * sandbox is a claim state rather than a plan (see `lib/plans.ts`), so no row
 * in the catalogue describes it and no admin edit should be able to widen it.
 */
export async function resolveWorkspaceLimits(
  db: D1Database,
  workspace: WorkspacePlanState,
  now: number
): Promise<PlanLimits> {
  if (isSandboxWorkspace(workspace)) return SANDBOX_LIMITS;

  const catalogue = await loadCatalogue(db, now);
  return limitsForPlan(catalogue, workspace.plan_override, workspace.org_plan);
}
