/**
 * Firebase ID token verification, per 16 PART 30.2.
 *
 * The Firebase Admin SDK is Node-targeted and does not run in Workers - but it
 * is not needed, because verifying an ID token is ordinary RS256 JWT
 * verification against Google's public keys, which Web Crypto already provides.
 * No secret is involved: JWKS are public, and FIREBASE_PROJECT_ID is public
 * configuration.
 *
 * Every failure here throws the same UNAUTHORIZED body as an API-key failure,
 * for the reason given in authenticate.ts: a distinguishable failure is an
 * oracle. The specific reason goes to the log and never to the caller.
 */

import { unauthorized } from "../lib/errors";

const JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

/** Versioned, so a format change cannot be served from a stale cache entry. */
const JWKS_CACHE_KEY = "firebase:jwks:v1";

/**
 * Used only when Google's response carries no usable `Cache-Control`. Their
 * keys rotate on the order of days, so an hour is conservative either way, and
 * an unrecognised `kid` forces a refetch regardless.
 */
const JWKS_FALLBACK_TTL_SECONDS = 3600;

/** KV rejects anything shorter. */
const KV_MIN_TTL_SECONDS = 60;

/**
 * Tolerance on `iat` only, for clock skew between Google's signer and the edge.
 * `exp` gets none: being generous about clocks there would extend the usable
 * life of every stolen token by the same margin.
 */
const IAT_SKEW_SECONDS = 60;

interface JwtHeader {
  alg: string;
  kid: string;
}

interface JwtPayload {
  iss: string;
  aud: string;
  sub: string;
  iat: number;
  exp: number;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
  firebase?: { sign_in_provider?: string };
}

/** What the rest of the chain gets. Deliberately not the raw payload. */
export interface FirebaseClaims {
  /** The Firebase UID - `sub`. The join key to `users.firebase_uid`. */
  uid: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  photoUrl: string | null;
  /** "password", "google.com", "github.com". Audit detail only. */
  signInProvider: string | null;
  /** Unix ms, to compare against `users.session_revoked_after` (30.4). */
  issuedAtMs: number;
}

/** The slice of KVNamespace this needs, so tests can supply a map. */
export interface JwksCache {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options: { expirationTtl: number }): Promise<void>;
}

function base64UrlDecode(segment: string): Uint8Array {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJsonSegment<T>(segment: string, what: string): T {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlDecode(segment))) as T;
  } catch {
    throw unauthorized(`token ${what} is not decodable JSON`);
  }
}

/**
 * Google sends `max-age` on the JWKS response, and it is the only honest source
 * for how long these keys may be held. Falling back to a fixed TTL when it is
 * missing or unparseable is safe because an unknown `kid` refetches anyway.
 */
export function parseMaxAge(cacheControl: string | null): number | null {
  if (cacheControl === null) return null;
  const match = /(?:^|,)\s*max-age\s*=\s*(\d+)/i.exec(cacheControl);
  const digits = match?.[1];
  if (digits === undefined) return null;
  const seconds = Number.parseInt(digits, 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

interface JwkSet {
  keys: JsonWebKey[];
}

function isJwkSet(value: unknown): value is JwkSet {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { keys?: unknown }).keys)
  );
}

async function fetchJwks(cache: JwksCache): Promise<JwkSet> {
  const response = await fetch(JWKS_URL);
  if (!response.ok) {
    // Fail closed. An unreachable JWKS endpoint means we cannot prove any token
    // is genuine, and serving requests on that basis is worse than refusing.
    throw unauthorized(`JWKS fetch returned ${response.status}`);
  }

  const body = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw unauthorized("JWKS response was not JSON");
  }
  if (!isJwkSet(parsed)) {
    throw unauthorized("JWKS response had no keys array");
  }

  const ttl = Math.max(
    KV_MIN_TTL_SECONDS,
    parseMaxAge(response.headers.get("cache-control")) ?? JWKS_FALLBACK_TTL_SECONDS
  );
  // A cache write must never be the reason a valid request fails.
  await cache.put(JWKS_CACHE_KEY, body, { expirationTtl: ttl }).catch(() => undefined);

  return parsed;
}

async function loadJwks(cache: JwksCache, forceRefresh: boolean): Promise<JwkSet> {
  if (!forceRefresh) {
    const cached = await cache.get(JWKS_CACHE_KEY).catch(() => null);
    if (cached !== null) {
      try {
        const parsed: unknown = JSON.parse(cached);
        if (isJwkSet(parsed)) return parsed;
      } catch {
        // A corrupt cache entry is not an auth failure - fall through and refetch.
      }
    }
  }
  return fetchJwks(cache);
}

function findKey(jwks: JwkSet, kid: string): JsonWebKey | null {
  return jwks.keys.find((key) => (key as { kid?: string }).kid === kid) ?? null;
}

async function verifySignature(
  jwk: JsonWebKey,
  signedInput: string,
  signature: Uint8Array
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
  return crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    signature,
    new TextEncoder().encode(signedInput)
  );
}

export interface VerifyDeps {
  cache: JwksCache;
  projectId: string;
  /** Unix ms. */
  now: number;
}

/**
 * Verify a Firebase ID token and return its claims.
 *
 * Order matters: everything cheap and local runs before the signature check,
 * and no claim is trusted until after it. A token that fails `aud` is rejected
 * however well it is signed - that is the check that stops a token minted by
 * the *other* environment's Firebase project from authenticating here, which is
 * the whole reason dev and prod are two separate projects (30.5).
 */
export async function verifyFirebaseToken(
  token: string,
  deps: VerifyDeps
): Promise<FirebaseClaims> {
  const parts = token.split(".");
  const [headerSegment, payloadSegment, signatureSegment] = parts;
  if (
    parts.length !== 3 ||
    headerSegment === undefined ||
    payloadSegment === undefined ||
    signatureSegment === undefined
  ) {
    throw unauthorized("token is not a three-part JWT");
  }

  const header = decodeJsonSegment<JwtHeader>(headerSegment, "header");
  if (header.alg !== "RS256") {
    // Naming the one accepted algorithm is what closes the algorithm-confusion
    // family, `alg: none` included.
    throw unauthorized(`token alg is ${header.alg}, not RS256`);
  }
  if (typeof header.kid !== "string" || header.kid === "") {
    throw unauthorized("token header carries no kid");
  }

  const signature = base64UrlDecode(signatureSegment);
  const signedInput = `${headerSegment}.${payloadSegment}`;

  // An unrecognised kid is the normal shape of Google's key rotation, so it
  // earns exactly one forced refetch - not one per request, which would turn
  // any garbage kid into a way to hammer Google's endpoint through us.
  let jwks = await loadJwks(deps.cache, false);
  let jwk = findKey(jwks, header.kid);
  if (jwk === null) {
    jwks = await loadJwks(deps.cache, true);
    jwk = findKey(jwks, header.kid);
  }
  if (jwk === null) {
    throw unauthorized(`no JWKS key matches kid ${header.kid}`);
  }

  if (!(await verifySignature(jwk, signedInput, signature))) {
    throw unauthorized("token signature does not verify");
  }

  const payload = decodeJsonSegment<JwtPayload>(payloadSegment, "payload");

  if (payload.iss !== `https://securetoken.google.com/${deps.projectId}`) {
    throw unauthorized(`token iss ${payload.iss} is not this project`);
  }
  if (payload.aud !== deps.projectId) {
    throw unauthorized(`token aud ${payload.aud} is not ${deps.projectId}`);
  }
  if (typeof payload.sub !== "string" || payload.sub === "") {
    throw unauthorized("token carries no sub");
  }

  const nowSeconds = Math.floor(deps.now / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= nowSeconds) {
    throw unauthorized("token is expired");
  }
  if (typeof payload.iat !== "number" || payload.iat > nowSeconds + IAT_SKEW_SECONDS) {
    throw unauthorized("token iat is in the future");
  }

  return {
    uid: payload.sub,
    email: typeof payload.email === "string" ? payload.email : null,
    emailVerified: payload.email_verified === true,
    displayName: typeof payload.name === "string" ? payload.name : null,
    photoUrl: typeof payload.picture === "string" ? payload.picture : null,
    signInProvider: payload.firebase?.sign_in_provider ?? null,
    issuedAtMs: payload.iat * 1000,
  };
}
