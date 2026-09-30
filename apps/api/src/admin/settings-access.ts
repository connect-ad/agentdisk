/**
 * Deployment settings, from the console.
 *
 * Two actions: a test send and a composed message. It extends `AuditedAdminAccess`
 * like every other area, so the recording is inherited rather than remembered —
 * a test send is an outbound message from the product's verified sender, and an
 * unrecorded one is a message nobody can later attribute.
 *
 * ── The recipient is not a parameter, and that is the security property ─────
 * `sendTest` takes no address. It reads `this.admin.email`, which came from the
 * `admin_users` row the credential resolved to, so there is no argument through
 * which a caller could name somebody else. An endpoint that emailed an address
 * from the request body would be an open relay operating from a domain with
 * SPF and DKIM already aligned for it — the most useful kind to an abuser, and
 * reachable by anybody holding any admin credential.
 *
 * ── Both outcomes are recorded ──────────────────────────────────────────────
 * A failed send writes a `denied` row before rethrowing. The button exists to
 * surface a broken configuration; a log that held only the sends that worked
 * could not show somebody discovering, four times in a row, that it does not.
 */

import { AuditedAdminAccess } from "./audited";

export class AdminSettingsAccess extends AuditedAdminAccess {
  /**
   * Send a test message to the caller's own address, recording either outcome.
   *
   * `send` is passed in rather than performed here for the same reason
   * `forcePasswordReset` does it: this class owns the audit discipline and the
   * choice of recipient, and knows nothing about providers. Returns the address
   * it used, so the response can name it without the handler having to reach
   * for the admin row a second time.
   */
  async sendTest(send: (to: string) => Promise<void>): Promise<string> {
    await this.requireRole("admin", "send a test email");

    const to = this.admin.email;
    const record = {
      action: "settings.email.test_sent",
      targetType: "settings",
      targetId: "email",
      metadata: { to },
    } as const;

    try {
      await send(to);
    } catch (cause) {
      await this.recordFleet({ ...record, result: "denied" });
      throw cause;
    }

    await this.recordFleet({ ...record, result: "success" });
    return to;
  }

  /**
   * Send an operator-written message, recording either outcome.
   *
   * Unlike `sendTest`, the recipient IS a parameter: composing mail to a
   * customer is the point. What keeps it from being a relay is who can reach
   * it - only a signed-in console operator - and that every send, including a
   * refused one, lands in the fleet log under their name. The log keeps the
   * envelope (sender, recipients, subject, attachment names), never the body.
   */
  async sendComposed(
    envelope: { from: string; to: string[]; subject: string; attachments: string[] },
    send: () => Promise<void>
  ): Promise<void> {
    await this.requireRole("admin", "compose an email");

    const record = {
      action: "settings.email.composed",
      targetType: "settings",
      targetId: "email",
      // Flattened: fleet metadata holds scalars only.
      metadata: {
        from: envelope.from,
        to: envelope.to.join(", "),
        subject: envelope.subject,
        attachments: envelope.attachments.join(", "),
      },
    } as const;

    try {
      await send();
    } catch (cause) {
      await this.recordFleet({ ...record, result: "denied" });
      throw cause;
    }

    await this.recordFleet({ ...record, result: "success" });
  }
}
