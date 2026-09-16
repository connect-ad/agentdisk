import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { clientIdentifier, consume, enforce } from "../src/lib/rate-limit";
import { ApiError } from "../src/lib/errors";
import { resetRateLimits } from "./helpers";

const NOW = 1_780_000_000_000;
const rule = { bucket: "test", limit: 3, windowSeconds: 3600 };

beforeEach(resetRateLimits);

describe("consume", () => {
  it("counts down and then refuses", async () => {
    const remaining: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await consume(env.CACHE, rule, "1.2.3.4", NOW);
      expect(r.allowed).toBe(true);
      remaining.push(r.remaining);
    }
    expect(remaining).toEqual([2, 1, 0]);

    const blocked = await consume(env.CACHE, rule, "1.2.3.4", NOW);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
  });

  it("counts each identifier separately", async () => {
    for (let i = 0; i < 3; i++) await consume(env.CACHE, rule, "1.1.1.1", NOW);
    expect((await consume(env.CACHE, rule, "1.1.1.1", NOW)).allowed).toBe(false);
    expect((await consume(env.CACHE, rule, "2.2.2.2", NOW)).allowed).toBe(true);
  });

  it("starts fresh in the next window", async () => {
    for (let i = 0; i < 3; i++) await consume(env.CACHE, rule, "3.3.3.3", NOW);
    expect((await consume(env.CACHE, rule, "3.3.3.3", NOW)).allowed).toBe(false);

    const nextWindow = NOW + rule.windowSeconds * 1000;
    expect((await consume(env.CACHE, rule, "3.3.3.3", nextWindow)).allowed).toBe(true);
  });

  it("refuses a window shorter than KV can express as a TTL", async () => {
    await expect(
      consume(env.CACHE, { bucket: "t", limit: 1, windowSeconds: 30 }, "x", NOW)
    ).rejects.toThrow(/minimum TTL/);
  });

  it("treats a corrupt counter as zero rather than as unlimited", async () => {
    const windowMs = rule.windowSeconds * 1000;
    const windowStart = Math.floor(NOW / windowMs) * windowMs;
    await env.CACHE.put(`rl:${rule.bucket}:corrupt:${windowStart}`, "not-a-number");

    const r = await consume(env.CACHE, rule, "corrupt", NOW);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(2);
  });
});

describe("enforce", () => {
  it("throws a 429 naming how long to wait", async () => {
    for (let i = 0; i < 3; i++) await enforce(env.CACHE, rule, "4.4.4.4", NOW);
    try {
      await enforce(env.CACHE, rule, "4.4.4.4", NOW);
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(429);
      expect((err as ApiError).details?.retryAfterSeconds).toBeGreaterThan(0);
    }
  });
});

describe("clientIdentifier", () => {
  it("uses the header Cloudflare sets, which a client cannot forge", () => {
    const req = new Request("https://x/", { headers: { "cf-connecting-ip": "9.9.9.9" } });
    expect(clientIdentifier(req)).toBe("9.9.9.9");
  });

  it("falls back to one shared bucket, which is stricter and not looser", () => {
    expect(clientIdentifier(new Request("https://x/"))).toBe("unknown-ip");
  });
});
