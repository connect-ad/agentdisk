import { describe, expect, it } from "vitest";
import { assertFileSizeAllowed, assertWithinQuota } from "../src/lib/quota";
import { PLAN_LIMITS, limitsFor, resolvePlan } from "../src/lib/plans";
import { ApiError } from "../src/lib/errors";
import type { WorkspaceRow } from "../src/db/types";

const NOW = 1_780_000_000_000;
const NEXT_PERIOD = NOW + 86_400_000;

function workspace(overrides: Partial<WorkspaceRow> = {}): WorkspaceRow {
  return {
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
    created_at: NOW,
    updated_at: NOW,
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

describe("assertWithinQuota", () => {
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
