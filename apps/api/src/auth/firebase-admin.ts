/**
 * Privileged Firebase Identity Toolkit calls, from a Worker.
 *
 * `firebase.ts` next door verifies ID tokens and needs no credential at all,
 * because JWKS are public. This file is the other half: the operations that act
 * *on* an account rather than reading a token, which Google gates behind a
 * service-account credential.
 *
 * **The Admin SDK is not an option and this is not a preference.** It is
 * Node-targeted — it reaches for `fs`, for `http`, and for the GCP metadata
 * server — and none of that exists here. Every doc in this repo that says "call
 * the Admin SDK" is describing intent. What actually runs is below: mint an
 * OAuth2 access token from the service account with the JWT-bearer grant, then
 * call the REST endpoint with it. Web Crypto signs the assertion; nothing else
 * is needed.
 *
 * **Why `returnOobLink` rather than letting Firebase send the mail.** The
 * unprivileged `accounts:sendOobCode` — the one that takes a Web API key — has
 * Firebase generate *and* deliver the message from its own templates. That is a
 * second sender identity, a second set of wording nobody in this repo can edit,
 * and a second delivery path with no logging on our side. Asking for the link
 * instead keeps one sender and one template set, at the cost of needing the
 * admin credential. See `lib/email.ts` for the delivery half.
 *
 * Absent configuration returns null rather than throwing, so a deployment
 * without the credential still serves every route that does not need it. The
 * refusal belongs at the point of use.
 */

import { ApiError } from "../lib/errors";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const IDENTITY_TOOLKIT_BASE = "https://identitytoolkit.googleapis.com/v1/projects";

/** The narrowest scope that permits `accounts:sendOobCode` and `accounts:lookup`. */
const SCOPE = "https://www.googleapis.com/auth/identitytoolkit";

/** Google caps assertion lifetime at an hour; the token it returns matches. */
const ASSERTION_TTL_SECONDS = 3600;

/**
 * Cached access tokens are retired early, so a token that is valid when read
 * from KV is still valid when Google receives it. Sixty seconds covers the
 * round trip with room to spare.
 */
const TOKEN_EXPIRY_MARGIN_SECONDS = 60;

const TOKEN_CACHE_KEY = "firebase:admin-token:v1";

/** The fields this module needs from a Google service-account JSON key. */
interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id?: string;
}

export interface FirebaseAdminConfig {
  serviceAccount: ServiceAccount;
  /**
   * Which project to act on. Taken from `FIREBASE_PROJECT_ID` rather than from
   * the key's own `project_id`, so that the project this deployment *verifies*
   * tokens against and the project it *modifies* accounts in can never drift
   * apart silently — they are the same variable.
   */
  projectId: string;
}

/**
 * Parse the configuration, or null when this deployment has none.
 *
 * A malformed key throws rather than returning null. Null means "this feature
 * is off here", which is a decision; a key that is present but unparseable is a
 * deployment mistake, and treating it as "off" would hide it until somebody
 * wondered why no mail ever arrived.
 */
export function readFirebaseAdminConfig(env: {
  FIREBASE_SERVICE_ACCOUNT_JSON?: string;
  FIREBASE_PROJECT_ID?: string;
}): FirebaseAdminConfig | null {
  const raw = env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const projectId = env.FIREBASE_PROJECT_ID;
  if (raw === undefined || raw === "") return null;
  if (projectId === undefined || projectId === "") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ApiError("INTERNAL_ERROR", "Account administration is not configured.", {
      internalReason: "FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON",
    });
  }

  const account = parsed as Partial<ServiceAccount>;
  if (typeof account.client_email !== "string" || typeof account.private_key !== "string") {
    throw new ApiError("INTERNAL_ERROR", "Account administration is not configured.", {
      internalReason: "FIREBASE_SERVICE_ACCOUNT_JSON lacks client_email or private_key",
    });
  }

  return {
    serviceAccount: {
      client_email: account.client_email,
      // Stored in JSON with literal \n. Whether they survive depends on how the
      // value was pasted into the secret, so both forms are accepted.
      private_key: account.private_key.replace(/\\n/g, "\n"),
      project_id: account.project_id,
    },
    projectId,
  };
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function encodeJson(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

/** PEM (PKCS#8) to the raw DER bytes Web Crypto wants. */
function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Sign the OAuth2 assertion. RS256, which is the only alg Google accepts here. */
async function signAssertion(account: ServiceAccount, now: number): Promise<string> {
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "pkcs8",
      pemToDer(account.private_key),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"]
    );
  } catch (cause) {
    throw new ApiError("INTERNAL_ERROR", "Account administration is not configured.", {
      internalReason: `service-account private_key is not an importable PKCS#8 key: ${String(cause)}`,
    });
  }

  const issuedAt = Math.floor(now / 1000);
  const claims = {
    iss: account.client_email,
    scope: SCOPE,
    aud: TOKEN_ENDPOINT,
    iat: issuedAt,
    exp: issuedAt + ASSERTION_TTL_SECONDS,
  };

  const signingInput = `${encodeJson({ alg: "RS256", typ: "JWT" })}.${encodeJson(claims)}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput)
  );

  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

/**
 * An access token for the service account, cached in KV between requests.
 *
 * Cached because minting one costs an RSA signature and a round trip to Google,
 * and the token is valid for an hour. The cache is keyed per deployment — each
 * environment has its own KV namespace — so a dev token can never be served to
 * prod.
 */
export async function getAccessToken(
  config: FirebaseAdminConfig,
  kv: KVNamespace,
  now: number
): Promise<string> {
  const cached = await kv.get(TOKEN_CACHE_KEY);
  if (cached !== null && cached !== "") return cached;

  const assertion = await signAssertion(config.serviceAccount, now);

  let response: Response;
  try {
    response = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    });
  } catch (cause) {
    throw new ApiError("INTERNAL_ERROR", "Account administration is unavailable.", {
      internalReason: `Google token endpoint unreachable: ${String(cause)}`,
    });
  }

  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    throw new ApiError("INTERNAL_ERROR", "Account administration is unavailable.", {
      internalReason: `Google token endpoint returned ${response.status}: ${detail}`,
    });
  }

  const body = (await response.json()) as { access_token?: string; expires_in?: number };
  if (typeof body.access_token !== "string" || body.access_token === "") {
    throw new ApiError("INTERNAL_ERROR", "Account administration is unavailable.", {
      internalReason: "Google token endpoint returned no access_token",
    });
  }

  const lifetime = typeof body.expires_in === "number" ? body.expires_in : ASSERTION_TTL_SECONDS;
  const ttl = lifetime - TOKEN_EXPIRY_MARGIN_SECONDS;
  // KV refuses a TTL under 60s. A token that short is not worth caching anyway.
  if (ttl >= 60) {
    await kv.put(TOKEN_CACHE_KEY, body.access_token, { expirationTtl: ttl });
  }

  return body.access_token;
}

export interface ResetLink {
  /** The one-time Firebase URL that lets the holder set a new password. */
  link: string;
  /** The address Firebase resolved, echoed back. */
  email: string;
}

/**
 * Generate a password-reset link for an existing account, without sending it.
 *
 * Returns null when no account exists for the address. That is not an error:
 * `users` in D1 and Firebase are two stores, and a row can outlive its identity
 * — a caller that needs to distinguish "sent" from "no such identity" gets to,
 * and one that does not can treat both as done.
 *
 * The returned link is a bearer credential equal to "own this account" for as
 * long as it lasts. It must never be logged, never be written to an audit row
 * and never be returned to an API caller — the only thing that may receive it
 * is the address it was minted for. Compare `lib/claim.ts`, which reaches the
 * same conclusion about claim tokens for the same reason.
 */
export async function generatePasswordResetLink(
  config: FirebaseAdminConfig,
  kv: KVNamespace,
  email: string,
  now: number,
  options: { continueUrl?: string } = {}
): Promise<ResetLink | null> {
  const accessToken = await getAccessToken(config, kv, now);

  let response: Response;
  try {
    response = await fetch(
      `${IDENTITY_TOOLKIT_BASE}/${encodeURIComponent(config.projectId)}/accounts:sendOobCode`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          requestType: "PASSWORD_RESET",
          email,
          // The half that matters: Firebase returns the link and sends nothing.
          returnOobLink: true,
          ...(options.continueUrl === undefined ? {} : { continueUrl: options.continueUrl }),
        }),
      }
    );
  } catch (cause) {
    throw new ApiError("INTERNAL_ERROR", "The reset link could not be generated.", {
      internalReason: `Identity Toolkit unreachable: ${String(cause)}`,
    });
  }

  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    // EMAIL_NOT_FOUND is the documented shape for "no such identity", and it is
    // the one non-2xx here that is an answer rather than a fault.
    if (detail.includes("EMAIL_NOT_FOUND")) return null;
    throw new ApiError("INTERNAL_ERROR", "The reset link could not be generated.", {
      internalReason: `Identity Toolkit returned ${response.status}: ${detail}`,
    });
  }

  const body = (await response.json()) as { oobLink?: string; email?: string };
  if (typeof body.oobLink !== "string" || body.oobLink === "") {
    throw new ApiError("INTERNAL_ERROR", "The reset link could not be generated.", {
      internalReason: "Identity Toolkit returned no oobLink",
    });
  }

  return { link: body.oobLink, email: body.email ?? email };
}
