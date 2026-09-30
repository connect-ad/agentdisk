/**
 * Email status, and a test send — the console's answer to "does outbound mail
 * actually work in this deployment?"
 *
 * Without this, the only way to find out is to perform a real password reset on
 * a real customer and ask them whether it arrived. That is a bad test in every
 * direction: it needs a willing customer, it sends them a live credential they
 * did not ask for, and it can only be run after somebody already needs it to
 * work.
 *
 * The status route exists because the browser cannot answer the question
 * itself. The credentials live in the Worker and never leave it, so the screen
 * either asks or guesses — and a screen that guesses is how a console starts
 * offering buttons that cannot work.
 */

import { z } from "zod";
import { ApiError, validationError } from "../lib/errors";
import {
  COMPOSE_DEFAULT_SENDER,
  SENDER_EMAIL,
  SENDING_DOMAIN,
  sendEmail,
  sendTestEmail,
} from "../lib/email";
import { json, requireAdmin, type AdminDeps } from "./admin";
import { area } from "./admin-console";
import { AdminSettingsAccess } from "../admin/settings-access";

/** Named on screen so an operator reading a bounce knows whose dashboard to open. */
const PROVIDER = "Cloudflare Email Service";

/**
 * GET /v1/admin/settings/email — any admin role.
 *
 * Readable below super_admin on purpose: support is exactly who is asked "is
 * email down?", and the answer is a boolean that grants nothing. The body
 * carries whether a credential is present, never any part of one.
 */
export async function adminGetEmailSettings(
  request: Request,
  deps: AdminDeps
): Promise<Response> {
  await requireAdmin(request, deps);

  return json({
    configured: deps.email !== null,
    sender: SENDER_EMAIL,
    provider: PROVIDER,
    composeDefaultSender: COMPOSE_DEFAULT_SENDER,
    sendingDomain: SENDING_DOMAIN,
  });
}

/**
 * POST /v1/admin/settings/email/test — super_admin.
 *
 * Sends one message to the caller's own address. The role gate is checked
 * inside `sendTest`, before the configuration is looked at, so a caller who may
 * not use this is told that rather than being told about the deployment.
 *
 * **Nothing is read from the body.** Not even to reject it — see
 * `settings-access.ts` for why the recipient is not a parameter anywhere on
 * this path.
 */
export async function adminTestEmail(request: Request, deps: AdminDeps): Promise<Response> {
  const admin = await requireAdmin(request, deps);

  const sentTo = await area(AdminSettingsAccess, admin, deps).sendTest(async (to) => {
    // Inside the callback, so the role refusal above happens first and an
    // unconfigured deployment still leaves a recorded `denied` row rather than
    // failing silently ahead of the audit write.
    if (deps.email === null) {
      throw new ApiError("INTERNAL_ERROR", "Email delivery is not configured.", {
        internalReason: "the EMAIL send_email binding is not configured",
      });
    }
    await sendTestEmail(deps.email, { to });
  });

  return json({ sentTo, provider: PROVIDER, sender: SENDER_EMAIL });
}

/* ------------------------------- compose -------------------------------- */

/** Email Service's own ceilings, checked here so a breach is a 400, not a 500. */
const MAX_RECIPIENTS = 50;
const MAX_MESSAGE_BYTES = 5 * 1024 * 1024;
/** Refused by Email Service, and by every mail filter worth the name. */
const BLOCKED_EXTENSIONS = /\.(exe|bat|cmd|scr|vbs|js|com|msi|ps1)$/i;

const address = z.string().trim().toLowerCase().email();

const composeSchema = z.object({
  from: address.refine((value) => value.endsWith(`@${SENDING_DOMAIN}`), {
    message: `The sender must be an @${SENDING_DOMAIN} address.`,
  }),
  fromName: z.string().trim().max(100).optional(),
  // A list, or one comma/semicolon/whitespace-separated string from a single
  // input box. Normalised to a de-duplicated list either way.
  to: z
    .union([z.string(), z.array(z.string())])
    .transform((value) =>
      (Array.isArray(value) ? value : value.split(/[,;\s]+/))
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry !== "")
    )
    .pipe(z.array(address).min(1).max(MAX_RECIPIENTS))
    .transform((list) => [...new Set(list)]),
  subject: z.string().trim().min(1).max(998),
  message: z.string().min(1).max(200_000),
  attachments: z
    .array(
      z.object({
        filename: z.string().trim().min(1).max(255),
        type: z.string().trim().min(1).max(255),
        /** Base64, without a `data:` prefix. */
        content: z.string().min(1),
      })
    )
    .max(20)
    .default([]),
});

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * POST /v1/admin/settings/email/compose - any console operator.
 *
 * Sends a message the operator wrote, through the same binding every other
 * message in the product uses. The sender is theirs to choose within
 * `SENDING_DOMAIN`; the default the screen offers is `noreply@`. The message is
 * plain text; the HTML part is that text escaped, so nothing typed into the box
 * can become markup in somebody's inbox.
 */
export async function adminComposeEmail(request: Request, deps: AdminDeps): Promise<Response> {
  const admin = await requireAdmin(request, deps);

  let body: z.infer<typeof composeSchema>;
  try {
    body = composeSchema.parse(await request.json());
  } catch (cause) {
    const issue = cause instanceof z.ZodError ? cause.issues[0] : undefined;
    throw validationError(
      issue === undefined
        ? "The message could not be read."
        : `${issue.path.join(".") || "body"}: ${issue.message}`
    );
  }

  const attachments: { filename: string; type: string; content: Uint8Array }[] = [];
  // The text goes out twice, as the plain part and the escaped HTML part.
  let total = new TextEncoder().encode(body.message).byteLength * 2;
  for (const file of body.attachments) {
    if (BLOCKED_EXTENSIONS.test(file.filename)) {
      throw validationError(`attachments: ${file.filename} is a file type that cannot be sent.`);
    }
    let content: Uint8Array;
    try {
      content = decodeBase64(file.content);
    } catch {
      throw validationError(`attachments: ${file.filename} could not be read.`);
    }
    total += content.byteLength;
    attachments.push({ filename: file.filename, type: file.type, content });
  }
  if (total > MAX_MESSAGE_BYTES) {
    throw validationError("The message and its attachments exceed 5 MB.");
  }

  const html =
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;` +
    `font-size:14px;line-height:1.6;color:#111621;white-space:pre-wrap">` +
    `${escapeHtml(body.message)}</div>`;

  const envelope = {
    from: body.from,
    to: body.to,
    subject: body.subject,
    attachments: attachments.map((file) => file.filename),
  };

  await area(AdminSettingsAccess, admin, deps).sendComposed(envelope, async () => {
    if (deps.email === null) {
      throw new ApiError("INTERNAL_ERROR", "Email delivery is not configured.", {
        internalReason: "the EMAIL send_email binding is not configured",
      });
    }
    await sendEmail(deps.email, {
      to: body.to,
      subject: body.subject,
      text: body.message,
      html,
      fromAddress: body.from,
      ...(body.fromName === undefined || body.fromName === "" ? {} : { fromName: body.fromName }),
      attachments,
    });
  });

  return json({ sent: true, from: body.from, to: body.to });
}
