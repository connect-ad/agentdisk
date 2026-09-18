/**
 * Stripe Product -> D1 `plans`, through one upsert that every caller shares.
 *
 * ── Why one function and not two ────────────────────────────────────────────
 * Three things can change the catalogue: a `product.created`/`product.updated`
 * webhook, an operator running the staff sync, and an edit made directly in the
 * Stripe dashboard (which arrives as the same webhook). amardrive's reference
 * architecture makes the point explicitly — its `/admin/packages/sync` replays
 * *the same* `onStripeProductChanged` upsert the webhook uses, so a missed
 * delivery, a dashboard edit and a manual reconcile all heal through identical
 * code. Two implementations would drift, and the drift would only ever show up
 * as somebody's entitlements being subtly wrong.
 *
 * ── Why entitlements live in metadata ───────────────────────────────────────
 * Stripe has no concept of "50 GB of storage" or "ten agent identities". It
 * knows products, prices and currencies. So the entitlements ride as strings in
 * `Product.metadata`, and `metadata.package_id` is the join key: a product
 * without one is not ours and is ignored entirely. That is what stops an
 * unrelated one-off charge in the same Stripe account appearing in the pricing
 * table.
 *
 * ── Why the price is fetched rather than read off the product ───────────────
 * `Product.default_price` is only set when the price was created *through* the
 * product. Ours are separate resources in Terraform, so the product carries no
 * pointer to them. Listing the product's active prices is also the more honest
 * question: it asks Stripe what this product can currently be sold at, rather
 * than trusting a field that may describe a price we have since archived.
 *
 * A consequence worth stating: `product.created` usually arrives BEFORE its
 * price exists, because Terraform creates the product first. That delivery
 * writes the row with a NULL price, and the price lands on the next
 * `product.updated` or - reliably - when the staff sync runs. This is why the
 * catalogue pipeline's summary tells you to run the sync after an apply, and
 * why checkout refuses a plan with no price instead of assuming one.
 */

import type { Stripe } from "./stripe";
import { invalidateCatalogue } from "./catalogue";

/** Every product of ours carries this prefix in `package_id`. Nothing else is ours. */
const PACKAGE_PREFIX = "agentdisk-";

/** What a metadata key can say, and what it means in the column. */
const UNLIMITED_COLUMN = -1;

/**
 * Read one entitlement out of product metadata.
 *
 * Three outcomes, mirroring migration 0012's three column states:
 *
 *   absent / unparseable -> null, meaning "this row does not say", which the
 *                           resolver answers from the lib/plans.ts floor
 *   "unlimited"          -> -1
 *   a number             -> that number
 *
 * Unparseable resolving to null rather than to 0 matters. A typo'd metadata
 * value is an unknown, and an unknown must fall to the floor; reading it as 0
 * would set somebody's storage limit to zero bytes and lock them out of their
 * own account on a misspelling.
 */
function entitlement(metadata: Stripe.Metadata, key: string): number | null {
  const raw = metadata[key];
  if (raw === undefined || raw === "") return null;
  if (raw.trim().toLowerCase() === "unlimited") return UNLIMITED_COLUMN;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.trunc(parsed);
}

/** A metadata flag. Absent reads as false, which is the tighter answer. */
function flag(metadata: Stripe.Metadata, key: string): number {
  return metadata[key] === "1" || metadata[key]?.toLowerCase() === "true" ? 1 : 0;
}

/**
 * Our plan id for a Stripe product, or null if it is not ours.
 *
 * `metadata.plan_id` is authoritative when present; otherwise the
 * `agentdisk-` prefix is stripped from `package_id`. Both are written by the
 * catalogue Terraform, and accepting either means a product created by hand in
 * the dashboard only needs the one key everybody remembers.
 */
export function planIdOf(product: Stripe.Product): string | null {
  const metadata = product.metadata ?? {};
  const packageId = metadata["package_id"];

  // The prefix is the ownership test, not decoration.
  //
  // This used to accept ANY package_id and return it unchanged when it lacked
  // the prefix. The comment above said a product without one "is not ours and
  // is ignored entirely" - but the check was for PRESENCE, not ownership, and
  // the two came apart the moment a real account was looked at: this Stripe
  // account also holds a sibling product's catalogue, four live products keyed
  // `amardrive-*`. Under the old rule a sync would have written plan rows called
  // `amardrive-pro` into this product's entitlement table, and the Plans screen
  // would have offered them.
  //
  // A shared Stripe account is the normal case, not an edge one. Anything that
  // is not explicitly ours is somebody else's.
  if (packageId === undefined || !packageId.startsWith(PACKAGE_PREFIX)) return null;

  // `plan_id` names the plan within our own namespace; it cannot be used to
  // claim a product that failed the test above.
  const explicit = metadata["plan_id"];
  if (explicit !== undefined && explicit !== "") return explicit;

  return packageId.slice(PACKAGE_PREFIX.length);
}

/** The monthly recurring price this product can currently be sold at. */
async function activeMonthlyPrice(
  stripe: Stripe,
  productId: string
): Promise<Stripe.Price | null> {
  const prices = await stripe.prices.list({ product: productId, active: true, limit: 100 });

  // Recurring only: a one-off price attached to a plan product would be a
  // mistake, and subscribing somebody to it would be a worse one.
  const recurring = prices.data.filter((price) => price.recurring !== null);
  const monthly = recurring.find((price) => price.recurring?.interval === "month");

  // Falls back to any recurring price rather than none, so an annual-only plan
  // is still sellable. `interval` is mirrored into the row, so the catalogue
  // records which it actually found rather than assuming monthly.
  return monthly ?? recurring[0] ?? null;
}

export interface PlanUpsert {
  planId: string;
  priceId: string | null;
}

/**
 * Mirror one Stripe product into `plans`.
 *
 * Returns null when the product is not ours — no `package_id`, so not part of
 * this catalogue. Silence is correct there: the Stripe account may legitimately
 * hold products this product knows nothing about.
 */
export async function syncProductToPlan(
  db: D1Database,
  stripe: Stripe,
  product: Stripe.Product,
  now: number
): Promise<PlanUpsert | null> {
  const planId = planIdOf(product);
  if (planId === null) return null;

  const metadata = product.metadata ?? {};
  const price = product.active ? await activeMonthlyPrice(stripe, product.id) : null;

  await db
    .prepare(
      `INSERT INTO plans (
         id, package_id, name, description,
         amount_cents, currency, interval,
         stripe_product_id, stripe_price_id,
         storage_bytes, file_count, egress_bytes_period, requests_period,
         max_file_bytes, agents, members, workspaces, api_keys,
         priority_support, is_public, is_default, sort_order,
         created_at, updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         package_id = excluded.package_id,
         name = excluded.name,
         description = excluded.description,
         amount_cents = excluded.amount_cents,
         currency = excluded.currency,
         interval = excluded.interval,
         stripe_product_id = excluded.stripe_product_id,
         stripe_price_id = excluded.stripe_price_id,
         storage_bytes = excluded.storage_bytes,
         file_count = excluded.file_count,
         egress_bytes_period = excluded.egress_bytes_period,
         requests_period = excluded.requests_period,
         max_file_bytes = excluded.max_file_bytes,
         agents = excluded.agents,
         members = excluded.members,
         workspaces = excluded.workspaces,
         api_keys = excluded.api_keys,
         priority_support = excluded.priority_support,
         is_public = excluded.is_public,
         is_default = excluded.is_default,
         sort_order = excluded.sort_order,
         updated_at = excluded.updated_at`
    )
    .bind(
      planId,
      metadata["package_id"] ?? null,
      product.name,
      product.description ?? null,
      price?.unit_amount ?? 0,
      price?.currency ?? "usd",
      price?.recurring?.interval ?? "month",
      product.id,
      price?.id ?? null,
      entitlement(metadata, "storage_bytes"),
      entitlement(metadata, "file_count"),
      entitlement(metadata, "egress_bytes_period"),
      entitlement(metadata, "requests_period"),
      entitlement(metadata, "max_file_bytes"),
      entitlement(metadata, "agents"),
      entitlement(metadata, "members"),
      entitlement(metadata, "workspaces"),
      entitlement(metadata, "api_keys"),
      flag(metadata, "priority_support"),
      // An archived product stays in the table but stops being offered, so
      // somebody already on it keeps their entitlements. Deleting the row would
      // drop every current subscriber to the default plan.
      product.active ? 1 : 0,
      flag(metadata, "is_default"),
      entitlement(metadata, "sort_order") ?? 0,
      now,
      now
    )
    .run();

  invalidateCatalogue();
  return { planId, priceId: price?.id ?? null };
}

/**
 * `product.deleted`, and an archived product.
 *
 * Marks the plan unsellable rather than removing it. The row is what resolves a
 * subscription's price back to entitlements, so deleting it would silently drop
 * everybody still on that plan to the default - which is the opposite of what
 * retiring a plan is supposed to mean. amardrive takes the same position and
 * refuses a hard delete outright once any subscription has referenced a package.
 *
 * `is_default` is cleared too: a retired plan must not remain the thing new
 * accounts land on, and the partial unique index would in any case refuse a
 * second row claiming to be default.
 */
export async function retirePlanForProduct(
  db: D1Database,
  product: Stripe.Product,
  now: number
): Promise<string | null> {
  const planId = planIdOf(product);
  if (planId === null) return null;

  await db
    .prepare(
      `UPDATE plans
          SET is_public = 0, is_default = 0, stripe_price_id = NULL, updated_at = ?
        WHERE id = ?`
    )
    .bind(now, planId)
    .run();

  invalidateCatalogue();
  return planId;
}

/* ------------------------- the other direction --------------------------- */

/**
 * A plan row rendered back into Stripe product metadata.
 *
 * Deliberately in this file, beside `entitlement` and `flag`, because the two
 * directions are one translation and separating them is how they drift. The
 * property that has to hold is a round trip: metadata written here must be read
 * back by `syncProductToPlan` into the same column values, or an admin edit
 * followed by the webhook it triggers would silently change the entitlement it
 * just set.
 *
 * The three column states map back exactly as they came:
 *
 *   null -> the key is OMITTED, not written as "" or "0". Absent is what the
 *           decoder turns into "this row did not say", which defers to the
 *           lib/plans.ts floor. Writing "0" would set a real limit of zero.
 *   -1   -> "unlimited"
 *   n    -> "n"
 */
export function metadataForPlan(row: {
  id: string;
  package_id: string | null;
  storage_bytes: number | null;
  file_count: number | null;
  egress_bytes_period: number | null;
  requests_period: number | null;
  max_file_bytes: number | null;
  agents: number | null;
  members: number | null;
  workspaces: number | null;
  api_keys: number | null;
  priority_support: number;
  is_default: number;
  sort_order: number;
}): Record<string, string> {
  const metadata: Record<string, string> = {
    package_id: row.package_id ?? `agentdisk-${row.id}`,
    plan_id: row.id,
    priority_support: row.priority_support === 1 ? "1" : "0",
    is_default: row.is_default === 1 ? "1" : "0",
    sort_order: String(row.sort_order),
  };

  const numeric: [string, number | null][] = [
    ["storage_bytes", row.storage_bytes],
    ["file_count", row.file_count],
    ["egress_bytes_period", row.egress_bytes_period],
    ["requests_period", row.requests_period],
    ["max_file_bytes", row.max_file_bytes],
    ["agents", row.agents],
    ["members", row.members],
    ["workspaces", row.workspaces],
    ["api_keys", row.api_keys],
  ];

  for (const [key, value] of numeric) {
    if (value === null) continue;
    metadata[key] = value === UNLIMITED_COLUMN ? "unlimited" : String(value);
  }

  return metadata;
}

/** The entitlement columns, in the order every screen and diff presents them. */
export const ENTITLEMENT_COLUMNS = [
  "storage_bytes",
  "max_file_bytes",
  "agents",
  "members",
  "workspaces",
  "api_keys",
  "file_count",
  "egress_bytes_period",
  "requests_period",
] as const;

export type EntitlementColumn = (typeof ENTITLEMENT_COLUMNS)[number];

/** Read one entitlement out of metadata, for callers outside this module. */
export function entitlementFromMetadata(
  metadata: Stripe.Metadata,
  key: string
): number | null {
  return entitlement(metadata, key);
}
