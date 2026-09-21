/**
 * Assert that a dev reset actually emptied what it claimed to. TEMPORARY —
 * delete alongside `.github/workflows/reset-dev.yml` and
 * `scripts/reset-dev-data.sql`.
 *
 * A separate file rather than `node -e` in the workflow so the checks can be
 * read without counting shell quoting levels, and so a mistake here is a
 * syntax error at the top of the step rather than a silently truthy `[ ]`.
 *
 * It asserts in both directions. "Everything is gone" is the easy half; the
 * half that matters is what SURVIVED. Emptying `staff_users` locks every
 * administrator out of the console permanently — migration 0014 seeds the
 * first one and will not re-run, because `d1_migrations` says it already did.
 * The first sign of that would be a failed login some time later, with nothing
 * connecting it to this run.
 */

import { readFileSync } from "node:fs";

const path = process.argv[2];
if (path === undefined) {
  console.log("::error::check-reset.mjs needs the path to wrangler's --json output.");
  process.exit(1);
}

let row;
try {
  const payload = JSON.parse(readFileSync(path, "utf8"));
  row = payload[0]?.results?.[0];
} catch (err) {
  console.log(`::error::Could not read the verification output: ${err.message}`);
  process.exit(1);
}

if (row === undefined) {
  // Not the same as "everything is zero". A shape we cannot read means the
  // reset is unverified, and reporting success on an unread result is the
  // failure mode this step exists to prevent.
  console.log("::error::Verification query returned nothing readable; the reset is unconfirmed.");
  process.exit(1);
}

const mustBeEmpty = ["users", "orgs", "workspaces", "files"];
const left = mustBeEmpty.filter(key => row[key] !== 0);

if (left.length > 0) {
  const detail = left.map(key => `${key}=${row[key]}`).join(", ");
  console.log(`::error::Still populated after the reset: ${detail}`);
  process.exit(1);
}

if (row.staff_kept === 0) {
  console.log(
    "::error::staff_users is empty - nobody can sign in to the admin console, " +
      "and migration 0014 will not re-seed it. Insert a super_admin row before deploying."
  );
  process.exit(1);
}

// Not fatal. The catalogue is populated by hand from the Stripe dashboard and
// an empty one degrades to the lib/plans.ts floor rather than breaking, so
// this is worth saying out loud and not worth failing the run over.
if (row.plans_kept === 0) {
  console.log("::warning::The plan catalogue is empty; entitlements fall back to the lib/plans.ts floor.");
}

console.log(`Dev is empty. Kept ${row.staff_kept} staff account(s) and ${row.plans_kept} plan(s).`);
