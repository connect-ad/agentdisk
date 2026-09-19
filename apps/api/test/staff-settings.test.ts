/**
 * The email settings area — status, and a test send.
 *
 * This exists so an operator can answer "is outbound email actually working in
 * this deployment?" without waiting for a customer to need a password reset.
 * Every test here is about one of two things:
 *
 * **The recipient is never chosen by the caller.** A test-send endpoint that
 * takes an address is an open relay with a friendly label, and it would be one
 * reachable by anybody holding a staff credential. The address comes from the
 * signed-in staff member's own row, and a body that supplies one is ignored
 * rather than rejected — rejecting it would tell a prober that the field is
 * read at all.
 *
 * **A failed send is recorded and refused, never swallowed.** The whole point
 * of the button is to surface a broken configuration; one that reported success
 * regardless would be worse than not having it, because it would be evidence.
 */

import { SELF, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { asStaff, installStaffJwks } from "./staff-auth";

const URL_BASE = "https://api-dev.agentdisk.io";
const PATH = "/v1/staff/settings/email";

const SUPPORT_EMAIL = "support@agentdisk.io";
const SUPER_EMAIL = "super@agentdisk.io";

function call(method: string, path: string, token: string, payload?: unknown): Promise<Response> {
  return SELF.fetch(`${URL_BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
}

/** Stub Mailjet, and hand back what was actually sent. */
function stubMailjet(outcome: "accepted" | "rejected" = "accepted"): { bodies: unknown[] } {
  const bodies: unknown[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

      if (url.startsWith("https://api.mailjet.com/")) {
        bodies.push(JSON.parse(String(init?.body)));
        if (outcome === "rejected") {
          return new Response(
            JSON.stringify({
              Messages: [{ Status: "error", Errors: [{ ErrorMessage: "sender is not verified" }] }],
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        return new Response(
          JSON.stringify({ Messages: [{ Status: "success", To: [{ MessageUUID: "uuid-test" }] }] }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }

      throw new Error(`unexpected outbound fetch to ${url}`);
    })
  );

  return { bodies };
}

async function fleetRows(): Promise<{ action: string; result: string; metadata: string }[]> {
  const rows = await env.DB.prepare(
    "SELECT action, result, metadata FROM staff_actions ORDER BY created_at"
  ).all<{ action: string; result: string; metadata: string }>();
  return rows.results ?? [];
}

let support = "";
let superAdmin = "";

beforeAll(installStaffJwks);

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM staff_users").run();
  await env.DB.prepare("DELETE FROM staff_actions").run();
  support = await asStaff(SUPPORT_EMAIL, "support", { id: "stf_SUPPORT" });
  superAdmin = await asStaff(SUPER_EMAIL, "super_admin", { id: "stf_SUPER" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /v1/staff/settings/email", () => {
  it("reports that this deployment can send, and from where", async () => {
    const response = await call("GET", PATH, support);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      configured: true,
      sender: "connect@agentdisk.io",
      provider: "Mailjet",
    });
  });

  it("carries no credential", async () => {
    // `configured` is a boolean derived from the same check the send path uses.
    // The screen cannot work this out for itself - the keys are in the Worker
    // and never leave it - which is the whole reason this route exists, and
    // also the reason it must not answer with more than a yes or no.
    const text = await (await call("GET", PATH, support)).text();

    // The provider's NAME is deliberately in the body - an operator reading a
    // bounce needs to know whose dashboard to open. What must never appear is
    // credential material, so the assertion names that rather than the word.
    expect(text).not.toMatch(/apiKey|secretKey|authorization|Basic /i);
    expect(text).not.toContain("test-mailjet-api-key");
    expect(text).not.toContain("test-mailjet-secret-key");
  });

  it("refuses an unauthenticated caller", async () => {
    const response = await SELF.fetch(`${URL_BASE}${PATH}`);
    expect(response.status).toBe(401);
  });
});

describe("POST /v1/staff/settings/email/test", () => {
  it("refuses support, and writes down the refusal", async () => {
    stubMailjet();

    const response = await call("POST", `${PATH}/test`, support, {});
    expect(response.status).toBe(403);

    const denied = (await fleetRows()).filter((row) => row.result === "denied");
    expect(denied).toHaveLength(1);
    expect(denied[0]?.action).toBe("staff.denied");
  });

  it("sends to the signed-in staff member's own address", async () => {
    const mailjet = stubMailjet();

    const response = await call("POST", `${PATH}/test`, superAdmin, {});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sentTo: SUPER_EMAIL });

    expect(mailjet.bodies).toHaveLength(1);
    const sent = mailjet.bodies[0] as {
      Messages: { From: { Email: string }; To: { Email: string }[] }[];
    };
    expect(sent.Messages[0]?.To[0]?.Email).toBe(SUPER_EMAIL);
    expect(sent.Messages[0]?.From.Email).toBe("connect@agentdisk.io");
  });

  it("ignores an address supplied in the body", async () => {
    // The case that turns this endpoint into an open relay if it is missed.
    const mailjet = stubMailjet();

    const response = await call("POST", `${PATH}/test`, superAdmin, {
      to: "attacker@example.com",
      email: "attacker@example.com",
    });

    expect(response.status).toBe(200);
    const sent = mailjet.bodies[0] as { Messages: { To: { Email: string }[] }[] };
    expect(sent.Messages[0]?.To[0]?.Email).toBe(SUPER_EMAIL);
    expect(JSON.stringify(mailjet.bodies)).not.toContain("attacker@example.com");
  });

  it("records the send in the fleet log", async () => {
    stubMailjet();

    await call("POST", `${PATH}/test`, superAdmin, {});

    const rows = (await fleetRows()).filter((row) => row.action === "settings.email.test_sent");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.result).toBe("success");
    expect(JSON.parse(rows[0]?.metadata ?? "{}")).toMatchObject({ to: SUPER_EMAIL });
  });

  it("refuses when the provider rejects, and records that too", async () => {
    // A 200 carrying Status: "error" - Mailjet's quiet failure. If this
    // endpoint reported success here it would be actively harmful: somebody
    // would read the green toast as proof that email works.
    stubMailjet("rejected");

    const response = await call("POST", `${PATH}/test`, superAdmin, {});
    expect(response.status).toBe(500);

    const rows = (await fleetRows()).filter((row) => row.action === "settings.email.test_sent");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.result).toBe("denied");
  });

  it("never returns the provider's own words", async () => {
    stubMailjet("rejected");

    const response = await call("POST", `${PATH}/test`, superAdmin, {});

    expect(await response.text()).not.toContain("sender is not verified");
  });
});
