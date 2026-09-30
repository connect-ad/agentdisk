# Share links, 7-day retention, and self-serve account deletion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a member publish a file or folder behind an expiring, revocable public link that the free plan cannot create; shorten the deletion grace period to 7 days; and give customers a self-serve account-deletion flow that tells them exactly what it destroys.

**Architecture:** A `share_links` row holds a token, a target (a file id or a folder path) and an expiry. A public Worker route resolves the token and 302s to a freshly minted 1-hour presigned R2 URL, so revocation is a row delete rather than something the signature has to encode. Entitlement rides on `PlanLimits.shareLinks`, which mirrors into the D1 `plans` table. Account deletion reuses the staff deletion path already in `staff/users-access.ts`.

**Tech Stack:** Cloudflare Workers, D1 (SQLite), R2, TypeScript, zod, vitest with `@cloudflare/vitest-pool-workers`, React + Vite for the dashboard.

**Spec:** [`docs/superpowers/specs/2026-09-20-share-links-and-account-deletion-design.md`](../specs/2026-09-20-share-links-and-account-deletion-design.md) — read it before Task 1. It carries the reasoning for every decision below, including the two that deliberately break existing patterns.

## Global Constraints

- **Tests run from the app directory**: `cd apps/api && npm test`. Typecheck is `npm run build` (it is `tsc --noEmit`). The dashboard is `cd apps/web && npm test`.
- **Never edit `design-system/`.** It is a byte-verified mirror of the Claude Design project.
- **Never edit `apps/web/src/components/index.js`** by hand — it is generated from `_ds_manifest.json`.
- **No raw hex, no hardcoded px** in any CSS or JSX. Style with `var(--*)` tokens only. Nothing enforces this; `Skill/1 Build.md` carries the greps that approximate it.
- **Colour never carries meaning alone** — every status pairs a tone with a word.
- **Every authentication failure returns one identical body.** The reason goes to `internalReason`, which is logged and never serialized.
- **Presigned URLs are never logged in full.** Use `redactPresigned` from `src/storage/presign.ts`.
- **Scope prefixes match whole segments.** `/agents/bot` must not authorize `/agents/bot-evil/secrets.txt`.
- **Migrations are append-only.** The next number is `0016`.
- Commit after every task. Never amend. The branch is `dev`.
- Attribution line for every commit: `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`

---

## File Structure

**Phase 1 — share links**

| File | Responsibility |
|---|---|
| `apps/api/migrations/0016_share_links.sql` | Create the table; add `share_links` to the `plans` catalogue |
| `apps/api/src/lib/shares.ts` | Pure helpers: TTL constants, expiry parsing, folder containment |
| `apps/api/src/db/shares.ts` | All SQL for `share_links`, workspace-bound |
| `apps/api/src/routes/shares.ts` | The three authenticated handlers |
| `apps/api/src/routes/shares-public.ts` | The two no-credential handlers, deliberately in their own file |
| `apps/api/test/shares.test.ts` | Phase 1's tests |
| `apps/web/src/components-local/ShareModal.jsx` | Create/copy/revoke dialog |
| `apps/web/src/routes/SharePage.jsx` | The public `/s/:token` page |

The public handlers live in a **separate file** from the authenticated ones so that "this file is reachable without a credential" is visible at the top of a file rather than buried among routes that are not.

**Phase 2 — retention:** `apps/api/src/jobs/staff-purge.ts`, `apps/web/src/routes/Legal.jsx`, `apps/admin/src/screens/Users.jsx`.

**Phase 3 — account deletion:** `apps/api/src/routes/account.ts`, `apps/web/src/routes/Settings.jsx`.

---

# PHASE 1 — Public share links

### Task 1: The schema

**Files:**
- Create: `apps/api/migrations/0016_share_links.sql`
- Modify: `apps/api/src/lib/ids.ts:63-84` (the `ID_PREFIX` map)
- Modify: `apps/api/test/helpers.ts:36-41` (`resetTenantData`)

**Interfaces:**
- Consumes: nothing.
- Produces: the `share_links` table; `ID_PREFIX.shareLink = "shr"`, so `newId("shareLink")` returns `shr_<ulid>`.

- [ ] **Step 1: Write the migration**

Create `apps/api/migrations/0016_share_links.sql`:

```sql
-- Public share links — 05 PART 12.4, designed 20 Sept 2026.
--
-- Two departures from the rest of this schema, both deliberate and both
-- explained in the design spec:
--
--  1. ON DELETE CASCADE, the first in these migrations. Every other cascade
--     here is hand-written because `folders.parent_folder_id` is self-
--     referencing and `files` is referenced from several places, so ordering
--     genuinely matters. `share_links` is a leaf — nothing references it — so
--     the database can do the work, and "must remember to delete this in
--     workspace-cascade.ts and purge.ts" becomes "cannot forget".
--
--  2. `token` is stored in cleartext, where api_keys.key_hash and
--     workspaces.claim_token_hash are hash-only. A share token grants read
--     access to bytes the owner has already chosen to publish — not "own this
--     workspace". It is revocable and dies within 7 days, and a link you
--     cannot copy twice is not a share feature. The consequence, stated
--     plainly: a dump of this table contains live share URLs.
--
-- There is no `revoked_at`. Revoking deletes the row, so a revoked token and a
-- token that never existed are the same absence, and no missed check can serve
-- bytes from a row that should be dead.

CREATE TABLE share_links (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('file','folder')),
  file_id       TEXT REFERENCES files(id) ON DELETE CASCADE,
  folder_path   TEXT,
  token         TEXT NOT NULL,
  token_hash    TEXT NOT NULL,
  expires_at    INTEGER NOT NULL,
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  CHECK ((kind = 'file'   AND file_id IS NOT NULL AND folder_path IS NULL)
      OR (kind = 'folder' AND folder_path IS NOT NULL AND file_id IS NULL))
);

CREATE UNIQUE INDEX idx_share_links_token ON share_links(token_hash);
CREATE INDEX idx_share_links_workspace ON share_links(workspace_id, expires_at);
CREATE INDEX idx_share_links_file ON share_links(file_id);

-- The entitlement column. NULL means "defer to the lib/plans.ts floor" and -1
-- means unlimited, matching migration 0012's convention for every other limit.
ALTER TABLE plans ADD COLUMN share_links INTEGER;
```

- [ ] **Step 2: Add the ID prefix**

In `apps/api/src/lib/ids.ts`, inside `ID_PREFIX`, after the `webhook: "whk",` line:

```ts
  /** A public share link. See migration 0016. */
  shareLink: "shr",
```

- [ ] **Step 3: Let tests clear the table**

In `apps/api/test/helpers.ts`, in `resetTenantData`, add `share_links` to the head of the array — before `files`, so the delete never depends on the cascade being the thing that cleans up:

```ts
  for (const table of ["share_links", "file_tags", "files", "folders", "api_keys", "agents", "audit_events"]) {
```

- [ ] **Step 4: Verify the migration applies and the suite still passes**

Run: `cd apps/api && npm test`
Expected: PASS, same count as before (675). The migration runs against the test D1 automatically; a syntax error in the SQL surfaces here as every test failing to start.

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/0016_share_links.sql apps/api/src/lib/ids.ts apps/api/test/helpers.ts
git commit -m "$(cat <<'EOF'
Add the share_links table, and say why it breaks two schema conventions

The first ON DELETE CASCADE in these migrations, and the first token stored
in cleartext. Both are argued in the migration header rather than left for
someone to discover and "fix".

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: The `share` scope op

**Files:**
- Modify: `apps/api/src/auth/scopes.ts:21` (`SCOPE_OPS`)
- Modify: `apps/api/src/auth/roles.ts:31` (`FULL_OPS`)
- Test: `apps/api/test/scopes.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `"share"` as a member of `ScopeOp`. `routes/keys.ts:37` builds its zod enum from `SCOPE_OPS`, so the key-creation API begins accepting it with no edit to that file.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/test/scopes.test.ts`:

```ts
describe("the share op", () => {
  it("is accepted in a stored scopes blob", () => {
    const scope = parseScopes(JSON.stringify({ ops: ["read", "share"], pathPrefix: "/*" }));
    expect(scope.ops).toContain("share");
  });

  it("is not granted by a blob that does not ask for it", () => {
    const scope = parseScopes(JSON.stringify({ ops: ["read", "write"], pathPrefix: "/*" }));
    expect(scopeAllowsOp(scope, "share")).toBe(false);
  });

  it("is included in a full-access role, so a dashboard owner can share", () => {
    expect(FULL_OPS).toContain("share");
  });

  it("is not included in a read-only role", () => {
    expect(READ_ONLY_OPS).not.toContain("share");
  });
});
```

Add to that file's imports, matching whatever import style it already uses:

```ts
import { FULL_OPS, READ_ONLY_OPS } from "../src/auth/roles";
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npm test -- scopes`
Expected: FAIL — `parseScopes` throws `scopes.ops contains an unknown op`, and `FULL_OPS` is not exported.

- [ ] **Step 3: Add the op**

In `apps/api/src/auth/scopes.ts`, line 21:

```ts
export const SCOPE_OPS = ["read", "write", "delete", "list", "keys:create", "share"] as const;
```

In `apps/api/src/auth/roles.ts`, line 31 — and **export both constants** so the test above can assert on them rather than on a copy:

```ts
/**
 * `share` is here because a dashboard owner acts through a role, not a key.
 *
 * This array is hardcoded rather than derived from SCOPE_OPS, which means
 * adding an op to SCOPE_OPS silently leaves roles without it. That fails in
 * the safe direction — nobody gains a capability by accident — but it is why
 * this line has to be edited by hand every time, and why the test asserts it.
 */
export const FULL_OPS: ScopeOp[] = ["read", "write", "delete", "list", "keys:create", "share"];
export const READ_ONLY_OPS: ScopeOp[] = ["read", "list"];
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/api && npm test -- scopes`
Expected: PASS

- [ ] **Step 5: Run the whole suite and typecheck**

Run: `cd apps/api && npm test && npm run build`
Expected: PASS, 675 + 4 tests. Adding a member to `SCOPE_OPS` cannot invalidate a stored blob — `parseScopes` fails closed on *unknown* ops only — so nothing existing should move.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/auth/scopes.ts apps/api/src/auth/roles.ts apps/api/test/scopes.test.ts
git commit -m "$(cat <<'EOF'
Add a share op, off by default on every key

FULL_OPS is hardcoded rather than derived from SCOPE_OPS, so roles do not
inherit a new op automatically. That fails safe but is easy to miss, so it
is now asserted.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: The `shareLinks` entitlement

**Files:**
- Modify: `apps/api/src/lib/plans.ts:39-58` (`PlanLimits`), `:76-133` (`PLAN_LIMITS`), `:170+` (`SANDBOX_LIMITS`)
- Modify: `apps/api/src/billing/catalogue.ts:57-77` (`PlanRow`), `:188-201` (`limitsFromRow`)
- Modify: `apps/api/src/billing/plan-sync.ts:291` (`metadataForPlan`) **and its decoder in the same file**
- Modify: `apps/api/test/claim.test.ts` (the limits-shaped literal)
- Test: `apps/api/test/plans.test.ts`

**Interfaces:**
- Consumes: Task 1's `plans.share_links` column.
- Produces: `PlanLimits.shareLinks: number`. `free` and `SANDBOX_LIMITS` are `0`; `team` is `UNLIMITED`.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/test/plans.test.ts`:

```ts
describe("share link entitlement", () => {
  it("gives the free plan none", () => {
    expect(PLAN_LIMITS.free.shareLinks).toBe(0);
  });

  it("gives an unclaimed sandbox none, so an anonymous workspace cannot publish", () => {
    expect(SANDBOX_LIMITS.shareLinks).toBe(0);
  });

  it("scales with the paid plans", () => {
    expect(PLAN_LIMITS.basic.shareLinks).toBe(10);
    expect(PLAN_LIMITS.pro.shareLinks).toBe(100);
    expect(PLAN_LIMITS.team.shareLinks).toBe(UNLIMITED);
  });

  it("falls back to the floor when the catalogue row does not specify one", () => {
    const limits = limitsFromRow(
      { ...blankPlanRow, share_links: null },
      PLAN_LIMITS.basic
    );
    expect(limits.shareLinks).toBe(10);
  });

  it("reads -1 in the catalogue as unlimited", () => {
    const limits = limitsFromRow(
      { ...blankPlanRow, share_links: -1 },
      PLAN_LIMITS.free
    );
    expect(limits.shareLinks).toBe(UNLIMITED);
  });
});
```

If `plans.test.ts` has no `blankPlanRow` fixture, add one at the top of the file — every `PlanRow` field set to `null` except `id: "pro"`, `name: "Pro"`, `amount_cents: 0`, `currency: "usd"`, `interval: "month"`, `priority_support: 0`, `is_public: 1`.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npm test -- plans`
Expected: FAIL — `shareLinks` does not exist on `PlanLimits`; typecheck errors too.

- [ ] **Step 3: Add the field everywhere the compiler names**

In `apps/api/src/lib/plans.ts`, inside `interface PlanLimits`, after `workspaces`:

```ts
  /**
   * Live public share links a workspace may hold.
   *
   * Zero is the free plan's wall, and it is a count rather than a boolean so
   * that it travels through the same D1 column, the same -1-means-unlimited
   * convention and the same staff-console editor as every other limit. A
   * boolean would have needed a second shape for one field.
   */
  shareLinks: number;
```

Then `shareLinks: 0` in `free`, `10` in `basic`, `100` in `pro`, `UNLIMITED` in `team`, and `0` in `SANDBOX_LIMITS` — with this comment above the sandbox one:

```ts
  // Zero, not a smaller number. An unclaimed sandbox is anonymous and
  // Turnstile-gated; nothing about it should be able to publish bytes to the
  // open internet.
  shareLinks: 0,
```

In `apps/api/src/billing/catalogue.ts`, add `share_links: number | null;` to `PlanRow` after `api_keys`, and to `limitsFromRow`:

```ts
    shareLinks: field(row.share_links, floor.shareLinks),
```

- [ ] **Step 4: Update `metadataForPlan` and its decoder together**

In `apps/api/src/billing/plan-sync.ts`, add `share_links` to the metadata written to Stripe **and** to the function that reads it back. Both directions in the same commit — the spec and CLAUDE.md both say separating them is how they drift, and the drift shows as an edit that appears to work and then quietly changes the entitlement it just set, via the webhook the edit itself triggered.

- [ ] **Step 5: Fix the test fixture the compiler points at**

`apps/api/test/claim.test.ts` constructs a `PlanLimits`-shaped literal. Add `shareLinks: 0` to it.

- [ ] **Step 6: Run the tests and typecheck**

Run: `cd apps/api && npm test && npm run build`
Expected: PASS. Typecheck is the real gate here — a missed construction site cannot compile.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/lib/plans.ts apps/api/src/billing/catalogue.ts apps/api/src/billing/plan-sync.ts apps/api/test/plans.test.ts apps/api/test/claim.test.ts
git commit -m "$(cat <<'EOF'
Share links are a per-plan count, and the free plan's is zero

A count rather than a boolean so it rides the existing D1 column, the -1
convention and the staff plan editor. metadataForPlan and its decoder move
together, as they must.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Pure helpers — expiry and folder containment

**Files:**
- Create: `apps/api/src/lib/shares.ts`
- Test: `apps/api/test/shares.test.ts`

**Interfaces:**
- Consumes: `normalizePrefix` from `src/auth/scopes.ts`, `randomSecret` and `sha256Hex` from `src/lib/keys.ts`.
- Produces:
  - `DEFAULT_SHARE_TTL_MS: number` (7 days), `MAX_SHARE_TTL_MS: number` (7 days)
  - `resolveExpiry(requested: number | undefined, now: number): number` — throws `ApiError("VALIDATION_ERROR")`
  - `pathIsInside(candidate: string, folder: string): boolean`
  - `mintShareToken(): Promise<{ token: string; tokenHash: string }>`
  - `shareUrl(dashboardUrl: string | undefined, token: string): string | null`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/shares.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SHARE_TTL_MS,
  MAX_SHARE_TTL_MS,
  mintShareToken,
  pathIsInside,
  resolveExpiry,
  shareUrl,
} from "../src/lib/shares";

const NOW = 1_780_000_000_000;

describe("resolveExpiry", () => {
  it("defaults to seven days", () => {
    expect(resolveExpiry(undefined, NOW)).toBe(NOW + DEFAULT_SHARE_TTL_MS);
  });

  it("accepts a date inside the cap", () => {
    const requested = NOW + 60 * 60 * 1000;
    expect(resolveExpiry(requested, NOW)).toBe(requested);
  });

  it("refuses a date beyond the cap", () => {
    expect(() => resolveExpiry(NOW + MAX_SHARE_TTL_MS + 1000, NOW)).toThrow(/7 days/);
  });

  it("refuses a date in the past", () => {
    expect(() => resolveExpiry(NOW - 1000, NOW)).toThrow(/future/);
  });
});

describe("pathIsInside", () => {
  it("accepts a direct child", () => {
    expect(pathIsInside("/reports/q3.pdf", "/reports")).toBe(true);
  });

  it("accepts a nested descendant, because folder shares are recursive", () => {
    expect(pathIsInside("/reports/draft/notes.md", "/reports")).toBe(true);
  });

  it("refuses a sibling whose name merely starts the same way", () => {
    // The whole bug class. A plain startsWith says this is inside /reports.
    expect(pathIsInside("/reports-private/secrets.md", "/reports")).toBe(false);
  });

  it("refuses the folder itself", () => {
    expect(pathIsInside("/reports", "/reports")).toBe(false);
  });

  it("treats the empty prefix as the whole workspace", () => {
    expect(pathIsInside("/anything.md", "")).toBe(true);
  });
});

describe("mintShareToken", () => {
  it("returns a token and its hash, and never the same token twice", async () => {
    const a = await mintShareToken();
    const b = await mintShareToken();
    expect(a.token).not.toBe(b.token);
    expect(a.token).toMatch(/^[0-9A-Za-z]{32}$/);
    expect(a.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("shareUrl", () => {
  it("builds the dashboard link", () => {
    expect(shareUrl("https://app.example.com/", "abc")).toBe("https://app.example.com/s/abc");
  });

  it("returns null when no dashboard is configured", () => {
    expect(shareUrl(undefined, "abc")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npm test -- shares`
Expected: FAIL — `Cannot find module '../src/lib/shares'`

- [ ] **Step 3: Write the helpers**

Create `apps/api/src/lib/shares.ts`:

```ts
/**
 * Shared vocabulary for public share links — 05 PART 12.4.
 *
 * Pure helpers only, so the containment rule below can be tested without a
 * database, a Worker or a presigned URL in sight.
 */

import { validationError } from "./errors";
import { randomSecret, sha256Hex } from "./keys";
import { normalizePrefix } from "../auth/scopes";

/** 12.4's cap. Both the default and the ceiling are seven days. */
export const MAX_SHARE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_SHARE_TTL_MS = MAX_SHARE_TTL_MS;

/**
 * How long the R2 URL behind a share is good for.
 *
 * Nothing to do with the share's own lifetime: the public route mints one of
 * these per hit, which is exactly what makes revocation possible. A share that
 * has been deleted stops working immediately, even though a URL handed out a
 * minute earlier stays valid for its remaining hour. That residual window is
 * the price of not being in the byte path, and it is bounded.
 */
export const SHARE_DOWNLOAD_TTL_SECONDS = 60 * 60;

export function resolveExpiry(requested: number | undefined, now: number): number {
  if (requested === undefined) return now + DEFAULT_SHARE_TTL_MS;
  if (requested <= now) {
    throw validationError("expiresAt must be in the future.");
  }
  if (requested > now + MAX_SHARE_TTL_MS) {
    throw validationError("A share link cannot last longer than 7 days.");
  }
  return requested;
}

/**
 * Is this file path inside this shared folder?
 *
 * Segment boundaries, never `startsWith`. "/reports" must not match
 * "/reports-private/secrets.md" — the identical bug class `scopeAllowsPath`
 * exists to solve, which is why the prefix is normalized by that module's own
 * function rather than by a second definition of the same idea here.
 */
export function pathIsInside(candidate: string, folder: string): boolean {
  const prefix = normalizePrefix(folder);
  if (prefix === "") return true;
  return candidate.startsWith(`${prefix}/`);
}

/** The raw token and the hash the lookup index uses. */
export async function mintShareToken(): Promise<{ token: string; tokenHash: string }> {
  const token = randomSecret(32);
  return { token, tokenHash: await sha256Hex(token) };
}

export function shareUrl(dashboardUrl: string | undefined, token: string): string | null {
  if (!dashboardUrl) return null;
  return `${dashboardUrl.replace(/\/+$/, "")}/s/${encodeURIComponent(token)}`;
}
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/api && npm test -- shares`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/shares.ts apps/api/test/shares.test.ts
git commit -m "$(cat <<'EOF'
Share expiry and folder containment, as pure functions

Containment reuses normalizePrefix rather than restating it. A second, subtly
different definition of "is this path inside that one" is how /reports starts
serving /reports-private.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Data access

**Files:**
- Create: `apps/api/src/db/shares.ts`
- Test: `apps/api/test/shares.test.ts` (append)

**Interfaces:**
- Consumes: Task 1's table, Task 4's helpers.
- Produces: `class WorkspaceScopedShares`, constructed as `new WorkspaceScopedShares(db, workspaceId)`:
  - `create(input: { id, kind, fileId, folderPath, token, tokenHash, expiresAt, createdBy, now }): Promise<void>`
  - `listLive(now: number): Promise<ShareRow[]>`
  - `countLive(now: number): Promise<number>`
  - `deleteById(id: string): Promise<boolean>`
  - and one module-level function, **not** on the class: `findShareByToken(db, tokenHash, now): Promise<ShareRow | null>`

`findShareByToken` is deliberately not a method. The class binds a workspace in its constructor, and the public route has no workspace until the token resolves — so the lookup that crosses that boundary is one named function rather than a constructor that can be handed any workspace id.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/test/shares.test.ts`:

```ts
import { env } from "cloudflare:test";
import { beforeEach } from "vitest";
import { WORKSPACE_A, WORKSPACE_B, resetTenantData, seedTwoWorkspaces } from "./helpers";
import { WorkspaceScopedShares, findShareByToken } from "../src/db/shares";

describe("WorkspaceScopedShares", () => {
  beforeEach(async () => {
    await seedTwoWorkspaces();
    await resetTenantData();
  });

  async function seedFile(id: string, path: string, workspaceId = WORKSPACE_A): Promise<void> {
    await env.DB.prepare(
      `INSERT INTO files (id, workspace_id, path, name, status, size_bytes, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', 7, 'usr_TESTUSER', ?, ?)`
    ).bind(id, workspaceId, path, path.split("/").pop(), NOW, NOW).run();
  }

  it("counts only links that have not expired", async () => {
    const shares = new WorkspaceScopedShares(env.DB, WORKSPACE_A);
    await seedFile("fil_LIVE", "/live.md");
    await seedFile("fil_DEAD", "/dead.md");

    await shares.create({
      id: "shr_LIVE", kind: "file", fileId: "fil_LIVE", folderPath: null,
      token: "tokenlive", tokenHash: "hashlive",
      expiresAt: NOW + 1000, createdBy: "usr_TESTUSER", now: NOW,
    });
    await shares.create({
      id: "shr_DEAD", kind: "file", fileId: "fil_DEAD", folderPath: null,
      token: "tokendead", tokenHash: "hashdead",
      expiresAt: NOW - 1000, createdBy: "usr_TESTUSER", now: NOW,
    });

    expect(await shares.countLive(NOW)).toBe(1);
  });

  it("does not see another workspace's links", async () => {
    await seedFile("fil_OTHER", "/other.md", WORKSPACE_B);
    await new WorkspaceScopedShares(env.DB, WORKSPACE_B).create({
      id: "shr_OTHER", kind: "file", fileId: "fil_OTHER", folderPath: null,
      token: "tokenother", tokenHash: "hashother",
      expiresAt: NOW + 1000, createdBy: "usr_TESTUSER", now: NOW,
    });

    expect(await new WorkspaceScopedShares(env.DB, WORKSPACE_A).countLive(NOW)).toBe(0);
  });

  it("refuses to delete a link belonging to another workspace", async () => {
    await seedFile("fil_OTHER2", "/other2.md", WORKSPACE_B);
    await new WorkspaceScopedShares(env.DB, WORKSPACE_B).create({
      id: "shr_OTHER2", kind: "file", fileId: "fil_OTHER2", folderPath: null,
      token: "t2", tokenHash: "h2",
      expiresAt: NOW + 1000, createdBy: "usr_TESTUSER", now: NOW,
    });

    const deleted = await new WorkspaceScopedShares(env.DB, WORKSPACE_A).deleteById("shr_OTHER2");
    expect(deleted).toBe(false);
  });

  it("resolves a live token and refuses an expired one", async () => {
    await seedFile("fil_T", "/t.md");
    await new WorkspaceScopedShares(env.DB, WORKSPACE_A).create({
      id: "shr_T", kind: "file", fileId: "fil_T", folderPath: null,
      token: "tok", tokenHash: "hashtok",
      expiresAt: NOW + 1000, createdBy: "usr_TESTUSER", now: NOW,
    });

    expect(await findShareByToken(env.DB, "hashtok", NOW)).not.toBeNull();
    expect(await findShareByToken(env.DB, "hashtok", NOW + 2000)).toBeNull();
    expect(await findShareByToken(env.DB, "nosuchhash", NOW)).toBeNull();
  });

  it("loses the link when the file is purged, via the cascade", async () => {
    await seedFile("fil_C", "/c.md");
    await new WorkspaceScopedShares(env.DB, WORKSPACE_A).create({
      id: "shr_C", kind: "file", fileId: "fil_C", folderPath: null,
      token: "tokc", tokenHash: "hashc",
      expiresAt: NOW + 1000, createdBy: "usr_TESTUSER", now: NOW,
    });

    await env.DB.prepare(`DELETE FROM files WHERE id = ?`).bind("fil_C").run();

    expect(await findShareByToken(env.DB, "hashc", NOW)).toBeNull();
  });
});
```

That last test is the one that proves the migration's cascade actually works in D1 rather than being decorative. If it fails, stop and fix the schema before going further — the whole "cannot forget" argument rests on it.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npm test -- shares`
Expected: FAIL — `Cannot find module '../src/db/shares'`

- [ ] **Step 3: Write the data access layer**

Create `apps/api/src/db/shares.ts`:

```ts
/**
 * Share link rows, bound to one workspace.
 *
 * Same discipline as WorkspaceScopedStorage: the workspace is fixed in the
 * constructor and every statement carries it, so there is no argument through
 * which a caller can name another tenant's links.
 *
 * `findShareByToken` is the one exception and is deliberately a module
 * function rather than a method — the public route has no workspace until the
 * token resolves, so the lookup that crosses the boundary is one named,
 * greppable function rather than a constructor that would accept any
 * workspace id at all.
 */

export interface ShareRow {
  id: string;
  workspace_id: string;
  kind: "file" | "folder";
  file_id: string | null;
  folder_path: string | null;
  token: string;
  token_hash: string;
  expires_at: number;
  created_by: string;
  created_at: number;
}

export interface CreateShareInput {
  id: string;
  kind: "file" | "folder";
  fileId: string | null;
  folderPath: string | null;
  token: string;
  tokenHash: string;
  expiresAt: number;
  createdBy: string;
  now: number;
}

export class WorkspaceScopedShares {
  constructor(private readonly db: D1Database, private readonly workspaceId: string) {}

  async create(input: CreateShareInput): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO share_links
           (id, workspace_id, kind, file_id, folder_path, token, token_hash,
            expires_at, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        input.id, this.workspaceId, input.kind, input.fileId, input.folderPath,
        input.token, input.tokenHash, input.expiresAt, input.createdBy, input.now
      )
      .run();
  }

  async listLive(now: number): Promise<ShareRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM share_links
          WHERE workspace_id = ? AND expires_at > ?
          ORDER BY created_at DESC`
      )
      .bind(this.workspaceId, now)
      .all<ShareRow>();
    return results ?? [];
  }

  async countLive(now: number): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM share_links WHERE workspace_id = ? AND expires_at > ?`
      )
      .bind(this.workspaceId, now)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  /** True if a row was removed. False means it was not this workspace's to remove. */
  async deleteById(id: string): Promise<boolean> {
    const result = await this.db
      .prepare(`DELETE FROM share_links WHERE id = ? AND workspace_id = ?`)
      .bind(id, this.workspaceId)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }
}

/** The public route's only way in. Expiry is part of the lookup, not a later check. */
export async function findShareByToken(
  db: D1Database,
  tokenHash: string,
  now: number
): Promise<ShareRow | null> {
  const row = await db
    .prepare(`SELECT * FROM share_links WHERE token_hash = ? AND expires_at > ?`)
    .bind(tokenHash, now)
    .first<ShareRow>();
  return row ?? null;
}
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/api && npm test -- shares`
Expected: PASS, including the cascade test.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/shares.ts apps/api/test/shares.test.ts
git commit -m "$(cat <<'EOF'
Share rows are workspace-bound, and the token lookup is not

findShareByToken is a module function rather than a method because the public
route has no workspace until the token resolves. Making it a method would mean
a constructor that accepts any workspace id.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: The authenticated routes

**Files:**
- Create: `apps/api/src/routes/shares.ts`
- Modify: `apps/api/src/index.ts` (register `/v1/shares`)
- Test: `apps/api/test/shares.test.ts` (append)

**Interfaces:**
- Consumes: Tasks 4 and 5.
- Produces: `createShare`, `listShares`, `deleteShare` — all `(ctx: AuthContext, request: Request) => Promise<Response>`, except `deleteShare(ctx, request, shareId)`.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/test/shares.test.ts` — the entitlement and authorization behaviour:

```ts
describe("POST /v1/shares", () => {
  beforeEach(async () => {
    await seedTwoWorkspaces();
    await resetTenantData();
    await setWorkspaceStatus(WORKSPACE_A, "active");
  });

  it("refuses a key that does not carry the share op", async () => {
    const { token } = await seedApiKey({ ops: ["read", "write", "list"] });
    const res = await call("POST", "/v1/shares", token, { fileId: "fil_X" });
    expect(res.status).toBe(403);
  });

  it("refuses the free plan with a message naming the limit", async () => {
    await env.DB.prepare(`UPDATE organizations SET plan = 'free' WHERE id = 'org_TESTORG'`).run();
    const { token } = await seedApiKey({ ops: ["read", "share"] });
    await seedFile("fil_FREE", "/free.md");

    const res = await call("POST", "/v1/shares", token, { fileId: "fil_FREE" });
    expect(res.status).toBe(403);
    const body = await res.json() as ErrorBody;
    expect(body.error.message).toMatch(/upgrade/i);
  });

  it("creates a link on a paid plan and returns the url exactly once", async () => {
    await env.DB.prepare(`UPDATE organizations SET plan = 'pro' WHERE id = 'org_TESTORG'`).run();
    const { token } = await seedApiKey({ ops: ["read", "share"] });
    await seedFile("fil_OK", "/ok.md");

    const res = await call("POST", "/v1/shares", token, { fileId: "fil_OK" });
    expect(res.status).toBe(201);
    const body = await res.json() as { share: { id: string; expiresAt: string }; url: string };
    expect(body.url).toMatch(/\/s\//);
    expect(body.share.id).toMatch(/^shr_/);
  });

  it("refuses to share a file in another workspace", async () => {
    await env.DB.prepare(`UPDATE organizations SET plan = 'pro' WHERE id = 'org_TESTORG'`).run();
    const { token } = await seedApiKey({ ops: ["read", "share"] });
    await seedFile("fil_B", "/b.md", WORKSPACE_B);

    const res = await call("POST", "/v1/shares", token, { fileId: "fil_B" });
    expect(res.status).toBe(404);
  });

  it("stops at the plan's ceiling and frees a slot when one is revoked", async () => {
    await env.DB.prepare(`UPDATE organizations SET plan = 'basic' WHERE id = 'org_TESTORG'`).run();
    const { token } = await seedApiKey({ ops: ["read", "share"] });

    const ids: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      await seedFile(`fil_N${i}`, `/n${i}.md`);
      const res = await call("POST", "/v1/shares", token, { fileId: `fil_N${i}` });
      expect(res.status).toBe(201);
      ids.push(((await res.json()) as { share: { id: string } }).share.id);
    }

    await seedFile("fil_OVER", "/over.md");
    expect((await call("POST", "/v1/shares", token, { fileId: "fil_OVER" })).status).toBe(403);

    expect((await call("DELETE", `/v1/shares/${ids[0]}`, token)).status).toBe(200);
    expect((await call("POST", "/v1/shares", token, { fileId: "fil_OVER" })).status).toBe(201);
  });
});
```

Reuse the `call`, `ErrorBody` and `seedFile` helpers already defined in this file and in `files.test.ts`; lift `call` and `ErrorBody` into `test/helpers.ts` if duplicating them feels wrong — that is a reasonable small refactor to fold into this task.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npm test -- shares`
Expected: FAIL — every request 404s, because the route does not exist.

- [ ] **Step 3: Write the handlers**

Create `apps/api/src/routes/shares.ts`:

```ts
/**
 * Share link management — the authenticated half. The public half is in
 * `shares-public.ts`, kept apart so that "no credential reaches this file" is
 * a property of a whole file rather than of a branch inside one.
 *
 * One creator endpoint serves both kinds, so the plan check and the live count
 * exist in exactly one place and cannot disagree between files and folders.
 */

import { z } from "zod";
import { ApiError, forbidden, validationError } from "../lib/errors";
import { normalizePath } from "../lib/paths";
import { newId } from "../lib/ids";
import { assertScopedPath } from "../auth/scopes";
import { auditAndNotify } from "../lib/audit";
import { WorkspaceScopedShares } from "../db/shares";
import { mintShareToken, resolveExpiry, shareUrl } from "../lib/shares";
import type { AuthContext } from "../middleware/auth";
import type { ShareRow } from "../db/shares";

const CreateSchema = z
  .object({
    fileId: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
    expiresAt: z.string().datetime().optional(),
  })
  .strict()
  .refine((body) => (body.fileId === undefined) !== (body.path === undefined), {
    message: "exactly one of fileId (a file) or path (a folder) is required",
  });

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function toResource(row: ShareRow, dashboardUrl: string | undefined) {
  return {
    id: row.id,
    kind: row.kind,
    fileId: row.file_id,
    path: row.folder_path,
    expiresAt: new Date(row.expires_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
    // Cleartext by design — see migration 0016. A link nobody can copy twice
    // is not a share feature.
    url: shareUrl(dashboardUrl, row.token),
  };
}

export async function createShare(ctx: AuthContext, request: Request): Promise<Response> {
  const parsed = CreateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    throw validationError(parsed.error.issues[0]?.message ?? "Invalid request body.");
  }
  const body = parsed.data;

  const shares = new WorkspaceScopedShares(ctx.db.raw, ctx.workspaceId);

  // The entitlement, before any work. Counting live rows rather than reading a
  // flag means revoking frees a slot with no second bookkeeping step.
  const live = await shares.countLive(ctx.now);
  if (live >= ctx.limits.shareLinks) {
    throw forbidden(
      ctx.limits.shareLinks === 0
        ? "Share links aren't available on this plan. Upgrade to share files publicly."
        : "This workspace has used all of its share links. Revoke one, or upgrade for more.",
      { limit: "shareLinks", used: live, allowed: ctx.limits.shareLinks }
    );
  }

  const expiresAt = resolveExpiry(
    body.expiresAt === undefined ? undefined : Date.parse(body.expiresAt),
    ctx.now
  );

  let kind: "file" | "folder";
  let fileId: string | null = null;
  let folderPath: string | null = null;

  if (body.fileId !== undefined) {
    const row = await ctx.db.files.findById(body.fileId);
    if (row === null || row.status !== "active") {
      throw new ApiError("NOT_FOUND", "No such file.");
    }
    assertScopedPath(ctx.scope, row.path, "share");
    kind = "file";
    fileId = row.id;
  } else {
    folderPath = normalizePath(body.path as string);
    assertScopedPath(ctx.scope, folderPath, "share");
    kind = "folder";
  }

  const id = newId("shareLink", ctx.now);
  const { token, tokenHash } = await mintShareToken();

  await shares.create({
    id, kind, fileId, folderPath, token, tokenHash,
    expiresAt, createdBy: ctx.userId ?? ctx.keyId, now: ctx.now,
  });

  // Audited because the row is destroyed on revoke, so this event is the only
  // lasting record that something was made public. See the spec.
  auditAndNotify(ctx, request, "share.created", {
    resourceType: "share",
    resourceId: id,
    metadata: { kind, fileId, path: folderPath, expiresAt },
    webhookData: { id, kind },
  });

  const resource = toResource(
    {
      id, workspace_id: ctx.workspaceId, kind, file_id: fileId, folder_path: folderPath,
      token, token_hash: tokenHash, expires_at: expiresAt,
      created_by: ctx.userId ?? ctx.keyId, created_at: ctx.now,
    },
    ctx.dashboardUrl
  );

  return json({ share: resource, url: resource.url }, 201);
}

export async function listShares(ctx: AuthContext): Promise<Response> {
  const rows = await new WorkspaceScopedShares(ctx.db.raw, ctx.workspaceId).listLive(ctx.now);
  return json({ shares: rows.map((row) => toResource(row, ctx.dashboardUrl)) });
}

export async function deleteShare(
  ctx: AuthContext,
  request: Request,
  shareId: string
): Promise<Response> {
  const removed = await new WorkspaceScopedShares(ctx.db.raw, ctx.workspaceId).deleteById(shareId);
  if (!removed) {
    throw new ApiError("NOT_FOUND", "No such share link.");
  }

  auditAndNotify(ctx, request, "share.revoked", {
    resourceType: "share",
    resourceId: shareId,
    metadata: { reason: "revoked by owner" },
    webhookData: { id: shareId },
  });

  return json({ revoked: true });
}
```

If `ctx.db.raw`, `ctx.scope`, `ctx.keyId`, `ctx.userId` or `assertScopedPath`'s signature differ from what is written here, adapt to what `middleware/auth.ts` actually exposes — read `AuthContext` before writing this file and match it. Do not add fields to `AuthContext` for this task.

- [ ] **Step 4: Register the routes**

In `apps/api/src/index.ts`, alongside the other `/v1/...` segment blocks and **before** any `:id` catch-all:

```ts
      if (segments[0] === "v1" && segments[1] === "shares") {
        const shareId = segments[2];

        if (shareId === undefined) {
          if (request.method === "POST") return await authed({ op: "share" }, createShare);
          if (request.method === "GET") return await authed({ op: "list" }, listShares);
          throw new ApiError("NOT_FOUND", "No such route.");
        }

        // "open" is a literal segment and is handled above, in the public
        // block. Reaching it here would mean the public match failed, and the
        // right answer is the same 404 any unknown route gets.
        if (shareId !== "open" && segments.length === 3 && request.method === "DELETE") {
          return await authed({ op: "share" }, (authCtx, req) =>
            deleteShare(authCtx, req, shareId)
          );
        }
        throw new ApiError("NOT_FOUND", "No such route.");
      }
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `cd apps/api && npm test && npm run build`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/shares.ts apps/api/src/index.ts apps/api/test/shares.test.ts
git commit -m "$(cat <<'EOF'
Create, list and revoke share links

One creator for both kinds, so the plan check and the live count cannot
disagree between files and folders. Revoking deletes the row, which is what
frees the slot.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: The public routes

**Files:**
- Create: `apps/api/src/routes/shares-public.ts`
- Modify: `apps/api/src/index.ts` (register above `withAuth`, beside the claim route)
- Test: `apps/api/test/shares.test.ts` (append)

**Interfaces:**
- Consumes: `findShareByToken`, `pathIsInside`, `SHARE_DOWNLOAD_TTL_SECONDS`.
- Produces: `previewShare(deps, token, now)` and `downloadShared(deps, token, fileId, now)`, both returning `Response` and both taking `{ db, files, signing, requestId }` rather than an `AuthContext` — there is no authenticated context here and the types should say so.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/test/shares.test.ts`:

```ts
describe("the public share routes", () => {
  const NOTHING = 404;

  async function publicGet(path: string): Promise<Response> {
    return SELF.fetch(`${URL_BASE}${path}`);  // no Authorization header at all
  }

  /** Read the body once — a Response body cannot be consumed twice. */
  async function refusal(path: string): Promise<{ status: number; code: string; message: string }> {
    const res = await publicGet(path);
    const body = (await res.json()) as ErrorBody;
    return { status: res.status, code: body.error.code, message: body.error.message };
  }

  it("answers identically for expired, revoked and never-existed tokens", async () => {
    // Three different causes, one of them a token that was real until a moment
    // ago. If any of these three differ, the route is an oracle that confirms
    // which guesses are real tokens.
    const expiredToken = await seedLiveFileShare("/expired.md", "fil_EXPIRED");
    await env.DB.prepare(`UPDATE share_links SET expires_at = ? WHERE token = ?`)
      .bind(NOW - 1, expiredToken).run();

    const revokedToken = await seedLiveFileShare("/revoked.md", "fil_REVOKED");
    await env.DB.prepare(`DELETE FROM share_links WHERE token = ?`).bind(revokedToken).run();

    const expired = await refusal(`/v1/shares/open/${expiredToken}`);
    const revoked = await refusal(`/v1/shares/open/${revokedToken}`);
    const never = await refusal("/v1/shares/open/neverexistedatall");

    expect(expired).toEqual(never);
    expect(revoked).toEqual(never);
    expect(never.status).toBe(NOTHING);
  });

  it("previews a live file share with no credential", async () => {
    // seed a pro workspace, a file and a share via the authenticated route
    const token = await seedLiveFileShare("/preview.md");
    const res = await publicGet(`/v1/shares/open/${token}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { kind: string; files: { id: string; name: string }[] };
    expect(body.kind).toBe("file");
    expect(body.files[0]?.name).toBe("preview.md");
  });

  it("serves nothing once the shared file is soft-deleted, and works again after a restore", async () => {
    const token = await seedLiveFileShare("/soft.md", "fil_SOFT");
    await env.DB.prepare(`UPDATE files SET status = 'deleted', deleted_at = ? WHERE id = ?`)
      .bind(NOW, "fil_SOFT").run();
    expect((await publicGet(`/v1/shares/open/${token}`)).status).toBe(NOTHING);

    await env.DB.prepare(`UPDATE files SET status = 'active', deleted_at = NULL WHERE id = ?`)
      .bind("fil_SOFT").run();
    expect((await publicGet(`/v1/shares/open/${token}`)).status).toBe(200);
  });

  it("refuses a sibling folder that merely shares a name prefix", async () => {
    const token = await seedLiveFolderShare("/reports");
    await seedFile("fil_EVIL", "/reports-private/secrets.md");

    const res = await publicGet(`/v1/shares/open/${token}/download/fil_EVIL`);
    expect(res.status).toBe(NOTHING);
  });

  it("refuses a file id from another workspace", async () => {
    const token = await seedLiveFolderShare("/reports");
    await seedFile("fil_OTHERWS", "/reports/x.md", WORKSPACE_B);

    expect((await publicGet(`/v1/shares/open/${token}/download/fil_OTHERWS`)).status).toBe(NOTHING);
  });

  it("refuses a file id that is not the one a file share names", async () => {
    const token = await seedLiveFileShare("/only.md", "fil_ONLY");
    await seedFile("fil_NOTSHARED", "/notshared.md");

    expect((await publicGet(`/v1/shares/open/${token}/download/fil_NOTSHARED`)).status).toBe(NOTHING);
  });

  it("serves nothing when the workspace is suspended", async () => {
    const token = await seedLiveFileShare("/susp.md");
    await setWorkspaceStatus(WORKSPACE_A, "suspended");
    expect((await publicGet(`/v1/shares/open/${token}`)).status).toBe(NOTHING);
  });
});
```

Write `seedLiveFileShare(path, fileId?)` and `seedLiveFolderShare(path)` as local helpers in this file: set the org's plan to `pro`, seed the file, mint a key with `["read","share"]`, POST to `/v1/shares`, and return the raw token parsed out of the returned `url`.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npm test -- shares`
Expected: FAIL — the public paths 404 through the generic "No such route." rather than through the share code.

- [ ] **Step 3: Write the public handlers**

Create `apps/api/src/routes/shares-public.ts`:

```ts
/**
 * The two routes in this product that serve a tenant's bytes with no
 * credential at all.
 *
 * Kept in their own file on purpose: "nothing here is authenticated" is a
 * property worth being able to see at the top of a file, rather than one
 * branch among many in a file full of routes that are.
 *
 * Every refusal is the same 404 with the same body. Expired, revoked, never
 * existed, wrong workspace, soft-deleted file, suspended workspace and a file
 * id outside the shared folder are indistinguishable to the caller — a
 * distinguishable failure is an oracle that confirms which tokens are real.
 * The reason goes to `internalReason`, which is logged and never serialized.
 */

import { ApiError } from "../lib/errors";
import { sha256Hex } from "../lib/keys";
import { findShareByToken } from "../db/shares";
import { pathIsInside, SHARE_DOWNLOAD_TTL_SECONDS } from "../lib/shares";
import { presignDownload, redactPresigned, type R2SigningConfig } from "../storage/presign";
import { objectKey } from "../storage/keys";
import type { FileRow } from "../db/types";

export interface PublicShareDeps {
  db: D1Database;
  signing: () => R2SigningConfig | null;
  requestId: string;
}

/** The one refusal. Never varies, whatever went wrong. */
function nothingHere(internalReason: string): ApiError {
  return new ApiError("NOT_FOUND", "This link isn't available.", { internalReason });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * Resolve a token to its share, its workspace and the files it currently
 * exposes. Folder shares are live and recursive, resolved by PATH — never by
 * folder_id, because folders are created lazily and a file can sit inside one
 * with folder_id still NULL, which would silently under-share.
 */
async function resolve(deps: PublicShareDeps, token: string, now: number) {
  const share = await findShareByToken(deps.db, await sha256Hex(token), now);
  if (share === null) throw nothingHere("no live share for that token");

  const workspace = await deps.db
    .prepare(`SELECT id, name, status FROM workspaces WHERE id = ?`)
    .bind(share.workspace_id)
    .first<{ id: string; name: string; status: string }>();

  if (workspace === null || workspace.status !== "active") {
    throw nothingHere(`workspace ${share.workspace_id} is ${workspace?.status ?? "missing"}`);
  }

  let files: FileRow[];
  if (share.kind === "file") {
    const row = await deps.db
      .prepare(`SELECT * FROM files WHERE id = ? AND workspace_id = ? AND status = 'active'`)
      .bind(share.file_id, share.workspace_id)
      .first<FileRow>();
    if (row === null) throw nothingHere("shared file is missing or not active");
    files = [row];
  } else {
    const { results } = await deps.db
      .prepare(
        `SELECT * FROM files
          WHERE workspace_id = ? AND status = 'active' AND path LIKE ?
          ORDER BY path`
      )
      .bind(share.workspace_id, `${share.folder_path}/%`)
      .all<FileRow>();
    // The LIKE narrows; pathIsInside decides. LIKE cannot express a segment
    // boundary, so "/reports/%" would also match "/reports/../x" shapes and
    // anything a future path normalization change let through.
    files = (results ?? []).filter((row) => pathIsInside(row.path, share.folder_path as string));
  }

  return { share, workspace, files };
}

export async function previewShare(
  deps: PublicShareDeps,
  token: string,
  now: number
): Promise<Response> {
  const { share, workspace, files } = await resolve(deps, token, now);

  return json({
    kind: share.kind,
    name: share.kind === "file" ? files[0]?.name : share.folder_path,
    workspaceName: workspace.name,
    expiresAt: new Date(share.expires_at).toISOString(),
    files: files.map((row) => ({
      id: row.id,
      name: row.name,
      path: row.path,
      sizeBytes: row.size_bytes,
      mimeType: row.mime_type,
    })),
  });
}

export async function downloadShared(
  deps: PublicShareDeps,
  token: string,
  fileId: string,
  now: number
): Promise<Response> {
  const { share, files } = await resolve(deps, token, now);

  // Containment. For a folder share this is the segment-boundary check; for a
  // file share it is an equality check the caller cannot route around. Both
  // are expressed as "is this id in the set this token exposes", which is one
  // rule rather than two that could disagree.
  const row = files.find((candidate) => candidate.id === fileId);
  if (row === undefined) throw nothingHere(`file ${fileId} is not inside share ${share.id}`);

  const config = deps.signing();
  if (config === null) throw nothingHere("presigning is not configured on this deployment");

  const url = await presignDownload(
    config,
    objectKey(share.workspace_id, row.id),
    SHARE_DOWNLOAD_TTL_SECONDS
  );

  console.log(
    JSON.stringify({
      level: "info",
      requestId: deps.requestId,
      message: "issued presigned download for a public share",
      shareId: share.id,
      fileId: row.id,
      workspaceId: share.workspace_id,
      bytes: row.size_bytes,
      url: redactPresigned(url),
    })
  );

  return Response.redirect(url, 302);
}
```

Check `objectKey`'s real signature in `src/storage/keys.ts` and match it; if it takes the stored `r2_object_key` off the row instead, use that.

- [ ] **Step 4: Register them above `withAuth`**

In `apps/api/src/index.ts`, immediately after the claim-link block (around line 392) and **before** the authenticated `/v1/shares` block from Task 6:

```ts
      // Public share links. Four and five segments, with a literal "open" that
      // `/v1/shares/:id` must never swallow — the same shape as the claim link
      // above, and the same reason `workspaces/needs-attention` had to learn
      // that literal segments are matched before :id patterns.
      //
      // Genuinely public: no credential is read, and that is the design. The
      // token is the only thing that can name this file.
      {
        const match = /^\/v1\/shares\/open\/([^/]+)(?:\/download\/([^/]+))?$/.exec(url.pathname);
        if (match !== null && request.method === "GET") {
          const shareToken = decodeURIComponent(match[1] as string);
          const deps = { db: env.DB, signing: () => readSigningConfig(env), requestId: id };
          const now = Date.now();

          return match[2] === undefined
            ? await previewShare(deps, shareToken, now)
            : await downloadShared(deps, shareToken, decodeURIComponent(match[2]), now);
        }
      }
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `cd apps/api && npm test && npm run build`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/shares-public.ts apps/api/src/index.ts apps/api/test/shares.test.ts
git commit -m "$(cat <<'EOF'
Serve a share link with no credential, and refuse everything identically

Expired, revoked, never-existed, suspended, soft-deleted and out-of-folder all
return the same 404 with the same body. A distinguishable failure is an oracle
telling somebody which of their guesses is a real token.

Folder membership is decided by path with a segment-boundary check, so a share
of /reports cannot serve /reports-private.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Revocation triggers and the expiry sweep

**Files:**
- Modify: `apps/api/src/staff/users-access.ts:367-390` (user deletion)
- Modify: `apps/api/src/staff/access.ts:327` (the other key-revoking path), `:467` (workspace suspend/delete)
- Modify: `apps/api/src/jobs/purge.ts`
- Test: `apps/api/test/shares.test.ts` (append)

**Interfaces:**
- Consumes: Task 1's table.
- Produces: no new exports. Existing operations gain a `DELETE FROM share_links`.

- [ ] **Step 1: Write the failing test**

```ts
describe("links die with the account and the workspace", () => {
  it("deleting a user deletes the links they created", async () => {
    const token = await seedLiveFileShare("/mine.md");
    await deleteUserViaStaff("usr_TESTUSER");
    expect((await publicGet(`/v1/shares/open/${token}`)).status).toBe(404);
    expect(await countShareRows()).toBe(0);
  });

  it("suspending a workspace deletes every link in it, whoever made them", async () => {
    const token = await seedLiveFileShare("/theirs.md");
    await suspendWorkspaceViaStaff(WORKSPACE_A);
    expect((await publicGet(`/v1/shares/open/${token}`)).status).toBe(404);
    expect(await countShareRows()).toBe(0);
  });

  it("the hourly purge removes expired rows", async () => {
    await seedFile("fil_EXP", "/exp.md");
    await new WorkspaceScopedShares(env.DB, WORKSPACE_A).create({
      id: "shr_EXP", kind: "file", fileId: "fil_EXP", folderPath: null,
      token: "expired", tokenHash: "hashexpired",
      expiresAt: NOW - 1, createdBy: "usr_TESTUSER", now: NOW,
    });

    await purgeExpiredShares(env.DB, NOW);
    expect(await countShareRows()).toBe(0);
  });
});
```

`deleteUserViaStaff` and `suspendWorkspaceViaStaff` should call the real staff methods, not raw SQL — the point of the test is that the *existing operation* now also deletes links. `countShareRows` is `SELECT COUNT(*) FROM share_links`.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npm test -- shares`
Expected: FAIL — links survive both operations; `purgeExpiredShares` does not exist.

- [ ] **Step 3: Add the deletes beside the existing key revocations**

In `apps/api/src/staff/users-access.ts`, in the same batch as the `UPDATE api_keys SET revoked_at = ...` at line 387:

```ts
        // Share links are deleted rather than marked, because there is no
        // revoked state to mark — see migration 0016. A share link is
        // anonymous and never reaches resolveVerifiedUser, so without this a
        // deleted account's files stay publicly downloadable for the whole
        // grace period while its owner is locked out.
        db.prepare(`DELETE FROM share_links WHERE created_by = ?`).bind(userId),
```

Do the same at `staff/access.ts:327`. At `staff/access.ts:467` — workspace suspend and delete — delete by workspace instead, because a suspended workspace must not keep serving public downloads no matter who created the link:

```ts
        db.prepare(`DELETE FROM share_links WHERE workspace_id = ?`).bind(workspaceId),
```

Record a `share.revoked` audit row for each bulk deletion, with `reason: "account deleted"` / `"workspace suspended"`. The spec requires it: the row is the only record that something was public, and deleting it without an audit event erases the evidence.

- [ ] **Step 4: Add the sweep**

In `apps/api/src/jobs/purge.ts`, export and call:

```ts
/**
 * Housekeeping, not enforcement. An expired row already serves nothing —
 * `findShareByToken` has the expiry in its WHERE clause, and the plan limit
 * counts unexpired rows — so this only keeps the table from growing.
 */
export async function purgeExpiredShares(db: D1Database, now: number): Promise<number> {
  const result = await db
    .prepare(`DELETE FROM share_links WHERE expires_at <= ?`)
    .bind(now)
    .run();
  return result.meta.changes ?? 0;
}
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `cd apps/api && npm test && npm run build`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/staff/users-access.ts apps/api/src/staff/access.ts apps/api/src/jobs/purge.ts apps/api/test/shares.test.ts
git commit -m "$(cat <<'EOF'
A deleted account's share links die with it, immediately

A share link is anonymous and never reaches resolveVerifiedUser, so without
this a deleted account's files stayed publicly downloadable for the whole
grace period while its owner was locked out. Suspending a workspace clears
its links too, whoever made them.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Register the public routes in the authentication sweep

**Files:**
- Modify: `apps/api/test/auth.test.ts` (the 41-route table)

- [ ] **Step 1: Read the table and add both routes as deliberately public**

`test/auth.test.ts` sweeps every authenticated route to prove an absent credential produces the standard failure rather than a 404. It exists precisely to catch a route added outside `withAuth`. Two landing silently is the failure it is for — so they go into the table explicitly marked public, with a comment saying why, rather than being omitted.

- [ ] **Step 2: Run the sweep**

Run: `cd apps/api && npm test -- auth`
Expected: PASS, with the route count risen from 41 by however the table counts the public entries.

- [ ] **Step 3: Commit**

```bash
git add apps/api/test/auth.test.ts
git commit -m "$(cat <<'EOF'
Record the two public share routes in the auth sweep

Marked public deliberately, not omitted. The sweep exists to catch a route
added outside withAuth; silence is the failure mode it is for.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: The dashboard share dialog

**Files:**
- Create: `apps/web/src/components-local/ShareModal.jsx`
- Modify: `apps/web/src/routes/FileBrowser.jsx`
- Modify: `apps/web/src/api.js` (or wherever the fetch wrappers live)
- Test: `apps/web/src/__tests__/ShareModal.test.jsx`

- [ ] **Step 1: Write the failing test**

```jsx
describe('ShareModal', () => {
  it('offers seven days by default', () => {
    render(<ShareModal open target={{ kind: 'file', name: 'q3.pdf' }} limits={{ shareLinks: 100 }} />);
    expect(screen.getByLabelText(/expires/i)).toHaveValue('7d');
  });

  it('tells a free-plan user why they cannot share, in words', () => {
    render(<ShareModal open target={{ kind: 'file', name: 'q3.pdf' }} limits={{ shareLinks: 0 }} />);
    expect(screen.getByText(/not available on your plan/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create link/i })).toBeDisabled();
  });

  it('warns that a shared folder publishes anything added to it later', () => {
    render(<ShareModal open target={{ kind: 'folder', name: '/reports' }} limits={{ shareLinks: 100 }} />);
    expect(screen.getByText(/anything added to this folder/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npm test -- ShareModal`
Expected: FAIL — module not found.

- [ ] **Step 3: Build the modal**

The skeleton, which the requirements below constrain:

```jsx
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Input, Modal, Select } from '../components/index.js';

const PRESETS = [
  { value: '1h', label: '1 hour', ms: 60 * 60 * 1000 },
  { value: '24h', label: '24 hours', ms: 24 * 60 * 60 * 1000 },
  { value: '7d', label: '7 days', ms: 7 * 24 * 60 * 60 * 1000 },
  { value: 'custom', label: 'Custom date…', ms: null },
];

const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export default function ShareModal({ open, target, limits, onClose, onCreated }) {
  const [expiry, setExpiry] = useState('7d');
  const [customDate, setCustomDate] = useState('');
  const [link, setLink] = useState(null);
  const [error, setError] = useState(null);

  // The handler lives in a ref, never in the dependency array below. Every
  // call site passes an inline arrow and the parent re-renders per keystroke,
  // so a dependency here would re-run the effect on every character typed and
  // throw focus back onto the header's close button.
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; });

  const allowed = limits.shareLinks > 0;

  // ... render: Alert for the free-plan reason, Select for expiry,
  //     folder warning, the copy field once `link` is set.
}
```

Requirements it must meet, all from the spec and the repo's standing rules:

- Import every component from `src/components/index.js`. Never from a component's own path.
- No raw hex, no hardcoded px. `var(--*)` tokens only.
- The expiry control offers `1h` / `24h` / `7d` and a custom date, and refuses anything past 7 days **in the UI as well as the API** — a control that lets you pick a date the server will reject is a control that lies.
- A folder target renders the warning that later additions become public, plus the live count and total size the link currently exposes.
- On a plan with `shareLinks === 0`, the create button is disabled and the reason is stated in words with a link to upgrade — computed from the workspace's real limits, never from a fixture.
- The badge for an existing link pairs a tone with a word. Colour never carries meaning alone.
- Revoking uses `ConfirmModal` with the default `destructive` (revoking *is* destructive). Creating is additive, so anything confirming a create passes `destructive={false}`.
- The dialog must be a **sibling** of the file drawer in the DOM, never a child — a `z-index` only ranks siblings within the nearest stacking context.
- Focus moves once, on open. Keep `onClose` in a ref, never in the effect's dependency array: every call site passes an inline arrow and the parent re-renders per keystroke, so a dependency there re-focuses the close button after every character typed.

- [ ] **Step 4: Run the tests and build**

Run: `cd apps/web && npm test && npm run build`
Expected: PASS

- [ ] **Step 5: Check how the MCP page renders an op with no tool behind it**

`apps/web/src/routes/McpConnection.jsx` derives tool availability from the
connecting key's own `scopes.ops` and renders `read` / `write` / `delete` /
`list` badges. `share` is now a possible member of that array with **no MCP
tool behind it**, by design.

Open the page with a key carrying `share` and confirm it renders sensibly —
either the op is filtered out of the tool view, or it appears without implying
a tool exists. A screen that invents a `share_file` tool because it saw the op
would be the same class of defect as the fixture-driven permissions this page
was already fixed for once.

- [ ] **Step 6: Run the adherence greps**

Run the greps in `Skill/1 Build.md`. Nothing in CI checks the import and token rules — `apps/web` has no `lint` script and CI's `npm run lint --if-present` skips it silently.

- [ ] **Step 7: Commit**

---

### Task 11: The public share page

**Files:**
- Create: `apps/web/src/routes/SharePage.jsx`
- Modify: the route table in `apps/web/src/main.jsx` (or wherever `/claim/:token` is registered)

- [ ] **Step 1: Write the failing test**

A test that the page renders a file share's name and download button from a mocked preview response, and renders the 404 state for a refused token.

- [ ] **Step 2: Run it and watch it fail**

- [ ] **Step 3: Build the page**

Model it on `apps/web/src/routes/Claim.jsx`, which is the existing public, token-in-URL page: no shell chrome, no workspace switcher, no account menu. It calls `GET /v1/shares/open/:token` and renders either one file with a download button or a folder listing whose rows link to the download route.

A refused token renders the ordinary not-found state. It must not say whether the link expired, was revoked, or never existed — the page must not undo the API's identical-refusal property by explaining it.

- [ ] **Step 4: Run the tests and build**

Run: `cd apps/web && npm test && npm run build`

- [ ] **Step 5: Commit**

---

# PHASE 2 — The deletion window becomes 7 days

### Task 12: Shorten the grace period, and every sentence that quotes it

**Files:**
- Modify: `apps/api/src/jobs/staff-purge.ts:34` and its header at `:2`
- Modify: `apps/api/src/index.ts:141`, `:786` (comments)
- Modify: `apps/api/src/db/user-lookup.ts:36` (comment only)
- Modify: `apps/web/src/routes/Legal.jsx:218`
- Modify: `apps/admin/src/screens/Users.jsx:213`, `:408`, `:441`
- Test: `apps/api/test/staff-purge.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("purges a deletion that is seven days old", async () => {
  expect(STAFF_PURGE_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1000);
});

it("leaves a deletion that is six days old alone", async () => {
  // seed a user with deleted_at = NOW - 6 days, run the purge, expect the row to survive
});

it("still defaults to reporting rather than deleting", async () => {
  // STAFF_PURGE_ENABLED unset => dryRun, nothing removed
});
```

That third test is not optional. Dev holds accounts whose `deleted_at` this shortened window makes immediately eligible; a purge that defaults to deleting would empty the environment on its first cron tick after deploy.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npm test -- staff-purge`

- [ ] **Step 3: Change the constant**

```ts
export const STAFF_PURGE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
```

- [ ] **Step 4: Change every sentence that quotes it**

- `Legal.jsx:218` — "permanently purged within roughly 30 days" → 7. **This is the privacy policy and therefore a stated retention promise, not a constant.** Settings → Privacy is a summary of this text and moves with it; the two have drifted once before.
- `Users.jsx:213, 408, 441` — the three staff console strings. Support reads these; they must never promise a month.
- The doc comments at `staff-purge.ts:2`, `index.ts:141`, `index.ts:786`, `user-lookup.ts:36`.

**Do not touch** `CLAIM_TOKEN_TTL_MS` (`db/bootstrap.ts:37`), `periodResetAt` (`db/user-lookup.ts:24` — the billing period, despite the neighbouring comment), or the 30-day range selectors in Activity, Usage and Keys. They say 30 for unrelated reasons.

- [ ] **Step 5: Run everything**

Run: `cd apps/api && npm test && npm run build`, then `cd apps/web && npm test && npm run build`, then `cd apps/admin && npm test && npm run build`

- [ ] **Step 6: Commit**

```bash
git commit -m "$(cat <<'EOF'
The deletion grace period is a week, not a month

One constant, plus the privacy policy and the three console strings support
reads from. The 30s in the claim token TTL and the billing period are
unrelated and stay.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

# PHASE 3 — Self-serve account deletion

### Task 13: `DELETE /v1/me`

**Files:**
- Create: `apps/api/src/routes/account.ts`
- Modify: `apps/api/src/index.ts`
- Test: `apps/api/test/account.test.ts`

**Interfaces:**
- Consumes: the deletion path in `staff/users-access.ts` — call it, do not reimplement it. It already sets `deleted_at` and `session_revoked_after`, revokes keys, deletes share links (Task 8) and is what `purgeStaffDeleted` knows how to finish.
- Produces: `deleteOwnAccount(request, deps, user)`.

- [ ] **Step 1: Write the failing test**

```ts
describe("DELETE /v1/me", () => {
  it("refuses an API key outright", async () => {
    const { token } = await seedApiKey({ ops: ["read", "write", "delete", "list"] });
    const res = await call("DELETE", "/v1/me", token, { email: "test@example.com" });
    expect(res.status).toBe(401);
  });

  it("refuses a confirmation that is not the caller's own email", async () => {
    const res = await callAsUser("DELETE", "/v1/me", { email: "someone-else@example.com" });
    expect(res.status).toBe(400);
  });

  it("marks the account, revokes the keys and deletes the share links in one operation", async () => {
    const shareToken = await seedLiveFileShare("/bye.md");
    const res = await callAsUser("DELETE", "/v1/me", { email: "test@example.com" });
    expect(res.status).toBe(200);

    const user = await env.DB.prepare(`SELECT deleted_at FROM users WHERE id = ?`)
      .bind("usr_TESTUSER").first<{ deleted_at: number | null }>();
    expect(user?.deleted_at).not.toBeNull();

    expect(await countLiveKeys()).toBe(0);
    expect((await publicGet(`/v1/shares/open/${shareToken}`)).status).toBe(404);
  });

  it("refuses the account entry afterwards, without waiting on Firebase", async () => {
    await callAsUser("DELETE", "/v1/me", { email: "test@example.com" });
    const res = await callAsUser("GET", "/v1/whoami");
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npm test -- account`

- [ ] **Step 3: Write the handler**

`DELETE /v1/me`, with the confirming email in the body — the shape `DELETE /v1/workspaces/:id` already uses, so the confirmation belongs to the operation rather than to one client.

- **Firebase session only.** An API key is refused with `unauthorized(...)`, exactly as the claim route refuses one. An agent credential must not be able to close its owner's account.
- The body's `email` must equal the caller's own, case-insensitively.
- Cancel the Stripe subscription.
- Delegate to the staff deletion path. Do not write a second implementation of it.
- Audit it, with the customer as the actor rather than a staff member.

- [ ] **Step 4: Register the route** in `index.ts`, in the block that needs a verified Firebase user and refuses API keys.

- [ ] **Step 5: Run the tests and typecheck**

Run: `cd apps/api && npm test && npm run build`

- [ ] **Step 6: Commit**

---

### Task 14: The account deletion dialog

**Files:**
- Modify: `apps/web/src/routes/Settings.jsx` (the Danger zone, near line 327)
- Test: `apps/web/src/__tests__/Settings.test.jsx`

- [ ] **Step 1: Write the failing test**

```jsx
it('names every workspace that will be destroyed and how many people lose access', () => {
  render(<DeleteAccountModal open workspaces={[
    { name: 'Acme Reports', otherMembers: 3 },
    { name: 'Client Files', otherMembers: 1 },
  ]} />);
  expect(screen.getByText(/Acme Reports/)).toBeInTheDocument();
  expect(screen.getByText(/3 other members lose access/)).toBeInTheDocument();
});

it('keeps the confirm button disabled until the email matches', () => {
  render(<DeleteAccountModal open email="karim@example.com" workspaces={[]} />);
  const confirm = screen.getByRole('button', { name: /delete my account/i });
  expect(confirm).toBeDisabled();
  fireEvent.change(screen.getByLabelText(/confirm/i), { target: { value: 'karim@example.com' } });
  expect(confirm).toBeEnabled();
});
```

- [ ] **Step 2: Run it and watch it fail**

- [ ] **Step 3: Build the dialog**

The copy, verbatim from the spec:

> **Delete your account?**
>
> **This happens immediately:**
> - Every API key you created stops working. Agents using them lose access at once.
> - Every share link you created is deleted. Anyone holding one gets nothing.
> - You're signed out everywhere.
> - Your subscription is cancelled. No further charges.
>
> **These are destroyed after 7 days:**
> - *Acme Reports* — 3 other members lose access
> - *Client Files* — 1 other member loses access
>
> **You cannot undo this yourself.** For 7 days, support can reverse it — contact us at agentdisk.io/support. After 7 days nothing can be recovered, by anyone.
>
> Type your email address to confirm.

The two-part structure is the point and must not be collapsed: the immediate consequences are irreversible today, the destruction is a week away, and the support path is real but bounded. A single "this cannot be undone" would be both too strong and too weak.

The workspace list is rendered from live data, never a placeholder. If the account owns no workspaces, that section is omitted rather than shown empty.

`ConfirmModal` keeps its default `destructive` here.

- [ ] **Step 4: Run the tests and build**

Run: `cd apps/web && npm test && npm run build`

- [ ] **Step 5: Commit**

---

## Final verification

- [ ] `cd apps/api && npm test && npm run build` — expect 675 + roughly 40 new tests, typecheck clean
- [ ] `cd apps/web && npm test && npm run build` — expect 217 + new tests, build clean
- [ ] `cd apps/admin && npm test && npm run build` — expect 33 tests, build clean
- [ ] Run the adherence greps from `Skill/1 Build.md` against `apps/web`
- [ ] Confirm the Worker is still under Cloudflare's 1 MB limit — it was 226 KiB gzipped
- [ ] Update `CLAUDE.md`'s Status block and Information Route with the share-link surface and the 7-day window

## Notes for whoever executes this

- **Task 5's cascade test is a gate.** If deleting a file row does not delete its share row, the migration's central argument is wrong and Tasks 8 and 13 rest on something that is not true. Stop and fix the schema rather than working around it.
- **`AuthContext`'s real shape wins** over what Task 6 assumes. Read `middleware/auth.ts` before writing that handler and adapt; do not add fields to the context to make the plan's code compile.
- **Nothing lints the dashboard.** `apps/web` has no `lint` script, CI runs `npm run lint --if-present` and skips it silently, and CSS was never linted at all. The greps in `Skill/1 Build.md` are the only check that the import and token rules held.
- **Where this plan gives requirements instead of code, that is deliberate and marked.** Tasks 1–9 and 12 carry the code to write. Tasks 10, 11, 13 and 14 carry exact requirements, exact copy and a skeleton, because each depends on an interface this plan did not read in full — the design system's component props, the dashboard's route table, and `staff/users-access.ts`'s deletion signature. Writing speculative code against an unread interface would produce something that looks authoritative and does not compile. **Read the neighbouring file first** — `Claim.jsx` for Task 11, `Settings.jsx`'s existing workspace-delete dialog for Task 14, `users-access.ts` for Task 13 — then write to what is actually there.
- **The copy in Tasks 13 and 14 is not a draft.** It was argued sentence by sentence in the design discussion. Change the structure and you change what the product promises about reversibility.
