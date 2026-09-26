/**
 * Sealed secrets: AES-256-GCM under a key derived from DATABASE_ENCRYPTION_KEY.
 *
 * This exists because API keys are now kept (migration 0022). A key used to
 * exist nowhere after creation - only its hash - and that was the whole of the
 * protection: nothing to leak. Keeping one so the owner can view it again
 * means the Worker can produce it, so the least that can be done is to make
 * the stored form useless without the secret the Worker runs with. A copy of
 * the database is not a copy of the keys.
 *
 * ── Format ─────────────────────────────────────────────────────────────────
 * `v1.<iv>.<ciphertext+tag>`, base64url. The version prefix is what lets the
 * scheme change without a migration that re-seals every row on the spot: a
 * reader that meets a version it does not know answers null, and the caller
 * treats that exactly like "never kept".
 *
 * ── Associated data ────────────────────────────────────────────────────────
 * Every seal binds the ciphertext to a caller-supplied string - the key's row
 * id - so a ciphertext copied from one row into another opens as nothing. A
 * database write that can move a column between rows must not be able to
 * make key A reveal as key B.
 *
 * ── Key derivation ─────────────────────────────────────────────────────────
 * The env value is an operator-chosen string, not raw key material, so it is
 * hashed to 256 bits rather than used directly. No salt, deliberately: there
 * is one secret and one purpose, and a salt would have to be stored beside
 * every ciphertext to add nothing.
 */

const VERSION = "v1";
const IV_BYTES = 12;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function aesKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** Seal `plaintext` so that only `openSecret` with the same secret and `aad` recovers it. */
export async function sealSecret(secret: string, plaintext: string, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await aesKey(secret);
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(aad) },
    key,
    encoder.encode(plaintext)
  );
  return `${VERSION}.${b64url(iv)}.${b64url(new Uint8Array(sealed))}`;
}

/**
 * The plaintext, or null. Null covers every way this can fail - wrong secret,
 * wrong `aad`, tampered bytes, unknown version, garbage - because none of
 * them is something a caller can do anything different about, and a
 * distinguishable failure here would say which of them it was.
 */
export async function openSecret(secret: string, sealed: string, aad: string): Promise<string | null> {
  const parts = sealed.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) return null;
  try {
    const key = await aesKey(secret);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64url(parts[1] ?? ""), additionalData: encoder.encode(aad) },
      key,
      unb64url(parts[2] ?? "")
    );
    return decoder.decode(plaintext);
  } catch {
    return null;
  }
}
