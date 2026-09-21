/**
 * The dev reset script's foreign-key ordering. TEMPORARY — delete alongside
 * `.github/workflows/reset-dev.yml`, `scripts/reset-dev-data.sql` and
 * `scripts/check-reset.mjs`.
 *
 * Worth a test despite being throwaway, because the ordering is the one part
 * that cannot fail in review and can only fail against real data. SQLite
 * checks foreign keys immediately and deletes rows within a statement in
 * arbitrary order, so `folders.parent_folder_id` (self-referencing) and
 * `files.folder_id` (referenced from outside) both break a naive DELETE — and
 * they break it *in the middle*, having already emptied some tables. The
 * failure mode is a half-wiped environment, which is worse than either
 * outcome.
 *
 * So this seeds the shapes that actually bite — a nested folder tree with
 * files in it, tagged, plus keys pointing at agents — and runs the real script
 * file rather than a copy of it.
 */

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { NOW, WORKSPACE_A, WORKSPACE_B, seedTwoWorkspaces } from "./helpers";
// Imported as text rather than read with `fs`: the workers runtime has no real
// filesystem, and its shim mangles an absolute Windows path into "/C:/...".
import resetSql from "../scripts/reset-dev-data.sql?raw";

/**
 * The script as the pipeline runs it.
 *
 * Read from the real file rather than restated here: a test asserting against
 * its own copy of the statements would pass forever while the file it is meant
 * to cover drifted. Split on `;` because D1 takes one statement at a time; the
 * file contains no string literal holding a semicolon, which is the only thing
 * that would make this naive split wrong.
 */
function resetStatements(): string[] {
  return resetSql
    .split("\n")
    .filter(line => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map(statement => statement.trim())
    .filter(statement => statement.length > 0);
}

async function runReset(): Promise<void> {
  for (const statement of resetStatements()) {
    await env.DB.prepare(statement).run();
  }
}

async function count(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

/** A workspace holding the shapes that break a careless delete. */
async function seedTenantData(workspaceId: string, suffix: string): Promise<void> {
  const parent = `fld_P${suffix}`;
  const child = `fld_C${suffix}`;
  const fileId = `fil_${suffix}`;
  const agentId = `agt_${suffix}`;

  await env.DB.prepare(
    `INSERT INTO folders (id, workspace_id, parent_folder_id, name, path, created_by, created_at)
     VALUES (?, ?, NULL, 'parent', '/parent', 'usr_TESTUSER', ?)`
  )
    .bind(parent, workspaceId, NOW)
    .run();

  // The self-reference. A single DELETE over `folders` can take the parent
  // first and fail on this row.
  await env.DB.prepare(
    `INSERT INTO folders (id, workspace_id, parent_folder_id, name, path, created_by, created_at)
     VALUES (?, ?, ?, 'child', '/parent/child', 'usr_TESTUSER', ?)`
  )
    .bind(child, workspaceId, parent, NOW)
    .run();

  await env.DB.prepare(
    `INSERT INTO agents (id, workspace_id, name, status, created_by_user_id, created_at)
     VALUES (?, ?, 'agent', 'active', 'usr_TESTUSER', ?)`
  )
    .bind(agentId, workspaceId, NOW)
    .run();

  // api_keys.agent_id -> agents. Keys must go before agents.
  await env.DB.prepare(
    `INSERT INTO api_keys
       (id, workspace_id, agent_id, name, key_prefix, key_last_four, key_hash,
        scopes, created_by_user_id, created_at)
     VALUES (?, ?, ?, 'key', 'ad_', 'abcd', ?, '{}', 'usr_TESTUSER', ?)`
  )
    .bind(`key_${suffix}`, workspaceId, agentId, `hash_${suffix}`, NOW)
    .run();

  // files.folder_id -> folders, referenced from outside the folder tree.
  await env.DB.prepare(
    `INSERT INTO files
       (id, workspace_id, folder_id, path, name, size_bytes, mime_type, checksum_sha256,
        r2_object_key, status, created_by, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, '/parent/child/a.txt', 'a.txt', 10, 'text/plain', NULL, ?, 'active', ?, ?, ?, NULL)`
  )
    .bind(fileId, workspaceId, child, `tenant/${workspaceId}/${fileId}`, "usr_TESTUSER", NOW, NOW)
    .run();

  await env.DB.prepare(`INSERT INTO file_tags (file_id, tag) VALUES (?, 'seeded')`)
    .bind(fileId)
    .run();

  await env.DB.prepare(
    `INSERT INTO audit_events
       (id, workspace_id, actor_type, actor_id, action, resource_type, resource_id,
        result, ip, client, request_id, metadata, created_at)
     VALUES (?, ?, 'api_key', ?, 'file.upload', 'file', ?, 'success', NULL, NULL, 'req_T', '{}', ?)`
  )
    .bind(`aud_${suffix}`, workspaceId, `key_${suffix}`, fileId, NOW)
    .run();
}

beforeEach(async () => {
  await seedTwoWorkspaces();
  await env.DB.prepare(`DELETE FROM file_tags`).run();
  await env.DB.prepare(`DELETE FROM files`).run();
  await env.DB.prepare(`DELETE FROM folders`).run();
  await env.DB.prepare(`DELETE FROM api_keys`).run();
  await env.DB.prepare(`DELETE FROM agents`).run();
  await env.DB.prepare(`DELETE FROM audit_events`).run();
});

describe("the dev reset script", () => {
  it("empties a populated environment without tripping a foreign key", async () => {
    await seedTenantData(WORKSPACE_A, "A");
    await seedTenantData(WORKSPACE_B, "B");

    // The assertion is partly that this does not throw. A mis-ordered script
    // fails part-way, which is the outcome worth preventing.
    await runReset();

    for (const table of [
      "file_tags",
      "files",
      "folders",
      "api_keys",
      "agents",
      "audit_events",
      "memberships",
      "workspaces",
      "organizations",
      "users",
    ]) {
      expect({ table, rows: await count(table) }).toEqual({ table, rows: 0 });
    }
  });

  it("is safe to run against an already-empty database", async () => {
    await runReset();
    await expect(runReset()).resolves.toBeUndefined();
  });

  it("leaves the tables that would lock the environment out", async () => {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO staff_users (id, email, role, created_at)
       VALUES ('stf_KEEP', 'keep@example.com', 'super_admin', ?)`
    )
      .bind(NOW)
      .run();

    const plansBefore = await count("plans");
    await runReset();

    // staff_users is the console's whole access model and migration 0014 will
    // not re-seed it; plans is populated by hand from Stripe and has no
    // pipeline that would put it back.
    expect(await count("staff_users")).toBeGreaterThan(0);
    expect(await count("plans")).toBe(plansBefore);
  });

  it("names every table it clears, so a new one cannot be silently missed", async () => {
    // A table added later and not added here would survive a reset, leaving
    // rows referencing tenants that no longer exist. This does not prevent
    // that - nothing can - but it makes the script's coverage explicit enough
    // to diff against the migrations when one is added.
    const cleared = resetStatements()
      .filter(s => s.toUpperCase().startsWith("DELETE FROM "))
      .map(s => s.slice("DELETE FROM ".length).trim());

    expect(cleared.sort()).toEqual(
      [
        "agents",
        "api_keys",
        "audit_events",
        "file_tags",
        "files",
        "folders",
        "job_runs",
        "memberships",
        "organizations",
        "pending_deletions",
        "share_links",
        "staff_actions",
        "users",
        "webhooks",
        "workspaces",
      ].sort()
    );
  });

  it("clears every inbound reference before it deletes anything", async () => {
    // The ordering rule, asserted as a property rather than as a line number:
    // both UPDATE ... SET ... = NULL statements must precede the first DELETE.
    const statements = resetStatements();
    const firstDelete = statements.findIndex(s => s.toUpperCase().startsWith("DELETE"));
    const nullings = statements
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => s.toUpperCase().startsWith("UPDATE"));

    expect(nullings.length).toBe(2);
    for (const { s, i } of nullings) {
      expect({ statement: s.split("\n")[0], beforeFirstDelete: i < firstDelete }).toEqual({
        statement: s.split("\n")[0],
        beforeFirstDelete: true,
      });
    }
  });
});
