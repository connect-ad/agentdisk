/**
 * Freezes a run's per-test outcomes into a comparable baseline, and diffs a
 * later run against it.
 *
 * Playwright's own HTML report is for reading; this is for deciding. The rule
 * the migration brief sets is narrow and mechanical — *a test that passed
 * before and fails now is a blocker* — so that is the only comparison this
 * makes. New tests and newly-fixed tests are reported but never block.
 *
 *   node scripts/snapshot.mjs save baseline/app-dev.json
 *   node scripts/snapshot.mjs compare baseline/app-dev.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RESULTS = path.join(here, 'test-results', 'results.json');

/** Flatten Playwright's nested JSON report into `"project › title" -> status`. */
function outcomes(report) {
  const out = {};
  const walk = (suites, trail) => {
    for (const suite of suites || []) {
      const next = suite.title ? [...trail, suite.title] : trail;
      for (const spec of suite.specs || []) {
        for (const t of spec.tests || []) {
          const key = `${t.projectName} › ${[...next, spec.title].join(' › ')}`;
          // `status` is the expectation-adjusted outcome: expected/unexpected/
          // flaky/skipped. "expected" is the only one that counts as a pass.
          out[key] = t.status;
        }
      }
      walk(suite.suites, next);
    }
  };
  walk(report.suites, []);
  return out;
}

function load(file) {
  if (!fs.existsSync(file)) {
    console.error(`✗ ${file} not found. Run \`npm test\` first.`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const [mode, file] = process.argv.slice(2);

if (mode === 'save') {
  const target = file || path.join(here, 'baseline', 'baseline.json');
  const snap = outcomes(load(RESULTS));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(snap, null, 2) + '\n');
  const passed = Object.values(snap).filter(s => s === 'expected').length;
  console.log(`✓ baseline saved: ${Object.keys(snap).length} tests, ${passed} passing → ${path.relative(process.cwd(), target)}`);
} else if (mode === 'compare') {
  const base = JSON.parse(fs.readFileSync(file || path.join(here, 'baseline', 'baseline.json'), 'utf8'));
  const now = outcomes(load(RESULTS));

  const regressed = [];
  const fixed = [];
  const added = [];
  const missing = [];

  for (const [key, was] of Object.entries(base)) {
    if (!(key in now)) { missing.push(key); continue; }
    const is = now[key];
    if (was === 'expected' && is !== 'expected') regressed.push(`${key}  (${was} → ${is})`);
    if (was !== 'expected' && is === 'expected') fixed.push(key);
  }
  for (const key of Object.keys(now)) if (!(key in base)) added.push(key);

  const section = (title, items) => {
    if (!items.length) return;
    console.log(`\n${title} (${items.length}):`);
    for (const i of items) console.log(`  ${i}`);
  };

  section('REGRESSED — passed at baseline, failing now', regressed);
  section('Disappeared — in the baseline, not in this run', missing);
  section('Fixed — failing at baseline, passing now', fixed);
  section('New — not in the baseline', added);

  if (regressed.length === 0 && missing.length === 0) {
    console.log('\n✓ No regressions against baseline.');
    process.exit(0);
  }
  console.log(`\n✗ ${regressed.length} regression(s), ${missing.length} disappeared. This is a merge blocker.`);
  process.exit(1);
} else {
  console.error('usage: node scripts/snapshot.mjs <save|compare> [file]');
  process.exit(1);
}
