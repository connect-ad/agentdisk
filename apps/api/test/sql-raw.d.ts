/**
 * `import sql from "./x.sql?raw"` — Vite's text import, typed. TEMPORARY:
 * delete alongside `test/reset-dev.test.ts`, its only consumer.
 *
 * Its own file rather than a block in `env.d.ts`, because that file ends in
 * `export {}` and is therefore a module: an ambient wildcard declaration
 * placed inside it is read as a module augmentation and silently fails to
 * match, which shows up as `TS2307: cannot find module` on the import it was
 * written to satisfy. This file deliberately has no import or export.
 */

declare module "*.sql?raw" {
  const contents: string;
  export default contents;
}
