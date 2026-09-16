/**
 * Customer webhooks — 05 PART 13, 03 §8.18.
 *
 * These are the customer's own endpoints, which this product calls when
 * something happens to their files. Not to be confused with
 * `/v1/webhooks/stripe`, which is Stripe calling us — same word, opposite
 * direction, and the codebase keeps them in separate files for exactly that
 * reason.
 *
 * **The signing secret is shown once, at creation, and never again.** It is the
 * thing a receiver uses to prove a delivery really came from us, so it is a
 * credential in every sense that matters and gets the same treatment as an API
 * key: returned in the creation response, then unreadable. Rotating it means
 * generating a new one, which is a deliberate act rather than a lookup.
 *
 * Delivery itself is not built. The rows here are what a delivery worker will
 * read when it exists, and until then this is registration only — said plainly
 * in the response so nobody wires an integration against a promise.
 */

import { z } from "zod";
import { ApiError, validationError } from "../lib/errors";
import { newId } from "../lib/ids";
import { audit } from "../lib/audit";
import type { AuthContext } from "../middleware/auth";
import type { WebhookRow } from "../db/types";

/** What a customer may subscribe to. Anything else is a typo, not a feature. */
export const WEBHOOK_EVENTS = [
  "file.created",
  "file.updated",
  "file.deleted",
  "file.restored",
  "folder.created",
  "folder.deleted",
] as const;

const createSchema = z.object({
  url: z
    .string()
    .trim()
    .url("That is not a valid URL.")
    .refine(value => value.startsWith("https://"), {
      // Plaintext delivery would put file paths and event metadata on the wire
      // for anyone on the path to read, and the signature would not help.
      message: "Webhook URLs must use https.",
    }),
  events: z
    .array(z.enum(WEBHOOK_EVENTS))
    .min(1, "Subscribe to at least one event.")
    .max(WEBHOOK_EVENTS.length),
});

const updateSchema = z
  .object({
    events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).optional(),
    status: z.enum(["active", "paused"]).optional(),
  })
  .refine(body => Object.keys(body).length > 0, { message: "Nothing to change." });

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** Note the absence of `secret`. This shape is what every read returns. */
function toResource(row: WebhookRow) {
  let events: string[] = [];
  try {
    events = JSON.parse(row.events) as string[];
  } catch {
    events = [];
  }
  return {
    id: row.id,
    url: row.url,
    events,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/**
 * A signing secret, in the same shape as Stripe's so it is recognisable.
 *
 * 32 bytes from the CSPRNG. A receiver HMACs the delivery body with this and
 * compares, so its only job is to be unguessable.
 */
function generateSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
  return `whsec_${hex}`;
}

async function parse<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  try {
    return schema.parse(await request.json());
  } catch (err) {
    throw validationError(
      err instanceof z.ZodError
        ? (err.issues[0]?.message ?? "That request body is not valid.")
        : "Send a JSON body."
    );
  }
}

export async function listWebhooks(ctx: AuthContext): Promise<Response> {
  const rows = await ctx.db.webhooks.list();
  return json({
    webhooks: rows.map(toResource),
    availableEvents: WEBHOOK_EVENTS,
    deliveryEnabled: true,
  });
}

export async function createWebhook(ctx: AuthContext, request: Request): Promise<Response> {
  const body = await parse(request, createSchema);

  const row: WebhookRow = {
    id: newId("webhook", ctx.now),
    workspace_id: ctx.workspaceId,
    url: body.url,
    secret: generateSecret(),
    events: JSON.stringify(body.events),
    status: "active",
    created_at: ctx.now,
  };

  await ctx.db.webhooks.insert(row);

  audit(ctx, request, "webhook.created", {
    resourceType: "webhook",
    resourceId: row.id,
    // The URL, never the secret.
    metadata: { url: row.url, events: body.events.join(",") },
  });

  return json(
    {
      webhook: toResource(row),
      secret: row.secret,
      secretShownOnce: true,
    },
    201
  );
}

export async function patchWebhook(
  ctx: AuthContext,
  request: Request,
  id: string
): Promise<Response> {
  const body = await parse(request, updateSchema);

  const existing = await ctx.db.webhooks.getById(id);
  if (existing === null) throw new ApiError("NOT_FOUND", "No such webhook.");

  await ctx.db.webhooks.update(id, {
    events: body.events === undefined ? undefined : JSON.stringify(body.events),
    status: body.status,
  });

  const updated = await ctx.db.webhooks.getById(id);
  audit(ctx, request, "webhook.updated", {
    resourceType: "webhook",
    resourceId: id,
    metadata: { status: body.status ?? null, events: body.events?.join(",") ?? null },
  });
  return json({ webhook: toResource(updated ?? existing) });
}

export async function deleteWebhook(
  ctx: AuthContext,
  request: Request,
  id: string
): Promise<Response> {
  const existing = await ctx.db.webhooks.getById(id);
  if (existing === null) throw new ApiError("NOT_FOUND", "No such webhook.");

  await ctx.db.webhooks.delete(id);
  audit(ctx, request, "webhook.deleted", {
    resourceType: "webhook",
    resourceId: id,
    metadata: { url: existing.url },
  });
  return json({ deleted: true });
}

