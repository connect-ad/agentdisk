/**
 * The email settings area — status, and a test send.
 *
 * This exists so an operator can answer "is outbound email actually working in
 * this deployment?" without waiting for a customer to need a password reset.
 * Every test here is about one of two things:
 *
 * **The recipient is never chosen by the caller.** A test-send endpoint that
 * takes an address is an open relay with a friendly label, and it would be one
 * reachable by anybody holding a admin credential. The address comes from the
 * signed-in admin member's own row, and a body that supplies one is ignored
 * rather than rejected — rejecting it would tell a prober that the field is
 * read at all.
 *
 * **A failed send is recorded and refused, never swallowed.** The whole point
 * of the button is to surface a broken configuration; one that reported success
 * regardless would be worse than not having it, because it would be evidence.
 */

import { SELF, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { asAdmin, installAdminJwks } from "./admin-auth";

const URL_BASE = "https://api-dev.agentdisk.io";
const PATH = "/v1/admin/settings/email";

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

/** A message as the Worker handed it to the EMAIL binding. */
interface Sent {
  from: { email: string; name: string };
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  attachments?: { filename: string; type: string; disposition: string; content: Uint8Array }[];
}

/** Stub the EMAIL binding, and hand back what was actually sent. */
function stubEmail(outcome: "accepted" | "rejected" = "accepted"): { sent: Sent[] } {
  const sent: Sent[] = [];

  vi.spyOn(env.EMAIL!, "send").mockImplementation(async (message: unknown) => {
    sent.push(message as Sent);
    if (outcome === "rejected") {
      throw Object.assign(new Error("sender is not verified"), { code: "E_SENDER_NOT_VERIFIED" });
    }
    return { messageId: "msg-test" };
  });

  return { sent };
}

async function fleetRows(): Promise<{ action: string; result: string; metadata: string }[]> {
  const rows = await env.DB.prepare(
    "SELECT action, result, metadata FROM admin_actions ORDER BY created_at"
  ).all<{ action: string; result: string; metadata: string }>();
  return rows.results ?? [];
}

let support = "";
let superAdmin = "";

beforeAll(installAdminJwks);

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM admin_users").run();
  await env.DB.prepare("DELETE FROM admin_actions").run();
  support = await asAdmin(SUPPORT_EMAIL, "admin", { id: "stf_SUPPORT" });
  superAdmin = await asAdmin(SUPER_EMAIL, "admin", { id: "stf_SUPER" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /v1/admin/settings/email", () => {
  it("reports that this deployment can send, and from where", async () => {
    const response = await call("GET", PATH, support);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      configured: true,
      sender: "connect@agentdisk.io",
      provider: "Cloudflare Email Service",
      composeDefaultSender: "noreply@agentdisk.io",
      sendingDomain: "agentdisk.io",
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
    expect(text).not.toMatch(/apiKey|secretKey|token|authorization|Basic /i);
  });

  it("refuses an unauthenticated caller", async () => {
    const response = await SELF.fetch(`${URL_BASE}${PATH}`);
    expect(response.status).toBe(401);
  });
});

describe("POST /v1/admin/settings/email/test", () => {
  it("no longer refuses anybody who can reach the console", async () => {
    // This pinned a 403 for support against a super_admin-only route. The
    // console has one role now, so the send is open to every operator - and
    // the refusal it used to record cannot be produced.
    stubEmail();

    const response = await call("POST", `${PATH}/test`, support, {});
    expect(response.status).toBe(200);

    const denied = (await fleetRows()).filter((row) => row.result === "denied");
    expect(denied).toHaveLength(0);
  });

  it("sends to the signed-in admin member's own address", async () => {
    const email = stubEmail();

    const response = await call("POST", `${PATH}/test`, superAdmin, {});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sentTo: SUPER_EMAIL });

    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]?.to).toBe(SUPER_EMAIL);
    expect(email.sent[0]?.from.email).toBe("connect@agentdisk.io");
  });

  it("ignores an address supplied in the body", async () => {
    // The case that turns this endpoint into an open relay if it is missed.
    const email = stubEmail();

    const response = await call("POST", `${PATH}/test`, superAdmin, {
      to: "attacker@example.com",
      email: "attacker@example.com",
    });

    expect(response.status).toBe(200);
    expect(email.sent[0]?.to).toBe(SUPER_EMAIL);
    expect(JSON.stringify(email.sent)).not.toContain("attacker@example.com");
  });

  it("records the send in the fleet log", async () => {
    stubEmail();

    await call("POST", `${PATH}/test`, superAdmin, {});

    const rows = (await fleetRows()).filter((row) => row.action === "settings.email.test_sent");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.result).toBe("success");
    expect(JSON.parse(rows[0]?.metadata ?? "{}")).toMatchObject({ to: SUPER_EMAIL });
  });

  it("refuses when the provider rejects, and records that too", async () => {
    // The binding throws. If this endpoint reported success here it would be
    // actively harmful: somebody would read the green toast as proof that
    // email works.
    stubEmail("rejected");

    const response = await call("POST", `${PATH}/test`, superAdmin, {});
    expect(response.status).toBe(500);

    const rows = (await fleetRows()).filter((row) => row.action === "settings.email.test_sent");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.result).toBe("denied");
  });

  it("never returns the provider's own words", async () => {
    stubEmail("rejected");

    const response = await call("POST", `${PATH}/test`, superAdmin, {});

    expect(await response.text()).not.toContain("sender is not verified");
  });
});

describe("POST /v1/admin/settings/email/compose", () => {
  const COMPOSE = `${PATH}/compose`;
  const base = {
    from: "noreply@agentdisk.io",
    to: "customer@example.com",
    subject: "About your account",
    message: "Hello <b>there</b>\nSecond line.",
  };

  it("sends what the operator wrote, from the sender they chose", async () => {
    const email = stubEmail();

    const response = await call("POST", COMPOSE, support, { ...base, from: "Billing@AgentDisk.io" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      sent: true,
      from: "billing@agentdisk.io",
      to: ["customer@example.com"],
    });

    expect(email.sent).toHaveLength(1);
    const sent = email.sent[0]!;
    expect(sent.from.email).toBe("billing@agentdisk.io");
    expect(sent.to).toEqual(["customer@example.com"]);
    expect(sent.subject).toBe("About your account");
    expect(sent.text).toBe(base.message);
    // Typed text never becomes markup in somebody's inbox.
    expect(sent.html).toContain("Hello &lt;b&gt;there&lt;/b&gt;");
    expect(sent.html).not.toContain("<b>");
  });

  it("splits a typed recipient list and drops duplicates", async () => {
    const email = stubEmail();

    const response = await call("POST", COMPOSE, support, {
      ...base,
      to: "a@example.com, b@example.com; a@example.com",
    });
    expect(response.status).toBe(200);
    expect(email.sent[0]?.to).toEqual(["a@example.com", "b@example.com"]);
  });

  it("carries attachments as bytes", async () => {
    const email = stubEmail();

    const response = await call("POST", COMPOSE, support, {
      ...base,
      attachments: [{ filename: "notes.txt", type: "text/plain", content: btoa("hello") }],
    });
    expect(response.status).toBe(200);

    const file = email.sent[0]?.attachments?.[0];
    expect(file?.filename).toBe("notes.txt");
    expect(file?.disposition).toBe("attachment");
    expect(new TextDecoder().decode(file?.content)).toBe("hello");
  });

  it("refuses a sender off the onboarded domain, before anything is sent", async () => {
    const email = stubEmail();

    const response = await call("POST", COMPOSE, support, { ...base, from: "ceo@example.com" });
    expect(response.status).toBe(400);
    expect(email.sent).toHaveLength(0);
  });

  it("refuses more than 50 recipients", async () => {
    const email = stubEmail();
    const to = Array.from({ length: 51 }, (_, i) => `r${i}@example.com`);

    const response = await call("POST", COMPOSE, support, { ...base, to });
    expect(response.status).toBe(400);
    expect(email.sent).toHaveLength(0);
  });

  it("refuses an executable attachment", async () => {
    const email = stubEmail();

    const response = await call("POST", COMPOSE, support, {
      ...base,
      attachments: [{ filename: "setup.exe", type: "application/octet-stream", content: btoa("MZ") }],
    });
    expect(response.status).toBe(400);
    expect(email.sent).toHaveLength(0);
  });

  it("records the envelope in the fleet log, never the body", async () => {
    stubEmail();

    await call("POST", COMPOSE, support, {
      ...base,
      attachments: [{ filename: "notes.txt", type: "text/plain", content: btoa("hello") }],
    });

    const rows = (await fleetRows()).filter((row) => row.action === "settings.email.composed");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.result).toBe("success");
    expect(JSON.parse(rows[0]?.metadata ?? "{}")).toMatchObject({
      from: "noreply@agentdisk.io",
      to: "customer@example.com",
      subject: "About your account",
      attachments: "notes.txt",
    });
    expect(rows[0]?.metadata).not.toContain("Second line");
  });

  it("refuses when the provider rejects, and records that too", async () => {
    stubEmail("rejected");

    const response = await call("POST", COMPOSE, support, base);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("sender is not verified");

    const rows = (await fleetRows()).filter((row) => row.action === "settings.email.composed");
    expect(rows[0]?.result).toBe("denied");
  });

  it("refuses an unauthenticated caller", async () => {
    const response = await SELF.fetch(`${URL_BASE}${COMPOSE}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(base),
    });
    expect(response.status).toBe(401);
  });
});
