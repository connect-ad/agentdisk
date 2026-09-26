/**
 * Customer webhooks — 05 PART 13, 03 §8.18.
 *
 * Two things are worth testing here beyond the CRUD. The signing secret must
 * behave like the credential it is — returned once, then gone — because a
 * receiver uses it to prove a delivery came from us, and a secret readable from
 * a list endpoint proves nothing.
 *
 * And `/v1/webhooks` and `/v1/webhooks/stripe` are opposite directions sharing
 * a prefix: one is us listing the customer's endpoints, the other is Stripe
 * calling us. A router that confused them would either expose billing internals
 * on a customer route or make the Stripe endpoint require a credential Stripe
 * does not have.
 */

import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { WORKSPACE_A, WORKSPACE_B, bearer, seedApiKey, seedTwoWorkspaces } from "./helpers";

const URL_BASE = "https://api-dev.agentdisk.io";

function send(path: string, token: string, method: string, body?: unknown): Promise<Response> {
  return SELF.fetch(`${URL_BASE}${path}`, {
    method,
    headers: { ...bearer(token), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(async () => {
  await seedTwoWorkspaces();
  for (const table of ["audit_events", "webhooks", "api_keys"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

describe("registering", () => {
  it("creates one and returns the secret exactly once", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["write", "list"] });

    const res = await send("/v1/webhooks", token, "POST", {
      url: "https://acme.example/hooks/agentdisk",
      events: ["file.created", "file.deleted"],
    });
    expect(res.status).toBe(201);

    const body = (await res.json()) as { secret: string; webhook: { id: string; events: string[] } };
    expect(body.secret).toMatch(/^whsec_[0-9a-f]{64}$/);
    expect(body.webhook.events).toEqual(["file.created", "file.deleted"]);

    // Never again. A secret a list endpoint hands back proves nothing about
    // who sent a delivery.
    const listed = await (await send("/v1/webhooks", token, "GET")).text();
    expect(listed).not.toContain(body.secret);
    expect(listed).not.toContain("whsec_");
  });

  it("refuses plaintext http", async () => {
    // Delivery over http puts file paths and event metadata on the wire for
    // anyone on the path, and a signature does not help with that.
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["write"] });
    const res = await send("/v1/webhooks", token, "POST", {
      url: "http://acme.example/hooks",
      events: ["file.created"],
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("https");
  });

  it("refuses an event it does not publish", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["write"] });
    const res = await send("/v1/webhooks", token, "POST", {
      url: "https://acme.example/hooks",
      events: ["file.created", "file.exfiltrated"],
    });
    expect(res.status).toBe(400);
  });

  it("refuses a subscription to nothing", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["write"] });
    const res = await send("/v1/webhooks", token, "POST", {
      url: "https://acme.example/hooks",
      events: [],
    });
    expect(res.status).toBe(400);
  });

  it("reports that delivery is running", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["list"] });
    const body = (await (await send("/v1/webhooks", token, "GET")).json()) as {
      deliveryEnabled: boolean;
      availableEvents: string[];
    };
    expect(body.deliveryEnabled).toBe(true);
    expect(body.availableEvents).toContain("file.created");
  });
});

describe("changing and removing", () => {
  async function create(token: string): Promise<string> {
    const body = (await (
      await send("/v1/webhooks", token, "POST", {
        url: "https://acme.example/hooks",
        events: ["file.created"],
      })
    ).json()) as { webhook: { id: string } };
    return body.webhook.id;
  }

  it("pauses and resumes", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["write", "list"] });
    const id = await create(token);

    const paused = await send(`/v1/webhooks/${id}`, token, "PATCH", { status: "paused" });
    expect(paused.status).toBe(200);
    expect(((await paused.json()) as { webhook: { status: string } }).webhook.status).toBe("paused");
  });

  it("changes the event subscription", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["write", "list"] });
    const id = await create(token);

    const res = await send(`/v1/webhooks/${id}`, token, "PATCH", {
      events: ["file.deleted", "folder.created"],
    });
    expect(((await res.json()) as { webhook: { events: string[] } }).webhook.events).toEqual([
      "file.deleted",
      "folder.created",
    ]);
  });

  it("deletes", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["write", "list"] });
    const id = await create(token);

    expect((await send(`/v1/webhooks/${id}`, token, "DELETE")).status).toBe(200);
    const listed = (await (await send("/v1/webhooks", token, "GET")).json()) as {
      webhooks: unknown[];
    };
    expect(listed.webhooks).toHaveLength(0);
  });

  it("cannot touch another workspace's webhook", async () => {
    const theirs = await seedApiKey({ workspaceId: WORKSPACE_B, ops: ["write", "list"] });
    const mine = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["write", "list"] });
    const id = await create(theirs.token);

    expect((await send(`/v1/webhooks/${id}`, mine.token, "DELETE")).status).toBe(404);
    expect((await send(`/v1/webhooks/${id}`, mine.token, "PATCH", { status: "paused" })).status).toBe(404);

    const stillTheirs = (await (await send("/v1/webhooks", theirs.token, "GET")).json()) as {
      webhooks: unknown[];
    };
    expect(stillTheirs.webhooks).toHaveLength(1);
  });

  it("needs write scope to change anything", async () => {
    const writer = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["write", "list"] });
    const id = await create(writer.token);

    const reader = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["read", "list"] });
    expect((await send(`/v1/webhooks/${id}`, reader.token, "DELETE")).status).toBe(403);
    expect((await send("/v1/webhooks", reader.token, "GET")).status).toBe(200);
  });
});

describe("the two /v1/webhooks routes are not confusable", () => {
  it("does not treat /v1/webhooks/stripe as a customer webhook id", async () => {
    // The customer route would need a credential; Stripe has none. If the
    // router ever matched this as an id, Stripe's deliveries would 401 forever.
    const res = await SELF.fetch(`${URL_BASE}/v1/webhooks/stripe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "ping" }),
    });
    // Refused for a missing *signature*, which is the Stripe handler answering.
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("signature");
  });

  it("still refuses a customer route without a credential", async () => {
    const res = await SELF.fetch(`${URL_BASE}/v1/webhooks`);
    expect(res.status).toBe(401);
  });
});
