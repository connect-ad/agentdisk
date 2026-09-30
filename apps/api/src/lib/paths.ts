/**
 * Path normalization and validation (06 PART 16.12).
 *
 * A client-supplied path can only ever reach the `path` column used for display
 * and listing - never the R2 object key, which is the server-generated
 * `tenant/{workspaceId}/{fileId}` (05 PART 12.1). That is a structural
 * mitigation. This validation is the second layer, not the only one.
 *
 * `..` is REJECTED, never resolved-and-collapsed. Collapsing is the classic bug
 * class: it turns a hostile path into a plausible one and hides the intent.
 */

export const MAX_PATH_LENGTH = 1024;
export const MAX_PATH_DEPTH = 32;
export const MAX_SEGMENT_LENGTH = 255;

export class PathValidationError extends Error {
  readonly code = "VALIDATION_ERROR";
  constructor(message: string) {
    super(message);
    this.name = "PathValidationError";
  }
}

/**
 * Normalize and validate an absolute path. Returns the canonical form.
 * Throws PathValidationError on anything suspicious.
 */
export function normalizePath(input: string): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new PathValidationError("Path is required.");
  }
  if (input.length > MAX_PATH_LENGTH) {
    throw new PathValidationError(`Path exceeds ${MAX_PATH_LENGTH} characters.`);
  }

  // Normalize Unicode first: without this, two visually identical paths can be
  // distinct byte sequences, which defeats the UNIQUE(workspace_id, path)
  // constraint and allows two "different" files to occupy one visible name.
  const normalized = input.normalize("NFC");

  if (normalized.includes("\0")) {
    throw new PathValidationError("Path may not contain a null byte.");
  }
  if (!normalized.startsWith("/")) {
    throw new PathValidationError("Path must start with '/'.");
  }
  if (normalized.includes("\\")) {
    throw new PathValidationError("Path may not contain a backslash.");
  }

  const segments = normalized.split("/").slice(1);
  const cleaned: string[] = [];

  for (const segment of segments) {
    if (segment === "") continue; // collapses '//' and a trailing '/'
    if (segment === ".") {
      throw new PathValidationError("Path may not contain a '.' segment.");
    }
    if (segment === "..") {
      throw new PathValidationError("Path may not contain a '..' segment.");
    }
    if (segment.length > MAX_SEGMENT_LENGTH) {
      throw new PathValidationError(`Path segment exceeds ${MAX_SEGMENT_LENGTH} characters.`);
    }
    // Control characters have no legitimate use in a name and are a display
    // spoofing vector (e.g. right-to-left override to disguise an extension).
    // oxlint-disable-next-line no-control-regex -- matching control chars is the point
    if (/[\u0000-\u001f\u007f]/.test(segment)) {
      throw new PathValidationError("Path may not contain control characters.");
    }
    cleaned.push(segment);
  }

  if (cleaned.length > MAX_PATH_DEPTH) {
    throw new PathValidationError(`Path exceeds ${MAX_PATH_DEPTH} levels deep.`);
  }

  return "/" + cleaned.join("/");
}

/** The final segment of a validated path. */
export function basename(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? "";
}

/** The parent directory of a validated path; '/' for a top-level entry. */
export function dirname(path: string): string {
  const segments = path.split("/").filter(Boolean);
  segments.pop();
  return segments.length === 0 ? "/" : "/" + segments.join("/");
}

/**
 * Escape a string for safe use inside a SQL LIKE pattern.
 *
 * Without this, a path containing '%' or '_' would silently widen a prefix
 * query - a listing for '/a_b' would also match '/axb'. Not a tenant-isolation
 * hole (workspace_id is still bound), but a correctness and information-leak
 * bug within a workspace.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
