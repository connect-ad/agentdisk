/**
 * Workspace URL slugs.
 *
 * A slug exists for one reason: `/w/ws_01K4M9XQ2R8T7VBNJH3ZC5D6EF/files` is an
 * address a person cannot read, retype, or recognise in a browser history. It
 * is **not** a new identifier and grants nothing - every API call, MCP config
 * snippet and the Settings → Workspace ID field still carry the real `ws_...`,
 * and the dashboard resolves a slug back to one before it does anything.
 *
 * Two properties make that resolution unambiguous, and both are load-bearing:
 *
 *  - **A slug can never look like an ID.** IDs are `ws_` + Crockford base32;
 *    `slugify` lowercases and turns every non-alphanumeric into `-`, so no slug
 *    can contain an underscore. A workspace literally named "ws_ABC" slugs to
 *    `ws-abc`. The dashboard can therefore tell which kind of thing a URL
 *    segment is by looking at it, with no lookup and no ambiguity.
 *  - **A slug never changes.** It is derived from the name once, at creation,
 *    and renaming leaves it alone - because the UI has always promised that
 *    "renaming never changes URLs or API paths", and a slug that tracked the
 *    name would quietly break every bookmark on a rename.
 *
 * Uniqueness is per organization, not global: two different accounts may both
 * have `my-workspace`, and a slug is only ever resolved against the workspaces
 * the caller can already reach. `idx_workspaces_org_slug` enforces it.
 */

/**
 * Long enough for a real name, short enough to stay readable in a URL bar. A
 * name is capped at 60 characters, so this only bites on names that are mostly
 * separators.
 */
const MAX_LENGTH = 48;

/**
 * Used when a name contains nothing a slug can be built from - a name that is
 * entirely punctuation, or entirely in a script that transliterates to nothing.
 * Deduplication then makes it `workspace-2`, `workspace-3`, and so on, so this
 * is a readable fallback rather than a collision.
 */
export const FALLBACK_SLUG = "workspace";

/**
 * A name reduced to a URL path segment: lowercase ASCII alphanumerics and
 * single dashes, no leading or trailing dash.
 *
 * Returns `""` when nothing survives. Callers must not use that as a slug -
 * `uniqueWorkspaceSlug` substitutes `FALLBACK_SLUG`.
 */
export function slugify(name: string): string {
  return (
    name
      // Decompose accented characters into letter + combining mark, then drop
      // the marks, so "Café Ops" becomes "cafe-ops" rather than "caf-ops".
      .normalize("NFKD")
      // \p{M} is every combining mark, which is exactly what NFKD produced.
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, MAX_LENGTH)
      // The slice can land mid-separator and leave a trailing dash behind.
      .replace(/-+$/, "")
  );
}

interface SlugRow {
  slug: string | null;
}

/**
 * A slug for `name` that no other workspace in `orgId` is using.
 *
 * Collisions get a numeric suffix (`my-workspace`, `my-workspace-2`), matching
 * what people expect from every other product that does this. The suffix is
 * chosen from the slugs already taken rather than from a count, so deleting
 * `my-workspace-2` and creating another does not produce a duplicate.
 *
 * This is advisory, not the guarantee: `idx_workspaces_org_slug` is. Two
 * simultaneous creates can both read the same free slug, and the loser gets a
 * UNIQUE violation its caller retries - which is the correct place for that to
 * be resolved, because only the database can actually settle a race.
 */
export async function uniqueWorkspaceSlug(
  db: D1Database,
  orgId: string,
  name: string
): Promise<string> {
  const base = slugify(name) || FALLBACK_SLUG;

  // `base` is `[a-z0-9-]+` by construction, so neither LIKE wildcard (`%`, `_`)
  // can appear in it and no escaping is needed.
  const rows = await db
    .prepare(`SELECT slug FROM workspaces WHERE org_id = ? AND (slug = ? OR slug LIKE ?)`)
    .bind(orgId, base, `${base}-%`)
    .all<SlugRow>();

  const taken = new Set(rows.results.map(row => row.slug).filter(slug => slug !== null));
  if (!taken.has(base)) return base;

  // Bounded by the number of slugs actually in the way, so this terminates even
  // if the set is somehow not what we think it is.
  for (let n = 2; n <= taken.size + 2; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }

  // Unreachable: the loop tries more candidates than there are taken slugs.
  return `${base}-${taken.size + 3}`;
}

/** True when a failed write was the slug uniqueness index, not something else. */
export function isSlugConflict(err: unknown): boolean {
  const message = String(err);
  return message.includes("UNIQUE") && message.includes("slug");
}
