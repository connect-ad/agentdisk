/**
 * Catch the one class of bug the bundler does not.
 *
 * A `<Component>` used in JSX but never imported or defined is a *runtime*
 * ReferenceError. `vite build` succeeds, `vitest` passes any suite that does
 * not mount that particular subtree, and the page renders completely blank in
 * a browser.
 *
 * That is not hypothetical. It shipped /login, /signup and /forgot-password as
 * three empty pages during the site rebuild — build green, 105/105 unit tests
 * green — and nearly shipped a blank agents screen the same week.
 *
 * This is deliberately a narrow lexical check rather than a real linter: no
 * new dependency, no config, and it only reports the thing that actually bit.
 *
 *   node scripts/check-jsx-identifiers.mjs
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOTS = ['src/routes', 'src/components-local', 'src/lib'];

/** Tags that are not components: SVG and HTML elements React knows. */
const INTRINSIC = new Set(['React', 'Fragment']);

function declaredNames(src) {
  const names = new Set();

  // import X, { A as B, C } from '...'  — including multi-line blocks.
  for (const m of src.matchAll(/import\s+([\s\S]*?)\s+from\s+['"][^'"]+['"]/g)) {
    const clause = m[1];
    // default and namespace imports
    for (const d of clause.matchAll(/(?:^|,)\s*([A-Za-z_$][\w$]*)\s*(?=,|$|\{)/g)) {
      names.add(d[1]);
    }
    // named imports, honouring `as`
    const braced = clause.match(/\{([\s\S]*)\}/);
    if (braced) {
      for (const part of braced[1].split(',')) {
        const bits = part.trim().split(/\s+as\s+/);
        const name = (bits[1] ?? bits[0]).trim();
        if (name) names.add(name);
      }
    }
  }

  // function Foo(), const Foo = , class Foo
  for (const m of src.matchAll(/(?:function|class)\s+([A-Z][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Z][\w$]*)\s*=/g)) names.add(m[1]);

  return names;
}

let problems = 0;
let scanned = 0;

for (const root of ROOTS) {
  if (!fs.existsSync(root)) continue;
  for (const file of fs.readdirSync(root)) {
    if (!/\.jsx$/.test(file)) continue;
    const full = path.join(root, file);
    const src = fs.readFileSync(full, 'utf8');
    scanned += 1;

    // Strip string and template literals first. A placeholder like
    // '<YOUR_API_KEY>' inside a quoted string is not JSX, and flagging it
    // would train people to ignore this check — which is how a genuinely
    // blank page gets waved through.
    const code = src
      .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
      .replace(/`(?:[^`\\]|\\.)*`/g, '``');

    const declared = declaredNames(src);
    const used = new Set(
      [...code.matchAll(/<([A-Z][A-Za-z0-9_$]*)/g)].map(m => m[1])
    );

    for (const tag of used) {
      if (INTRINSIC.has(tag)) continue;
      // A member expression like <Foo.Bar> is declared by its root.
      const rootName = tag.split('.')[0];
      if (declared.has(rootName)) continue;
      console.error(`  ${full}: <${tag}> is used but never imported or defined`);
      problems += 1;
    }
  }
}

if (problems > 0) {
  console.error(`\n✗ ${problems} undefined JSX component(s) across ${scanned} files.`);
  console.error('  Each one renders a blank page at runtime while the build stays green.');
  process.exit(1);
}

console.log(`✓ every JSX component is imported or defined (${scanned} files)`);
