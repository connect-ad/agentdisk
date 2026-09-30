/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { Env as WorkerEnv } from "../src/index";

/**
 * The pool types `env` as `Cloudflare.Env`, so that is the interface to
 * augment. Extending the Worker's own Env rather than restating the bindings
 * keeps the tests honest: adding a binding to src/index.ts makes it available
 * here automatically, and removing one breaks the tests that used it.
 */
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      /** Migrations read from disk by vitest.config.ts, applied in setup. */
      TEST_MIGRATIONS: { name: string; queries: string[] }[];
      TURNSTILE_SECRET_KEY: string;
      R2_ACCESS_KEY_ID: string;
      R2_SECRET_ACCESS_KEY: string;
    }
  }
}

export {};
