/**
 * The console's view of the deletion queue.
 *
 * `job_runs` has been written by the sweep since deferred deletion landed and
 * read by nothing, so nobody could see what was queued, what the last run did,
 * or whether the job was running at all. These pin the three answers.
 */

import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { NOW, ORG_ID, WORKSPACE_A, seedTwoWorkspaces } from "./helpers";
import { asAdmin, installAdminJwks } from "./admin-auth";

const URL_BASE = "https://api-dev.agentdisk.io";
const reason = "a reason long enough to be one";

async function call(method: string, path: string, token: string, body?: unknown) {
  return SELF.fetch(`${URL_BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function queuePendingFile(id: string, dueAt: number, sizeBytes = 100): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO pending_deletions
       (file_id, r2_object_key, size_bytes, path, name, workspace_id, workspace_name,
        org_id, deleted_by, source, marked_at, due_at, attempts)
     VALUES (?, ?, ?, ?, ?, ?, 'Workspace A', ?, 'usr_TESTUSER', 'workspace_delete', ?, ?, 0)`
  )
    .bind(
      id,
      `tenant/${WORKSPACE_A}/${id}`,
      sizeBytes,
      `/${id}.txt`,
      `${id}.txt`,
      WORKSPACE_A,
      ORG_ID,
      NOW,
      dueAt
    )
    .run();
}

let token: string;

beforeEach(async () => {
  await seedTwoWorkspaces();
  await env.DB.prepare(`DELETE FROM pending_deletions`).run();
  await env.DB.prepare(`DELETE FROM job_runs`).run();
  await env.DB.prepare(`DELETE FROM admin_actions`).run();
  await installAdminJwks();
  token = await asAdmin("ops@agentdisk.io", "admin", { id: "stf_OPS" });
});

describe("GET /v1/admin/deletions/queue", () => {
  it("reports what is waiting and what is already due", async () => {
    // Relative to the REAL clock, not the fixture's NOW. The route runs with
    // Date.now() from the router, and the fixture's NOW is months in the past,
    // so "NOW + a day" is still overdue by the time the handler reads it.
    await queuePendingFile("fil_DUE", Date.now() - 1000, 500);
    await queuePendingFile("fil_LATER", Date.now() + 86_400_000, 250);

    const res = await call("GET", "/v1/admin/deletions/queue", token);
    expect(res.status).toBe(200);

    const queue = (await res.json()) as {
      files: number;
      bytes: number;
      overdue: number;
      oldestMarkedAt: number | null;
    };
    expect(queue.files).toBe(2);
    expect(queue.bytes).toBe(750);
    // Only one is past its date - the number that says what the next run takes.
    expect(queue.overdue).toBe(1);
    expect(queue.oldestMarkedAt).toBe(NOW);
  });

  it("counts queued accounts separately from queued bytes", async () => {
    // Two different questions: storage still being paid for, and people who
    // cannot yet sign up again with their own address. Summing them would
    // answer neither.
    await env.DB.prepare(
      `INSERT INTO users (id, email, firebase_uid, is_provisional, session_revoked_after,
                          deleted_at, purge_after, created_at, updated_at)
       VALUES ('usr_QUEUED', 'queued@example.com', 'fb-q', 0, 0, ?, ?, ?, ?)`
    )
      .bind(NOW, Date.now() - 1, NOW, NOW)
      .run();

    const queue = (await (await call("GET", "/v1/admin/deletions/queue", token)).json()) as {
      accounts: number;
      accountsOverdue: number;
    };
    expect(queue.accounts).toBe(1);
    expect(queue.accountsOverdue).toBe(1);
  });
});

describe("POST /v1/admin/deletions/run", () => {
  it("runs on demand and records who asked", async () => {
    await queuePendingFile("fil_NOW", Date.now() - 1000);

    const res = await call("POST", "/v1/admin/deletions/run", token, { reason });
    expect(res.status).toBe(200);

    const runs = (await (await call("GET", "/v1/admin/deletions/runs", token)).json()) as {
      runs: { trigger: string; actorEmail: string | null; finishedAt: number | null }[];
    };
    // An on-demand destruction must name who asked for it; the cron's row
    // names nobody, which is how the two are told apart afterwards.
    expect(runs.runs[0]?.trigger).toBe("admin");
    expect(runs.runs[0]?.actorEmail).toBe("ops@agentdisk.io");
    expect(runs.runs[0]?.finishedAt).not.toBeNull();
  });

  it("writes a fleet audit row for the run", async () => {
    await call("POST", "/v1/admin/deletions/run", token, { reason });

    const row = await env.DB.prepare(
      `SELECT action, reason FROM admin_actions WHERE action = 'deletions.run'`
    ).first<{ action: string; reason: string }>();
    expect(row?.reason).toBe(reason);
  });

  it("refuses without a reason", async () => {
    expect((await call("POST", "/v1/admin/deletions/run", token, {})).status).toBe(400);
  });

  it("refuses without a credential at all", async () => {
    const res = await SELF.fetch(`${URL_BASE}/v1/admin/deletions/queue`);
    expect(res.status).toBe(401);
  });
});

describe("GET /v1/admin/claim-links", () => {
  async function seedLink(id: string, opts: { claimed?: boolean; createdAt?: number } = {}) {
    await env.DB.prepare(
      `INSERT INTO workspaces
         (id, org_id, name, slug, status, period_reset_at, claimed_at,
          claim_token_hash, claim_token_expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        ORG_ID,
        `Sandbox ${id}`,
        id.toLowerCase(),
        NOW,
        opts.claimed === true ? NOW : null,
        `hash-${id}`,
        NOW + 604_800_000,
        opts.createdAt ?? Date.now(),
        NOW
      )
      .run();
  }

  it("lists a link nobody has ever touched", async () => {
    // The query is over `workspaces`, not `claim_attempts`, precisely so these
    // appear: a link nobody has opened is what somebody looks for when asked
    // why a person never received theirs.
    await seedLink("ws_UNTOUCHED");

    const res = await call("GET", "/v1/admin/claim-links?state=unclaimed", token);
    const body = (await res.json()) as { links: { workspaceId: string; attempts: number }[] };
    const row = body.links.find(l => l.workspaceId === "ws_UNTOUCHED");
    expect(row).toBeDefined();
    expect(row?.attempts).toBe(0);
  });

  it("separates claimed from unclaimed", async () => {
    await seedLink("ws_OPEN");
    await seedLink("ws_TAKEN", { claimed: true });

    const open = (await (
      await call("GET", "/v1/admin/claim-links?state=unclaimed", token)
    ).json()) as { links: { workspaceId: string }[] };
    expect(open.links.map(l => l.workspaceId)).toContain("ws_OPEN");
    expect(open.links.map(l => l.workspaceId)).not.toContain("ws_TAKEN");

    const taken = (await (
      await call("GET", "/v1/admin/claim-links?state=claimed", token)
    ).json()) as { links: { workspaceId: string }[] };
    expect(taken.links.map(l => l.workspaceId)).toContain("ws_TAKEN");
  });

  it("shows what the next sweep will destroy", async () => {
    // The filter with a deadline attached, and the reason it exists: this is
    // what you check before pressing run-now.
    await seedLink("ws_FRESH");
    await seedLink("ws_STALE", { createdAt: Date.now() - 8 * 24 * 60 * 60 * 1000 });

    const due = (await (await call("GET", "/v1/admin/claim-links?state=due", token)).json()) as {
      links: { workspaceId: string }[];
    };
    expect(due.links.map(l => l.workspaceId)).toContain("ws_STALE");
    expect(due.links.map(l => l.workspaceId)).not.toContain("ws_FRESH");
  });

  it("finds one by workspace id or by token hash", async () => {
    await seedLink("ws_FINDME");

    const byId = (await (
      await call("GET", "/v1/admin/claim-links?q=ws_FINDME", token)
    ).json()) as { links: unknown[] };
    expect(byId.links).toHaveLength(1);

    const byHash = (await (
      await call("GET", "/v1/admin/claim-links?q=hash-ws_FINDME", token)
    ).json()) as { links: unknown[] };
    expect(byHash.links).toHaveLength(1);
  });

  it("falls back to all rather than refusing an unrecognised filter", async () => {
    const res = await call("GET", "/v1/admin/claim-links?state=nonsense", token);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { state: string }).state).toBe("all");
  });
});
