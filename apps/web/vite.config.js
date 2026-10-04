import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { discoveryFiles } from './scripts/agent-discovery.js';
import { renderHeadersFile, renderRobotsFile, robotsMetaTag } from './scripts/security-headers.js';

// This config is ESM (`"type": "module"`), so the CommonJS `__dirname` global
// does not exist here.
const here = dirname(fileURLToPath(import.meta.url));

/**
 * Emit `dist/_headers` so Cloudflare's asset server attaches the security
 * headers to every response, and `dist/robots.txt` beside it.
 *
 * Generated rather than committed under `public/` because two CSP directives
 * name the API origin and the Firebase auth domain this build was compiled
 * against, and those differ between dev and prod. Reading them from the same
 * `VITE_*` values the bundle is built with means the policy cannot come to
 * describe a different backend than the app actually calls. The robots file
 * and the `X-Robots-Tag` header differ by environment too — only prod may be
 * indexed — and `ENVIRONMENT_NAME` is the CI deploy job's own name for the
 * environment it is pinned to. Unset means not prod; see `isIndexable`.
 *
 * `closeBundle` rather than `writeBundle`: Vite empties `outDir` as part of the
 * build, and writing before it has finished is a race that loses the file
 * silently on some runs.
 */
function securityHeadersFile(env) {
  const options = {
    apiBase: env.VITE_API_BASE,
    firebaseAuthDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
    environment: env.ENVIRONMENT_NAME
  };
  return {
    name: 'agentdisk-security-headers',
    apply: 'build',
    // A non-indexable build also says so inside the document, for crawlers
    // that read neither robots.txt nor response headers.
    transformIndexHtml() {
      const tag = robotsMetaTag(options);
      // Which hostname the prerendered landing page belongs to, for the
      // guard below: on the app host `/` is a redirect into the app, and the
      // homepage must not paint first. Absent in a single-host build.
      const siteHost = env.VITE_SITE_HOST
        ? [{ tag: 'meta', attrs: { name: 'agentdisk:site-host', content: env.VITE_SITE_HOST }, injectTo: 'head' }]
        : [];
      return [
        ...(tag ? [tag] : []),
        ...siteHost,
        // Synchronous, from <head>, ahead of the body: it hides prerendered
        // markup that belongs to another route before anything paints. See
        // public/prerender-guard.js and scripts/prerender.mjs.
        { tag: 'script', attrs: { src: '/prerender-guard.js' }, injectTo: 'head' }
      ];
    },
    closeBundle() {
      writeFileSync(join(here, 'dist', '_headers'), renderHeadersFile(options), 'utf8');
      writeFileSync(join(here, 'dist', 'robots.txt'), renderRobotsFile(options), 'utf8');
      // sitemap.xml is written by scripts/prerender.mjs since 4 Oct 2026,
      // from the same list of routes it prerenders, blog posts included.
      //
      // The agent discovery documents (auth.md, openapi.json, the API catalog,
      // the MCP server card, the skills index, the ARD manifest), naming this
      // environment's API and site. Only a build that knows both hostnames
      // can write them; a single-host local build goes without.
      if (env.VITE_API_BASE && env.VITE_SITE_HOST && env.VITE_APP_HOST) {
        const files = discoveryFiles({
          apiBase: env.VITE_API_BASE,
          siteHost: env.VITE_SITE_HOST,
          appHost: env.VITE_APP_HOST,
          llmsTxt: readFileSync(join(here, 'public', 'llms.txt'), 'utf8')
        });
        for (const [path, contents] of Object.entries(files)) {
          const file = join(here, 'dist', ...path.split('/').filter(Boolean));
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, contents, 'utf8');
        }
      }
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
    // No source map. Until 28 Sept 2026 a 2.5 MB map was served beside the
    // bundle, and this codebase's comments are a guide to where its guards
    // are and why. Set to 'hidden' if a map is ever wanted for local
    // debugging, and keep `*.map` out of dist either way - the asset server
    // uploads everything in it.
    build: { outDir: 'dist', sourcemap: false }
  };
});
