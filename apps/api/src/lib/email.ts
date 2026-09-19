/**
 * Transactional email, via Mailjet.
 *
 * This module is deliberately generic. It knows how to send a message and it
 * owns the wording of the templates it ships, and it knows nothing about who is
 * asking or why — no staff assumptions, no customer assumptions, no imports
 * from `staff/` or `auth/`. Callers pass an address and the facts; the module
 * decides nothing about authorization. That is what lets a second caller adopt
 * it without first having to unpick the first caller's context.
 *
 * **Absent configuration is a refusal, not a silent no-op.** `sendEmail` throws
 * when the credentials are unset, for the same reason `readSigningConfig`
 * returns null and the presign routes refuse: a delivery path that reports
 * success while sending nothing is the failure mode that costs the most to
 * find, because everything downstream looks healthy. A caller that genuinely
 * wants best-effort delivery has to say so by catching.
 *
 * Nothing here retries. A non-2xx is either a configuration error (wrong key,
 * unverified sender) that a retry cannot fix, or a rate limit the caller is
 * better placed to reschedule than a Worker holding a request open.
 *
 * ── The Send API, not SMTP ──────────────────────────────────────────────────
 * Mailjet's SMTP relay cannot be reached from here. Workers have no `net`, and
 * while `cloudflare:sockets` can `startTls`, no maintained SMTP implementation
 * exists for workerd and one on the request path would be fragile. The Send API
 * is the same delivery over the transport this runtime actually has, and it
 * authenticates with the key pair as HTTP Basic — which is why both halves are
 * required and why either alone is treated as no configuration at all.
 *
 * ── A 200 is not a success, and this is the part worth reading ──────────────
 * The provider this replaced accepted with 202, so `response.ok` was the whole
 * check. **Mailjet answers 200 with a per-message status**: an unverified
 * sender, a blocked recipient or a malformed payload arrives inside a 200 as
 * `Messages[0].Status === "error"`. Keeping the old check would report success
 * for a message nobody will receive — precisely the shape the second paragraph
 * above exists to forbid, and the one `backlog/023` is named for. So the body
 * is parsed and anything but `success` throws.
 */

import { ApiError } from "./errors";

const MAILJET_ENDPOINT = "https://api.mailjet.com/v3.1/send";

/**
 * The verified sending identity for this domain. A constant rather than
 * configuration: Mailjet rejects a `from` that is not a verified sender on the
 * account, so making it settable per environment would only move a hard failure
 * from deploy time to send time.
 */
export const SENDER_EMAIL = "connect@agentdisk.io";
export const SENDER_NAME = "AgentDisk";

/** What the module needs from the environment. Passed in, never read globally. */
export interface EmailConfig {
  apiKey: string;
  secretKey: string;
}

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  /**
   * The plain-text alternative. Required, not optional: a message sent without
   * one is scored as spam by most receivers and is unreadable in a client that
   * refuses HTML, and making it optional guarantees some template will omit it.
   */
  text: string;
  /** Overrides the display name only. The address stays the verified sender. */
  fromName?: string;
  replyTo?: string;
}

export interface SendResult {
  /** Mailjet's per-recipient `MessageUUID`. Null when it returns none. */
  messageId: string | null;
}

/** The subset of Mailjet's response this module reads. */
interface MailjetResponse {
  Messages?: {
    Status?: string;
    Errors?: { ErrorMessage?: string }[];
    To?: { MessageUUID?: string }[];
  }[];
}

/**
 * Read the email configuration, or null when this deployment has none.
 *
 * Null means "not configured", which is a legitimate state — a dev deployment
 * without the credentials still serves every route that does not send. It is
 * the caller's job to turn that into a refusal at the point of use, so that the
 * error names the feature the operator was trying to use rather than a missing
 * variable they have no context for.
 *
 * **Both halves or neither.** The Send API uses the pair as Basic user and
 * password, so one without the other authenticates nothing; a half-set pair is
 * a misconfiguration to report as "not configured", never a degraded mode to
 * run in.
 */
export function readEmailConfig(env: {
  MAILJET_API_KEY?: string;
  MAILJET_SECRET_KEY?: string;
}): EmailConfig | null {
  const apiKey = env.MAILJET_API_KEY;
  const secretKey = env.MAILJET_SECRET_KEY;
  if (apiKey === undefined || apiKey === "") return null;
  if (secretKey === undefined || secretKey === "") return null;
  return { apiKey, secretKey };
}

function failed(reason: string): ApiError {
  return new ApiError("INTERNAL_ERROR", "The message could not be sent.", {
    internalReason: reason,
  });
}

/**
 * Send one message.
 *
 * Throws `ApiError` on any failure. The thrown body is generic; Mailjet's own
 * response text goes to `internalReason` and never to the caller, because a
 * provider error can quote the recipient address back and these are sent on
 * paths where the requester is not the recipient.
 */
export async function sendEmail(
  config: EmailConfig,
  message: EmailMessage
): Promise<SendResult> {
  const payload = {
    Messages: [
      {
        From: { Email: SENDER_EMAIL, Name: message.fromName ?? SENDER_NAME },
        To: [{ Email: message.to }],
        Subject: message.subject,
        TextPart: message.text,
        HTMLPart: message.html,
        ...(message.replyTo === undefined ? {} : { ReplyTo: { Email: message.replyTo } }),
      },
    ],
  };

  let response: Response;
  try {
    response = await fetch(MAILJET_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`${config.apiKey}:${config.secretKey}`)}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (cause) {
    throw failed(`Mailjet request failed: ${String(cause)}`);
  }

  if (!response.ok) {
    // Bounded: a provider that decides to return a large body should not put
    // the whole of it into a log line.
    const detail = (await response.text().catch(() => "")).slice(0, 500);
    throw failed(`Mailjet returned ${response.status}: ${detail}`);
  }

  let body: MailjetResponse;
  try {
    body = (await response.json()) as MailjetResponse;
  } catch (cause) {
    // A 200 nobody can read is not evidence of anything, least of all delivery.
    throw failed(`Mailjet returned an unreadable 200: ${String(cause)}`);
  }

  const first = body.Messages?.[0];
  if (first?.Status !== "success") {
    const detail = (first?.Errors ?? [])
      .map((error) => error.ErrorMessage ?? "")
      .join("; ")
      .slice(0, 500);
    throw failed(`Mailjet rejected the message (${first?.Status ?? "no status"}): ${detail}`);
  }

  return { messageId: first.To?.[0]?.MessageUUID ?? null };
}

/* ------------------------------- templates ------------------------------- */

/**
 * Minimal shared chrome. Inline styles and a table-free single column, because
 * the clients that matter strip `<style>` blocks and disagree about everything
 * else. No image, so nothing depends on remote content being loaded.
 */
function layout(heading: string, bodyHtml: string): string {
  return [
    `<div style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">`,
    `<div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e2e6ec;border-radius:12px;padding:28px">`,
    `<p style="margin:0 0 20px;font-size:15px;font-weight:600;color:#111621">AgentDisk</p>`,
    `<h1 style="margin:0 0 14px;font-size:20px;font-weight:600;color:#111621">${heading}</h1>`,
    bodyHtml,
    `</div>`,
    `<p style="max-width:520px;margin:16px auto 0;font-size:12px;line-height:1.5;color:#5f6875">`,
    `You received this because an action was taken on an AgentDisk account registered to this address.`,
    `</p>`,
    `</div>`,
  ].join("");
}

function button(href: string, label: string): string {
  return (
    `<p style="margin:0 0 20px"><a href="${href}" ` +
    `style="display:inline-block;padding:11px 18px;border-radius:8px;background:#6d28d9;` +
    `color:#ffffff;font-size:14px;font-weight:600;text-decoration:none">${label}</a></p>`
  );
}

export interface PasswordResetEmail {
  to: string;
  resetUrl: string;
  /**
   * Who asked for it. `self` is the ordinary forgot-password flow; `support`
   * means somebody other than the account holder started it, which the
   * recipient is entitled to know — an unexplained reset link is
   * indistinguishable from a phishing attempt, and a recipient who cannot tell
   * the difference is trained to click both or neither.
   */
  initiatedBy?: "self" | "support";
  /** How long the link lasts, in words. Provider-defined, so it is passed in. */
  expiresIn?: string;
}

/** Build and send a password-reset message. */
export async function sendPasswordResetEmail(
  config: EmailConfig,
  options: PasswordResetEmail
): Promise<SendResult> {
  const { to, resetUrl, initiatedBy = "self", expiresIn = "1 hour" } = options;
  const bySupport = initiatedBy === "support";

  const opening = bySupport
    ? "A member of the AgentDisk support team started a password reset on your account at your request or in response to a support issue."
    : "You asked to reset the password on your AgentDisk account.";

  const closing = bySupport
    ? "If you did not ask for this and have not contacted support, do not use this link — reply to this message and we will look into it."
    : "If you did not ask for this, you can ignore this message. Your password will not change until you use the link.";

  const html = layout(
    "Reset your password",
    [
      `<p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:#374151">${opening}</p>`,
      button(resetUrl, "Choose a new password"),
      `<p style="margin:0 0 18px;font-size:13px;line-height:1.6;color:#5f6875">This link expires in ${expiresIn} and can be used once.</p>`,
      `<p style="margin:0;font-size:13px;line-height:1.6;color:#5f6875">${closing}</p>`,
    ].join("")
  );

  const text = [
    opening,
    "",
    "Choose a new password:",
    resetUrl,
    "",
    `This link expires in ${expiresIn} and can be used once.`,
    "",
    closing,
  ].join("\n");

  return await sendEmail(config, {
    to,
    subject: "Reset your AgentDisk password",
    html,
    text,
  });
}

export interface TestEmail {
  to: string;
}

/**
 * Build and send a test message.
 *
 * It carries no link and asks the reader to do nothing, which is not
 * minimalism: this is the one message in the product that gets sent on a whim,
 * to prove the pipe works. A copy forwarded to somebody else, or sitting in a
 * mailbox months later, should be inert — no action to take, nothing to click,
 * nothing that stops being true.
 *
 * It does name who caused it, because an unexplained message from a product's
 * verified sender is indistinguishable from a compromised one, and a staff team
 * that cannot tell the difference is trained to ignore both.
 */
export async function sendTestEmail(
  config: EmailConfig,
  options: TestEmail
): Promise<SendResult> {
  const opening =
    "Someone signed in to the AgentDisk staff console asked for a test message. This is it.";
  const closing =
    "Nothing about any account changed and there is nothing to do. If you did not ask for this, " +
    "say so to the rest of the staff team — it means somebody holding super_admin ran the check.";

  const html = layout(
    "Email delivery is working",
    [
      `<p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:#374151">${opening}</p>`,
      `<p style="margin:0;font-size:13px;line-height:1.6;color:#5f6875">${closing}</p>`,
    ].join("")
  );

  const text = [opening, "", closing].join("\n");

  return await sendEmail(config, {
    to: options.to,
    subject: "AgentDisk email delivery test",
    html,
    text,
  });
}
