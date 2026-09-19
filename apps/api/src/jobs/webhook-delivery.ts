/**
 * Delivering webhooks — 05 PART 13, 06 PART 16.18.
 *
 * Registration has existed for a while and nothing was ever sent, so an
 * endpoint a customer configured was a promise the product did not keep. This
 * is the delivery half.
 *
 * It runs through the queue rather than inline on the request that caused it,
 * and that is the whole design. A customer's endpoint being slow, down, or
 * hostile must not slow down, fail, or hang the upload that triggered the
 * event — the person uploading a file has no relationship with whoever runs
 * that endpoint, and making them wait on it is borrowing somebody else's
 * reliability problem.
 *
 * **Signing.** Every delivery carries an HMAC-SHA256 over `timestamp.body`,
 * keyed with the endpoint's secret, in the same header shape Stripe uses. The
 * timestamp is inside the signed material specifically so a captured delivery
 * cannot be replayed later — without it, a valid signature stays valid forever.
 */

import type { WebhookRow } from "../db/types";

/** Deliveries older than this are refused by a correct receiver. */
export const REPLAY_WINDOW_SECONDS = 300;

/** A customer's endpoint gets this long before we give up on one attempt. */
const TIMEOUT_MS = 10_000;

export interface WebhookEvent {
  kind: "webhook.delivery";
  workspaceId: string;
  webhookId: string;
  event: string;
  /** The payload, already free of anything sensitive. */
  data: Record<string, unknown>;
  occurredAt: number;
  /** Incremented by the queue's own retry machinery, carried for the log. */
  attempt?: number;
}

export function isWebhookEvent(value: unknown): value is WebhookEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "webhook.delivery"
  );
}

/**
 * Sign a body the way a receiver will verify it.
 *
 * Exported because the signature is the contract with the customer's code, and
 * a contract with no test is a hope.
 */
export async function signBody(
  secret: string,
  body: string,
  timestampSeconds: number
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestampSeconds}.${body}`)
  );
  const hex = Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
  return `t=${timestampSeconds},v1=${hex}`;
}

export interface DeliveryOutcome {
  delivered: boolean;
  status?: number;
  /** Whether a retry could plausibly succeed. */
  retryable: boolean;
  reason?: string;
}

/**
 * Send one delivery.
 *
 * The retryable/permanent split matters more than it looks. A 500 or a timeout
 * is worth retrying; a 410 Gone or a 404 is the receiver telling us this
 * endpoint no longer exists, and retrying that for hours is a small denial of
 * service aimed at somebody who already asked us to stop.
 */
export async function deliverOnce(
  hook: WebhookRow,
  event: WebhookEvent,
  now: number
): Promise<DeliveryOutcome> {
  const timestamp = Math.floor(now / 1000);
  const body = JSON.stringify({
    id: `evt_${event.occurredAt}_${event.webhookId}`,
    type: event.event,
    workspaceId: event.workspaceId,
    occurredAt: new Date(event.occurredAt).toISOString(),
    data: event.data,
  });

  const signature = await signBody(hook.secret, body, timestamp);

  try {
    const response = await fetch(hook.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "AgentDisk-Webhooks/1.0",
        "agentdisk-signature": signature,
        // Named so a receiver can dedupe, because at-least-once delivery means
        // they will eventually see the same event twice.
        "agentdisk-event": event.event,
        "agentdisk-delivery": `${event.occurredAt}-${event.webhookId}`,
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (response.ok) return { delivered: true, status: response.status, retryable: false };

    // 4xx other than 408/429 means the receiver understood and rejected it.
    // Retrying will not change their mind.
    const retryable =
      response.status >= 500 || response.status === 408 || response.status === 429;
    return {
      delivered: false,
      status: response.status,
      retryable,
      reason: `endpoint answered ${response.status}`,
    };
  } catch (err) {
    // Timeouts, DNS failures, TLS problems. All transient in principle.
    return {
      delivered: false,
      retryable: true,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Handle one queued delivery.
 *
 * Returns whether the message should be acked. A paused or deleted endpoint
 * acks: the work is not failing, it is no longer wanted, and leaving it to
 * retry into the dead-letter queue would fill that queue with things nobody
 * asked for.
 */
export async function handleDelivery(
  db: D1Database,
  event: WebhookEvent,
  now: number
): Promise<{ ack: boolean; outcome?: DeliveryOutcome }> {
  const hook = await db
    .prepare(`SELECT * FROM webhooks WHERE id = ? AND workspace_id = ?`)
    .bind(event.webhookId, event.workspaceId)
    .first<WebhookRow>();

  if (hook === null || hook.status !== "active") {
    return { ack: true };
  }

  const outcome = await deliverOnce(hook, event, now);
  return { ack: outcome.delivered || !outcome.retryable, outcome };
}

/**
 * Queue the deliveries an event should produce.
 *
 * Best-effort by construction: it is called from `waitUntil`, and a queue that
 * is momentarily unavailable must not fail the upload that triggered it. A
 * missed notification is a smaller harm than a refused write.
 */
export async function enqueueWebhookEvents(
  webhooks: { list(): Promise<WebhookRow[]> },
  queue: Queue,
  workspaceId: string,
  event: string,
  data: Record<string, unknown>,
  now: number
): Promise<number> {
  // The workspace-scoped repository, not a raw binding - so this cannot read
  // another tenant's endpoints even by mistake.
  const rows = await webhooks.list();

  const interested = rows.filter(row => {
    if (row.status !== "active") return false;
    try {
      return (JSON.parse(row.events) as string[]).includes(event);
    } catch {
      // An unreadable subscription grants nothing rather than everything.
      return false;
    }
  });

  for (const row of interested) {
    await queue.send({
      kind: "webhook.delivery",
      workspaceId,
      webhookId: row.id,
      event,
      data,
      occurredAt: now,
    } satisfies WebhookEvent);
  }

  return interested.length;
}
