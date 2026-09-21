import { describe, expect, it } from "vitest";
import { assertFileSizeAllowed, assertWithinQuota } from "../src/lib/quota";
import {
  PLAN_LIMITS,
  PLAN_NAMES,
  SANDBOX_LIMITS,
  UNLIMITED,
  limitsFor,
  resolvePlan,
} from "../src/lib/plans";
import { ApiError } from "../src/lib/errors";
import type { AccountUsage, WorkspaceRow } from "../src/db/types";

const NOW = 1_780_000_000_000;
const NEXT_PERIOD = NOW + 86_400_000;

/**
 * A workspace that is alone in its billing account.
 *
 * The account counters default to mirroring the workspace's own, so a fixture
 * written before storage became account-scoped still means what it said - one
 * workspace, one org, the two numbers identical. A test about an account
 * holding *several* workspaces sets `org_storage_bytes_used` explicitly and
 * leaves the workspace's own below it, which is the case this whole change
 * exists for.
 */
function workspace(
  overrides: Partial<WorkspaceRow & AccountUsage> = {}
): WorkspaceRow & AccountUsage {
  const base: WorkspaceRow = {
    id: "ws_TEST",
    org_id: "org_TEST",
    name: "Test",
    slug: "test",
    status: "active",
    plan_override: null,
    storage_bytes_used: 0,
    file_count: 0,
    egress_bytes_period: 0,
    requests_period: 0,
    period_reset_at: NEXT_PERIOD,
    claimed_at: NOW,
    claim_token_hash: null,
    claim_token_expires_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
  return {
    org_storage_bytes_used: base.storage_bytes_used,
    org_file_count: base.file_count,
    ...base,
    ...overrides,
  };
}

const free = PLAN_LIMITS.free;

describe("resolvePlan", () => {
  it("prefers the workspace override, then the org plan", () => {
    expect(resolvePlan("team", "free")).toBe("team");
    expect(resolvePlan(null, "pro")).toBe("pro");
  });

  it("falls back to the tightest plan for anything unrecognised", () => {
    // A typo in a plan column must never be what grants Team quota.
    expect(resolvePlan("enterprise", "platinum")).toBe("free");
    expect(resolvePlan(null, "")).toBe("free");
    expect(limitsFor("nonsense", "nonsense")).toBe(PLAN_LIMITS.free);
  });
});

/**
 * The canonical pricing table, asserted as a table rather than a prose claim.
 *
 * These are cheap tests guarding an expensive mistake: every number here is
 * also printed on the pricing page and written into Stripe product metadata,
 * and the three copies drifting apart is exactly what backlog/024 recorded.
 */
describe("the plan catalogue", () => {
  it("offers four plans, cheapest first", () => {
    expect(PLAN_NAMES).toEqual(["free", "basic", "pro", "team"]);
  });

  it("resolves basic, which did not exist before the billing module", () => {
    expect(resolvePlan(null, "basic")).toBe("basic");
    expect(limitsFor(null, "basic")).toBe(PLAN_LIMITS.basic);
  });

  it("leaves egress, requests and file count unlimited on every plan", () => {
    // Decided 17 Sept 2026: R2 egress costs nothing, so it is free to promise,
    // and storage already bounds file count. The CHECKS are deliberately still
    // in place - only the values widened - so a cap can return as data.
    for (const plan of PLAN_NAMES) {
      expect(PLAN_LIMITS[plan].egressBytesPerPeriod).toBe(UNLIMITED);
      expect(PLAN_LIMITS[plan].requestsPerPeriod).toBe(UNLIMITED);
      expect(PLAN_LIMITS[plan].fileCount).toBe(UNLIMITED);
    }
  });

  it("never lets a cheaper plan out-grant a dearer one", () => {
    // Catches a transposed digit anywhere in the table, which is the realistic
    // way these numbers go wrong.
    const dimensions = [
      "storageBytes",
      "maxFileBytes",
      "agents",
      "apiKeys",
      "members",
      "workspaces",
    ] as const;

    for (const dimension of dimensions) {
      // reduce rather than an index loop: it walks consecutive pairs while
      // keeping each element typed as PlanName, where PLAN_NAMES[i - 1] would
      // be possibly-undefined under noUncheckedIndexedAccess.
      [...PLAN_NAMES].reduce((cheaper, dearer) => {
        expect(PLAN_LIMITS[dearer][dimension]).toBeGreaterThanOrEqual(
          PLAN_LIMITS[cheaper][dimension]
        );
        return dearer;
      });
    }
  });

  it("holds an unclaimed sandbox tighter than free on every aggregate", () => {
    // The sandbox is the one thing with no card attached to it, which is why
    // it does NOT inherit the unlimited allowances.
    expect(SANDBOX_LIMITS.storageBytes).toBeLessThan(PLAN_LIMITS.free.storageBytes);
    expect(SANDBOX_LIMITS.fileCount).toBeLessThan(PLAN_LIMITS.free.fileCount);
    expect(SANDBOX_LIMITS.egressBytesPerPeriod).toBeLessThan(UNLIMITED);
    expect(SANDBOX_LIMITS.requestsPerPeriod).toBeLessThan(UNLIMITED);
  });
});

describe("assertWithinQuota", () => {
  it("never trips the request counter now that requests are unlimited", () => {
    // The counter is still incremented and still compared; the comparison just
    // cannot fire. Asserted so that deleting the check would be a test failure
    // rather than a silent no-op.
    const busy = workspace({ requests_period: 500_000_000 });
    expect(() => assertWithinQuota(busy, free, {}, NOW)).not.toThrow();
  });

  it("never trips the egress allowance now that egress is unlimited", () => {
    const busy = workspace({ egress_bytes_period: 900 * 1024 ** 3 });
    expect(() =>
      assertWithinQuota(busy, free, { egressBytes: 50 * 1024 ** 3 }, NOW)
    ).not.toThrow();
  });

  describe("storage and files are the account's allowance, not the workspace's", () => {
    // The defect this pins: before migration 0017 an account could hold N
    // times its plan's storage by owning N workspaces - and pressing "New
    // workspace" is free. The subscription is sold to the account, so the
    // allowance has to be counted there.

    it("refuses a nearly-empty workspace whose ACCOUNT is full", () => {
      const ws = workspace({
        storage_bytes_used: 10,
        org_storage_bytes_used: free.storageBytes - 5,
      });
      expect(() => assertWithinQuota(ws, free, { bytes: 100 }, NOW)).toThrow(ApiError);
    });

    it("allows a full workspace whose ACCOUNT still has room", () => {
      // The mirror image, and the one that proves the check reads the account
      // rather than merely reading whichever number is larger. A workspace at
      // what used to be its ceiling is fine, because it no longer has one.
      const ws = workspace({
        storage_bytes_used: free.storageBytes,
        org_storage_bytes_used: 10,
      });
      expect(() => assertWithinQuota(ws, free, { bytes: 100 }, NOW)).not.toThrow();
    });

    it("counts files the same way, in both directions", () => {
      const full = workspace({ file_count: 0, org_file_count: free.fileCount });
      expect(() => assertWithinQuota(full, free, { files: 1 }, NOW)).toThrow(ApiError);

      const room = workspace({ file_count: free.fileCount, org_file_count: 0 });
      expect(() => assertWithinQuota(room, free, { files: 1 }, NOW)).not.toThrow();
    });

    it("names the account, not the workspace, in what it reports", () => {
      // Somebody told their *workspace* is full, looking at a workspace
      // holding a fraction of the plan, concludes the product is broken - and
      // goes looking for the fix in the wrong place. The number reported is
      // the account's too, so it agrees with the limit printed beside it.
      const ws = workspace({ storage_bytes_used: 0, org_storage_bytes_used: free.storageBytes });
      try {
        assertWithinQuota(ws, free, { bytes: 1 }, NOW);
        throw new Error("expected a throw");
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).message).toContain("account");
        expect((err as ApiError).details).toMatchObject({
          limit: "storage",
          used: free.storageBytes,
        });
      }
    });

    it("leaves egress and requests on the workspace", () => {
      // Period counters, reset on the workspace's own period_reset_at. There
      // is no account-level period to reset an account-level counter on, so
      // these deliberately did not move - asserted so that "make everything
      // account-scoped" is a test failure rather than a plausible-looking
      // tidy-up.
      const ws = workspace({
        egress_bytes_period: free.egressBytesPerPeriod,
        org_storage_bytes_used: 0,
        org_file_count: 0,
      });
      expect(() => assertWithinQuota(ws, free, { egressBytes: 1 }, NOW)).toThrow(ApiError);

      const busy = workspace({
        requests_period: free.requestsPerPeriod,
        org_storage_bytes_used: 0,
        org_file_count: 0,
      });
      expect(() => assertWithinQuota(busy, free, {}, NOW)).toThrow(ApiError);
    });
  });

  it("passes an idle workspace", () => {
    expect(() => assertWithinQuota(workspace(), free, {}, NOW)).not.toThrow();
  });

  it("refuses a write that would cross the storage cap, and names the dimension", () => {
    const ws = workspace({ storage_bytes_used: free.storageBytes - 100 });
    try {
      assertWithinQuota(ws, free, { bytes: 200 }, NOW);
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe("LIMIT_EXCEEDED");
      expect((err as ApiError).status).toBe(429);
      expect((err as ApiError).details).toMatchObject({ limit: "storage" });
    }
  });

  it("allows a write that exactly fills the cap", () => {
    const ws = workspace({ storage_bytes_used: free.storageBytes - 100 });
    expect(() => assertWithinQuota(ws, free, { bytes: 100 }, NOW)).not.toThrow();
  });

  it("refuses one file too many", () => {
    const ws = workspace({ file_count: free.fileCount });
    expect(() => assertWithinQuota(ws, free, { files: 1 }, NOW)).toThrow(ApiError);
  });

  it("refuses egress beyond the period allowance", () => {
    const ws = workspace({ egress_bytes_period: free.egressBytesPerPeriod });
    expect(() => assertWithinQuota(ws, free, { egressBytes: 1 }, NOW)).toThrow(ApiError);
  });

  it("refuses requests beyond the period allowance", () => {
    const ws = workspace({ requests_period: free.requestsPerPeriod });
    expect(() => assertWithinQuota(ws, free, {}, NOW)).toThrow(ApiError);
  });

  it("treats period counters as zero once the reset moment has passed", () => {
    // Otherwise a workspace that hit its monthly cap stays locked out until the
    // reconciliation job happens to run - a bug that only appears on the first
    // of the month, in production.
    const stale = workspace({
      requests_period: free.requestsPerPeriod * 2,
      egress_bytes_period: free.egressBytesPerPeriod * 2,
      period_reset_at: NOW - 1,
    });
    expect(() => assertWithinQuota(stale, free, { egressBytes: 1000 }, NOW)).not.toThrow();
  });

  it("does not extend that grace to storage, which is not a period counter", () => {
    const ws = workspace({
      storage_bytes_used: free.storageBytes,
      period_reset_at: NOW - 1,
    });
    expect(() => assertWithinQuota(ws, free, { bytes: 1 }, NOW)).toThrow(ApiError);
  });
});

describe("assertFileSizeAllowed", () => {
  it("rejects a file larger than the plan's single-file cap", () => {
    expect(() => assertFileSizeAllowed(free.maxFileBytes + 1, free)).toThrow(ApiError);
    try {
      assertFileSizeAllowed(free.maxFileBytes + 1, free);
    } catch (err) {
      expect((err as ApiError).status).toBe(413);
    }
  });

  it("allows one exactly at the cap", () => {
    expect(() => assertFileSizeAllowed(free.maxFileBytes, free)).not.toThrow();
  });
});
