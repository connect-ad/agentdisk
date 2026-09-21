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

import { ApiError } from "../lib/errors";
import { SENDER_EMAIL, sendTestEmail } from "../lib/email";
import { json, requireAdmin, type AdminDeps } from "./admin";
import { area } from "./admin-console";
import { AdminSettingsAccess } from "../admin/settings-access";

/** Named on screen so an operator reading a bounce knows whose dashboard to open. */
const PROVIDER = "Mailjet";

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
        internalReason: "MAILJET_API_KEY / MAILJET_SECRET_KEY are not both set",
      });
    }
    await sendTestEmail(deps.email, { to });
  });

  return json({ sentTo, provider: PROVIDER, sender: SENDER_EMAIL });
}
