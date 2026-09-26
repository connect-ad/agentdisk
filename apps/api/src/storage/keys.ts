/**
 * R2 object key strategy - 05 PART 12.1.
 *
 * `tenant/{workspaceId}/{fileId}` and nothing else. The client-supplied path
 * never appears here.
 *
 * 06 PART 16.12 calls this out as one of the strongest arguments for an
 * ID-based key: because the storage location is built entirely from two
 * server-generated IDs, a path-traversal string in a client's `path` can only
 * ever affect the `path` column used for display and listing. It cannot reach
 * the place the bytes actually live. That is a structural mitigation rather
 * than input validation - the validation in lib/paths.ts is the second layer,
 * not the only one.
 *
 * The tenant prefix also makes a whole workspace's objects listable and
 * deletable as one prefix, which is what workspace deletion and the
 * reconciliation sweep (10.8) both need.
 */

const TENANT_PREFIX = "tenant";

/** Matches the IDs newId() produces: a short kind prefix plus a 26-char ULID. */
const ID_PATTERN = /^[a-z]{2,4}_[0-9A-HJKMNP-TV-Z]{26}$/;

export class ObjectKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObjectKeyError";
  }
}

/**
 * Build the R2 key for a file.
 *
 * Both IDs are validated even though both are server-generated. They are
 * generated *somewhere else*, and the cost of checking is a regex against a
 * 30-character string; the cost of not checking is that any future code path
 * which lets an ID come from elsewhere silently gains the ability to write
 * outside its tenant prefix.
 */
export function objectKey(workspaceId: string, fileId: string): string {
  if (!ID_PATTERN.test(workspaceId)) {
    throw new ObjectKeyError(`Refusing to build an object key from a malformed workspace ID.`);
  }
  if (!ID_PATTERN.test(fileId)) {
    throw new ObjectKeyError(`Refusing to build an object key from a malformed file ID.`);
  }
  return `${TENANT_PREFIX}/${workspaceId}/${fileId}`;
}

/** Every object belonging to one workspace, for deletion and reconciliation. */
export function workspacePrefix(workspaceId: string): string {
  if (!ID_PATTERN.test(workspaceId)) {
    throw new ObjectKeyError(`Refusing to build a prefix from a malformed workspace ID.`);
  }
  return `${TENANT_PREFIX}/${workspaceId}/`;
}

/**
 * Confirm a key belongs to a workspace before acting on it.
 *
 * Used on the read side: the key comes from the files row, which is already
 * workspace-scoped, so this is belt and braces. It is cheap, and it turns a
 * hypothetical repository bug into a refusal rather than a cross-tenant read.
 */
export function keyBelongsToWorkspace(key: string, workspaceId: string): boolean {
  return key.startsWith(workspacePrefix(workspaceId));
}
