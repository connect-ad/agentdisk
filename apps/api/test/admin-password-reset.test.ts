/**
 * Admin-initiated password reset — doc 32 PART 6, and the reversal of
 * Amendment 4.
 *
 * Three things here are worth more than the rest, because getting them wrong is
 * severe and invisible from the outside:
 *
 * **The reset link never leaves the server except by email.** It is a bearer
 * credential equal to "own this account". A admin member who could read it back
 * out of the response, or find it later in an audit row, would hold that
 * credential for a customer they are merely supporting. The tests below assert
 * its absence in both places rather than assuming it.
 *
 * **A send that did not happen is never reported as one.** The two halves of
 * the configuration are checked before anything is written, and a provider
 * failure is recorded as denied and rethrown. The alternative shape — accept,
 * log success, drop the mail — is the failure this product has already shipped
 * once (backlog/023) and is the reason the quota warning is computed on the
 * request path rather than in the dashboard.
 *
 * **Every attempt lands in the fleet log.** `admin_actions` exists because these
 * actions are not workspace-scoped; an unrecorded one is precisely the
 * cross-tenant reach the whole admin model is built to keep reviewable.
 */

import { SELF, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { asAdmin, installAdminJwks } from "./admin-auth";
import { NOW, seedTwoWorkspaces } from "./helpers";

const URL_BASE = "https://api-dev.agentdisk.io";
const ENCRYPTION_KEY = "test-database-encryption-key";
const TOTP_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const PASSWORD = "a-long-admin-password";

const USER_ID = "usr_TESTUSER";
const USER_EMAIL = "test@example.com";

/** The link the stubbed Identity Toolkit hands back. Must never be echoed. */
const RESET_LINK =
  "https://agentdisk-dev.firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=SECRET_OOB_CODE";


function post(path: string, body?: unknown, token?: string): Promise<Response> {
  return SELF.fetch(`${URL_BASE}${path}`, {
    method: "POST",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}


interface StubOptions {
  /** What Identity Toolkit answers. `missing` is its EMAIL_NOT_FOUND shape. */
  identity?: "link" | "missing" | "error";
  /** How the EMAIL binding answers. `rejected` is a thrown error with a code. */
  mail?: "accepted" | "rejected";
}

/** A message as the Worker handed it to the EMAIL binding. */
interface SentEmail {
  from: { email: string; name: string };
  to: string;
  html: string;
  text: string;
}

/**
 * Stub the three outbound calls the path makes, and hand back the recorded
 * requests so the tests can assert on what was actually sent rather than on
 * what the code appears to send.
 */
function stubOutbound(options: StubOptions = {}): {
  emails: SentEmail[];
  identityBodies: unknown[];
  tokenCalls: number;
} {
  const { identity = "link", mail = "accepted" } = options;
  const emails: SentEmail[] = [];
  const identityBodies: unknown[] = [];
  let tokenCalls = 0;

  const recorded = { emails, identityBodies, get tokenCalls() { return tokenCalls; } };

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = init?.body;

      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        tokenCalls += 1;
        return new Response(JSON.stringify({ access_token: "ya29.test-token", expires_in: 3600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url.includes("identitytoolkit.googleapis.com")) {
        identityBodies.push(JSON.parse(String(body)));
        if (identity === "missing") {
          return new Response(JSON.stringify({ error: { message: "EMAIL_NOT_FOUND" } }), { status: 400 });
        }
        if (identity === "error") {
          return new Response(JSON.stringify({ error: { message: "INTERNAL" } }), { status: 500 });
        }
        return new Response(JSON.stringify({ oobLink: RESET_LINK, email: USER_EMAIL }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      throw new Error(`unexpected outbound fetch to ${url}`);
    })
  );

  vi.spyOn(env.EMAIL!, "send").mockImplementation(async (message: unknown) => {
    emails.push(message as SentEmail);
    if (mail === "rejected") {
      throw Object.assign(new Error("sender is not verified"), { code: "E_SENDER_NOT_VERIFIED" });
    }
    return { messageId: "msg_test_1" };
  });

  return recorded as { emails: SentEmail[]; identityBodies: unknown[]; tokenCalls: number };
}

/** Narrowing helper: the suite runs under noUncheckedIndexedAccess. */
function at<T>(list: T[], index: number): T {
  const value = list[index];
  if (value === undefined) throw new Error(`expected an entry at index ${index}`);
  return value;
}

async function fleetRows(): Promise<
  { action: string; actorId: string; targetId: string; reason: string; result: string; metadata: string }[]
> {
  const rows = await env.DB.prepare(
    `SELECT action, actor_id AS actorId, target_id AS targetId, reason, result, metadata
       FROM admin_actions ORDER BY created_at`
  ).all<{ action: string; actorId: string; targetId: string; reason: string; result: string; metadata: string }>();
  return rows.results ?? [];
}

let supportToken = "";
let adminToken = "";

beforeAll(installAdminJwks);

beforeEach(async () => {
  await seedTwoWorkspaces();
  for (const table of ["admin_users", "admin_actions", "audit_events"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  // The access token is cached across requests by design; left in place it
  // would make the "mints a token" assertion pass or fail on test order.
  await env.CACHE.delete("firebase:admin-token:v1");

  // seedTwoWorkspaces() builds the user, the org and both workspaces but no
  // membership - nothing else in the suite needs one. This path does: the
  // workspace-scoped rows are found by walking memberships, which is what makes
  // a workspace owner able to see that admin acted on one of their members.
  // The org id is the one seedTwoWorkspaces uses.
  await env.DB.prepare(
    `INSERT OR IGNORE INTO memberships (id, org_id, user_id, role, created_at)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind("mem_TESTMEMBER", "org_TESTORG", USER_ID, "owner", NOW)
    .run();

  supportToken = await asAdmin("support@agentdisk.io", "admin", { id: "stf_SUPPORT" });
  adminToken = await asAdmin("admin@agentdisk.io", "admin", { id: "stf_ADMIN" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("admin password reset", () => {
  it("sends the link to the customer and never returns it", async () => {
    const outbound = stubOutbound();
    const token = supportToken;

    const res = await post(
      `/v1/admin/users/${USER_ID}/password-reset`,
      { reason: "Caller verified by support ticket 4471." },
      token
    );

    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(JSON.parse(raw)).toEqual({ userId: USER_ID, passwordResetSent: true });

    // The assertion that matters. A admin member holding this link holds the
    // customer's account, so its absence from the response is the control, not
    // the shape of the JSON around it.
    expect(raw).not.toContain("oobCode");
    expect(raw).not.toContain(RESET_LINK);

    // It went to the account holder, from the verified sender.
    expect(outbound.emails).toHaveLength(1);
    const message = at(outbound.emails, 0);
    expect(message.from.email).toBe("connect@agentdisk.io");
    expect(message.to).toBe(USER_EMAIL);
    expect(message.html).toContain(RESET_LINK);
    expect(message.text).toContain(RESET_LINK);
  });

  it("asks Identity Toolkit for the link rather than letting Firebase send it", async () => {
    // returnOobLink is the whole reason this needs a service-account credential
    // instead of a Web API key. Without it Firebase sends its own mail, from a
    // second sender identity, with wording nobody in this repo can edit.
    const outbound = stubOutbound();
    const token = supportToken;

    await post(`/v1/admin/users/${USER_ID}/password-reset`, { reason: "Ticket 4471." }, token);

    expect(outbound.identityBodies).toHaveLength(1);
    expect(at(outbound.identityBodies, 0)).toMatchObject({
      requestType: "PASSWORD_RESET",
      email: USER_EMAIL,
      returnOobLink: true,
    });
  });

  it("records the attempt in the fleet log, without the link", async () => {
    stubOutbound();
    const token = supportToken;

    await post(
      `/v1/admin/users/${USER_ID}/password-reset`,
      { reason: "Caller verified by support ticket 4471." },
      token
    );

    const rows = await fleetRows();
    expect(rows).toHaveLength(1);
    expect(at(rows, 0).action).toBe("admin.user.password_reset");
    expect(at(rows, 0).actorId).toBe("stf_SUPPORT");
    expect(at(rows, 0).targetId).toBe(USER_ID);
    expect(at(rows, 0).reason).toBe("Caller verified by support ticket 4471.");
    expect(at(rows, 0).result).toBe("success");
    // Same credential, same rule: the address is the subject of the record, the
    // link is a way into the account.
    expect(at(rows, 0).metadata).not.toContain("oobCode");
    expect(JSON.parse(at(rows, 0).metadata)).toMatchObject({ email: USER_EMAIL, outcome: "sent" });
  });

  it("also writes a workspace-scoped row the customer can see", async () => {
    stubOutbound();
    const token = supportToken;

    await post(`/v1/admin/users/${USER_ID}/password-reset`, { reason: "Ticket 4471." }, token);

    // The seeded user is a member of one org that owns two workspaces, so both
    // owners learn that admin acted rather than only the fleet log knowing.
    const rows = await env.DB.prepare(
      `SELECT workspace_id AS workspaceId, actor_type AS actorType
         FROM audit_events WHERE action = 'admin.user.password_reset'`
    ).all<{ workspaceId: string; actorType: string }>();

    expect(rows.results ?? []).toHaveLength(2);
    for (const row of rows.results ?? []) {
      expect(row.actorType).toBe("admin");
    }
  });

  it("records a failed send as denied and refuses", async () => {
    // The shape this product got wrong before: accept, report success, send
    // nothing. A support engineer who is told the mail went has told a customer
    // the same thing.
    stubOutbound({ mail: "rejected" });
    const token = supportToken;

    const res = await post(`/v1/admin/users/${USER_ID}/password-reset`, { reason: "Ticket 4471." }, token);
    expect(res.status).toBe(500);

    const rows = await fleetRows();
    expect(rows).toHaveLength(1);
    expect(at(rows, 0).result).toBe("denied");
  });

  it("accepts an address Firebase has no identity for, and says so only in the log", async () => {
    const outbound = stubOutbound({ identity: "missing" });
    const token = supportToken;

    const res = await post(`/v1/admin/users/${USER_ID}/password-reset`, { reason: "Ticket 4471." }, token);
    expect(res.status).toBe(200);

    // Nothing was sent, because there was nothing to send.
    expect(outbound.emails).toHaveLength(0);

    const rows = await fleetRows();
    expect(at(rows, 0).result).toBe("success");
    expect(JSON.parse(at(rows, 0).metadata)).toMatchObject({ outcome: "no_identity" });
  });

  it("refuses without a reason", async () => {
    stubOutbound();
    const token = supportToken;

    const res = await post(`/v1/admin/users/${USER_ID}/password-reset`, { reason: "  " }, token);
    expect(res.status).toBe(400);
    expect(await fleetRows()).toHaveLength(0);
  });

  it("refuses an unknown user before sending anything", async () => {
    const outbound = stubOutbound();
    const token = supportToken;

    const res = await post("/v1/admin/users/usr_NOSUCHUSER/password-reset", { reason: "Ticket." }, token);
    expect(res.status).toBe(404);
    expect(outbound.emails).toHaveLength(0);
    expect(await fleetRows()).toHaveLength(0);
  });

  it("refuses an unauthenticated caller", async () => {
    stubOutbound();
    const res = await post(`/v1/admin/users/${USER_ID}/password-reset`, { reason: "Ticket." });
    expect(res.status).toBe(401);
    expect(await fleetRows()).toHaveLength(0);
  });

  it("is available to support, not only to admin", async () => {
    // Deliberate, per the doc 32 role matrix: this is the action a support
    // engineer performs on the phone, and it grants the admin member nothing -
    // the link goes to the customer's address, never to them.
    stubOutbound();
    for (const token of [supportToken, adminToken]) {
      const res = await post(`/v1/admin/users/${USER_ID}/password-reset`, { reason: "Ticket." }, token);
      expect(res.status).toBe(200);
    }
  });

  it("caches the access token across requests", async () => {
    const outbound = stubOutbound();
    const token = supportToken;

    await post(`/v1/admin/users/${USER_ID}/password-reset`, { reason: "One." }, token);
    await post(`/v1/admin/users/${USER_ID}/password-reset`, { reason: "Two." }, token);

    // One RSA signature and one round trip to Google, not two. The token is
    // good for an hour and minting it is the expensive half of this path.
    expect(outbound.tokenCalls).toBe(1);
    expect(outbound.emails).toHaveLength(2);
  });
});
