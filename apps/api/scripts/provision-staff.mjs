/**
 * Provision a staff account.
 *
 * This exists because `POST /v1/staff/users` deliberately returns 501: an
 * endpoint that mints a working staff credential is an endpoint that can be
 * tricked into minting one. The consequence is a chicken-and-egg problem —
 * creating a staff account requires being a staff super_admin — and this script
 * is the documented way out of it. It is also the only way the *first* account
 * can ever exist.
 *
 * It computes exactly what the Worker computes (same PBKDF2 parameters, same
 * AES-GCM format, same base32 TOTP), because Node 22 and Workers both expose
 * Web Crypto. Nothing here reimplements an algorithm the API would then reject.
 *
 * What it writes and what it shows are different on purpose. The generated
 * `.sql` file contains only a password *hash* and an *encrypted* TOTP secret,
 * so it is safe to hand to `wrangler`. The password and the enrolment URI are
 * printed to the terminal once and never written anywhere — same show-once
 * discipline as a customer API key.
 *
 * usage:
 *   DATABASE_ENCRYPTION_KEY=... node scripts/provision-staff.mjs \
 *     --email you@example.com --role super_admin [--env dev]
 *
 * The encryption key comes from the environment, never from an argument:
 * arguments land in shell history and in the process list, where other users on
 * the machine can read them.
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

/* ------------------------------- arguments ------------------------------- */

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const flag = process.argv[i];
  if (!flag?.startsWith("--")) continue;
  args.set(flag.slice(2), process.argv[i + 1]);
}

const email = args.get("email")?.trim().toLowerCase();
const role = args.get("role") ?? "super_admin";
const environment = args.get("env") ?? "dev";

const ROLES = ["support", "admin", "super_admin"];

function die(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

if (!email || !email.includes("@")) die("--email is required and must be an address");
if (!ROLES.includes(role)) die(`--role must be one of ${ROLES.join(", ")}`);
if (!["dev", "prod"].includes(environment)) die("--env must be dev or prod");

const encryptionKey = process.env.DATABASE_ENCRYPTION_KEY;
if (!encryptionKey) {
  die(
    "DATABASE_ENCRYPTION_KEY is not set. It must match the value the Worker runs with, " +
      "or the TOTP secret written here cannot be decrypted at login. " +
      "Set it in your shell from the GitHub Environment secret; do not pass it as an argument."
  );
}

/* -------------------------- crypto, mirrored ----------------------------- */
// Kept byte-compatible with apps/api/src/staff/crypto.ts. If that file's
// parameters change, this one has to change with it — which is why both say so.

const PBKDF2_ITERATIONS = 210_000;
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

const toHex = (bytes) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

async function derive(password, salt, iterations) {
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
    256
  );
  return new Uint8Array(bits);
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toHex(salt)}$${toHex(hash)}`;
}

function generateTotpSecret(bytes = 20) {
  const random = crypto.getRandomValues(new Uint8Array(bytes));
  let bits = "";
  for (const byte of random) bits += byte.toString(2).padStart(8, "0");
  let secret = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    secret += BASE32[Number.parseInt(bits.slice(i, i + 5), 2)];
  }
  return secret;
}

function base32Decode(secret) {
  let bits = "";
  for (const char of secret.toUpperCase()) {
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

/** RFC 6238, so the operator can confirm enrolment before trusting the account. */
async function currentTotp(secret) {
  const counter = Math.floor(Date.now() / 1000 / 30);
  const key = await crypto.subtle.importKey(
    "raw",
    base32Decode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setUint32(0, Math.floor(counter / 0x100000000));
  view.setUint32(4, counter >>> 0);

  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, buffer));
  const offset = mac[mac.length - 1] & 0x0f;
  const binary =
    ((mac[offset] & 0x7f) << 24) |
    ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) << 8) |
    (mac[offset + 3] & 0xff);
  return (binary % 1_000_000).toString().padStart(6, "0");
}

async function encryptionCryptoKey(secret) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt"]);
}

async function encryptSecret(plaintext, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await encryptionCryptoKey(key),
    new TextEncoder().encode(plaintext)
  );
  return `${toHex(iv)}:${toHex(new Uint8Array(ciphertext))}`;
}

/* ---------------------------------- ULID --------------------------------- */

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function ulid(now = Date.now()) {
  let time = "";
  let value = now;
  for (let i = 9; i >= 0; i -= 1) {
    const mod = value % 32;
    time = ULID_ALPHABET[mod] + time;
    value = (value - mod) / 32;
  }
  const random = crypto.getRandomValues(new Uint8Array(16));
  return time + Array.from(random, (b) => ULID_ALPHABET[b % 32]).join("");
}

/* ------------------------------ a password ------------------------------- */

/**
 * Generated rather than chosen. A staff password typed by a human at
 * provisioning time is a password that gets reused, and this account is the one
 * that can read any customer's file list.
 */
function generatePassword(length = 32) {
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789-_";
  const random = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(random, (b) => alphabet[b % alphabet.length]).join("");
}

/* --------------------------------- main ---------------------------------- */

const id = `stf_${ulid()}`;
const password = generatePassword();
const totpSecret = generateTotpSecret();
const now = Date.now();

const passwordHash = await hashPassword(password);
const encryptedTotp = await encryptSecret(totpSecret, encryptionKey);

// SQL string literals: the only user-controlled value is the email, and a
// doubled quote is SQLite's own escape. Everything else is generated hex.
const sqlSafeEmail = email.replace(/'/g, "''");

const sql = `-- Staff account for ${sqlSafeEmail} (${role}), generated ${new Date(now).toISOString()}.
-- Contains a password hash and an ENCRYPTED TOTP secret; neither is usable on
-- its own. Delete this file once applied.
INSERT INTO staff_users (id, email, password_hash, totp_secret, role, created_at)
VALUES (
  '${id}',
  '${sqlSafeEmail}',
  '${passwordHash}',
  '${encryptedTotp}',
  '${role}',
  ${now}
);
`;

const outPath = resolve(process.cwd(), `staff-${environment}-${id}.sql`);
writeFileSync(outPath, sql, { encoding: "utf8", mode: 0o600 });

const totpNow = await currentTotp(totpSecret);
const otpauth = `otpauth://totp/${encodeURIComponent(`AgentDisk:${email}`)}?secret=${totpSecret}&issuer=AgentDisk&algorithm=SHA1&digits=6&period=30`;

console.log(`
Staff account prepared — NOT yet created. One command left.

  id       ${id}
  email    ${email}
  role     ${role}
  env      ${environment}

Apply it:

  npx wrangler d1 execute agentdisk-${environment} --remote --file "${outPath}"

Then delete that file. It is not a credential, but it is a fact about one.

------------------------------------------------------------------------
SHOWN ONCE. Nothing below is stored anywhere, by design.

  password   ${password}

  enrol in your authenticator, either by URI:
    ${otpauth}

  or by typing this secret manually:
    ${totpSecret}

  Your authenticator should be showing ${totpNow} right now.
  If it shows something else, the enrolment did not take — fix that
  BEFORE applying the SQL, or you will create an account you cannot
  log in to and cannot delete through the API.
------------------------------------------------------------------------
`);
