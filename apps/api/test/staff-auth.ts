/**
 * Signing in as staff, in a test.
 *
 * Staff auth is Firebase now (migration 0014), so a test that wants to be a
 * staff member needs a token the Worker will actually verify — not a fixture it
 * trusts. This mints one with a real RSA key and pre-seeds the JWKS cache with
 * the matching public key, so `verifyFirebaseToken` runs its real code path and
 * nothing reaches Google.
 *
 * Shared rather than copied into each staff test file, because there are four
 * of them and the signing details are exactly the sort of thing that drifts.
 *
 * The important consequence for anyone reading a test written with this: the
 * token proves an IDENTITY and nothing more. What makes it staff is the
 * `staff_users` row `asStaff` writes. Minting a token without that row is how
 * you test the "not staff" refusal, and that asymmetry is the whole of the new
 * authorisation model.
 */

import { env } from "cloudflare:test";

/**
 * The project the test Worker verifies against.
 *
 * Comes from `[env.dev]` in wrangler.toml, which the test pool loads - NOT from
 * a vitest binding. Overriding it in vitest.config.ts breaks every other test
 * that mints a customer token, because they all mint for this audience too.
 */
export const TEST_PROJECT_ID = "agentdisk-dev";

/** The key the verifier caches. Versioned in firebase.ts; kept in step here. */
const JWKS_CACHE_KEY = "firebase:jwks:v1";
const KID = "staff-test-key";

let keyPair: CryptoKeyPair | null = null;

function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const segment = (value: unknown): string =>
  b64url(new TextEncoder().encode(JSON.stringify(value)));

/**
 * Generate the signing key once and publish it where the verifier looks.
 *
 * Call from `beforeAll`. Seeding the cache rather than stubbing `fetch` means
 * the verifier's cache-hit path is the one under test, which is also the path
 * production takes on all but the first request after a key rotation.
 */
export async function installStaffJwks(): Promise<void> {
  if (keyPair === null) {
    keyPair = (await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"]
    )) as CryptoKeyPair;
  }

  const jwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey;
  await env.CACHE.put(
    JWKS_CACHE_KEY,
    JSON.stringify({ keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }] }),
    { expirationTtl: 3600 }
  );
}

export interface TokenOptions {
  email: string;
  uid?: string;
  emailVerified?: boolean;
  projectId?: string;
  /** Seconds relative to now. */
  iatOffset?: number;
}

/** A Firebase ID token this deployment will accept. */
export async function firebaseToken(options: TokenOptions): Promise<string> {
  if (keyPair === null) await installStaffJwks();

  const seconds = Math.floor(Date.now() / 1000) + (options.iatOffset ?? 0);
  const projectId = options.projectId ?? TEST_PROJECT_ID;

  const header = { alg: "RS256", kid: KID, typ: "JWT" };
  const payload = {
    iss: `https://securetoken.google.com/${projectId}`,
    aud: projectId,
    sub: options.uid ?? `uid-${options.email}`,
    iat: seconds,
    exp: seconds + 3600,
    email: options.email,
    email_verified: options.emailVerified ?? true,
    firebase: { sign_in_provider: "google.com" },
  };

  const signedInput = `${segment(header)}.${segment(payload)}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    keyPair!.privateKey,
    new TextEncoder().encode(signedInput)
  );
  return `${signedInput}.${b64url(new Uint8Array(signature))}`;
}

/**
 * Give an address a staff role, and return a token for it.
 *
 * The two halves are deliberately separable: `firebaseToken` alone gives a
 * signed-in identity that is NOT staff, which is what the refusal tests need.
 */
export async function asStaff(
  email: string,
  role: "support" | "admin" | "super_admin",
  options: { id?: string; disabled?: boolean } = {}
): Promise<string> {
  const id = options.id ?? `stf_${role.toUpperCase()}`;
  await env.DB.prepare(
    `INSERT OR REPLACE INTO staff_users
       (id, email, role, disabled_at, last_login_at, created_at, invited_by)
     VALUES (?, ?, ?, ?, NULL, ?, NULL)`
  )
    .bind(id, email.toLowerCase(), role, options.disabled === true ? Date.now() : null, Date.now())
    .run();

  return firebaseToken({ email });
}
