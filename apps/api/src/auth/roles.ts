/**
 * The three human roles, and what each may do inside a workspace.
 *
 * Corrected Sept 2026 from doc 06 PART 15.2's original owner/admin/member. The
 * middle role could do everything an admin could except manage people, which at
 * the file level is no difference at all - so the role people actually wanted,
 * somebody who can see the work without changing it, did not exist. It does now.
 *
 *   owner   the billing account. Owns every workspace under it, invites, pays,
 *           and is the only role that can delete a workspace.
 *   admin   invited to one workspace. Full control of its contents, its agents
 *           and its keys. Cannot invite, cannot delete the workspace.
 *   reader  invited to one workspace. Can see it. Cannot change it.
 *
 * `reader` is the reason `scopeForRole` is not a constant: a read-only human is
 * expressed in exactly the same `{ ops, pathPrefix }` shape as a read-only
 * agent key, so it runs through the same check rather than a parallel one that
 * could drift from it.
 */

import { forbidden } from "../lib/errors";
import type { KeyScope, ScopeOp } from "./scopes";

/**
 * Two roles, not three. "admin" was the middle one and is gone, because the
 * word now means an operator of the internal console and nothing else - a
 * customer's workspace admin and a console admin sharing a name is exactly the
 * confusion this rename existed to remove.
 *
 * The consequence, stated plainly: **no invitable role can write.** Somebody
 * invited into a workspace reads it. Writing belongs to the owner and to the
 * API keys they mint, which is where agent writes came from anyway.
 */
export const MEMBER_ROLES = ["owner", "reader"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export function isMemberRole(value: string): value is MemberRole {
  return (MEMBER_ROLES as readonly string[]).includes(value);
}

/**
 * `share` is here because a dashboard owner acts through a role, not a key.
 *
 * This array is hardcoded rather than derived from SCOPE_OPS, which means
 * adding an op to SCOPE_OPS silently leaves roles without it. That fails in
 * the safe direction - nobody gains a capability by accident - but it is why
 * this line has to be edited by hand every time, and why the test asserts it.
 */
export const FULL_OPS: ScopeOp[] = ["read", "write", "delete", "list", "keys:create", "share"];
export const READ_ONLY_OPS: ScopeOp[] = ["read", "list"];

/**
 * Path-prefix narrowing stays empty for every role. It exists for *agent* keys,
 * whose purpose is least privilege for an automated caller; a person who can
 * open the dashboard can already see every file listed in it, so pretending
 * otherwise at the API would be theatre.
 */
export function scopeForRole(role: MemberRole): KeyScope {
  return { ops: role === "reader" ? [...READ_ONLY_OPS] : [...FULL_OPS], pathPrefix: "" };
}

/** Manage people and settings. Owner only - an admin manages contents, not access. */
export function assertCanInvite(role: MemberRole): void {
  if (role !== "owner") {
    throw forbidden("Only the workspace owner can invite or remove people.");
  }
}

/** Agents, keys, and workspace settings short of deletion. */
export function assertCanAdminister(role: MemberRole): void {
  if (role === "reader") {
    throw forbidden("This action needs the admin or owner role.");
  }
}

/** Billing, workspace deletion. Owner only. */
export function assertCanOwn(role: MemberRole): void {
  if (role !== "owner") {
    throw forbidden("This action needs the owner role.");
  }
}
