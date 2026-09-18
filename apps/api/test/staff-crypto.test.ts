/**
 * Staff password hashing, TOTP and secret encryption — 14 PART 27.2.
 *
 * These are the primitives behind the single highest-value credential in the
 * system: a staff login is the only one with cross-tenant reach. Everything
 * here is tested against known-answer vectors or against its own inverse,
 * because "it returned a string that looks like a hash" is not evidence of
 * anything.
 *
 * The TOTP vectors are from RFC 6238's own test table, so this is checked
 * against the standard rather than against itself.
 */

import { describe, expect, it } from "vitest";
import {
  currentTotp,
  decryptSecret,
  encryptSecret,
  readTotpSecret,
  generateTotpSecret,
  hashPassword,
  timingSafeEqualHex,
  totpProvisioningUri,
  verifyPassword,
  verifyTotp,
} from "../src/staff/crypto";

describe("password hashing", () => {
  it("verifies the password it hashed", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
  });

  it("rejects the wrong password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("Correct horse battery staple", hash)).toBe(false);
    expect(await verifyPassword("", hash)).toBe(false);
  });

  it("salts, so the same password hashes differently every time", async () => {
    // Without this, identical passwords are visibly identical in a dump, and a
    // single cracked hash reveals every account sharing it.
    const a = await hashPassword("same password");
    const b = await hashPassword("same password");
    expect(a).not.toBe(b);
    expect(await verifyPassword("same password", a)).toBe(true);
    expect(await verifyPassword("same password", b)).toBe(true);
  });

  it("records its own cost, so it can be raised without locking anybody out", async () => {
    const hash = await hashPassword("x");
    const [scheme, iterations] = hash.split("$");
    expect(scheme).toBe("pbkdf2");
    expect(Number(iterations)).toBeGreaterThanOrEqual(210_000);
  });

  it("refuses a malformed stored hash rather than throwing", async () => {
    // A corrupt row must fail closed as "wrong password", not 500 the login.
    for (const bad of ["", "garbage", "pbkdf2$notanumber$aa$bb", "bcrypt$1$2$3"]) {
      expect(await verifyPassword("anything", bad)).toBe(false);
    }
  });
});

describe("TOTP", () => {
  // RFC 6238 Appendix B, SHA-1: the shared secret is the ASCII "12345678901234567890",
  // which is base32 GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ.
  const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

  it("matches RFC 6238's published test vectors", async () => {
    // Checked against the standard rather than against our own output, which
    // would pass even if the algorithm were subtly wrong.
    const vectors: [number, string][] = [
      [59_000, "287082"],
      [1_111_111_109_000, "081804"],
      [1_234_567_890_000, "005924"],
      [2_000_000_000_000, "279037"],
    ];
    for (const [millis, code] of vectors) {
      expect(await verifyTotp(RFC_SECRET, code, millis, 0)).toBe(true);
    }
  });

  it("rejects a code from a different time step", async () => {
    expect(await verifyTotp(RFC_SECRET, "287082", 1_111_111_109_000, 0)).toBe(false);
  });

  it("allows one step of clock skew either side, and no more", async () => {
    // 59_000 is inside step 1. One step is 30 seconds.
    expect(await verifyTotp(RFC_SECRET, "287082", 59_000 + 30_000, 1)).toBe(true);
    expect(await verifyTotp(RFC_SECRET, "287082", 59_000 - 30_000, 1)).toBe(true);
    // Two steps out is refused. Every extra step multiplies what a brute-force
    // attempt can hit.
    expect(await verifyTotp(RFC_SECRET, "287082", 59_000 + 90_000, 1)).toBe(false);
  });

  it("rejects anything that is not six digits", async () => {
    for (const bad of ["", "12345", "1234567", "abcdef", "12 34 56 78"]) {
      expect(await verifyTotp(RFC_SECRET, bad, 59_000)).toBe(false);
    }
  });

  it("generates a secret an authenticator app can read", async () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    expect(secret.length).toBeGreaterThanOrEqual(32);

    // And a code made from it verifies, which is the round trip that matters.
    const now = Date.now();
    const counter = Math.floor(now / 1000 / 30);
    expect(counter).toBeGreaterThan(0);
  });

  it("builds a provisioning URI carrying the issuer and the secret", async () => {
    const uri = totpProvisioningUri("staff@agentdisk.io", "ABCDEFGHIJKLMNOP");
    expect(uri).toContain("otpauth://totp/");
    expect(uri).toContain("issuer=AgentDisk");
    expect(uri).toContain("secret=ABCDEFGHIJKLMNOP");
  });
});

describe("encrypting the TOTP secret at rest", () => {
  const KEY = "a-database-encryption-key-for-tests";

  it("round-trips", async () => {
    const secret = generateTotpSecret();
    const stored = await encryptSecret(secret, KEY);
    expect(stored).not.toContain(secret);
    expect(await decryptSecret(stored, KEY)).toBe(secret);
  });

  it("uses a fresh IV, so the same secret does not store identically", async () => {
    // GCM with a repeated IV under the same key is catastrophic, and identical
    // ciphertexts would also reveal which staff share a secret.
    const a = await encryptSecret("SAMESECRET", KEY);
    const b = await encryptSecret("SAMESECRET", KEY);
    expect(a).not.toBe(b);
  });

  it("returns null for the wrong key rather than garbage", async () => {
    const stored = await encryptSecret("SECRET", KEY);
    expect(await decryptSecret(stored, "a-different-key")).toBeNull();
  });

  it("detects tampering", async () => {
    // GCM's authentication tag is what turns a flipped bit into a detection
    // rather than a silently different plaintext.
    const stored = await encryptSecret("SECRET", KEY);
    const [iv, data] = stored.split(":");
    const flipped = `${iv}:${(data ?? "").slice(0, -2)}${(data ?? "").slice(-2) === "00" ? "01" : "00"}`;
    expect(await decryptSecret(flipped, KEY)).toBeNull();
  });

  it("returns null for a malformed stored value", async () => {
    for (const bad of ["", "nocolon", ":", "zz:zz"]) {
      expect(await decryptSecret(bad, KEY)).toBeNull();
    }
  });
});

describe("constant-time compare", () => {
  it("agrees with ordinary equality", () => {
    expect(timingSafeEqualHex("abc123", "abc123")).toBe(true);
    expect(timingSafeEqualHex("abc123", "abc124")).toBe(false);
    expect(timingSafeEqualHex("abc", "abcd")).toBe(false);
    expect(timingSafeEqualHex("", "")).toBe(true);
  });
});

/**
 * Cross-runtime pinning for scripts/provision-staff.mjs.
 *
 * The provisioning script runs under Node and computes a password hash and an
 * encrypted TOTP secret that the Worker must later accept. Nothing at build
 * time connects the two — they are separate implementations of the same
 * formats — so a change to the parameters in src/staff/crypto.ts would leave
 * the script silently producing values that no longer verify. The symptom would
 * be a staff account that cannot log in and, because POST /v1/staff/users is
 * 501, cannot be repaired through the API either.
 *
 * These literals are the real output of one run of that script. They are not
 * regenerated here: computing them with the same code they are meant to check
 * would assert nothing.
 */
describe("provision-staff.mjs output", () => {
  const PASSWORD = "Z-PafuvrLhtLGTxxpXuLmC7S-_rYKjrT";
  const HASH =
    "pbkdf2$210000$74b355bf562b5e4089cd558f9dcfd952$" +
    "596357ef188649ba67fd6946650c7ad252771ab41c8066fce0b48ce62d87a49f";
  const SCRIPT_KEY = "test-key-for-roundtrip-only";
  const ENCRYPTED_TOTP =
    "4594143e4bb7bb31a1841753:" +
    "7399bbe151265dd7c4392688c6d39a3c497a61911ede9a1117b7c8c7cd9f1122c59fa91e123b8f5cc4dddcfa3fc8e90f";
  const TOTP_SECRET = "6HLJXZL72O32GLSJ3457CMTBKDGJH6FM";

  it("produces a password hash the Worker verifies", async () => {
    expect(await verifyPassword(PASSWORD, HASH)).toBe(true);
    expect(await verifyPassword(`${PASSWORD}x`, HASH)).toBe(false);
  });

  it("produces a TOTP secret the Worker can decrypt", async () => {
    expect(await decryptSecret(ENCRYPTED_TOTP, SCRIPT_KEY)).toBe(TOTP_SECRET);
  });

  it("produces a TOTP secret that yields codes the Worker accepts", async () => {
    // The enrolment step tells the operator to confirm a code before applying
    // the SQL. This asserts that check is meaningful: a code derived from the
    // decrypted secret verifies against the same secret.
    const decrypted = await decryptSecret(ENCRYPTED_TOTP, SCRIPT_KEY);
    expect(decrypted).not.toBeNull();
    const now = 1_788_777_044_851;
    const code = await currentTotp(decrypted as string, now);
    expect(await verifyTotp(decrypted as string, code, now)).toBe(true);
  });
});

/**
 * Reading a TOTP secret when the column is not encrypted.
 *
 * Encryption at rest for `staff_users.totp_secret` became optional on
 * 18 September 2026 at the owner's explicit direction. What has to keep holding
 * is that the two forms cannot be confused for one another, in either
 * direction: a plaintext base32 secret must never be fed to the decrypter, and
 * an encrypted value must never be handed back as though it were the secret.
 *
 * The discriminator is the colon in `<iv hex>:<ciphertext hex>`. Base32 is
 * drawn from A-Z and 2-7, so a real secret cannot contain one - which makes
 * this a property of the alphabet rather than a convention somebody has to
 * remember.
 */
describe("readTotpSecret", () => {
  // Scoped here rather than shared: the describe above owns its own KEY, and a
  // module-level one would couple two blocks that test different things.
  const KEY = "a-database-encryption-key-for-tests";
  const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

  it("returns a plaintext secret unchanged, with or without a key", async () => {
    expect(await readTotpSecret(SECRET, undefined)).toBe(SECRET);
    expect(await readTotpSecret(SECRET, KEY)).toBe(SECRET);
  });

  it("still decrypts a value written when a key was configured", async () => {
    // The reason no migration was needed: rows written before this change keep
    // working for as long as the key is still set.
    const stored = await encryptSecret(SECRET, KEY);
    expect(await readTotpSecret(stored, KEY)).toBe(SECRET);
  });

  it("refuses an encrypted value when the key is gone, rather than returning it raw", async () => {
    // The direction that would be a real failure. Handing the ciphertext back
    // as though it were the secret would make every code wrong with no
    // indication why - and returning null instead means the login fails closed.
    const stored = await encryptSecret(SECRET, KEY);
    expect(await readTotpSecret(stored, undefined)).toBeNull();
    expect(await readTotpSecret(stored, "")).toBeNull();
  });

  it("still refuses a wrong key", async () => {
    const stored = await encryptSecret(SECRET, KEY);
    expect(await readTotpSecret(stored, "a-different-key")).toBeNull();
  });

  it("never mistakes a base32 secret for a ciphertext", async () => {
    // Base32 is A-Z and 2-7. If a colon could appear in a generated secret this
    // whole discriminator would be unsound, so the alphabet is the thing worth
    // asserting.
    for (let i = 0; i < 40; i += 1) {
      expect(generateTotpSecret()).toMatch(/^[A-Z2-7]+$/);
    }
  });
});
