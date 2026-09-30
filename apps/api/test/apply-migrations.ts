import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll } from "vitest";

/** Bring the test D1 up to the current schema before any test runs. */
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
