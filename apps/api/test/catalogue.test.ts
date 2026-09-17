/**
 * The plan catalogue resolver — 14 PART 29.6.
 *
 * What is worth proving here is the direction of every failure. The catalogue
 * exists so an admin can change a price without a deploy, which means the
 * request path now depends on data that can be missing, stale, half-written or
 * the wrong type. Each of those must produce the tier's own hardcoded limits
 * and never anything wider.
 *
 * That is the bug amardrive actually ships - a user with no subscription row
 * gets a hardcoded 15 GB against a 5 GB free tier - and the tests below are
 * written against each way this could repeat it rather than against the happy
 * path, which is the part nobody gets wrong.
 */

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  defaultPlanId,
  invalidateCatalogue,
  limitsForPlan,
  limitsFromRow,
  loadCatalogue,
  resolvePlanId,
  resolveWorkspaceLimits,
  type Catalogue,
  type PlanRow,
} from "../src/billing/catalogue";
import { PLAN_LIMITS, SANDBOX_LIMITS, UNLIMITED } from "../src/lib/plans";

const NOW = 1_780_000_000_000;

/** A complete row, so each test can vary exactly one thing. */
function row(overrides: Partial<PlanRow> = {}): PlanRow {
  return {
    id: "pro",
    package_id: "agentdisk-pro",
    name: "Pro",
    description: null,
    amount_cents: 2000,
    currency: "usd",
    interval: "month",
    stripe_product_id: null,
    stripe_price_id: null,
    storage_bytes: 50 * 1024 ** 3,
    file_count: -1,
    egress_bytes_period: -1,
    requests_period: -1,
    max_file_bytes: 1024 ** 3,
    agents: 10,
    members: 5,
    workspaces: 10,
    api_keys: 20,
    priority_support: 1,
    is_public: 1,
    is_default: 0,
    sort_order: 30,
    ...overrides,
  };
}

function catalogueOf(...rows: PlanRow[]): Catalogue {
  return new Map(rows.map((r) => [r.id, r]));
}

beforeEach(() => {
  // The cache is module-level and per-isolate, so one test's load would
  // otherwise decide the next one's answer.
  invalidateCatalogue();
});

describe("limitsFromRow — the per-field fallback", () => {
  it("takes the row's values when it has them", () => {
    const limits = limitsFromRow(row(), PLAN_LIMITS.pro);
    expect(limits.storageBytes).toBe(50 * 1024 ** 3);
    expect(limits.agents).toBe(10);
    expect(limits.workspaces).toBe(10);
  });

  it("reads -1 as unlimited, not as a limit of minus one", () => {
    const limits = limitsFromRow(row(), PLAN_LIMITS.pro);
    expect(limits.fileCount).toBe(UNLIMITED);
    expect(limits.egressBytesPerPeriod).toBe(UNLIMITED);
    expect(limits.requestsPerPeriod).toBe(UNLIMITED);
  });

  it("falls back to the tier's own floor for a NULL column", () => {
    // NULL means "this row did not say", which is the state a column added by a
    // later migration is in until the sync learns to write it.
    const limits = limitsFromRow(row({ storage_bytes: null }), PLAN_LIMITS.pro);
    expect(limits.storageBytes).toBe(PLAN_LIMITS.pro.storageBytes);
  });

  it("falls back for a value that is not a finite number", () => {
    // SQLite column types are affinities, not constraints, so a TEXT value in
    // an INTEGER column is a real state rather than a hypothetical one.
    const limits = limitsFromRow(
      row({ agents: "lots" as unknown as number, members: Number.NaN }),
      PLAN_LIMITS.pro
    );
    expect(limits.agents).toBe(PLAN_LIMITS.pro.agents);
    expect(limits.members).toBe(PLAN_LIMITS.pro.members);
  });

  it("keeps every good column when one is bad", () => {
    // The point of falling back per field rather than per row: one unwritten
    // column must not discard an admin's correct edit to a different one.
    const limits = limitsFromRow(
      row({ storage_bytes: 999 * 1024 ** 3, agents: null }),
      PLAN_LIMITS.pro
    );
    expect(limits.storageBytes).toBe(999 * 1024 ** 3);
    expect(limits.agents).toBe(PLAN_LIMITS.pro.agents);
  });

  it("falls back to the SAME tier, never to free", () => {
    // The whole safety argument. Falling back to Free would be "tight" but
    // wrong - it would silently downgrade a paying customer on a missing
    // column. Falling back to Team would be the amardrive bug.
    const allMissing = limitsFromRow(
      row({
        id: "team",
        storage_bytes: null,
        agents: null,
        members: null,
        workspaces: null,
        api_keys: null,
        max_file_bytes: null,
      }),
      PLAN_LIMITS.team
    );
    expect(allMissing.storageBytes).toBe(PLAN_LIMITS.team.storageBytes);
    expect(allMissing.agents).toBe(PLAN_LIMITS.team.agents);
    expect(allMissing.storageBytes).not.toBe(PLAN_LIMITS.free.storageBytes);
  });
});

describe("defaultPlanId — never the hardcoded literal", () => {
  it("reads the default off the data", () => {
    const catalogue = catalogueOf(
      row({ id: "starter", is_default: 1 }),
      row({ id: "pro", is_default: 0 })
    );
    // Deliberately not called "free": amardrive hardcoded 'free', the real ids
    // carried a prefix, and the lookup returned null for everybody on it.
    expect(defaultPlanId(catalogue)).toBe("starter");
  });

  it("falls back to the tightest tier when no row claims to be default", () => {
    expect(defaultPlanId(catalogueOf(row({ is_default: 0 })))).toBe("free");
    expect(defaultPlanId(catalogueOf())).toBe("free");
  });
});

describe("resolvePlanId", () => {
  const catalogue = catalogueOf(
    row({ id: "free", is_default: 1 }),
    row({ id: "pro" }),
    row({ id: "team" })
  );

  it("prefers the workspace override, then the org plan", () => {
    expect(resolvePlanId(catalogue, "team", "free")).toBe("team");
    expect(resolvePlanId(catalogue, null, "pro")).toBe("pro");
  });

  it("ignores a name neither the catalogue nor the code knows", () => {
    expect(resolvePlanId(catalogue, "enterprise", "platinum")).toBe("free");
    expect(resolvePlanId(catalogue, "", "")).toBe("free");
  });

  it("still honours a code-known plan the catalogue has not got", () => {
    // An empty or partial plans table must not silently downgrade a paying
    // customer to the default.
    expect(resolvePlanId(catalogueOf(), "team", "free")).toBe("team");
  });
});

describe("limitsForPlan", () => {
  it("uses the tier floor when the catalogue has no such row", () => {
    expect(limitsForPlan(catalogueOf(), null, "team")).toEqual(PLAN_LIMITS.team);
  });

  it("gives a catalogue-only plan the free floor for anything it omits", () => {
    // The code has no opinion about what "enterprise" is worth, so an unwritten
    // column on it must not inherit Team's allowance for sorting last. It can
    // still grant more - it just has to say so.
    const limits = limitsForPlan(
      catalogueOf(row({ id: "enterprise", storage_bytes: 9 * 1024 ** 4, agents: null })),
      "enterprise",
      "free"
    );
    expect(limits.storageBytes).toBe(9 * 1024 ** 4);
    expect(limits.agents).toBe(PLAN_LIMITS.free.agents);
  });
});

describe("resolveWorkspaceLimits — against the real seeded catalogue", () => {
  const claimed = { claimed_at: NOW, claim_token_hash: null };

  it("reads the four seeded plans out of D1", async () => {
    const catalogue = await loadCatalogue(env.DB, NOW);
    expect([...catalogue.keys()].sort()).toEqual(["basic", "free", "pro", "team"]);
    expect(defaultPlanId(catalogue)).toBe("free");
  });

  it("enforces what migration 0012 seeded, not what the code hardcodes", async () => {
    const limits = await resolveWorkspaceLimits(
      env.DB,
      { ...claimed, plan_override: null, org_plan: "basic" },
      NOW
    );
    expect(limits.storageBytes).toBe(5 * 1024 ** 3);
    expect(limits.agents).toBe(5);
    expect(limits.workspaces).toBe(3);
    expect(limits.apiKeys).toBe(6);
    expect(limits.egressBytesPerPeriod).toBe(UNLIMITED);
  });

  it("holds an unclaimed sandbox to SANDBOX_LIMITS whatever the catalogue says", async () => {
    // The short-circuit is the point: a sandbox is a claim state, not a plan,
    // so no admin edit and no plan_override can widen it.
    const limits = await resolveWorkspaceLimits(
      env.DB,
      {
        claimed_at: null,
        claim_token_hash: "deadbeef",
        plan_override: "team",
        org_plan: "team",
      },
      NOW
    );
    expect(limits).toEqual(SANDBOX_LIMITS);
  });

  it("does not widen a workspace whose plan column is nonsense", async () => {
    const limits = await resolveWorkspaceLimits(
      env.DB,
      { ...claimed, plan_override: "platinum", org_plan: "platinum" },
      NOW
    );
    expect(limits.storageBytes).toBe(PLAN_LIMITS.free.storageBytes);
  });

  it("serves a second call from cache within the TTL", async () => {
    const first = await loadCatalogue(env.DB, NOW);
    const second = await loadCatalogue(env.DB, NOW + 1_000);
    expect(second).toBe(first);

    const later = await loadCatalogue(env.DB, NOW + 61_000);
    expect(later).not.toBe(first);
  });
});
