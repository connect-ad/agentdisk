/**
 * The claim-attempt log.
 *
 * The preview stopped explaining itself: a claimed link now answers exactly as
 * an unknown one does, because the route takes no credential and a
 * distinguishable answer told anybody guessing tokens which guesses named a
 * real workspace. This is where the explanation went instead — support can say
 * what happened to a link without the answer being free to everyone.
 *
 * Two properties matter more than the rest, and both are pinned below: the
 * token itself is never stored, and the row outlives the workspace it names.
 */

import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { NOW } from "./helpers";
import { sha256Hex } from "../src/lib/keys";
import { sweepPendingDeletions } from "../src/jobs/pending-deletions";
import { CLAIM_ATTEMPT_RETENTION_MS } from "../src/lib/claim-log";

const URL_BASE = "https://api-dev.agentdisk.io";

async function attempts(): Promise<
  { outcome: string; ip: string | null; workspace_id: string | null; token_hash: string }[]
> {
  const rows = await env.DB.prepare(
    `SELECT outcome, ip, workspace_id, token_hash FROM claim_attempts ORDER BY created_at`
  ).all<{ outcome: string; ip: string | null; workspace_id: string | null; token_hash: string }>();
  return rows.results ?? [];
}

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM claim_attempts`).run();
});

describe("previewing a claim link", () => {
  it("records an unknown token, and stores its hash rather than the token", async () => {
    await SELF.fetch(`${URL_BASE}/v1/workspaces/claim/tok_definitelynotreal`, {
      headers: { "cf-connecting-ip": "203.0.113.7", "user-agent": "curl/8.0" },
    });

    const rows = await attempts();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe("unknown_token");
    expect(rows[0]?.ip).toBe("203.0.113.7");

    // The whole point of hashing: a support engineer can confirm WHICH link
    // was used and can never use it. A row holding the token would hand
    // whoever reads the table the ability to claim somebody's workspace.
    expect(rows[0]?.token_hash).not.toBe("tok_definitelynotreal");
    expect(rows[0]?.token_hash).toBe(await sha256Hex("tok_definitelynotreal"));
  });

  it("records the address Cloudflare vouches for, and nothing a client can forge", async () => {
    // `x-forwarded-for` is client-settable. A forgeable value in a log whose
    // entire purpose is accountability is worse than an honest blank.
    await SELF.fetch(`${URL_BASE}/v1/workspaces/claim/tok_forged`, {
      headers: { "x-forwarded-for": "198.51.100.1" },
    });

    const rows = await attempts();
    expect(rows[0]?.ip).toBeNull();
  });

  it("keeps the row after the workspace it names is gone", async () => {
    // No foreign key, deliberately. The trail is worth most precisely when the
    // workspace has been destroyed - which is when somebody asks what
    // happened to it.
    await env.DB.prepare(
      `INSERT INTO claim_attempts (id, token_hash, workspace_id, outcome, created_at)
       VALUES ('cla_ORPHAN', 'hash', 'ws_LONGGONE', 'previewed', ?)`
    )
      .bind(NOW)
      .run();

    const rows = await attempts();
    expect(rows.find(r => r.workspace_id === "ws_LONGGONE")).toBeDefined();
  });
});

describe("retention", () => {
  it("trims attempts past ninety days, and keeps the rest", async () => {
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO claim_attempts (id, token_hash, outcome, created_at)
       VALUES ('cla_OLD', 'h1', 'previewed', ?), ('cla_RECENT', 'h2', 'previewed', ?)`
    )
      .bind(now - CLAIM_ATTEMPT_RETENTION_MS - 1000, now - 1000)
      .run();

    const result = await sweepPendingDeletions(env.DB, env.FILES, now, { dryRun: false });
    expect(result.claimAttemptsTrimmed).toBe(1);

    const left = await attempts();
    expect(left).toHaveLength(1);
  });

  it("trims nothing on a dry run", async () => {
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO claim_attempts (id, token_hash, outcome, created_at)
       VALUES ('cla_OLD2', 'h3', 'previewed', ?)`
    )
      .bind(now - CLAIM_ATTEMPT_RETENTION_MS - 1000)
      .run();

    const result = await sweepPendingDeletions(env.DB, env.FILES, now);
    expect(result.claimAttemptsTrimmed).toBe(0);
    expect(await attempts()).toHaveLength(1);
  });
});
