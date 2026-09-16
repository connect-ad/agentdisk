/**
 * POST /v1/me/logout-all - "log out everywhere", per 16 PART 30.4.
 *
 * There is no `refresh_tokens` table to revoke rows in any more, so this writes
 * `users.session_revoked_after = now`. Every ID token issued before that instant
 * is refused on its next request, wherever it is being held.
 *
 * **What this does and does not achieve, stated plainly.** Every other open
 * session is forced to quietly re-prove itself: the Firebase SDK sees the 401,
 * mints a fresh ID token from the refresh token it already holds, and carries
 * on. That is the right answer for "I left myself signed in on a shared
 * computer". It is *not* the answer for a stolen device, because the underlying
 * Firebase refresh token is untouched and can still mint new tokens. Closing
 * that case needs Firebase's Admin-SDK-only `revokeRefreshTokens`, which cannot
 * run in a Worker - a named V2 gap, not an oversight.
 *
 * Restricted to a signed-in human. An agent's API key must not be able to end
 * its creator's browser sessions: the key was issued to automate storage, and
 * quietly acquiring authority over the person who issued it is precisely the
 * escalation that keeping the two credential kinds separate exists to prevent.
 */

import { forbidden } from "../lib/errors";
import type { AuthContext } from "../middleware/auth";

export async function logoutAll(ctx: AuthContext): Promise<Response> {
  if (ctx.self === null) {
    throw forbidden("Only a signed-in user can end their own sessions.");
  }

  await ctx.self.revokeSessions();

  return new Response(
    JSON.stringify({
      revokedAfter: new Date(ctx.now).toISOString(),
      // Said out loud in the response, because a UI that promises more than
      // this is lying to the person clicking the button.
      effect: "Other sessions must obtain a new token on their next request.",
    }),
    { status: 200, headers: { "content-type": "application/json; charset=utf-8" } }
  );
}
