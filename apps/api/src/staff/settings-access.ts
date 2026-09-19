/**
 * Deployment settings, from the console.
 *
 * One action today: sending a test message. It extends `AuditedStaffAccess`
 * like every other area, so the recording is inherited rather than remembered —
 * a test send is an outbound message from the product's verified sender, and an
 * unrecorded one is a message nobody can later attribute.
 *
 * ── The recipient is not a parameter, and that is the security property ─────
 * `sendTest` takes no address. It reads `this.staff.email`, which came from the
 * `staff_users` row the credential resolved to, so there is no argument through
 * which a caller could name somebody else. An endpoint that emailed an address
 * from the request body would be an open relay operating from a domain with
 * SPF and DKIM already aligned for it — the most useful kind to an abuser, and
 * reachable by anybody holding any staff credential.
 *
 * ── Both outcomes are recorded ──────────────────────────────────────────────
 * A failed send writes a `denied` row before rethrowing. The button exists to
 * surface a broken configuration; a log that held only the sends that worked
 * could not show somebody discovering, four times in a row, that it does not.
 */

import { AuditedStaffAccess } from "./audited";

export class StaffSettingsAccess extends AuditedStaffAccess {
  /**
   * Send a test message to the caller's own address, recording either outcome.
   *
   * `send` is passed in rather than performed here for the same reason
   * `forcePasswordReset` does it: this class owns the audit discipline and the
   * choice of recipient, and knows nothing about providers. Returns the address
   * it used, so the response can name it without the handler having to reach
   * for the staff row a second time.
   */
  async sendTest(send: (to: string) => Promise<void>): Promise<string> {
    await this.requireRole("super_admin", "send a test email");

    const to = this.staff.email;
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
}
