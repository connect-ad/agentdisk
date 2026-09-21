import { describe, expect, it } from "vitest";
import {
  DEFAULT_SHARE_TTL_MS,
  MAX_SHARE_TTL_MS,
  mintShareToken,
  pathIsInside,
  resolveExpiry,
  shareUrl,
} from "../src/lib/shares";

const NOW = 1_780_000_000_000;

describe("resolveExpiry", () => {
  it("defaults to seven days", () => {
    expect(resolveExpiry(undefined, NOW)).toBe(NOW + DEFAULT_SHARE_TTL_MS);
  });

  it("accepts a date inside the cap", () => {
    const requested = NOW + 60 * 60 * 1000;
    expect(resolveExpiry(requested, NOW)).toBe(requested);
  });

  it("refuses a date beyond the cap", () => {
    expect(() => resolveExpiry(NOW + MAX_SHARE_TTL_MS + 1000, NOW)).toThrow(/7 days/);
  });

  it("refuses a date in the past", () => {
    expect(() => resolveExpiry(NOW - 1000, NOW)).toThrow(/future/);
  });
});

describe("pathIsInside", () => {
  it("accepts a direct child", () => {
    expect(pathIsInside("/reports/q3.pdf", "/reports")).toBe(true);
  });

  it("accepts a nested descendant, because folder shares are recursive", () => {
    expect(pathIsInside("/reports/draft/notes.md", "/reports")).toBe(true);
  });

  it("refuses a sibling whose name merely starts the same way", () => {
    // The whole bug class. A plain startsWith says this is inside /reports.
    expect(pathIsInside("/reports-private/secrets.md", "/reports")).toBe(false);
  });

  it("refuses the folder itself", () => {
    expect(pathIsInside("/reports", "/reports")).toBe(false);
  });

  it("treats the empty prefix as the whole workspace", () => {
    expect(pathIsInside("/anything.md", "")).toBe(true);
  });
});

describe("mintShareToken", () => {
  it("returns a token and its hash, and never the same token twice", async () => {
    const a = await mintShareToken();
    const b = await mintShareToken();
    expect(a.token).not.toBe(b.token);
    expect(a.token).toMatch(/^[0-9A-Za-z]{32}$/);
    expect(a.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("shareUrl", () => {
  it("builds the dashboard link", () => {
    expect(shareUrl("https://app.example.com/", "abc")).toBe("https://app.example.com/s/abc");
  });

  it("returns null when no dashboard is configured", () => {
    expect(shareUrl(undefined, "abc")).toBeNull();
  });
});
