import { generateKeyPairSync } from "node:crypto";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

/**
 * Tests run inside the real Workers runtime against a real (Miniflare-backed)
 * D1, not a mock. Doc 08 is explicit that tenant-isolation tests must prove
 * behaviour against actual D1 - a mocked query layer would happily "prove" an
 * isolation guarantee the real SQL does not provide.
 *
 * Migrations are read here, in Node, because the Workers runtime has no
 * filesystem. They are the same .sql files the deploy applies: a separately
 * maintained test schema is how a migration bug survives a green suite.
 */
export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");

  // A throwaway RSA key, generated fresh every run, so the staff password-reset
  // path can exercise the real assertion signing in auth/firebase-admin.ts
  // rather than a stub of it. Generated rather than committed: a PEM in the
  // repo is a PEM somebody eventually reuses, and a scanner cannot tell a test
  // key from a live one.
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const serviceAccountJson = JSON.stringify({
    client_email: "test-admin@agentdisk-dev.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    project_id: "agentdisk-dev",
  });

  return {
    plugins: [
      cloudflareTest({
        singleWorker: true,
        wrangler: { configPath: "./wrangler.toml", environment: "dev" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            // POST /v1/workspaces refuses to run without this, by design. The
            // value is irrelevant - every test stubs the siteverify call - but
            // it has to be present or the route fails closed before its gates.
            TURNSTILE_SECRET_KEY: "test-turnstile-secret",
            // Billing refuses to run without both, so the webhook tests
            // would never reach the signature check they exist to exercise.
            // Staff login refuses to run without it, because it decrypts
            // the TOTP secret and an unverifiable second factor is not one.
            DATABASE_ENCRYPTION_KEY: "test-database-encryption-key",
            STRIPE_SECRET_KEY: "sk_test_dummy",
            STRIPE_WEBHOOK_SECRET: "whsec_test_secret",
            // Presigning needs a key pair to produce a signature at all. These
            // are fake and never verified by anything - the tests assert the
            // URL's shape and scope, not that R2 would accept it - but without
            // them every presign path would return "not configured" and the
            // upload and download routes would go untested.
            R2_ACCESS_KEY_ID: "test-access-key-id",
            R2_SECRET_ACCESS_KEY: "test-secret-access-key",
            // Staff password reset refuses without both, so every test of it
            // would assert the refusal and none would reach the send. The
            // outbound calls are stubbed per-test; these only have to be
            // present and well-formed.
            MAILERSEND_API_TOKEN: "test-mailersend-token",
            FIREBASE_SERVICE_ACCOUNT_JSON: serviceAccountJson,
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
