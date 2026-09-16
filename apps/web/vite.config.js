import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { renderHeadersFile } from './scripts/security-headers.js';

// This config is ESM (`"type": "module"`), so the CommonJS `__dirname` global
// does not exist here.
const here = dirname(fileURLToPath(import.meta.url));

/**
 * Emit `dist/_headers` so Cloudflare's asset server attaches the security
 * headers to every response.
 *
 * Generated rather than committed under `public/` because two CSP directives
 * name the API origin and the Firebase auth domain this build was compiled
 * against, and those differ between dev and prod. Reading them from the same
 * `VITE_*` values the bundle is built with means the policy cannot come to
 * describe a different backend than the app actually calls.
 *
 * `closeBundle` rather than `writeBundle`: Vite empties `outDir` as part of the
 * build, and writing before it has finished is a race that loses the file
 * silently on some runs.
 */
function securityHeadersFile(env) {
  return {
    name: 'agentdisk-security-headers',
    apply: 'build',
    closeBundle() {
      writeFileSync(
        join(here, 'dist', '_headers'),
        renderHeadersFile({
          apiBase: env.VITE_API_BASE,
          firebaseAuthDomain: env.VITE_FIREBASE_AUTH_DOMAIN
        }),
        'utf8'
      );
    }
  };
}

export default defineConfig(({ mode }) => {
  // Third argument '' loads every variable, not only the VITE_-prefixed ones —
  // harmless here, and it means a rename of either variable does not silently
  // produce a policy with a missing source.
  const env = loadEnv(mode, here, '');

  return {
    plugins: [react(), securityHeadersFile(env)],
    build: { outDir: 'dist', sourcemap: true }
  };
});
