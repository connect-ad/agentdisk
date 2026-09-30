/**
 * Firebase ID token verification (16 PART 30.2).
 *
 * These run against real Web Crypto in the real Workers runtime, with a real
 * RSA key pair generated per suite - the same primitives the deployed Worker
 * uses. What is stubbed is only what is outside the boundary: Google's JWKS
 * endpoint and the KV namespace in front of it.
 *
 * The `aud` case is the one this file exists for. Dev and prod are two separate
 * Firebase projects precisely so that a token minted by one cannot authenticate
 * against the other, and a claim that unprovable is worth nothing.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parseMaxAge, verifyFirebaseToken, type JwksCache } from "../src/auth/firebase";
import { ApiError } from "../src/lib/errors";

const PROJECT_ID = "agentdisk-dev";
const OTHER_PROJECT_ID = "agentdisk";
const KID = "test-key-1";

/** Workers' JsonWebKey type omits the JOSE header fields a key set carries. */
type TestJwk = JsonWebKey & { kid?: string; alg?: string; use?: string };

let privateKey: CryptoKey;
let publicJwk: TestJwk;

function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function encodeSegment(value: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(value)));
}

interface TokenOptions {
  projectId?: string;
  iss?: string;
  kid?: string;
  alg?: string;
  /** Seconds from now. Negative puts the token in the past. */
  expIn?: number;
  iatOffset?: number;
  sub?: string;
  email?: string;
  emailVerified?: boolean;
  signInProvider?: string;
  /** Re-encode the payload after signing, to simulate tampering. */
  tamper?: boolean;
}

async function mintToken(options: TokenOptions = {}): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const projectId = options.projectId ?? PROJECT_ID;

  const header = { alg: options.alg ?? "RS256", kid: options.kid ?? KID, typ: "JWT" };
  const payload = {
    iss: options.iss ?? `https://securetoken.google.com/${projectId}`,
    aud: projectId,
    sub: options.sub ?? "firebase-uid-abc123",
    iat: nowSeconds + (options.iatOffset ?? 0),
    exp: nowSeconds + (options.expIn ?? 3600),
    email: options.email ?? "person@example.com",
    email_verified: options.emailVerified ?? true,
    name: "Test Person",
    picture: "https://example.com/avatar.png",
    firebase: { sign_in_provider: options.signInProvider ?? "password" },
  };

  const signedInput = `${encodeSegment(header)}.${encodeSegment(payload)}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(signedInput)
  );
  const token = `${signedInput}.${b64url(new Uint8Array(signature))}`;

  if (options.tamper === true) {
    const parts = token.split(".");
    const swapped = encodeSegment({ ...payload, sub: "someone-else" });
    return `${parts[0]}.${swapped}.${parts[2]}`;
  }
  return token;
}

/** A KV stand-in that records what was written, so TTL can be asserted. */
function makeCache(seed?: string): JwksCache & {
  writes: { value: string; expirationTtl: number }[];
  reads: number;
} {
  let stored = seed ?? null;
  const writes: { value: string; expirationTtl: number }[] = [];
  return {
    writes,
    reads: 0,
    async get() {
      this.reads += 1;
      return stored;
    },
    async put(_key, value, options) {
      stored = value;
      writes.push({ value, expirationTtl: options.expirationTtl });
    },
  };
}

function jwksBody(keys: TestJwk[]): string {
  return JSON.stringify({ keys });
}

function stubJwksFetch(body: string, cacheControl?: string): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    async () =>
      new Response(body, {
        status: 200,
        headers: cacheControl === undefined ? {} : { "cache-control": cacheControl },
      })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function expectUnauthorized(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(ApiError);
  await promise.catch((err: unknown) => {
    expect((err as ApiError).code).toBe("UNAUTHORIZED");
  });
}

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  privateKey = pair.privateKey;
  publicJwk = {
    ...((await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey),
    kid: KID,
    alg: "RS256",
    use: "sig",
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("verifyFirebaseToken", () => {
  it("accepts a well-formed token and returns its claims", async () => {
    const cache = makeCache(jwksBody([publicJwk]));
    const claims = await verifyFirebaseToken(await mintToken(), {
      cache,
      projectId: PROJECT_ID,
      now: Date.now(),
    });

    expect(claims.uid).toBe("firebase-uid-abc123");
    expect(claims.email).toBe("person@example.com");
    expect(claims.emailVerified).toBe(true);
    expect(claims.signInProvider).toBe("password");
    expect(claims.issuedAtMs).toBeGreaterThan(0);
  });

  it("rejects a token minted by the other environment's Firebase project", async () => {
    // The whole point of two projects. This token is perfectly signed by the
    // same key - only `aud` and `iss` name the other project.
    const cache = makeCache(jwksBody([publicJwk]));
    await expectUnauthorized(
      verifyFirebaseToken(await mintToken({ projectId: OTHER_PROJECT_ID }), {
        cache,
        projectId: PROJECT_ID,
        now: Date.now(),
      })
    );
  });

  it("rejects a token whose iss is not this project, even when aud matches", async () => {
    const cache = makeCache(jwksBody([publicJwk]));
    await expectUnauthorized(
      verifyFirebaseToken(
        await mintToken({ iss: `https://securetoken.google.com/${OTHER_PROJECT_ID}` }),
        { cache, projectId: PROJECT_ID, now: Date.now() }
      )
    );
  });

  it("rejects any algorithm but RS256", async () => {
    const cache = makeCache(jwksBody([publicJwk]));
    for (const alg of ["none", "HS256", "RS512"]) {
      await expectUnauthorized(
        verifyFirebaseToken(await mintToken({ alg }), {
          cache,
          projectId: PROJECT_ID,
          now: Date.now(),
        })
      );
    }
  });

  it("rejects an expired token", async () => {
    const cache = makeCache(jwksBody([publicJwk]));
    await expectUnauthorized(
      verifyFirebaseToken(await mintToken({ expIn: -1 }), {
        cache,
        projectId: PROJECT_ID,
        now: Date.now(),
      })
    );
  });

  it("rejects a token issued further in the future than clock skew allows", async () => {
    const cache = makeCache(jwksBody([publicJwk]));
    await expectUnauthorized(
      verifyFirebaseToken(await mintToken({ iatOffset: 600 }), {
        cache,
        projectId: PROJECT_ID,
        now: Date.now(),
      })
    );
  });

  it("tolerates small forward clock skew on iat", async () => {
    const cache = makeCache(jwksBody([publicJwk]));
    const claims = await verifyFirebaseToken(await mintToken({ iatOffset: 30 }), {
      cache,
      projectId: PROJECT_ID,
      now: Date.now(),
    });
    expect(claims.uid).toBe("firebase-uid-abc123");
  });

  it("rejects a payload edited after signing", async () => {
    const cache = makeCache(jwksBody([publicJwk]));
    await expectUnauthorized(
      verifyFirebaseToken(await mintToken({ tamper: true }), {
        cache,
        projectId: PROJECT_ID,
        now: Date.now(),
      })
    );
  });

  it("rejects anything that is not a three-part JWT", async () => {
    const cache = makeCache(jwksBody([publicJwk]));
    for (const bad of ["", "abc", "a.b", "a.b.c.d"]) {
      await expectUnauthorized(
        verifyFirebaseToken(bad, { cache, projectId: PROJECT_ID, now: Date.now() })
      );
    }
  });

  it("serves from cache without touching Google", async () => {
    const fetchMock = stubJwksFetch(jwksBody([publicJwk]));
    const cache = makeCache(jwksBody([publicJwk]));

    await verifyFirebaseToken(await mintToken(), {
      cache,
      projectId: PROJECT_ID,
      now: Date.now(),
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refetches once on an unrecognised kid - Google's key rotation", async () => {
    const rotated: TestJwk = { ...publicJwk, kid: "rotated-key" };
    const fetchMock = stubJwksFetch(jwksBody([rotated]));
    // The cache holds only the old key, so the rotated kid misses.
    const cache = makeCache(jwksBody([{ ...publicJwk, kid: "stale-key" }]));

    const claims = await verifyFirebaseToken(await mintToken({ kid: "rotated-key" }), {
      cache,
      projectId: PROJECT_ID,
      now: Date.now(),
    });

    expect(claims.uid).toBe("firebase-uid-abc123");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refetches at most once for a kid that does not exist anywhere", async () => {
    // A garbage kid must not become a way to hammer Google's endpoint through us.
    const fetchMock = stubJwksFetch(jwksBody([publicJwk]));
    const cache = makeCache(jwksBody([publicJwk]));

    await expectUnauthorized(
      verifyFirebaseToken(await mintToken({ kid: "no-such-key" }), {
        cache,
        projectId: PROJECT_ID,
        now: Date.now(),
      })
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("caches a fetched key set for the max-age Google sends", async () => {
    stubJwksFetch(jwksBody([publicJwk]), "public, max-age=19860, must-revalidate");
    const cache = makeCache();

    await verifyFirebaseToken(await mintToken(), {
      cache,
      projectId: PROJECT_ID,
      now: Date.now(),
    });

    expect(cache.writes).toHaveLength(1);
    expect(cache.writes[0]?.expirationTtl).toBe(19860);
  });

  it("falls back to a fixed TTL when no max-age is sent", async () => {
    stubJwksFetch(jwksBody([publicJwk]));
    const cache = makeCache();

    await verifyFirebaseToken(await mintToken(), {
      cache,
      projectId: PROJECT_ID,
      now: Date.now(),
    });

    expect(cache.writes[0]?.expirationTtl).toBe(3600);
  });

  it("refuses every token when the JWKS endpoint is unreachable", async () => {
    // Fail closed: without keys we cannot prove any token is genuine.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("upstream down", { status: 503 }))
    );
    const cache = makeCache();

    await expectUnauthorized(
      verifyFirebaseToken(await mintToken(), {
        cache,
        projectId: PROJECT_ID,
        now: Date.now(),
      })
    );
  });

  it("survives a corrupt cache entry by refetching", async () => {
    const fetchMock = stubJwksFetch(jwksBody([publicJwk]));
    const cache = makeCache("{not json at all");

    const claims = await verifyFirebaseToken(await mintToken(), {
      cache,
      projectId: PROJECT_ID,
      now: Date.now(),
    });

    expect(claims.uid).toBe("firebase-uid-abc123");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("parseMaxAge", () => {
  it("reads the directive wherever it sits in the header", () => {
    expect(parseMaxAge("max-age=300")).toBe(300);
    expect(parseMaxAge("public, max-age=300, must-revalidate")).toBe(300);
    expect(parseMaxAge("PUBLIC, MAX-AGE=42")).toBe(42);
  });

  it("returns null for anything it cannot use", () => {
    expect(parseMaxAge(null)).toBeNull();
    expect(parseMaxAge("no-store")).toBeNull();
    expect(parseMaxAge("max-age=0")).toBeNull();
    expect(parseMaxAge("max-age=abc")).toBeNull();
  });

  it("does not read s-maxage as max-age", () => {
    // A substring match would, and s-maxage is a shared-cache directive that
    // says nothing about how long we may hold the keys.
    expect(parseMaxAge("s-maxage=600")).toBeNull();
  });
});
