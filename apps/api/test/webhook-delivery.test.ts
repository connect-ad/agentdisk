/**
 * Webhook delivery — 05 PART 13, 06 PART 16.18.
 *
 * The signature is a contract with somebody else's code, so it gets verified
 * here the way a receiver would verify it, independently rather than by calling
 * our own signer twice and comparing it to itself.
 *
 * The other half is the retryable/permanent split. Retrying a 500 is right;
 * retrying a 410 for hours is a small denial of service aimed at somebody who
 * has already told us to stop.
 */

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import {
  deliverOnce,
  enqueueWebhookEvents,
  handleDelivery,
  isWebhookEvent,
  signBody,
  type WebhookEvent,
} from "../src/jobs/webhook-delivery";
import { WorkspaceScopedWebhooks } from "../src/db/workspace-scoped";
import { NOW, WORKSPACE_A, WORKSPACE_B, seedTwoWorkspaces } from "./helpers";
import type { WebhookRow } from "../src/db/types";

const SECRET = "whsec_" + "a".repeat(64);

function hook(overrides: Partial<WebhookRow> = {}): WebhookRow {
  return {
    id: "whk_TEST",
    workspace_id: WORKSPACE_A,
    url: "https://receiver.example/hooks",
    secret: SECRET,
    events: JSON.stringify(["file.created"]),
    status: "active",
    created_at: NOW,
    ...overrides,
  };
}

function event(overrides: Partial<WebhookEvent> = {}): WebhookEvent {
  return {
    kind: "webhook.delivery",
    workspaceId: WORKSPACE_A,
    webhookId: "whk_TEST",
    event: "file.created",
    data: { id: "fil_1", path: "/a.txt" },
    occurredAt: NOW,
    ...overrides,
  };
}

/** Verify the way a customer's server would, from the secret alone. */
async function verifyAsReceiver(
  secret: string,
  signatureHeader: string,
  body: string
): Promise<boolean> {
  const parts = Object.fromEntries(
    signatureHeader.split(",").map(p => p.split("=") as [string, string])
  );
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const expected = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${parts.t}.${body}`)
  );
  const hex = Array.from(new Uint8Array(expected))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
  return hex === parts.v1;
}

/** Captures what was sent so the signature can be checked against the real body. */
function captureFetch(response: Response): { calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return response.clone();
    })
  );
  return { calls };
}

beforeEach(async () => {
  await seedTwoWorkspaces();
  await env.DB.prepare(`DELETE FROM webhooks`).run();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("signing", () => {
  it("produces a signature a receiver can verify from the secret alone", async () => {
    const captured = captureFetch(new Response(null, { status: 200 }));
    await deliverOnce(hook(), event(), NOW);

    const init = captured.calls[0]?.init as RequestInit & { headers: Record<string, string> };
    const signature = init.headers["agentdisk-signature"] ?? "";
    const body = init.body as string;

    expect(await verifyAsReceiver(SECRET, signature, body)).toBe(true);
  });

  it("does not verify against a different secret", async () => {
    const captured = captureFetch(new Response(null, { status: 200 }));
    await deliverOnce(hook(), event(), NOW);

    const init = captured.calls[0]?.init as RequestInit & { headers: Record<string, string> };
    expect(
      await verifyAsReceiver(
        "whsec_" + "b".repeat(64),
        init.headers["agentdisk-signature"] ?? "",
        init.body as string
      )
    ).toBe(false);
  });

  it("covers the timestamp, so a captured delivery cannot be replayed later", async () => {
    // Without the timestamp inside the signed material, a valid signature stays
    // valid forever and a recorded request can be sent back at any time.
    const body = '{"hello":"world"}';
    const early = await signBody(SECRET, body, 1000);
    const late = await signBody(SECRET, body, 2000);
    expect(early).not.toBe(late);
  });

  it("changes if the body changes by one byte", async () => {
    const a = await signBody(SECRET, '{"n":1}', 1000);
    const b = await signBody(SECRET, '{"n":2}', 1000);
    expect(a).not.toBe(b);
  });

  it("sends a delivery id a receiver can dedupe on", async () => {
    // At-least-once means they will see the same event twice eventually.
    const captured = captureFetch(new Response(null, { status: 200 }));
    await deliverOnce(hook(), event(), NOW);
    const init = captured.calls[0]?.init as RequestInit & { headers: Record<string, string> };
    expect(init.headers["agentdisk-delivery"]).toBeTruthy();
    expect(init.headers["agentdisk-event"]).toBe("file.created");
  });
});

describe("what counts as retryable", () => {
  const cases: [number, boolean][] = [
    [200, false], // delivered
    [204, false],
    [500, true],
    [502, true],
    [503, true],
    [408, true],
    [429, true],
    [400, false],
    [401, false],
    [404, false],
    [410, false],
  ];

  for (const [status, retryable] of cases) {
    it(`${status} is ${retryable ? "retried" : "not retried"}`, async () => {
      captureFetch(new Response(null, { status }));
      const outcome = await deliverOnce(hook(), event(), NOW);
      if (status < 300) {
        expect(outcome.delivered).toBe(true);
      } else {
        expect(outcome.delivered).toBe(false);
        expect(outcome.retryable).toBe(retryable);
      }
    });
  }

  it("retries a network failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("connect ECONNREFUSED"); }));
    const outcome = await deliverOnce(hook(), event(), NOW);
    expect(outcome).toMatchObject({ delivered: false, retryable: true });
  });
});

describe("handling a queued delivery", () => {
  async function seedHook(row: WebhookRow): Promise<void> {
    await env.DB.prepare(
      `INSERT INTO webhooks (id, workspace_id, url, secret, events, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(row.id, row.workspace_id, row.url, row.secret, row.events, row.status, row.created_at).run();
  }

  it("acks a successful delivery", async () => {
    await seedHook(hook());
    captureFetch(new Response(null, { status: 200 }));
    expect(await handleDelivery(env.DB, event(), NOW)).toMatchObject({ ack: true });
  });

  it("retries a 500", async () => {
    await seedHook(hook());
    captureFetch(new Response(null, { status: 500 }));
    expect(await handleDelivery(env.DB, event(), NOW)).toMatchObject({ ack: false });
  });

  it("acks a 410 rather than hammering somebody who asked us to stop", async () => {
    await seedHook(hook());
    captureFetch(new Response(null, { status: 410 }));
    expect(await handleDelivery(env.DB, event(), NOW)).toMatchObject({ ack: true });
  });

  it("acks and sends nothing when the endpoint is paused", async () => {
    await seedHook(hook({ status: "paused" }));
    const captured = captureFetch(new Response(null, { status: 200 }));
    expect(await handleDelivery(env.DB, event(), NOW)).toMatchObject({ ack: true });
    expect(captured.calls).toHaveLength(0);
  });

  it("acks and sends nothing when the endpoint is gone", async () => {
    // No row at all. The work is not failing, it is no longer wanted.
    const captured = captureFetch(new Response(null, { status: 200 }));
    expect(await handleDelivery(env.DB, event(), NOW)).toMatchObject({ ack: true });
    expect(captured.calls).toHaveLength(0);
  });

  it("will not deliver an event for another workspace's webhook", async () => {
    await seedHook(hook());
    const captured = captureFetch(new Response(null, { status: 200 }));
    await handleDelivery(env.DB, event({ workspaceId: WORKSPACE_B }), NOW);
    expect(captured.calls).toHaveLength(0);
  });
});

describe("fan-out", () => {
  function fakeQueue(): { sent: unknown[]; send(m: unknown): Promise<void> } {
    const sent: unknown[] = [];
    return { sent, async send(m) { sent.push(m); } };
  }

  async function seed(id: string, events: string[], status = "active"): Promise<void> {
    await env.DB.prepare(
      `INSERT INTO webhooks (id, workspace_id, url, secret, events, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, WORKSPACE_A, "https://x.example/h", SECRET, JSON.stringify(events), status, NOW).run();
  }

  it("queues only the endpoints subscribed to that event", async () => {
    await seed("whk_A", ["file.created"]);
    await seed("whk_B", ["file.deleted"]);
    const queue = fakeQueue();

    const repo = new WorkspaceScopedWebhooks(env.DB, WORKSPACE_A);
    const n = await enqueueWebhookEvents(repo, queue as unknown as Queue, WORKSPACE_A, "file.created", {}, NOW);

    expect(n).toBe(1);
    expect((queue.sent[0] as WebhookEvent).webhookId).toBe("whk_A");
  });

  it("skips paused endpoints", async () => {
    await seed("whk_P", ["file.created"], "paused");
    const queue = fakeQueue();
    const repo = new WorkspaceScopedWebhooks(env.DB, WORKSPACE_A);
    expect(await enqueueWebhookEvents(repo, queue as unknown as Queue, WORKSPACE_A, "file.created", {}, NOW)).toBe(0);
  });

  it("grants nothing on an unreadable subscription", async () => {
    // Fail closed. A corrupt events blob must not mean "send everything".
    await env.DB.prepare(
      `INSERT INTO webhooks (id, workspace_id, url, secret, events, status, created_at)
       VALUES ('whk_BAD', ?, 'https://x.example/h', ?, 'not json', 'active', ?)`
    ).bind(WORKSPACE_A, SECRET, NOW).run();

    const queue = fakeQueue();
    const repo = new WorkspaceScopedWebhooks(env.DB, WORKSPACE_A);
    expect(await enqueueWebhookEvents(repo, queue as unknown as Queue, WORKSPACE_A, "file.created", {}, NOW)).toBe(0);
  });
});

describe("message recognition", () => {
  it("accepts its own messages and rejects anything else", async () => {
    expect(isWebhookEvent(event())).toBe(true);
    expect(isWebhookEvent({ kind: "something.else" })).toBe(false);
    expect(isWebhookEvent(null)).toBe(false);
    expect(isWebhookEvent("a string")).toBe(false);
  });
});
