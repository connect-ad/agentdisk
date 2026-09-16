/**
 * Capability scopes for API keys - 06 PART 15.2.
 *
 * Stored as the JSON blob in api_keys.scopes:
 *   { "ops": ["read", "write"], "pathPrefix": "/agents/research-bot/*" }
 *
 * Two things this file is careful about:
 *
 *  - **It fails closed.** A scopes blob that does not parse, or that carries an
 *    op we do not recognise, grants nothing. The tempting alternative - ignore
 *    what you don't understand and honour the rest - turns a corrupt row into a
 *    silent privilege grant.
 *  - **Prefix matching respects segment boundaries.** "/agents/bot" must not
 *    authorize "/agents/bot-evil/secrets.txt". Plain startsWith says it does;
 *    that is the whole bug class, so matching is on whole segments only.
 */

import { ApiError, forbidden } from "../lib/errors";
import { normalizePath } from "../lib/paths";

export const SCOPE_OPS = ["read", "write", "delete", "list", "keys:create"] as const;
export type ScopeOp = (typeof SCOPE_OPS)[number];

export interface KeyScope {
  ops: ScopeOp[];
  /** Always normalized: no trailing "*", no trailing "/", "" means the whole workspace. */
  pathPrefix: string;
}

/** Thrown when a stored scopes blob is unusable. Callers turn this into a 401, not a 403. */
export class ScopeParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeParseError";
  }
}

function isScopeOp(value: unknown): value is ScopeOp {
  return typeof value === "string" && (SCOPE_OPS as readonly string[]).includes(value);
}

/**
 * Reduce a stored prefix to its comparable form.
 *
 * "/a/b/*" and "/a/b/" and "/a/b" all mean the same subtree, so they all
 * normalize to "/a/b". "/" and "/*" and "" all mean the whole workspace and
 * normalize to "".
 */
export function normalizePrefix(raw: string): string {
  let prefix = raw.normalize("NFC").trim();
  if (prefix.endsWith("*")) prefix = prefix.slice(0, -1);
  while (prefix.endsWith("/")) prefix = prefix.slice(0, -1);
  if (prefix === "") return "";
  if (!prefix.startsWith("/")) {
    throw new ScopeParseError("pathPrefix must start with /");
  }
  return prefix;
}

export function parseScopes(json: string): KeyScope {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new ScopeParseError("scopes is not valid JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ScopeParseError("scopes must be a JSON object");
  }

  const candidate = raw as { ops?: unknown; pathPrefix?: unknown };

  if (!Array.isArray(candidate.ops)) {
    throw new ScopeParseError("scopes.ops must be an array");
  }
  for (const op of candidate.ops) {
    if (!isScopeOp(op)) {
      throw new ScopeParseError("scopes.ops contains an unknown op");
    }
  }

  const pathPrefix = candidate.pathPrefix === undefined ? "" : candidate.pathPrefix;
  if (typeof pathPrefix !== "string") {
    throw new ScopeParseError("scopes.pathPrefix must be a string");
  }

  return {
    ops: [...new Set(candidate.ops as ScopeOp[])],
    pathPrefix: normalizePrefix(pathPrefix),
  };
}

export function serializeScopes(scope: KeyScope): string {
  return JSON.stringify({
    ops: scope.ops,
    pathPrefix: scope.pathPrefix === "" ? "/*" : `${scope.pathPrefix}/*`,
  });
}

export function scopeAllowsOp(scope: KeyScope, op: ScopeOp): boolean {
  return scope.ops.includes(op);
}

/**
 * Does this scope cover this path?
 *
 * `path` must already have been through normalizePath - this function assumes
 * ".." is gone and the string is NFC. It does not re-validate, because a caller
 * that skipped normalization has a bug that should surface there, not be
 * papered over here.
 */
export function scopeAllowsPath(scope: KeyScope, path: string): boolean {
  if (scope.pathPrefix === "") return true;
  if (path === scope.pathPrefix) return true;
  return path.startsWith(`${scope.pathPrefix}/`);
}

/** Throws FORBIDDEN if the scope does not cover this operation, and path if given. */
export function assertScope(scope: KeyScope, op: ScopeOp, path?: string): void {
  if (!scopeAllowsOp(scope, op)) {
    throw forbidden("This key isn't allowed to perform that operation.", {
      requiredOp: op,
      grantedOps: scope.ops,
    });
  }
  if (path !== undefined && !scopeAllowsPath(scope, path)) {
    throw forbidden("This key isn't allowed to access that path.", {
      pathPrefix: scope.pathPrefix === "" ? "/*" : `${scope.pathPrefix}/*`,
    });
  }
}

/**
 * Can `parent` mint `child`? Used at sub-key creation time (15.2: a sub-key can
 * never exceed its parent's scope).
 *
 * The path test reuses scopeAllowsPath with the child's *prefix* as the path,
 * which gives the right answer in both directions: parent "/a" may mint "/a/b",
 * parent "/a/b" may not mint "/a".
 */
export function isSubsetScope(child: KeyScope, parent: KeyScope): boolean {
  if (!child.ops.every((op) => parent.ops.includes(op))) return false;
  if (parent.pathPrefix === "") return true;
  if (child.pathPrefix === "") return false;
  return scopeAllowsPath(parent, child.pathPrefix);
}

/**
 * Normalize a client-supplied path and check it against the scope in one step,
 * so no caller can accidentally do the check against a raw string.
 */
export function assertScopedPath(scope: KeyScope, op: ScopeOp, rawPath: string): string {
  let normalized: string;
  try {
    normalized = normalizePath(rawPath);
  } catch (err) {
    throw new ApiError("VALIDATION_ERROR", err instanceof Error ? err.message : "Invalid path.");
  }
  assertScope(scope, op, normalized);
  return normalized;
}
