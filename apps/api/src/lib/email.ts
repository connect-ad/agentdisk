/**
 * Transactional email, via Cloudflare Email Service.
 *
 * This module is deliberately generic. It knows how to send a message and it
 * owns the wording of the templates it ships, and it knows nothing about who is
 * asking or why — no admin assumptions, no customer assumptions, no imports
 * from `admin/` or `auth/`. Callers pass an address and the facts; the module
 * decides nothing about authorization. That is what lets a second caller adopt
 * it without first having to unpick the first caller's context.
 *
 * **Absent configuration is a refusal, not a silent no-op.** `sendEmail` throws
 * when the binding is missing, for the same reason `readSigningConfig` returns
 * null and the presign routes refuse: a delivery path that reports success
 * while sending nothing is the failure mode that costs the most to find,
 * because everything downstream looks healthy. A caller that genuinely wants
 * best-effort delivery has to say so by catching.
 *
 * Nothing here retries. A rejection is either a configuration error (sender
 * not on an onboarded domain, not in `allowed_sender_addresses`) that a retry
 * cannot fix, or a rate limit the caller is better placed to reschedule than a
 * Worker holding a request open.
 *
 * ── A binding, not a credential ─────────────────────────────────────────────
 * The `send_email` binding in wrangler.toml is the whole of the authorization.
 * There is no API key in this Worker to leak, rotate or half-set, which is why
 * this replaced Mailjet's Send API (whose key pair CI had to push, and whose
 * "200 with a per-message error" had to be parsed to avoid reporting a message
 * nobody would receive as sent — `backlog/023`). The binding throws on every
 * failure, with a `code` such as `E_SENDER_NOT_VERIFIED`, so a resolved promise
 * is the success and there is no body to second-guess.
 *
 * Firebase's own mail (sign-up, reset, email-link) is the same service over
 * SMTP, configured in the Firebase console. The two share the account's quota.
 */

import { ApiError } from "./errors";

/**
 * The sending identity for every template in this module. A constant rather
 * than configuration: it must sit on the domain onboarded to Email Sending, so
 * making it settable per environment would only move a hard failure from
 * deploy time to send time.
 */
export const SENDER_EMAIL = "connect@agentdisk.io";
export const SENDER_NAME = "AgentDisk";

/**
 * The domain onboarded to Email Sending. Any `from` on it is deliverable; any
 * other is refused by Cloudflare with `E_SENDER_NOT_VERIFIED`. The console's
 * compose screen lets an operator pick the local part, and checks this domain
 * itself so the refusal is a 400 naming the field rather than a failed send.
 */
export const SENDING_DOMAIN = "agentdisk.io";

/** What the console's compose screen offers as the sender until it is edited. */
export const COMPOSE_DEFAULT_SENDER = `noreply@${SENDING_DOMAIN}`;

/** What the module needs from the environment. Passed in, never read globally. */
export interface EmailConfig {
  binding: SendEmail;
}

export interface EmailMessage {
  /** One address, or up to 50 — Email Service's per-message recipient limit. */
  to: string | string[];
  subject: string;
  html: string;
  /**
   * The plain-text alternative. Required, not optional: a message sent without
   * one is scored as spam by most receivers and is unreadable in a client that
   * refuses HTML, and making it optional guarantees some template will omit it.
   */
  text: string;
  /** Overrides the display name. */
  fromName?: string;
  /**
   * Overrides the address. Only the console's compose screen sets it, and only
   * after checking it is on `SENDING_DOMAIN`. Every template leaves it unset.
   */
  fromAddress?: string;
  replyTo?: string;
  attachments?: { filename: string; type: string; content: ArrayBuffer | ArrayBufferView }[];
}

export interface SendResult {
  /** The Email Service message ID. Null when it returns none. */
  messageId: string | null;
}

/**
 * Read the email configuration, or null when this deployment has none.
 *
 * Null means "not configured", which is a legitimate state — a deployment
 * without the binding still serves every route that does not send. It is the
 * caller's job to turn that into a refusal at the point of use, so that the
 * error names the feature the operator was trying to use rather than a missing
 * binding they have no context for.
 */
export function readEmailConfig(env: { EMAIL?: SendEmail }): EmailConfig | null {
  return env.EMAIL === undefined ? null : { binding: env.EMAIL };
}

function failed(reason: string): ApiError {
  return new ApiError("INTERNAL_ERROR", "The message could not be sent.", {
    internalReason: reason,
  });
}

/**
 * Send one message.
 *
 * Throws `ApiError` on any failure. The thrown body is generic; the service's
 * own error goes to `internalReason` and never to the caller, because a
 * provider error can quote the recipient address back and these are sent on
 * paths where the requester is not the recipient.
 */
export async function sendEmail(
  config: EmailConfig,
  message: EmailMessage
): Promise<SendResult> {
  let result: EmailSendResult;
  try {
    result = await config.binding.send({
      from: { email: message.fromAddress ?? SENDER_EMAIL, name: message.fromName ?? SENDER_NAME },
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
      ...(message.attachments === undefined || message.attachments.length === 0
        ? {}
        : {
            attachments: message.attachments.map((file) => ({
              disposition: "attachment" as const,
              filename: file.filename,
              type: file.type,
              content: file.content,
            })),
          }),
    });
  } catch (cause) {
    const code = (cause as { code?: unknown } | null)?.code;
    // Bounded: an error message should not put an arbitrary amount of text
    // into a log line.
    const detail = String(cause).slice(0, 500);
    throw failed(`Email Service rejected the message (${String(code ?? "no code")}): ${detail}`);
  }

  return { messageId: result?.messageId ?? null };
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
 * verified sender is indistinguishable from a compromised one, and a admin team
 * that cannot tell the difference is trained to ignore both.
 */
export async function sendTestEmail(
  config: EmailConfig,
  options: TestEmail
): Promise<SendResult> {
  const opening =
    "Someone signed in to the AgentDisk admin console asked for a test message. This is it.";
  const closing =
    "Nothing about any account changed and there is nothing to do. If you did not ask for this, " +
    "say so to the rest of the admin team — it means somebody holding super_admin ran the check.";

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

/* --------------------------- the renewal ladder --------------------------- */
/**
 * Three messages, sent by `jobs/billing-renewal.ts` as a period runs out.
 *
 * AgentDisk does not auto-renew, so these are not a courtesy — they are the
 * only thing standing between a customer and losing access to their files by
 * forgetting. Stripe used to send this class of message on our behalf; under
 * manual renewal there is no subscription for it to dun, so it falls to us.
 *
 * Every one of them states the same two facts, deliberately repeated rather
 * than assumed remembered: **nothing has been deleted**, and **reading and
 * downloading keep working**. Somebody who meets the write lock on a failed
 * upload with no explanation concludes their data is gone, and that is a
 * support crisis manufactured out of a billing event.
 */

export interface RenewalEmail {
  to: string;
  /** The plan's display name, as the customer knows it: "Pro", "Team". */
  planName: string;
  /** The end of the paid period, already formatted for a human. */
  periodEndDate: string;
  /** Where to go and pay. The Manage Subscription page. */
  renewUrl: string;
}

/** Day −7: the plan is running out and will not renew by itself. */
export async function sendRenewalReminderEmail(
  config: EmailConfig,
  options: RenewalEmail
): Promise<SendResult> {
  const { to, planName, periodEndDate, renewUrl } = options;

  // Said in the first sentence, because it is the fact the whole message
  // exists to convey and the one a reader is most likely to assume otherwise.
  const opening =
    `Your ${planName} plan ends on ${periodEndDate}. ` +
    `It will not renew automatically — AgentDisk never charges a card without you asking.`;
  const closing =
    "If you let it end, uploads pause but everything you have stored stays readable and " +
    "downloadable for a further 7 days, and you can renew at any point in that window.";

  const html = layout(
    `Your plan ends on ${periodEndDate}`,
    [
      `<p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:#374151">${opening}</p>`,
      button(renewUrl, `Renew ${planName}`),
      `<p style="margin:0;font-size:13px;line-height:1.6;color:#5f6875">${closing}</p>`,
    ].join("")
  );

  const text = [opening, "", "Renew:", renewUrl, "", closing].join("\n");

  return await sendEmail(config, {
    to,
    subject: `Your ${planName} plan ends on ${periodEndDate}`,
    html,
    text,
  });
}

export interface RenewalExpiredEmail extends RenewalEmail {
  /** When the data gets scheduled for deletion, formatted. */
  graceEndDate: string;
}

/** Day 0: the period has ended, writes are locked, the grace clock starts. */
export async function sendPlanExpiredEmail(
  config: EmailConfig,
  options: RenewalExpiredEmail
): Promise<SendResult> {
  const { to, planName, periodEndDate, graceEndDate, renewUrl } = options;

  const opening =
    `Your ${planName} plan ended on ${periodEndDate}. New uploads are paused.`;
  const reassurance =
    "Nothing has been deleted. Every file you have stored is still readable and downloadable, " +
    "and your API keys still work for reads.";
  const deadline =
    `Renew before ${graceEndDate} and everything resumes exactly as it was. ` +
    `If the account is still unrenewed on ${graceEndDate}, its data is scheduled for deletion.`;

  const html = layout(
    "Your plan has ended",
    [
      `<p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:#374151">${opening}</p>`,
      `<p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:#374151">${reassurance}</p>`,
      button(renewUrl, `Renew ${planName}`),
      `<p style="margin:0;font-size:13px;line-height:1.6;color:#5f6875">${deadline}</p>`,
    ].join("")
  );

  const text = [opening, "", reassurance, "", "Renew:", renewUrl, "", deadline].join("\n");

  return await sendEmail(config, {
    to,
    subject: `Your ${planName} plan has ended`,
    html,
    text,
  });
}

export interface DeletionScheduledEmail extends RenewalEmail {
  /** Where the customer can still get their files out. */
  dashboardUrl: string;
}

/**
 * Day +7: the grace window is over and the data is queued for removal.
 *
 * This message is not in the original specification and was added deliberately.
 * Scheduling the deletion of a paying customer's files without telling them at
 * the moment it happens is indefensible — the two earlier messages warned about
 * a future event, and this is the one that says it has now been set in motion
 * and how to stop it.
 *
 * It says "scheduled", not "deleted", because that is the truth: the stamp is
 * written here and the bytes go later, so renewing still undoes it.
 */
export async function sendDeletionScheduledEmail(
  config: EmailConfig,
  options: DeletionScheduledEmail
): Promise<SendResult> {
  const { to, planName, periodEndDate, renewUrl, dashboardUrl } = options;

  const opening =
    `Your ${planName} plan ended on ${periodEndDate} and the 7-day grace period is over. ` +
    `The data in this account has been scheduled for deletion.`;
  const escape =
    "This is reversible. Renewing the plan cancels the deletion and restores the account " +
    "exactly as it was — nothing has been removed yet.";
  const exportNote =
    "If you would rather not renew, sign in and download what you need first. Reads and " +
    "downloads still work until the deletion runs.";

  const html = layout(
    "Your data is scheduled for deletion",
    [
      `<p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:#374151">${opening}</p>`,
      `<p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:#374151">${escape}</p>`,
      button(renewUrl, `Renew ${planName} and keep everything`),
      `<p style="margin:0;font-size:13px;line-height:1.6;color:#5f6875">${exportNote} <a href="${dashboardUrl}" style="color:#6d28d9">Open AgentDisk</a>.</p>`,
    ].join("")
  );

  const text = [
    opening,
    "",
    escape,
    "",
    "Renew and keep everything:",
    renewUrl,
    "",
    exportNote,
    dashboardUrl,
  ].join("\n");

  return await sendEmail(config, {
    to,
    subject: "Your AgentDisk data is scheduled for deletion",
    html,
    text,
  });
}
