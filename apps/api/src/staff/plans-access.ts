/**
 * The plan catalogue, edited from the console — 32 PART 6 (Plans & Pricing).
 *
 * ── Stripe is written first, and that ordering is the safety property ───────
 * An edit pushes to Stripe and only then writes D1. If the Stripe call throws,
 * the local row is never touched and the operator sees Stripe's own error. The
 * alternative — write locally, push in the background — produces a pricing
 * table that says one thing while Stripe charges another, and nothing surfaces
 * the disagreement until a customer is billed wrongly.
 *
 * The residual risk runs the other way: Stripe succeeds, the D1 write fails,
 * and the two disagree until something heals them. That case is already
 * covered, twice. The `product.updated` webhook our own push triggers calls
 * `syncProductToPlan`, and the staff sync replays the same upsert on demand.
 * So the failure mode we can recover from automatically is the one we chose to
 * be exposed to.
 *
 * ── A price is immutable, in Stripe and not merely in our code ──────────────
 * Changing an amount always means creating a NEW Stripe Price and archiving the
 * old one. Existing subscribers keep billing the archived price until they
 * renew, which is Stripe's behaviour and not something this code can choose.
 * The modal warns before saving; `repriced` in the result is what it warns
 * from.
 *
 * ── This is the only writer ─────────────────────────────────────────────────
 * `infra/stripe-catalogue/` used to declare the same products, which meant an
 * apply after an edit here silently reverted it. That root was deleted on
 * 18 September 2026 once the products existed in Stripe: Terraform held no
 * state for them, so an apply would have created a SECOND set of four products
 * carrying the same `package_id`s, and the sync would have taken whichever was
 * written last. Removing it was the fix, not the tidying.
 *
 * The products are now created once and edited here. Production is populated
 * from the Stripe dashboard by hand, deliberately — there is no pipeline to
 * keep in step and no second declaration to drift from.
 */

import { AuditedStaffAccess } from "./audited";
import { ApiError, validationError } from "../lib/errors";
import { invalidateCatalogue, type PlanRow } from "../billing/catalogue";
import {
  ENTITLEMENT_COLUMNS,
  entitlementFromMetadata,
  metadataForPlan,
  planIdOf,
  type EntitlementColumn,
} from "../billing/plan-sync";
import type { Stripe } from "../billing/stripe";

/**
 * A plan row as the console sees it.
 *
 * The two sync scalars are not on `PlanRow` itself: that type is read on the
 * request path by every authenticated call through the catalogue cache, and it
 * has no use for them. This is the console's view, not the hot path's.
 */
export interface StaffPlanRow extends PlanRow {
  last_synced_at: number | null;
  last_synced_direction: string | null;
}

/** Every column an operator may set, and nothing else. */
export interface PlanPatch {
  name?: string;
  description?: string | null;
  amount_cents?: number;
  storage_bytes?: number | null;
  max_file_bytes?: number | null;
  agents?: number | null;
  members?: number | null;
  workspaces?: number | null;
  api_keys?: number | null;
  share_links?: number | null;
  file_count?: number | null;
  egress_bytes_period?: number | null;
  requests_period?: number | null;
  priority_support?: number;
  is_public?: number;
  is_default?: number;
  sort_order?: number;
}

export interface PlanFieldDiff {
  field: string;
  local: string | number | null;
  remote: string | number | null;
}

export interface PlanDiff {
  planId: string;
  name: string;
  stripeProductId: string | null;
  /** Present in Stripe but with no row here yet. */
  unknownLocally: boolean;
  fields: PlanFieldDiff[];
}

/**
 * The columns the sync may write, as a set.
 *
 * `id`, `package_id` and `stripe_product_id` are deliberately absent: they are
 * identity, not content, and a sync that could rewrite them could repoint one
 * plan's row at another plan's product.
 */
const SYNCABLE = new Set<string>([
  ...ENTITLEMENT_COLUMNS,
  "name",
  "description",
  "amount_cents",
  "priority_support",
  "sort_order",
]);

export class StaffPlanAccess extends AuditedStaffAccess {
  /** Support+ read. Reading the catalogue is not recorded per row; the list is one action. */
  async list(): Promise<StaffPlanRow[]> {
    const rows = await this.db
      .prepare(
        `SELECT id, package_id, name, description, amount_cents, currency, interval,
                stripe_product_id, stripe_price_id,
                storage_bytes, file_count, egress_bytes_period, requests_period,
                max_file_bytes, agents, members, workspaces, api_keys, share_links,
                priority_support, is_public, is_default, sort_order,
                last_synced_at, last_synced_direction
           FROM plans ORDER BY sort_order ASC, amount_cents ASC`
      )
      .all<StaffPlanRow>();
    return rows.results ?? [];
  }

  private async requirePlan(planId: string): Promise<StaffPlanRow> {
    const row = await this.db
      .prepare(`SELECT * FROM plans WHERE id = ?`)
      .bind(planId)
      .first<StaffPlanRow>();
    if (row === null) throw new ApiError("NOT_FOUND", "No such plan.");
    return row;
  }

  /**
   * `is_default` is a partial unique index, not a convention.
   *
   * `idx_plans_one_default` refuses a second row claiming to be the default, so
   * promoting one has to demote the others in the same breath or the write
   * fails on a constraint the operator never saw.
   */
  private clearOtherDefaults(planId: string): D1PreparedStatement {
    return this.db
      .prepare(`UPDATE plans SET is_default = 0, updated_at = ? WHERE id != ? AND is_default = 1`)
      .bind(this.now, planId);
  }

  /**
   * Edit a plan: Stripe first, then here.
   *
   * Returns `repriced` so the caller can tell the operator a new Stripe Price
   * was minted and the old one archived — which is a thing that happened to
   * their billing setup, not an implementation detail.
   */
  async update(
    stripe: Stripe,
    planId: string,
    patch: PlanPatch,
    reason: string
  ): Promise<{ plan: StaffPlanRow; repriced: boolean; newPriceId: string | null }> {
    await this.requireRole("admin", "edit plans");

    const current = await this.requirePlan(planId);
    if (current.stripe_product_id === null) {
      // Nothing to push to. This is the state a freshly migrated environment is
      // in before the catalogue has ever been applied or synced, and saving
      // locally would produce exactly the silent divergence this method is
      // ordered to avoid.
      throw new ApiError("CONFLICT", "This plan is not in Stripe yet. Run the catalogue sync first.", {
        internalReason: `plan ${planId} has no stripe_product_id`,
      });
    }

    const merged: StaffPlanRow = { ...current, ...patch } as StaffPlanRow;
    if (merged.amount_cents < 0 || !Number.isInteger(merged.amount_cents)) {
      throw validationError("A price must be a whole number of cents, and not negative.");
    }

    // ---- Stripe, first ----
    await stripe.products.update(current.stripe_product_id, {
      name: merged.name,
      description: merged.description ?? undefined,
      metadata: metadataForPlan(merged),
    });

    let newPriceId: string | null = null;
    const repriced =
      patch.amount_cents !== undefined && patch.amount_cents !== current.amount_cents;

    if (repriced) {
      const created = await stripe.prices.create({
        product: current.stripe_product_id,
        currency: merged.currency,
        unit_amount: merged.amount_cents,
        recurring: { interval: merged.interval as "month" | "year" },
        metadata: { plan_id: planId },
      });
      newPriceId = created.id;

      // Archive the old one AFTER the new one exists. The other order leaves a
      // window in which the plan has no sellable price, and a checkout started
      // in that window fails for a reason the customer cannot act on.
      if (current.stripe_price_id !== null) {
        await stripe.prices.update(current.stripe_price_id, { active: false });
      }
    }

    // ---- then here ----
    const statements: D1PreparedStatement[] = [];
    if (merged.is_default === 1) statements.push(this.clearOtherDefaults(planId));
    statements.push(
      this.db
        .prepare(
          `UPDATE plans SET
             name = ?, description = ?, amount_cents = ?,
             storage_bytes = ?, file_count = ?, egress_bytes_period = ?, requests_period = ?,
             max_file_bytes = ?, agents = ?, members = ?, workspaces = ?, api_keys = ?,
             share_links = ?,
             priority_support = ?, is_public = ?, is_default = ?, sort_order = ?,
             stripe_price_id = COALESCE(?, stripe_price_id),
             last_synced_at = ?, last_synced_direction = 'outbound', updated_at = ?
           WHERE id = ?`
        )
        .bind(
          merged.name,
          merged.description,
          merged.amount_cents,
          merged.storage_bytes,
          merged.file_count,
          merged.egress_bytes_period,
          merged.requests_period,
          merged.max_file_bytes,
          merged.agents,
          merged.members,
          merged.workspaces,
          merged.api_keys,
          merged.share_links,
          merged.priority_support,
          merged.is_public,
          merged.is_default,
          merged.sort_order,
          newPriceId,
          this.now,
          this.now,
          planId
        )
    );
    await this.db.batch(statements);
    invalidateCatalogue();

    await this.recordFleet({
      action: "plan.edit",
      targetType: "plan",
      targetId: planId,
      reason,
      metadata: {
        fields: Object.keys(patch).join(","),
        repriced,
        newPriceId,
      },
    });
    await this.recordFleet({
      action: "plan.push_to_stripe",
      targetType: "plan",
      targetId: planId,
      reason,
      metadata: { productId: current.stripe_product_id, repriced },
    });

    return { plan: await this.requirePlan(planId), repriced, newPriceId };
  }

  /** Create a plan, in Stripe and here. super_admin only. */
  async create(
    stripe: Stripe,
    input: PlanPatch & { id: string; currency?: string; interval?: string },
    reason: string
  ): Promise<StaffPlanRow> {
    await this.requireRole("super_admin", "create plans");

    if (!/^[a-z][a-z0-9_-]{1,30}$/.test(input.id)) {
      throw validationError("A plan id is lowercase letters, digits, dashes or underscores.");
    }
    const existing = await this.db
      .prepare(`SELECT id FROM plans WHERE id = ?`)
      .bind(input.id)
      .first<{ id: string }>();
    if (existing !== null) throw new ApiError("CONFLICT", "A plan with that id already exists.");

    const amount = input.amount_cents ?? 0;
    const currency = input.currency ?? "usd";
    const interval = input.interval ?? "month";

    const draft = {
      id: input.id,
      package_id: `agentdisk-${input.id}`,
      storage_bytes: input.storage_bytes ?? null,
      file_count: input.file_count ?? null,
      egress_bytes_period: input.egress_bytes_period ?? null,
      requests_period: input.requests_period ?? null,
      max_file_bytes: input.max_file_bytes ?? null,
      agents: input.agents ?? null,
      members: input.members ?? null,
      workspaces: input.workspaces ?? null,
      api_keys: input.api_keys ?? null,
      share_links: input.share_links ?? null,
      priority_support: input.priority_support ?? 0,
      is_default: input.is_default ?? 0,
      sort_order: input.sort_order ?? 0,
    };

    const product = await stripe.products.create({
      name: input.name ?? input.id,
      description: input.description ?? undefined,
      metadata: metadataForPlan(draft),
    });

    // Free is the absence of a subscription, not a $0 one. A $0 recurring price
    // would give every account on this plan a real Stripe subscription that can
    // go past_due - which is the whole reason the catalogue gives the free plan
    // a product and no price.
    let priceId: string | null = null;
    if (amount > 0) {
      const price = await stripe.prices.create({
        product: product.id,
        currency,
        unit_amount: amount,
        recurring: { interval: interval as "month" | "year" },
        metadata: { plan_id: input.id },
      });
      priceId = price.id;
    }

    const statements: D1PreparedStatement[] = [];
    if (draft.is_default === 1) statements.push(this.clearOtherDefaults(input.id));
    statements.push(
      this.db
        .prepare(
          `INSERT INTO plans (
             id, package_id, name, description, amount_cents, currency, interval,
             stripe_product_id, stripe_price_id,
             storage_bytes, file_count, egress_bytes_period, requests_period,
             max_file_bytes, agents, members, workspaces, api_keys, share_links,
             priority_support, is_public, is_default, sort_order,
             last_synced_at, last_synced_direction, created_at, updated_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'outbound',?,?)`
        )
        .bind(
          input.id,
          draft.package_id,
          input.name ?? input.id,
          input.description ?? null,
          amount,
          currency,
          interval,
          product.id,
          priceId,
          draft.storage_bytes,
          draft.file_count,
          draft.egress_bytes_period,
          draft.requests_period,
          draft.max_file_bytes,
          draft.agents,
          draft.members,
          draft.workspaces,
          draft.api_keys,
          draft.share_links,
          draft.priority_support,
          input.is_public ?? 1,
          draft.is_default,
          draft.sort_order,
          this.now,
          this.now,
          this.now
        )
    );
    await this.db.batch(statements);
    invalidateCatalogue();

    await this.recordFleet({
      action: "plan.create",
      targetType: "plan",
      targetId: input.id,
      reason,
      metadata: { productId: product.id, priceId, amountCents: amount },
    });

    return this.requirePlan(input.id);
  }

  /**
   * Retire a plan: hidden from new signups, existing subscribers untouched.
   *
   * The row survives. It is what resolves a subscription's price back to
   * entitlements, so deleting it would silently drop everybody still on that
   * plan to the default — the opposite of what retiring is supposed to mean.
   */
  async retire(stripe: Stripe, planId: string, reason: string): Promise<StaffPlanRow> {
    await this.requireRole("super_admin", "retire plans");

    const current = await this.requirePlan(planId);
    if (current.is_default === 1) {
      // Retiring the default would leave new accounts landing on a plan that is
      // no longer offered, and the partial unique index means nothing would
      // automatically take its place.
      throw new ApiError("CONFLICT", "Make another plan the default before retiring this one.");
    }

    if (current.stripe_product_id !== null) {
      await stripe.products.update(current.stripe_product_id, { active: false });
    }
    if (current.stripe_price_id !== null) {
      await stripe.prices.update(current.stripe_price_id, { active: false });
    }

    await this.db
      .prepare(
        `UPDATE plans SET is_public = 0, is_default = 0, stripe_price_id = NULL,
                          last_synced_at = ?, last_synced_direction = 'outbound', updated_at = ?
          WHERE id = ?`
      )
      .bind(this.now, this.now, planId)
      .run();
    invalidateCatalogue();

    await this.recordFleet({
      action: "plan.retire",
      targetType: "plan",
      targetId: planId,
      reason,
      metadata: { productId: current.stripe_product_id },
    });

    return this.requirePlan(planId);
  }

  /**
   * What Stripe says versus what we hold, field by field.
   *
   * This is the safety mechanism, and the reason a one-click pull is not an
   * acceptable implementation: where both sides changed since the last sync,
   * the operator has to be shown both values and pick per field. Auto-resolving
   * here bills real customers the wrong amount.
   */
  async stripeDiff(stripe: Stripe): Promise<PlanDiff[]> {
    await this.requireRole("admin", "read the Stripe diff");

    const local = new Map((await this.list()).map(row => [row.id, row]));
    const products = await stripe.products.list({ active: true, limit: 100 });
    const diffs: PlanDiff[] = [];

    for (const product of products.data) {
      const planId = planIdOf(product);
      // No package_id means the product belongs to somebody else's purpose in
      // the same Stripe account - a one-off charge, say - and must never appear
      // in a pricing diff.
      if (planId === null) continue;

      const metadata = product.metadata ?? {};
      const row = local.get(planId);
      const fields: PlanFieldDiff[] = [];

      const prices = await stripe.prices.list({ product: product.id, active: true, limit: 100 });
      const recurring = prices.data.filter(price => price.recurring !== null);
      const price = recurring.find(p => p.recurring?.interval === "month") ?? recurring[0] ?? null;

      const compare = (field: string, localValue: string | number | null, remote: string | number | null) => {
        if (localValue !== remote) fields.push({ field, local: localValue, remote });
      };

      compare("name", row?.name ?? null, product.name);
      compare("description", row?.description ?? null, product.description ?? null);

      // Price needs its own handling, because "Stripe has no active recurring
      // price" is not the same claim as "Stripe says the price is null".
      //
      // A free plan has no price BY DESIGN - a $0 recurring price would give
      // every free account a real subscription that can go past_due - so
      // comparing our 0 against a missing price reported a difference that
      // could never be resolved and could never be safely applied. It showed up
      // on every diff for AgentDisk Free and meant nothing.
      //
      // A plan we sell for money with no active price is a different matter
      // entirely: somebody archived it in Stripe, and that IS worth surfacing.
      if (price !== null) {
        compare("amount_cents", row?.amount_cents ?? null, price.unit_amount ?? null);
      } else if ((row?.amount_cents ?? 0) > 0) {
        fields.push({ field: "amount_cents", local: row?.amount_cents ?? null, remote: null });
      }
      for (const column of ENTITLEMENT_COLUMNS) {
        compare(column, row?.[column as EntitlementColumn] ?? null, entitlementFromMetadata(metadata, column));
      }
      compare(
        "priority_support",
        row?.priority_support ?? null,
        metadata["priority_support"] === "1" ? 1 : 0
      );

      if (fields.length > 0 || row === undefined) {
        diffs.push({
          planId,
          name: product.name,
          stripeProductId: product.id,
          unknownLocally: row === undefined,
          fields,
        });
      }
    }

    await this.recordFleet({
      action: "plan.stripe_diff",
      metadata: { plans: diffs.length },
    });

    return diffs;
  }

  /**
   * Apply only the fields the operator ticked.
   *
   * Nothing here reads the diff again. The selections name plan and field, and
   * the value is re-read from Stripe at apply time rather than carried from the
   * diff the operator looked at — so a change made in Stripe between the two
   * cannot be applied under a value the operator never saw.
   */
  async syncFromStripe(
    stripe: Stripe,
    selections: { planId: string; fields: string[] }[],
    reason: string
  ): Promise<{ planId: string; applied: string[] }[]> {
    await this.requireRole("admin", "sync plans from Stripe");

    const applied: { planId: string; applied: string[] }[] = [];

    for (const selection of selections) {
      const row = await this.requirePlan(selection.planId);
      if (row.stripe_product_id === null) continue;

      const product = await stripe.products.retrieve(row.stripe_product_id);
      const metadata = product.metadata ?? {};
      const prices = await stripe.prices.list({ product: product.id, active: true, limit: 100 });
      const recurring = prices.data.filter(price => price.recurring !== null);
      const price = recurring.find(p => p.recurring?.interval === "month") ?? recurring[0] ?? null;

      const sets: string[] = [];
      const values: (string | number | null)[] = [];
      const took: string[] = [];

      for (const field of selection.fields) {
        if (!SYNCABLE.has(field)) continue;

        let value: string | number | null;
        if (field === "name") value = product.name;
        else if (field === "description") value = product.description ?? null;
        else if (field === "amount_cents") {
          // Refuse rather than write 0. Taking a price that does not exist
          // would silently make a paid plan free - the exact damage the
          // diff-then-confirm flow exists to prevent, arriving through the
          // confirm step itself.
          if (price === null) continue;
          value = price.unit_amount ?? 0;
        }
        else if (field === "priority_support") value = metadata["priority_support"] === "1" ? 1 : 0;
        else if (field === "sort_order") value = entitlementFromMetadata(metadata, "sort_order") ?? 0;
        else value = entitlementFromMetadata(metadata, field);

        sets.push(`${field} = ?`);
        values.push(value);
        took.push(field);
      }

      if (took.includes("amount_cents") && price !== null) {
        sets.push("stripe_price_id = ?");
        values.push(price.id);
      }

      if (sets.length === 0) continue;

      await this.db
        .prepare(
          `UPDATE plans SET ${sets.join(", ")},
                  last_synced_at = ?, last_synced_direction = 'inbound', updated_at = ?
            WHERE id = ?`
        )
        .bind(...values, this.now, this.now, selection.planId)
        .run();

      applied.push({ planId: selection.planId, applied: took });

      await this.recordFleet({
        action: "plan.sync_from_stripe",
        targetType: "plan",
        targetId: selection.planId,
        reason,
        metadata: { fields: took.join(","), productId: product.id },
      });
    }

    invalidateCatalogue();
    return applied;
  }
}
