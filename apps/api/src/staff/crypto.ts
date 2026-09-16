/**
 * Password hashing, TOTP, and encrypting the TOTP secret at rest —
 * 14 PART 27.2, 06 PART 16.5/16.16a.
 *
 * **On the password hash.** 16.5 specifies Argon2id and names bcrypt as the
 * documented fallback, and it explicitly required this to be *measured* at
 * implementation time rather than assumed, because Workers caps CPU per
 * request. Measured: neither runs here without shipping a WASM build, and a
 * WASM Argon2id inside the CPU budget would need parameters weak enough to
 * undercut the point of choosing it. PBKDF2-SHA256 is what Web Crypto provides
 * natively. At 210,000 iterations it is OWASP's current floor for
 * PBKDF2-HMAC-SHA256, and it is what this platform can actually deliver.
 *
 * This is a deviation from the spec, recorded here rather than made quietly.
 * It applies to **staff only** — customers never have a password at all, since
 * Firebase owns that entirely.
 *
 * **On the TOTP secret.** It is encrypted with AES-256-GCM under
 * `DATABASE_ENCRYPTION_KEY` and decrypted only in memory at verification. A
 * second factor stored in plaintext is worth exactly as much as the database it
 * sits in, which is to say it is not a second factor.
 */

const PBKDF2_ITERATIONS = 210_000;
const SALT_BYTES = 16;
const KEY_BITS = 256;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** `pbkdf2$<iterations>$<salt hex>$<hash hex>` — self-describing, so the cost can be raised later without invalidating existing hashes. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toHex(salt)}$${toHex(hash)}`;
}

async function derive(
  password: string,
  salt: Uint8Array,
  iterations: number
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    KEY_BITS
  );
  return new Uint8Array(bits);
}

/**
 * Verify a password against a stored hash.
 *
 * The parameters come from the stored string rather than the constants above,
 * so raising the iteration count does not lock out every existing account.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;

  const iterations = Number.parseInt(parts[1] ?? "", 10);
  const salt = parts[2];
  const expected = parts[3];
  if (!Number.isFinite(iterations) || salt === undefined || expected === undefined) return false;

  const actual = toHex(await derive(password, fromHex(salt), iterations));
  return timingSafeEqualHex(actual, expected);
}

/** Constant-time over equal-length hex. Length is fixed for everything we produce. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* --------------------------------- TOTP ---------------------------------- */

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const TOTP_PERIOD = 30;
const TOTP_DIGITS = 6;

/** A new secret, in the base32 an authenticator app expects. */
export function generateTotpSecret(bytes = 20): string {
  const random = crypto.getRandomValues(new Uint8Array(bytes));
  let bits = "";
  for (const byte of random) bits += byte.toString(2).padStart(8, "0");
  let secret = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    secret += BASE32[Number.parseInt(bits.slice(i, i + 5), 2)];
  }
  return secret;
}

function base32Decode(secret: string): Uint8Array {
  const clean = secret.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = "";
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) continue;
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  }
  return bytes;
}

/**
 * The code for one time step.
 *
 * Exported because provisioning a staff account needs to show the operator a
 * working code to confirm their authenticator is enrolled correctly - and
 * because a test that searches for a valid code instead of computing one does a
 * million HMACs to learn something the algorithm can just tell it.
 */
export async function totpAt(secret: string, counter: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    base32Decode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );

  // RFC 4226: the counter is an 8-byte big-endian integer.
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setUint32(0, Math.floor(counter / 0x100000000));
  view.setUint32(4, counter >>> 0);

  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, buffer));
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const binary =
    (((mac[offset] ?? 0) & 0x7f) << 24) |
    (((mac[offset + 1] ?? 0) & 0xff) << 16) |
    (((mac[offset + 2] ?? 0) & 0xff) << 8) |
    ((mac[offset + 3] ?? 0) & 0xff);

  return (binary % 10 ** TOTP_DIGITS).toString().padStart(TOTP_DIGITS, "0");
}

/** The code valid right now, for the same secret. */
export async function currentTotp(secret: string, now: number): Promise<string> {
  return totpAt(secret, Math.floor(now / 1000 / TOTP_PERIOD));
}

/**
 * Verify a TOTP code, allowing one step either side.
 *
 * The window is deliberately ±1 step and not more. Every extra step multiplies
 * the codes a brute-force attempt can hit, and thirty seconds of clock skew is
 * already generous for a phone that syncs its time from the network.
 */
export async function verifyTotp(
  secret: string,
  code: string,
  now: number,
  window = 1
): Promise<boolean> {
  const trimmed = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(trimmed)) return false;

  const counter = Math.floor(now / 1000 / TOTP_PERIOD);
  for (let drift = -window; drift <= window; drift += 1) {
    // Compared in constant time. A timing-distinguishable compare here would
    // leak which digits were right, one request at a time.
    if (timingSafeEqualHex(await totpAt(secret, counter + drift), trimmed)) return true;
  }
  return false;
}

/** The URI an authenticator app scans. Never logged — it contains the secret. */
export function totpProvisioningUri(email: string, secret: string): string {
  const label = encodeURIComponent(`AgentDisk:${email}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=AgentDisk&algorithm=SHA1&digits=6&period=30`;
}

/* ------------------------- encryption at rest ---------------------------- */

async function encryptionKey(secret: string): Promise<CryptoKey> {
  // The configured secret is a passphrase, not a key. Hashing it to 256 bits
  // means any length of secret works and none of it is truncated silently.
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** `<iv hex>:<ciphertext hex>`. A fresh IV per encryption, which GCM requires. */
export async function encryptSecret(plaintext: string, key: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await encryptionKey(key),
    new TextEncoder().encode(plaintext)
  );
  return `${toHex(iv)}:${toHex(new Uint8Array(ciphertext))}`;
}

export async function decryptSecret(stored: string, key: string): Promise<string | null> {
  const [ivHex, dataHex] = stored.split(":");
  if (ivHex === undefined || dataHex === undefined) return null;
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromHex(ivHex) },
      await encryptionKey(key),
      fromHex(dataHex)
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    // A wrong key or a tampered ciphertext. GCM's authentication tag is what
    // makes this a detection rather than silent garbage.
    return null;
  }
}
