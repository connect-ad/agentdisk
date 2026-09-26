/**
 * Inject Terraform-owned resource IDs into wrangler.toml at deploy time.
 *
 * Usage: node scripts/apply-tf-outputs.mjs <env> <terraform-output-json-file>
 *
 * Terraform owns the infrastructure; Wrangler owns the code. This script is the
 * seam between them, so no human ever pastes a resource ID into wrangler.toml
 * and no ID can silently drift from what Terraform actually created.
 *
 * Fails loudly: a missing or empty output aborts the deploy rather than
 * shipping a Worker bound to the wrong (or a nonexistent) resource.
 */
import { readFileSync, writeFileSync } from "node:fs";

const [, , environment, outputsPath] = process.argv;

if (!environment || !outputsPath) {
  console.error("usage: apply-tf-outputs.mjs <dev|prod> <terraform-outputs.json>");
  process.exit(1);
}
if (environment !== "dev" && environment !== "prod") {
  console.error(`refusing to run: environment must be "dev" or "prod", got "${environment}"`);
  process.exit(1);
}

const outputs = JSON.parse(readFileSync(outputsPath, "utf8"));

/** `terraform output -json` wraps each value as { value, type, sensitive }. */
function requireOutput(name) {
  const raw = outputs[name];
  const value = raw && typeof raw === "object" && "value" in raw ? raw.value : raw;
  if (typeof value !== "string" || value.trim() === "") {
    console.error(`Terraform output "${name}" is missing or empty. Did \`terraform apply\` run?`);
    process.exit(1);
  }
  return value.trim();
}

const replacements = {
  TF_OUTPUT_d1_database_id: requireOutput("d1_database_id"),
  TF_OUTPUT_kv_namespace_id: requireOutput("kv_namespace_id"),
  // The R2 S3 endpoint presigned URLs are signed against. Identifiers, not
  // credentials - the access key pair that signs them is a Worker secret.
  TF_OUTPUT_account_id: requireOutput("account_id"),
  TF_OUTPUT_r2_bucket_name: requireOutput("r2_bucket_name"),
};

const configPath = new URL("../wrangler.toml", import.meta.url);
let config = readFileSync(configPath, "utf8");

// Only rewrite the block for the environment being deployed, so a dev deploy can
// never accidentally stamp a dev database ID into the prod section.
const startMarker = `[env.${environment}]`;
const start = config.indexOf(startMarker);
if (start === -1) {
  console.error(`wrangler.toml has no [env.${environment}] section.`);
  process.exit(1);
}
const otherMarker = environment === "dev" ? "[env.prod]" : "[env.dev]";
const otherIndex = config.indexOf(otherMarker);
const end = otherIndex > start ? otherIndex : config.length;

let block = config.slice(start, end);
for (const [placeholder, value] of Object.entries(replacements)) {
  if (!block.includes(placeholder)) {
    console.error(`Placeholder ${placeholder} not found in [env.${environment}] block.`);
    process.exit(1);
  }
  block = block.replaceAll(placeholder, value);
}

config = config.slice(0, start) + block + config.slice(end);
writeFileSync(configPath, config, "utf8");

console.log(`Injected Terraform outputs into [env.${environment}]:`);
for (const key of Object.keys(replacements)) {
  console.log(`  ${key} -> (${replacements[key].length} chars)`);
}
