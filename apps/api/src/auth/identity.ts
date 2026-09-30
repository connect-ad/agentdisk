/**
 * Who a request is. Resolved once, by the middleware, before any handler runs.
 *
 * Two kinds, and the union is the point: adding the second one could not
 * silently produce an identity that is neither, and every consumer had to be
 * told about it by the compiler rather than by a bug.
 *
 *   api_key       an agent (or a human's personal token) - 06 PART 15.3
 *   firebase_user a signed-in human               - 16 PART 30
 *
 * Agents never touch Firebase; humans never hold an API key as a session. What
 * they share is everything after this point: the same scope check, the same
 * workspace resolution, the same quota gate, the same scoped repositories.
 */

import type { KeyMode } from "../lib/keys";
import type { KeyScope } from "./scopes";
import type { MemberRole } from "./roles";

interface IdentityBase {
  /**
   * Bound before any handler runs. This - not any client input - is where every
   * scoped query gets its workspace.
   */
  workspaceId: string;
  scope: KeyScope;
  /** How this actor is recorded in audit_events. */
  actorType: "agent" | "user";
  actorId: string;
}

export interface ApiKeyIdentity extends IdentityBase {
  kind: "api_key";
  keyId: string;
  mode: KeyMode;
  agentId: string | null;
  createdByUserId: string;
  /** Display-safe fragments of the credential. Never the hash, never the secret. */
  keyPrefix: string;
  keyLastFour: string;
  /** As stored. The middleware uses it to decide whether a refresh is worth a write. */
  lastUsedAt: number | null;
}

export interface FirebaseUserIdentity extends IdentityBase {
  kind: "firebase_user";
  actorType: "user";
  userId: string;
  firebaseUid: string;
  email: string;
  emailVerified: boolean;
  orgId: string;
  role: MemberRole;
  /** "password", "google.com", "github.com". Audit detail only. */
  signInProvider: string | null;
}

export type Identity = ApiKeyIdentity | FirebaseUserIdentity;

/** A short, non-secret description of the caller, safe to put in a log line. */
export function describeIdentity(identity: Identity): Record<string, string> {
  const common = {
    actorType: identity.actorType,
    actorId: identity.actorId,
    workspaceId: identity.workspaceId,
  };
  return identity.kind === "api_key"
    ? { ...common, credential: "api_key", keyId: identity.keyId }
    : { ...common, credential: "firebase", userId: identity.userId, role: identity.role };
}
