/**
 * The console's routes, through the real Worker — 32 PART 5, 6 and 11.
 *
 * This file exists for one assertion repeated across every gated endpoint: that
 * the role check is enforced SERVER-SIDE. The console also hides what a role
 * cannot do, and that hiding is a convenience for the operator; it is not the
 * control, and a test that only proved the button was absent would be testing
 * the wrong half. So every case below calls the endpoint directly with a real
 * session for a lower role and expects a 403.
 *
 * The other thing it pins is routing order. `plans/stripe-diff`,
 * `plans/sync-from-stripe` and `workspaces/needs-attention` are literal paths
 * that sit where an `:id` pattern would otherwise swallow them — a regression
 * there would not fail typecheck and would surface as "no such plan:
 * stripe-diff", which reads like a data problem rather than a routing one.
 */

import { SELF, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asAdmin, firebaseToken, installAdminJwks } from "./admin-auth";
import { NOW, WORKSPACE_A, WORKSPACE_B, seedTwoWorkspaces } from "./helpers";

const URL_BASE = "https://api-dev.agentdisk.io";

function call(
  method: string,
  path: string,
  token: string,
  payload?: unknown
): Promise<Response> {
  return SELF.fetch(`${URL_BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
}


let support = "";
let admin = "";
let superAdmin = "";

beforeAll(installAdminJwks);

beforeEach(async () => {
  await seedTwoWorkspaces();
  for (const table of ["admin_users", "admin_actions", "audit_events"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare(`UPDATE workspaces SET status = 'active', deleted_at = NULL`).run();
  await env.DB.prepare(`UPDATE users SET deleted_at = NULL, disabled_at = NULL`).run();

  // A token proves an identity; the admin_users row is what makes it admin.
  support = await asAdmin("support@agentdisk.io", "admin", { id: "stf_SUPPORT" });
  admin = await asAdmin("admin@agentdisk.io", "admin", { id: "stf_ADMIN" });
  superAdmin = await asAdmin("super@agentdisk.io", "admin", { id: "stf_SUPER" });
});

/* ---------------------------- the role matrix ---------------------------- */

describe("the role matrix, enforced server-side", () => {
  const reason = "a reason long enough to be one";

  it("lets support read everything a support engineer needs", async () => {
    // The design gates Billing and Plans at admin. That is one notch too strict
    // on reads: support is exactly who needs to see WHY a customer's writes are
    // blocked, and being unable to look up the plan is what turns a one-minute
    // answer into an escalation.
    expect((await call("GET", "/v1/admin/plans", support)).status).toBe(200);
    expect((await call("GET", "/v1/admin/billing", support)).status).toBe(200);
    expect((await call("GET", "/v1/admin/audit", support)).status).toBe(200);
    expect((await call("GET", "/v1/admin/workspaces", support)).status).toBe(200);
  });

  // ── What used to be here ──────────────────────────────────────────────
  // Five tests pinning a three-tier matrix: support could not do admin writes,
  // admin could not do super_admin writes, and a refusal was recorded as
  // `admin.denied`. The console now has ONE role, so nothing refuses anybody
  // and none of that can be asserted - a test expecting 403 would be asserting
  // the opposite of the model.
  //
  // Stated plainly, because it is a real reduction: **every console operator
  // can now do everything**, including deleting a workspace, editing the plan
  // catalogue and granting console access to a new address. The only boundary
  // left is the `admin_users` lookup - being in that table at all.
  //
  // `requireRole` and the `admin.denied` audit path are deliberately still in
  // the source. They cannot fire today; they are what restores the gate
  // everywhere at once if a tier ever comes back.

  it("opens what used to be super_admin-only to the one role", async () => {
    // 200 where the matrix above expected 403. Read as the record of a
    // deliberate collapse, not as coverage of a permission model. Listing
    // console accounts was the most privileged read there was.
    expect((await call("GET", "/v1/admin/accounts", admin)).status).toBe(200);
  });

  it("still writes an audit row for a console action", async () => {
    // The half of the discipline that survives, and the half worth keeping: an
    // action reaching the console is recorded whether or not a role gated it.
    // An action that actually lands. The agent PATCH above 404s before doing
    // anything, and a lookup that found nothing has nothing to record.
    const res = await call("PATCH", `/v1/admin/workspaces/${WORKSPACE_A}/plan-override`, admin, {
      planId: "pro",
      reason,
    });
    expect(res.status).toBe(200);

    const rows = await env.DB.prepare(
      `SELECT actor_role FROM admin_actions`
    ).all<Record<string, unknown>>();

    expect(rows.results?.length).toBeGreaterThan(0);
    expect(rows.results?.every(r => r.actor_role === "admin")).toBe(true);
  });

  it("lets the console do the abuse-response actions", async () => {
    const res = await call("PATCH", "/v1/admin/agents/agt_NOPE", admin, {
      disabled: true,
      reason,
    });
    // 404 rather than 403: the credential passed, the agent does not exist.
    expect(res.status).toBe(404);
  });

  it("has no restore route, because a restore cannot restore the bytes", async () => {
    // Pinned at 404 the way POST /v1/staff/users was. Restore survived the
    // design that removed it, and could resurrect an account whose bytes a
    // sweep had already erased - returning an empty shell and reporting
    // success. A route answering anything but 404 here is that capability
    // coming back.
    expect(
      (await call("POST", "/v1/admin/users/usr_ANY/restore", admin, { reason })).status
    ).toBe(404);
    expect(
      (await call("POST", `/v1/admin/workspaces/${WORKSPACE_A}/restore`, admin, { reason })).status
    ).toBe(404);
  });

  it("refuses every console route without a credential at all", async () => {
    for (const path of [
      "/v1/admin/plans",
      "/v1/admin/billing",
      "/v1/admin/audit",
      "/v1/admin/accounts",
      "/v1/admin/users?email=nobody@example.com",
    ]) {
      const res = await SELF.fetch(`${URL_BASE}${path}`);
      expect(`${path} -> ${res.status}`).toBe(`${path} -> 401`);
    }
  });

  it("refuses a signed-in customer who is not admin", async () => {
    // THE boundary, now that one Firebase token reaches both surfaces. This
    // token is valid, its email is verified, and it belongs to somebody with no
    // admin_users row - which must be indistinguishable from a forged one.
    const outsider = await firebaseToken({ email: "customer@example.com" });

    for (const path of ["/v1/admin/plans", "/v1/admin/workspaces", "/v1/admin/accounts"]) {
      const res = await call("GET", path, outsider);
      expect(`${path} -> ${res.status}`).toBe(`${path} -> 401`);
    }
  });

  it("refuses a admin address whose email Firebase has not verified", async () => {
    // Without this, anybody able to sign up naming a admin address would
    // inherit that admin row.
    const unverified = await firebaseToken({
      email: "super@agentdisk.io",
      emailVerified: false,
    });
    expect((await call("GET", "/v1/admin/accounts", unverified)).status).toBe(401);
  });

  it("refuses a token minted for another Firebase project", async () => {
    const wrongAudience = await firebaseToken({
      email: "super@agentdisk.io",
      projectId: "some-other-project",
    });
    expect((await call("GET", "/v1/admin/accounts", wrongAudience)).status).toBe(401);
  });

  it("stops accepting a token the moment the admin row is disabled", async () => {
    expect((await call("GET", "/v1/admin/workspaces", admin)).status).toBe(200);

    await env.DB.prepare(`UPDATE admin_users SET disabled_at = ? WHERE id = 'stf_ADMIN'`)
      .bind(Date.now())
      .run();

    // The same token, unexpired. Disable is read per request, so there is no
    // window at all - which the four-hour session it replaced could not manage.
    expect((await call("GET", "/v1/admin/workspaces", admin)).status).toBe(401);
  });
});

/* ------------------------------ routing order ---------------------------- */

describe("literal paths are not swallowed by :id patterns", () => {
  it("routes plans/stripe-diff and plans/sync-from-stripe as themselves", async () => {
    // Without the ordering these would look up a plan named "stripe-diff" and
    // answer 404 - which reads like a data problem, not a routing one.
    const diff = await call("GET", "/v1/admin/plans/stripe-diff", admin);
    expect(diff.status).not.toBe(404);

    const sync = await call("POST", "/v1/admin/plans/sync-from-stripe", admin, {
      selections: [{ planId: "pro", fields: ["agents"] }],
      reason: "a reason long enough",
    });
    expect(sync.status).not.toBe(404);
  });

  it("routes workspaces/needs-attention as itself", async () => {
    const res = await call("GET", "/v1/admin/workspaces/needs-attention", support);
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty("workspaces");
  });

  it("still 404s a genuinely unknown admin path", async () => {
    expect((await call("GET", "/v1/admin/nothing-here", superAdmin)).status).toBe(404);
  });
});

/* --------------------------------- users --------------------------------- */

describe("looking a customer up", () => {
  it("finds an account by its exact address and records the lookup", async () => {
    const res = await call("GET", "/v1/admin/users?email=owner@example.com", support);
    expect(res.status).toBe(200);

    const recorded = await env.DB.prepare(
      `SELECT action, target_id FROM admin_actions WHERE action = 'user.lookup'`
    ).all<Record<string, unknown>>();
    expect(recorded.results?.length).toBe(1);
  });

  it("records a lookup that found nobody", async () => {
    // A lookup that missed is still a admin member asking after a named
    // individual, which is the fact the log exists to hold.
    await call("GET", "/v1/admin/users?email=stranger@example.com", support);
    const recorded = await env.DB.prepare(
      `SELECT metadata FROM admin_actions WHERE action = 'user.lookup'`
    ).first<{ metadata: string }>();
    expect(recorded?.metadata).toContain('"found":false');
  });

  it("refuses a partial address rather than searching for it", async () => {
    // A admin tool that can search %@gmail.com is a admin tool that can
    // enumerate the customer base.
    expect((await call("GET", "/v1/admin/users?email=owner", support)).status).toBe(400);
  });
});

/* ------------------------------- deletions ------------------------------- */

describe("deleting a workspace", () => {
  const reason = "a reason long enough to be one";

  it("refuses unless the workspace is already suspended", async () => {
    // Suspension is instant, reversible and cuts off access, so it is the right
    // first move in every scenario ending in deletion - and it gives the
    // customer a chance to notice before a 30-day countdown starts.
    const res = await call("DELETE", `/v1/admin/workspaces/${WORKSPACE_A}`, superAdmin, {
      confirmName: "Workspace A",
      reason,
    });
    expect(res.status).toBe(409);
  });

  it("refuses when the typed name does not match", async () => {
    await env.DB.prepare(`UPDATE workspaces SET status = 'suspended' WHERE id = ?`)
      .bind(WORKSPACE_A)
      .run();

    const res = await call("DELETE", `/v1/admin/workspaces/${WORKSPACE_A}`, superAdmin, {
      confirmName: "Not The Name",
      reason,
    });
    expect(res.status).toBe(400);
  });

  it("soft-deletes, and the row survives for the window", async () => {
    const workspace = await env.DB.prepare(`SELECT name FROM workspaces WHERE id = ?`)
      .bind(WORKSPACE_A)
      .first<{ name: string }>();
    await env.DB.prepare(`UPDATE workspaces SET status = 'suspended' WHERE id = ?`)
      .bind(WORKSPACE_A)
      .run();

    const res = await call("DELETE", `/v1/admin/workspaces/${WORKSPACE_A}`, superAdmin, {
      confirmName: workspace?.name,
      reason,
    });
    expect(res.status).toBe(200);

    const after = await env.DB.prepare(
      `SELECT status, deleted_at AS deletedAt FROM workspaces WHERE id = ?`
    )
      .bind(WORKSPACE_A)
      .first<{ status: string; deletedAt: number | null }>();

    // Still there. Nothing irreversible happened inline; the cascade is the
    // purge job's, 30 days later.
    expect(after?.status).toBe("deleted");
    expect(after?.deletedAt).not.toBeNull();
  });

});

/* ---------------------------- admin accounts ----------------------------- */

describe("admin accounts", () => {
  const reason = "a reason long enough to be one";

  it("creates one as an email and a role, with no credential to show", async () => {
    const res = await call("POST", "/v1/admin/accounts", superAdmin, {
      email: "New@AgentDisk.io",
      role: "admin",
      reason,
    });
    expect(res.status).toBe(201);

    const created = (await res.json()) as { account: { id: string; email: string; role: string } };
    // Lowercased on the way in: an address differing only in case is one person
    // to Google and must be one row here.
    expect(created.account.email).toBe("new@agentdisk.io");
    expect(created.account.role).toBe("admin");
    // Nothing secret was minted, so nothing secret comes back.
    expect(JSON.stringify(created)).not.toMatch(/password|totp|secret/i);
  });

  it("lets any console operator grant console access", async () => {
    // This used to assert 403 - granting a role was the one thing only
    // super_admin could do. With one role there is nobody to refuse, so the
    // meaningful property is what is left: anyone already in `admin_users` can
    // put somebody else in it. That is the escalation path now, and it is
    // recorded rather than prevented.
    const res = await call("POST", "/v1/admin/accounts", admin, {
      email: "granted-by-peer@agentdisk.io",
      role: "admin",
      reason,
    });
    expect(res.status).toBe(201);

    const row = await env.DB.prepare(
      `SELECT action, actor_role FROM admin_actions WHERE action = 'admin.create'`
    ).first<{ action: string; actor_role: string }>();
    expect(row?.actor_role).toBe("admin");
  });

  it("refuses a role that is not the one role", async () => {
    // "super_admin" was valid for months and is still the obvious thing to
    // type. It must be rejected at the edge rather than written into a column
    // whose value nothing in the authorization chain would recognise.
    const res = await call("POST", "/v1/admin/accounts", admin, {
      email: "escalation@agentdisk.io",
      role: "super_admin",
      reason,
    });
    expect(res.status).toBe(400);
  });

  it("lets the newly granted address sign in, and not before", async () => {
    const theirToken = await firebaseToken({ email: "later@agentdisk.io" });
    expect((await call("GET", "/v1/admin/workspaces", theirToken)).status).toBe(401);

    await call("POST", "/v1/admin/accounts", admin, {
      email: "later@agentdisk.io",
      role: "admin",
      reason,
    });

    // Same token, unchanged. The grant is a row, read fresh on every request -
    // which is why it takes effect without re-authentication, and why a
    // disable does too.
    expect((await call("GET", "/v1/admin/workspaces", theirToken)).status).toBe(200);
  });

  it("refuses to disable your own account", async () => {
    // It removes the only role that can re-enable anyone, and there may be no
    // other super_admin. The way back would be the provisioning script.
    const res = await call("PATCH", "/v1/admin/accounts/stf_SUPER/disable", superAdmin, {
      disabled: true,
      reason,
    });
    expect(res.status).toBe(403);
  });

  it("refuses to change your own role", async () => {
    // Survives the collapse unchanged, and is the one self-protection left.
    // There is only one role to change to, so this currently refuses a no-op -
    // but it is the guard that stops a future tier being self-granted, and it
    // is cheaper to keep than to remember to re-add.
    const res = await call("PATCH", "/v1/admin/accounts/stf_SUPER", superAdmin, {
      role: "admin",
      reason,
    });
    expect(res.status).toBe(403);

    const row = await env.DB.prepare(`SELECT role FROM admin_users WHERE id = 'stf_SUPER'`)
      .first<{ role: string }>();
    expect(row?.role).toBe("admin");
  });

});

/* -------------------------------- the audit ------------------------------ */

describe("the audit log", () => {
  it("filters by action prefix, which is what Sync History is", async () => {
    await call("GET", "/v1/admin/users?email=owner@example.com", support);

    const res = await call("GET", "/v1/admin/audit?action=user.", support);
    const body = (await res.json()) as { rows: { action: string }[] };
    expect(body.rows.length).toBeGreaterThan(0);
    expect(body.rows.every(row => row.action.startsWith("user."))).toBe(true);
  });

  it("exports CSV, and records the export in the log it exported", async () => {
    const res = await call("GET", "/v1/admin/audit/export", support);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");

    const recorded = await env.DB.prepare(
      `SELECT action FROM admin_actions WHERE action = 'audit.export'`
    ).first<{ action: string }>();
    expect(recorded?.action).toBe("audit.export");
  });

  it("neutralises a formula in an operator-supplied reason", async () => {
    // The reason field is free text an operator types, so it is exactly where a
    // payload would be planted for whoever opens the export in a spreadsheet.
    await env.DB.prepare(
      `INSERT INTO admin_actions (id, actor_id, actor_email, actor_role, action, result, created_at, reason)
       VALUES ('sac_X', 'stf_SUPPORT', 'support@agentdisk.io', 'support', 'user.lookup', 'success', ?, ?)`
    )
      .bind(NOW, "=cmd|'/c calc'!A1")
      .run();

    const csv = await (await call("GET", "/v1/admin/audit/export", support)).text();
    expect(csv).toContain(`"'=cmd`);
  });
});

/* ------------------------- the fleet list itself ------------------------- */

describe("GET /v1/admin/workspaces", () => {
  const reason = "a reason long enough to be one";

  // The status test below seeds 60 filler workspaces to push the real ones off
  // the first page. They must not survive into the tests after it, which assert
  // against an unpaginated two-workspace fleet.
  beforeEach(async () => {
    await env.DB.prepare(`DELETE FROM workspaces WHERE id LIKE 'ws_FILLER%'`).run();
  });

  it("searches by name rather than failing", async () => {
    // The search has never once succeeded: the query carried ESCAPE '\',
    // which SQLite reads as a two-character escape expression and rejects, so
    // every ?q= answered 500. Nothing in the suite passed a q at all, which is
    // how a green run covered a feature that could not work.
    const res = await call("GET", "/v1/admin/workspaces?q=Workspace%20A", support);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { workspaces: { name: string }[] };
    expect(body.workspaces.map((w) => w.name)).toEqual(["Workspace A"]);
  });

  it("treats a LIKE wildcard in the search term as a literal", async () => {
    // The escaping is the reason the ESCAPE clause is there at all; with the
    // clause fixed, this is what it buys.
    const res = await call("GET", "/v1/admin/workspaces?q=%25", support);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { workspaces: unknown[] }).workspaces).toEqual([]);
  });

  it("filters by status on the server, beyond the first page", async () => {
    // The Suspended view used to fetch this list and filter it in the browser.
    // With 60 newer workspaces ahead of it, the one suspended workspace fell
    // outside the default 50 and the screen said "No suspended workspaces".
    for (let i = 0; i < 60; i++) {
      await env.DB.prepare(
        `INSERT INTO workspaces (id, org_id, name, period_reset_at, created_at, updated_at)
         VALUES (?, 'org_TESTORG', ?, ?, ?, ?)`
      )
        .bind(`ws_FILLER${String(i).padStart(19, "0")}`, `Filler ${i}`, NOW, NOW + 1000 + i, NOW)
        .run();
    }
    await env.DB.prepare(`UPDATE workspaces SET status = 'suspended' WHERE id = ?`)
      .bind(WORKSPACE_A)
      .run();

    const res = await call("GET", "/v1/admin/workspaces?status=suspended", support);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { workspaces: { id: string }[] };
    expect(body.workspaces.map((w) => w.id)).toEqual([WORKSPACE_A]);
  });

  it("refuses an unrecognised status instead of answering the wider question", async () => {
    const res = await call("GET", "/v1/admin/workspaces?status=banana", support);
    expect(res.status).toBe(400);
  });

  it("reports the plan a workspace is actually on, override included", async () => {
    // `o.plan` alone showed the organization's plan, so a workspace carrying an
    // override displayed the plan it is NOT on - while resolveWorkspaceLimits
    // enforced the one it is. The Usage tab's percentages were computed against
    // the wrong plan for exactly these workspaces.
    expect(
      (
        await call("PATCH", `/v1/admin/workspaces/${WORKSPACE_A}/plan-override`, admin, {
          planId: "basic",
          reason,
        })
      ).status
    ).toBe(200);

    const listed = (await (await call("GET", "/v1/admin/workspaces", support)).json()) as {
      workspaces: { id: string; plan: string; planOverride: string | null }[];
    };
    const row = listed.workspaces.find((w) => w.id === WORKSPACE_A);
    expect(row?.plan).toBe("basic");
    expect(row?.planOverride).toBe("basic");

    const detail = (await (
      await call("GET", `/v1/admin/workspaces/${WORKSPACE_A}`, support)
    ).json()) as { workspace: { plan: string; planOverride: string | null } };
    expect(detail.workspace.plan).toBe("basic");
    expect(detail.workspace.planOverride).toBe("basic");
  });

  it("shows the same override on every workspace of the account", async () => {
    // This used to assert null here, on the grounds that only WORKSPACE_A had
    // been bumped. Since migration 0018 the override lives on the
    // organization, so a bump applied through one workspace is visible from
    // its sibling - which is the whole point: the ceiling and the usage it is
    // compared against are now the same unit.
    const a = (await (
      await call("GET", `/v1/admin/workspaces/${WORKSPACE_A}`, support)
    ).json()) as { workspace: { plan: string; planOverride: string | null } };
    const b = (await (
      await call("GET", `/v1/admin/workspaces/${WORKSPACE_B}`, support)
    ).json()) as { workspace: { plan: string; planOverride: string | null } };

    expect(b.workspace.planOverride).toBe(a.workspace.planOverride);
    expect(b.workspace.plan).toBe(a.workspace.plan);
  });

  it("keeps null distinguishable from an override equal to the plan", async () => {
    // Still matters, and is the reason planOverride is reported beside plan
    // rather than folded into it: "on the account's plan" and "explicitly
    // pinned to the plan it is already on" are different states, and only one
    // of them survives the subscription changing.
    await call("PATCH", `/v1/admin/workspaces/${WORKSPACE_A}/plan-override`, admin, {
      planId: null,
      reason: "a reason long enough to be one",
    });

    const cleared = (await (
      await call("GET", `/v1/admin/workspaces/${WORKSPACE_A}`, support)
    ).json()) as { workspace: { plan: string; planOverride: string | null } };
    expect(cleared.workspace.planOverride).toBeNull();
  });
});
