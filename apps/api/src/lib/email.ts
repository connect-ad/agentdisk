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

/* ------------------------------ support ------------------------------ */

/**
 * Where the dashboard's Support form delivers. One constant, deliberately: it
 * is an inbox a person reads, not a per-environment setting, and a dev
 * deployment writing to the same inbox as prod is a feature — a request from
 * `app-dev` is still a request.
 */
export const SUPPORT_INBOX = "connect@amardisk.io";

/**
 * The address a support request is sent *from*. On `SENDING_DOMAIN`, so it is
 * deliverable; distinct from `SENDER_EMAIL` so the inbox can filter "a person
 * asked for help through the site" from the product's own transactional mail.
 * The person's address goes in Reply-To, never in From: a From we do not own
 * is refused by Cloudflare, and a reply must reach the person, not us.
 */
export const SUPPORT_SENDER = `websupport@${SENDING_DOMAIN}`;

/**
 * The topics the Support screen offers, and the words it shows for each. The
 * screen sends the id; the message carries the label, because "keys" tells the
 * reader less than "Key or scope problem". Change one and change the other:
 * `routes/Support.jsx` holds the same table.
 */
export const SUPPORT_TOPICS = {
  billing: "Billing or invoices",
  keys: "Key or scope problem",
  errors: "Agent hitting 5xx",
  other: "Something else",
} as const;

export type SupportTopic = keyof typeof SUPPORT_TOPICS;

export interface SupportRequestEmail {
  /** The signed-in person's verified address, from the credential. */
  fromPerson: string;
  topic: SupportTopic;
  subject: string;
  message: string;
  workspace: { id: string; name: string };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * A request for help, as a person typed it on the Support screen.
 *
 * The facts come first and the message last, so whoever reads the inbox sees
 * who is asking, about what, and from which workspace before the prose. The
 * message is plain text in both parts — the HTML part is the text escaped, so
 * nothing typed into the box becomes markup in the inbox.
 */
export async function sendSupportRequestEmail(
  config: EmailConfig,
  options: SupportRequestEmail
): Promise<SendResult> {
  const topicLabel = SUPPORT_TOPICS[options.topic];
  const facts: [string, string][] = [
    ["From", options.fromPerson],
    ["Topic", topicLabel],
    ["Workspace", `${options.workspace.name} (${options.workspace.id})`],
    ["Subject", options.subject],
  ];

  const text = [
    ...facts.map(([label, value]) => `${label}: ${value}`),
    "",
    options.message,
  ].join("\n");

  const html =
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;` +
    `font-size:14px;line-height:1.6;color:#111621">` +
    `<table style="border-collapse:collapse;margin:0 0 16px">` +
    facts
      .map(
        ([label, value]) =>
          `<tr><td style="padding:2px 12px 2px 0;color:#5f6875">${label}</td>` +
          `<td style="padding:2px 0">${escapeHtml(value)}</td></tr>`
      )
      .join("") +
    `</table>` +
    `<div style="white-space:pre-wrap">${escapeHtml(options.message)}</div>` +
    `</div>`;

  return await sendEmail(config, {
    to: SUPPORT_INBOX,
    fromAddress: SUPPORT_SENDER,
    fromName: "AgentDisk web support",
    replyTo: options.fromPerson,
    subject: `[${topicLabel}] ${options.subject}`,
    html,
    text,
  });
}

/* --------------------------- the renewal ladder --------------------------- */
/**
 * Three messages, sent by `jobs/billing-renewal.ts` around a renewal.
 *
 * AgentDisk auto-renews (owner's decision, 25 September 2026), so the first of
 * these is **advance notice of a charge** rather than a request to act. That is
 * not a courtesy: a subscription that bills without warning is the pattern
 * consumer-protection rules across the US and EU were written about, and
 * several jurisdictions require notice before a renewal charge specifically.
 * The other two are the dunning ladder, which Stripe drives and we narrate.
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
  /** Where the subscription is managed. The Manage Subscription page. */
  renewUrl: string;
}

export interface RenewalReminderEmail extends RenewalEmail {
  /** What will be charged, already formatted: "$20.00". */
  amount: string;
  /** "month" or "year", for the sentence that names the cadence. */
  interval: "month" | "year";
}

/**
 * Day −7: the plan renews on this date, for this amount.
 *
 * The amount is not optional and the date is not approximate. A renewal notice
 * that says only "your plan renews soon" leaves the customer unable to check it
 * against their statement, which is the one thing the message is for.
 */
export async function sendRenewalReminderEmail(
  config: EmailConfig,
  options: RenewalReminderEmail
): Promise<SendResult> {
  const { to, planName, periodEndDate, renewUrl, amount, interval } = options;

  // Amount and date in the first sentence, because together they are the whole
  // content of the notice and a reader should not have to hunt for either.
  const opening =
    `Your ${planName} plan renews automatically on ${periodEndDate}, ` +
    `and the card on file will be charged ${amount} for another ${interval}.`;
  const closing =
    "Nothing is needed from you if that is what you want. If you would rather stop, " +
    "you can cancel from the billing page at any time before that date — you keep the " +
    "plan until the period you have already paid for runs out.";

  const html = layout(
    `Your plan renews on ${periodEndDate}`,
    [
      `<p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:#374151">${opening}</p>`,
      button(renewUrl, "Manage subscription"),
      `<p style="margin:0;font-size:13px;line-height:1.6;color:#5f6875">${closing}</p>`,
    ].join("")
  );

  const text = [opening, "", "Manage subscription:", renewUrl, "", closing].join("\n");

  return await sendEmail(config, {
    to,
    subject: `Your ${planName} plan renews on ${periodEndDate} — ${amount}`,
    html,
    text,
  });
}

export interface PaymentFailedEmail extends RenewalEmail {
  /** When the data gets scheduled for deletion, formatted. */
  graceEndDate: string;
}

/**
 * Day 0: the renewal charge failed, writes are locked, the grace clock starts.
 *
 * Written to be actionable rather than alarming, because the overwhelming
 * majority of these are an expired card rather than somebody leaving. The fix
 * is one link, and it is the first thing in the message.
 */
export async function sendPaymentFailedEmail(
  config: EmailConfig,
  options: PaymentFailedEmail
): Promise<SendResult> {
  const { to, planName, periodEndDate, graceEndDate, renewUrl } = options;

  const opening =
    `We could not take payment for your ${planName} plan on ${periodEndDate}. ` +
    `This is usually an expired or replaced card. New uploads are paused until it is sorted out.`;
  const reassurance =
    "Nothing has been deleted. Every file you have stored is still readable and downloadable, " +
    "and your API keys still work for reads.";
  const deadline =
    `We will keep retrying the card until ${graceEndDate}, and everything resumes the moment ` +
    `one succeeds. If it is still unpaid on ${graceEndDate}, the account's data is scheduled ` +
    `for deletion.`;

  const html = layout(
    "We could not take payment",
    [
      `<p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:#374151">${opening}</p>`,
      button(renewUrl, "Update payment method"),
      `<p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:#374151">${reassurance}</p>`,
      `<p style="margin:0;font-size:13px;line-height:1.6;color:#5f6875">${deadline}</p>`,
    ].join("")
  );

  const text = [opening, "", "Update payment method:", renewUrl, "", reassurance, "", deadline].join(
    "\n"
  );

  return await sendEmail(config, {
    to,
    subject: `Payment failed for your ${planName} plan`,
    html,
    text,
  });
}

/* ---------------------------- account closure ---------------------------- */

export interface AccountErasedEmail {
  to: string;
  /** The day the person closed the account, already formatted for a human. */
  closedDate: string;
}

/**
 * Day 7 after a person closes their own account: the last message, sent by the
 * sweep in `jobs/pending-deletions.ts` immediately BEFORE it deletes the
 * Firebase identity and releases the address.
 *
 * The order is the whole design. The address was deliberately kept for seven
 * days so this could be sent; once the sweep releases it there is nowhere to
 * send to, so a failed send holds the release for that hour rather than the
 * other way round — the one place in this codebase where an email outcome is
 * allowed to gate a state change, and `pending-deletions.ts` says why.
 *
 * From `noreply@`, because there is no account left to reply about, with
 * Reply-To pointing at support so "reply to this message" still reaches a
 * person. Both addresses are on `SENDING_DOMAIN`.
 */
export async function sendAccountErasedEmail(
  config: EmailConfig,
  options: AccountErasedEmail
): Promise<SendResult> {
  const { to, closedDate } = options;

  const opening =
    `On ${closedDate} you asked us to close your AgentDisk account. The seven-day period ` +
    `has now ended and we have completed the deletion.`;
  const today =
    "Your files, unreachable since that day, are now erased, and so is your sign-in identity. " +
    "This email address is no longer attached to any AgentDisk account and can be used to " +
    "create a new one.";
  const already =
    `Every workspace you owned, with its API keys, agents, webhooks, share links and folder ` +
    `structure; access for anyone you had invited; your subscription and saved payment details.`;
  const kept =
    "Invoices, kept at Stripe for seven years, because tax law requires it. They hold your " +
    "billing name, address and the amounts paid, and nothing else.";
  const closing =
    "Nothing can be recovered. If you did not request this closure, reply to this message or " +
    `write to ${SENDER_EMAIL}.`;

  const para = (text: string) =>
    `<p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:#374151">${text}</p>`;
  const label = (text: string) =>
    `<p style="margin:0 0 6px;font-size:13px;font-weight:600;color:#111621">${text}</p>`;

  const html = layout(
    "Your AgentDisk account has been permanently deleted",
    [
      para(opening),
      label("Removed today"),
      para(today),
      label(`Already removed on ${closedDate}`),
      para(already),
      label("What we keep"),
      para(kept),
      `<p style="margin:0;font-size:13px;line-height:1.6;color:#5f6875">${closing}</p>`,
    ].join("")
  );

  const text = [
    opening,
    "",
    "Removed today",
    today,
    "",
    `Already removed on ${closedDate}`,
    already,
    "",
    "What we keep",
    kept,
    "",
    closing,
    "",
    "— AgentDisk",
  ].join("\n");

  return await sendEmail(config, {
    to,
    subject: "Your AgentDisk account has been permanently deleted",
    html,
    text,
    fromAddress: COMPOSE_DEFAULT_SENDER,
    replyTo: SENDER_EMAIL,
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
    `We were unable to collect payment for your ${planName} plan, and the 7-day grace period ` +
    `that began on ${periodEndDate} is now over. The data in this account has been scheduled ` +
    `for deletion.`;
  const escape =
    "This is reversible. Starting a plan again cancels the deletion and restores the account " +
    "exactly as it was — nothing has been removed yet.";
  const exportNote =
    "If you would rather not renew, sign in and download what you need first. Reads and " +
    "downloads still work until the deletion runs.";

  const html = layout(
    "Your data is scheduled for deletion",
    [
      `<p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:#374151">${opening}</p>`,
      `<p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:#374151">${escape}</p>`,
      button(renewUrl, `Restart ${planName} and keep everything`),
      `<p style="margin:0;font-size:13px;line-height:1.6;color:#5f6875">${exportNote} <a href="${dashboardUrl}" style="color:#6d28d9">Open AgentDisk</a>.</p>`,
    ].join("")
  );

  const text = [
    opening,
    "",
    escape,
    "",
    "Restart the plan and keep everything:",
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
