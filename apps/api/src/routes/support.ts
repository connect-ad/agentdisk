/**
 * `POST /v1/support` — the dashboard's Support form.
 *
 * Until 26 September 2026 the screen rendered the design's ticket form with
 * the button disabled and a banner saying there was nothing behind it. This is
 * what is behind it: one email to the support inbox, through the same binding
 * every other message in the product uses.
 *
 * ── A person's act ──────────────────────────────────────────────────────────
 * Refused for an API key. The message names a person as its sender and carries
 * their address as Reply-To, and an agent has no address to reply to; a key
 * that could write to the support inbox in its owner's name is also a
 * spam vector with the product's own sender on it.
 *
 * ── The address comes from the credential ───────────────────────────────────
 * The body never carries an email. `identity.email` is the address Firebase
 * verified, so what the inbox sees as "From" and replies to is the account
 * that asked, not a field the client filled in. A body that includes one is
 * ignored rather than refused, so a stale client is not broken by it.
 *
 * ── No role check ───────────────────────────────────────────────────────────
 * A reader may ask for help. `op: null` for the same reason as `whoami`: no
 * scope describes it, and the human check above is the whole gate.
 *
 * ── Absent mail is a failure ────────────────────────────────────────────────
 * A deployment without the EMAIL binding answers 500, the same as the console's
 * compose. Reporting success for a message nobody will receive is the
 * `backlog/023` failure, and this is the worst screen in the product for it.
 */

import { z } from "zod";
import type { AuthContext } from "../middleware/auth";
import { ApiError, forbidden, validationError } from "../lib/errors";
import {
  SUPPORT_TOPICS,
  sendSupportRequestEmail,
  type EmailConfig,
  type SupportTopic,
} from "../lib/email";

const TOPIC_IDS = Object.keys(SUPPORT_TOPICS) as [SupportTopic, ...SupportTopic[]];

const schema = z.object({
  topic: z.enum(TOPIC_IDS),
  subject: z.string().trim().min(1, "Say in one line what is failing.").max(200),
  message: z.string().trim().min(1, "Describe what happened.").max(5000),
});

export interface SupportDeps {
  /** Null when this deployment cannot send. */
  email: EmailConfig | null;
}

export async function sendSupportRequest(
  ctx: AuthContext,
  request: Request,
  deps: SupportDeps
): Promise<Response> {
  if (ctx.identity.kind !== "firebase_user") {
    throw forbidden("An API key cannot contact support. This is a person's act.");
  }

  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await request.json());
  } catch (cause) {
    const issue = cause instanceof z.ZodError ? cause.issues[0] : undefined;
    throw validationError(
      issue === undefined
        ? "The request could not be read."
        : `${issue.path.join(".") || "body"}: ${issue.message}`
    );
  }

  if (deps.email === null) {
    throw new ApiError("INTERNAL_ERROR", "Email delivery is not configured.", {
      internalReason: "the EMAIL send_email binding is not configured",
    });
  }

  await sendSupportRequestEmail(deps.email, {
    fromPerson: ctx.identity.email,
    topic: body.topic,
    subject: body.subject,
    message: body.message,
    workspace: { id: ctx.workspace.id, name: ctx.workspace.name },
  });

  return Response.json({ sent: true });
}
