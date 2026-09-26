import { describe, expect, it } from "vitest";
import {
  LIVE_PREFIX,
  TEST_PREFIX,
  SECRET_LENGTH,
  extractBearerToken,
  generateApiKey,
  hasCredentialInQuery,
  hashApiKey,
  isApiKeyToken,
  keyMode,
  timingSafeEqual,
} from "../src/lib/keys";

describe("generateApiKey", () => {
  it("produces the 15.3 format", async () => {
    const key = await generateApiKey("live");
    expect(key.token.startsWith(LIVE_PREFIX)).toBe(true);
    expect(key.token.slice(LIVE_PREFIX.length)).toHaveLength(SECRET_LENGTH);
    expect(key.token).toMatch(/^ask_live_[0-9A-Za-z]{32}$/);
  });

  it("stores only a display prefix and the last four, never the secret", async () => {
    const key = await generateApiKey("live");
    const secret = key.token.slice(LIVE_PREFIX.length);

    expect(key.keyPrefix).toBe(LIVE_PREFIX + secret.slice(0, 8));
    expect(key.keyLastFour).toBe(secret.slice(-4));

    // The stored fragments must not be enough to reconstruct the credential:
    // 8 + 4 of 32 characters leaves 20 unknown.
    expect(key.keyPrefix + key.keyLastFour).not.toContain(secret);
  });

  it("hashes the whole token, so live and test are different credentials", async () => {
    const key = await generateApiKey("live");
    const secret = key.token.slice(LIVE_PREFIX.length);

    expect(key.keyHash).toBe(await hashApiKey(key.token));
    expect(key.keyHash).not.toBe(await hashApiKey(TEST_PREFIX + secret));
    expect(key.keyHash).toHaveLength(64);
  });

  it("does not repeat itself", async () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 200; i++) {
      tokens.add((await generateApiKey("live")).token);
    }
    expect(tokens.size).toBe(200);
  });

  it("uses the whole base62 alphabet, so the rejection sampling is not folding", async () => {
    // A modulo fold of 0..255 into 62 would over-represent the first 8
    // characters of the alphabet by ~33%. Over this many samples the counts
    // separate clearly; a uniform draw keeps every bucket close to its share.
    const counts = new Map<string, number>();
    for (let i = 0; i < 300; i++) {
      for (const char of (await generateApiKey("live")).token.slice(LIVE_PREFIX.length)) {
        counts.set(char, (counts.get(char) ?? 0) + 1);
      }
    }
    const total = 300 * SECRET_LENGTH;
    const expected = total / 62;
    const low = [..."01234567"].reduce((sum, c) => sum + (counts.get(c) ?? 0), 0);
    const high = [..."stuvwxyz"].reduce((sum, c) => sum + (counts.get(c) ?? 0), 0);

    expect(counts.size).toBe(62);
    // Folded output would put `low` roughly a third above `high`. Allow generous
    // sampling noise but not that.
    expect(low).toBeLessThan(high * 1.25);
    expect(low).toBeGreaterThan(expected * 8 * 0.75);
  });
});

describe("timingSafeEqual", () => {
  it("matches identical strings and rejects any difference", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(true);
  });
});

describe("token shape helpers", () => {
  it("recognises both modes and nothing else", () => {
    expect(isApiKeyToken("ask_live_x")).toBe(true);
    expect(isApiKeyToken("ask_test_x")).toBe(true);
    expect(isApiKeyToken("sk_live_x")).toBe(false);
    expect(keyMode("ask_test_x")).toBe("test");
    expect(keyMode("nope")).toBe(null);
  });
});

describe("extractBearerToken", () => {
  const withHeaders = (headers: HeadersInit) =>
    new Request("https://api.example/v1/whoami", { headers });

  it("reads a bearer token case-insensitively", () => {
    expect(extractBearerToken(withHeaders({ authorization: "Bearer abc" }))).toBe("abc");
    expect(extractBearerToken(withHeaders({ authorization: "bearer abc" }))).toBe("abc");
  });

  it("ignores other schemes and empty values", () => {
    expect(extractBearerToken(withHeaders({ authorization: "Basic abc" }))).toBe(null);
    expect(extractBearerToken(withHeaders({ authorization: "Bearer" }))).toBe(null);
    expect(extractBearerToken(withHeaders({ authorization: "Bearer   " }))).toBe(null);
    expect(extractBearerToken(new Request("https://api.example/v1/whoami"))).toBe(null);
  });
});

describe("hasCredentialInQuery", () => {
  it("catches the usual parameter names", () => {
    for (const name of ["api_key", "apiKey", "access_token", "token", "Bearer"]) {
      expect(hasCredentialInQuery(new URL(`https://api.example/v1?${name}=whatever`))).toBe(true);
    }
  });

  it("catches a key under an unusual parameter name, by its prefix", () => {
    expect(hasCredentialInQuery(new URL("https://api.example/v1?q=ask_live_abc"))).toBe(true);
  });

  it("leaves ordinary query strings alone", () => {
    expect(hasCredentialInQuery(new URL("https://api.example/v1/files?path=/a&limit=50"))).toBe(
      false
    );
  });
});
