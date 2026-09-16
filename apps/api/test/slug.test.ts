/**
 * Workspace URL slugs.
 *
 * Two properties carry the whole design and are asserted first, because
 * everything else in the dashboard's routing is built on them: a slug can never
 * be mistaken for a `ws_...` ID, and a slug is unique within one billing
 * account. The rest is ordinary shaping.
 */

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { FALLBACK_SLUG, isSlugConflict, slugify, uniqueWorkspaceSlug } from "../src/lib/slug";

const NOW = 1_780_000_000_000;
const ORG = "org_SLUGTEST";
const OTHER_ORG = "org_SLUGOTHER";

async function seedOrg(id: string): Promise<void> {
  const ownerId = `usr_SLUG_${id}`;
  await env.DB.prepare(
    `INSERT OR REPLACE INTO users (id, email, is_provisional, session_revoked_after,
                                   created_at, updated_at)
     VALUES (?, ?, 1, 0, ?, ?)`
  )
    .bind(ownerId, `${id}@slug.invalid`, NOW, NOW)
    .run();
  await env.DB.prepare(
    `INSERT OR REPLACE INTO organizations (id, name, owner_user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(id, id, ownerId, NOW, NOW)
    .run();
}

let counter = 0;

async function seedWorkspace(orgId: string, name: string, slug: string): Promise<string> {
  const id = `ws_SLUG${(counter += 1).toString().padStart(6, "0")}`;
  await env.DB.prepare(
    `INSERT INTO workspaces (id, org_id, name, slug, status, period_reset_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`
  )
    .bind(id, orgId, name, slug, NOW + 1000, NOW, NOW)
    .run();
  return id;
}

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM workspaces WHERE id LIKE 'ws_SLUG%'`).run();
  await seedOrg(ORG);
  await seedOrg(OTHER_ORG);
});

describe("slugify", () => {
  it("lowercases and joins words with a single dash", () => {
    expect(slugify("My Workspace")).toBe("my-workspace");
    expect(slugify("Abc")).toBe("abc");
    expect(slugify("after-new")).toBe("after-new");
  });

  it("collapses runs of separators and trims the ends", () => {
    expect(slugify("  Client   A  ")).toBe("client-a");
    expect(slugify("--Edge--Case--")).toBe("edge-case");
    expect(slugify("Marketing / Q3 (draft)")).toBe("marketing-q3-draft");
  });

  it("strips diacritics rather than dropping the letter", () => {
    expect(slugify("Café Ops")).toBe("cafe-ops");
    expect(slugify("Zürich")).toBe("zurich");
  });

  /**
   * The invariant the dashboard's routing depends on. IDs are `ws_` plus
   * Crockford base32; a slug can hold neither an underscore nor an uppercase
   * letter, so a URL segment beginning `ws_` is always an ID and never a slug -
   * even for a workspace whose owner deliberately named it after one.
   */
  it("can never produce something shaped like a workspace ID", () => {
    expect(slugify("ws_01K4M9XQ2R8T7VBNJH3ZC5D6EF")).toBe("ws-01k4m9xq2r8t7vbnjh3zc5d6ef");
    expect(slugify("ws_ABC")).not.toContain("_");
  });

  it("returns empty when nothing survives, rather than a stray dash", () => {
    expect(slugify("!!!")).toBe("");
    expect(slugify("   ")).toBe("");
    expect(slugify("日本語")).toBe("");
  });

  it("caps the length without leaving a trailing dash", () => {
    const slug = slugify(`${"a".repeat(47)} bbbb`);
    expect(slug.length).toBeLessThanOrEqual(48);
    expect(slug.endsWith("-")).toBe(false);
  });
});

describe("uniqueWorkspaceSlug", () => {
  it("uses the plain slug when nothing holds it", async () => {
    expect(await uniqueWorkspaceSlug(env.DB, ORG, "My Workspace")).toBe("my-workspace");
  });

  it("suffixes on collision within the same account", async () => {
    await seedWorkspace(ORG, "My Workspace", "my-workspace");
    expect(await uniqueWorkspaceSlug(env.DB, ORG, "My Workspace")).toBe("my-workspace-2");

    await seedWorkspace(ORG, "My Workspace", "my-workspace-2");
    expect(await uniqueWorkspaceSlug(env.DB, ORG, "My Workspace")).toBe("my-workspace-3");
  });

  /**
   * The suffix comes from what is taken, not from a count - otherwise deleting
   * `-2` and creating another would hand out a slug that already exists.
   */
  it("reuses a freed suffix instead of counting", async () => {
    await seedWorkspace(ORG, "Client", "client");
    await seedWorkspace(ORG, "Client", "client-3");
    expect(await uniqueWorkspaceSlug(env.DB, ORG, "Client")).toBe("client-2");
  });

  it("does not collide across billing accounts", async () => {
    await seedWorkspace(OTHER_ORG, "My Workspace", "my-workspace");
    expect(await uniqueWorkspaceSlug(env.DB, ORG, "My Workspace")).toBe("my-workspace");
  });

  it("falls back to a readable name when the name slugifies to nothing", async () => {
    expect(await uniqueWorkspaceSlug(env.DB, ORG, "!!!")).toBe(FALLBACK_SLUG);
    await seedWorkspace(ORG, "!!!", FALLBACK_SLUG);
    expect(await uniqueWorkspaceSlug(env.DB, ORG, "???")).toBe(`${FALLBACK_SLUG}-2`);
  });

  /**
   * A prefix match must not be mistaken for a collision: `client-side` does not
   * make `client` unavailable, and the LIKE that finds suffixed slugs must not
   * treat a dash-containing neighbour as one of them.
   */
  it("is not confused by a longer slug that starts the same way", async () => {
    await seedWorkspace(ORG, "Client Side", "client-side");
    expect(await uniqueWorkspaceSlug(env.DB, ORG, "Client")).toBe("client");
  });
});

describe("the uniqueness index", () => {
  it("refuses a duplicate slug in one account, and says so recognisably", async () => {
    await seedWorkspace(ORG, "Dupe", "dupe");
    let caught: unknown = null;
    try {
      await seedWorkspace(ORG, "Dupe", "dupe");
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    // The create route retries on exactly this, so misidentifying it would turn
    // a recoverable race into a 500.
    expect(isSlugConflict(caught)).toBe(true);
  });

  it("allows the same slug in two different accounts", async () => {
    await seedWorkspace(ORG, "Shared", "shared");
    await expect(seedWorkspace(OTHER_ORG, "Shared", "shared")).resolves.toBeDefined();
  });
});

describe("the 0009 backfill", () => {
  /**
   * Rows that predate the column were given their own ID as a slug and then
   * upgraded where the name allowed it. Both halves matter: `helpers.ts` seeds
   * its workspaces through the same migrated schema, so a NULL here would mean
   * the column was added without the backfill running.
   */
  it("left no workspace without a slug", async () => {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM workspaces WHERE slug IS NULL`
    ).first<{ n: number }>();
    expect(row?.n).toBe(0);
  });
});
