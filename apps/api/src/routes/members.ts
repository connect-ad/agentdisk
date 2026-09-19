/**
 * Workspace members — 05 PART 13, 03 §8.22.
 *
 * Only the account owner may invite, promote, or remove. An admin runs the
 * workspace's *contents* — agents, keys, files; the owner runs its *access*.
 * That split is what stops an invited admin from quietly adding themselves a
 * second account or removing the person paying the bill.
 *
 * Invitations require the person to already have an AgentDisk account, which is
 * a product decision rather than a limitation: it means every membership row
 * points at a real, Firebase-verified identity, and there is no pending-invite
 * state that can be claimed by whoever reaches the mailbox first.
 */

import { z } from "zod";
import { ApiError, validationError } from "../lib/errors";
import { assertCanInvite, isMemberRole, MEMBER_ROLES } from "../auth/roles";
import type { MemberRecord } from "../db/members";
import type { AuthContext } from "../middleware/auth";
import { audit } from "../lib/audit";

/** The owner's own row is not grantable — it comes with paying for the account. */
const INVITABLE_ROLES = ["admin", "reader"] as const;

const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email("That is not a valid email address."),
  role: z.enum(INVITABLE_ROLES),
});

const roleSchema = z.object({ role: z.enum(INVITABLE_ROLES) });

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function toResource(row: MemberRecord, callerUserId: string | null) {
  return {
    id: row.membershipId,
    userId: row.userId,
    email: row.email,
    role: row.role,
    /** True for the account owner, whose access covers every workspace. */
    accountOwner: row.workspaceId === null,
    isYou: row.userId === callerUserId,
    joinedAt: new Date(row.createdAt).toISOString(),
  };
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

/** Members is a human surface; an agent key has no business reading the roster. */
function requireHuman(ctx: AuthContext): { userId: string; role: string } {
  if (ctx.identity.kind !== "firebase_user") {
    throw new ApiError("FORBIDDEN", "Only a signed-in user can manage members.");
  }
  return { userId: ctx.identity.userId, role: ctx.identity.role };
}

export async function listWorkspaceMembers(ctx: AuthContext): Promise<Response> {
  const caller = requireHuman(ctx);
  const members = await ctx.members.list();
  return json({ members: members.map(row => toResource(row, caller.userId)) });
}

export async function inviteMember(ctx: AuthContext, request: Request): Promise<Response> {
  const caller = requireHuman(ctx);
  if (!isMemberRole(caller.role)) throw new ApiError("FORBIDDEN", "Unknown role.");
  assertCanInvite(caller.role);

  const body = await parse(request, inviteSchema);

  const user = await ctx.members.findUserByEmail(body.email);
  if (user !== null && user.firebase_uid !== null && user.emailVerifiedAt === null) {
    // The check that the provisioning path deliberately does not make. Anyone
    // can type an address into a signup form; letting an account that has never
    // proved it owns one *receive an invitation* addressed to it would hand a
    // squatter access somebody meant for their colleague.
    throw new ApiError(
      "CONFLICT",
      `${body.email} has an account but has not verified that address yet. ` +
        "Ask them to click the link in their verification email, then invite them."
    );
  }
  if (user === null || user.firebase_uid === null) {
    // Named plainly rather than hidden. This is not account enumeration in any
    // meaningful sense - the person inviting already believes their colleague
    // works with them - and staying vague would leave an owner staring at a
    // form that silently does nothing.
    throw new ApiError(
      "NOT_FOUND",
      `No AgentDisk account for ${body.email}. Ask them to sign up first, then invite them.`
    );
  }

  const existing = await ctx.members.list();
  const already = existing.find(m => m.userId === user.id);
  if (already) {
    throw new ApiError(
      "CONFLICT",
      already.workspaceId === null
        ? "That person owns this account and already has access to every workspace."
        : "That person is already a member of this workspace."
    );
  }

  const added = await ctx.members.add(user.id, body.role, ctx.now);
  if (added === null) throw new ApiError("NOT_FOUND", "No such workspace.");

  audit(ctx, request, "member.added", {
    resourceType: "membership",
    resourceId: added.membershipId,
    metadata: { email: added.email, role: added.role },
  });
  return json({ member: toResource(added, caller.userId) }, 201);
}

export async function changeMemberRole(
  ctx: AuthContext,
  request: Request,
  membershipId: string
): Promise<Response> {
  const caller = requireHuman(ctx);
  if (!isMemberRole(caller.role)) throw new ApiError("FORBIDDEN", "Unknown role.");
  assertCanInvite(caller.role);

  const body = await parse(request, roleSchema);

  const member = await ctx.members.find(membershipId);
  if (member === null) throw new ApiError("NOT_FOUND", "No such member.");
  if (member.workspaceId === null) {
    throw new ApiError(
      "FORBIDDEN",
      "The account owner's access cannot be changed from a workspace."
    );
  }

  await ctx.members.setRole(membershipId, body.role);
  const updated = await ctx.members.find(membershipId);
  audit(ctx, request, "member.role_changed", {
    resourceType: "membership",
    resourceId: membershipId,
    metadata: { email: member.email, from: member.role, to: body.role },
  });
  return json({ member: toResource(updated ?? member, caller.userId) });
}

/**
 * Remove somebody, optionally taking their keys with them.
 *
 * `?revokeKeys=true` is what 03 §8.22 designs as a checkbox defaulted to on.
 * The default lives in the UI rather than here on purpose: an API that revoked
 * by default would surprise a script written against the plain endpoint, and
 * one that never revoked would let a departing person's credential outlive
 * their access. Making the caller say which they mean is the only version with
 * no surprising case.
 */
export async function removeWorkspaceMember(
  ctx: AuthContext,
  request: Request,
  membershipId: string
): Promise<Response> {
  const caller = requireHuman(ctx);
  if (!isMemberRole(caller.role)) throw new ApiError("FORBIDDEN", "Unknown role.");
  assertCanInvite(caller.role);

  const member = await ctx.members.find(membershipId);
  if (member === null) throw new ApiError("NOT_FOUND", "No such member.");
  if (member.workspaceId === null) {
    throw new ApiError(
      "FORBIDDEN",
      "The account owner cannot be removed from their own workspace."
    );
  }

  const revokeKeys = new URL(request.url).searchParams.get("revokeKeys") === "true";
  // Revoke before removing. Afterwards the membership row is gone and, with it,
  // any chance to answer "whose keys were those" if the request fails halfway.
  const keysRevoked = revokeKeys
    ? await ctx.members.revokeKeysCreatedBy(member.userId, ctx.now)
    : 0;

  await ctx.members.remove(membershipId);

  audit(ctx, request, "member.removed", {
    resourceType: "membership",
    resourceId: membershipId,
    metadata: { email: member.email, role: member.role, keysRevoked },
  });
  return json({ removed: true, keysRevoked });
}

export { MEMBER_ROLES };
