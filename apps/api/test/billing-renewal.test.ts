/**
 * The renewal ladder — `jobs/billing-renewal.ts`.
 *
 * AgentDisk auto-renews (owner's decision, 25 September 2026). Stripe raises the
 * invoice and retries a failure; this job gives notice before a charge, and when
 * collection fails it runs the ladder that ends in deletion: locked at the
 * failure, scheduled at day +7, purged at day +14.
 *
 * **The ladder is anchored on `past_due_since`, never on `current_period_end`.**
 * Under auto-renewal a period end is a non-event — it passes, Stripe charges,
 * and a new one is mirrored in — so an account whose period end is in the past
 * is usually one that renewed perfectly. Expiring on that would lock out paying
 * customers on every renewal day, which is why several tests below set a
 * period end in the past and assert that nothing happens.
 *
 * Two properties are worth more than all the others here and are tested first:
 * **it reports before it acts**, and **a successful payment takes back a
 * scheduled deletion**. The first is what stops a deploy emptying an
 * environment; the second is what stops a paying customer losing their files.
 */

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { runRenewalLadder, type RenewalResult } from "../src/jobs/billing-renewal";
import type { EmailConfig } from "../src/lib/email";
import {
  RENEWAL_GRACE_MS,
  RENEWAL_NOTICE_MS,
  RENEWAL_REMINDER_MS,
} from "../src/lib/renewal";
import { NOW, ORG_ID, seedTwoWorkspaces } from "./helpers";

const DAY = 24 * 60 * 60 * 1000;
const DASHBOARD = "https://app-dev.agentdisk.io";

/** Every message this suite watched go out, in order. */
interface Sent {
  to: string;
  subject: string;
  body: string;
}

let sent: Sent[] = [];
let failNextSend = false;

/**
 * Email, stubbed at the binding.
 *
 * `lib/email.ts` sends through Cloudflare Email Service's `send_email` binding,
 * so the stub is an object with a `send` method rather than an intercepted
 * `fetch`. Stubbing at this level still runs the real templates, which is the
 * point: a subject line that stops naming the plan, or a body that stops saying
 * nothing has been deleted, is a real regression and this is where it surfaces.
 */
function emailStub(): EmailConfig {
  return {
    binding: {
      send: async (message: { to: string; subject: string; text: string }) => {
        if (failNextSend) {
          failNextSend = false;
          throw Object.assign(new Error("service unavailable"), { code: "E_TEMPORARY" });
        }
        sent.push({ to: message.to, subject: message.subject, body: message.text });
        return { messageId: "msg_test" };
      },
    } as unknown as SendEmail,
  };
}

function run(overrides: Partial<Parameters<typeof runRenewalLadder>[0]> = {}): Promise<RenewalResult> {
  return runRenewalLadder({
    db: env.DB,
    email: emailStub(),
    dashboardUrl: DASHBOARD,
    now: NOW,
    dryRun: false,
    ...overrides,
  });
}

/**
 * A live subscription renewing on `endsAt`.
 *
 * The subscription id matters: the reminder pass requires one, so a comped
 * account with a hand-set period is never promised a charge that nothing will
 * raise.
 */
async function setPeriod(endsAt: number | null, status = "active"): Promise<void> {
  await env.DB.prepare(
    `UPDATE organizations SET current_period_end = ?, billing_status = ?, plan = 'pro',
            billing_interval = 'month', stripe_subscription_id = 'sub_live',
            cancel_at_period_end = 0
      WHERE id = ?`
  )
    .bind(endsAt, status, ORG_ID)
    .run();
}

/**
 * An account whose renewal charge failed at `since`.
 *
 * This is what day 0 of the ladder actually looks like, and it is a different
 * fact from the period having ended — Stripe raises the invoice, attempts it,
 * and only then reports the failure, so the two moments can be days apart.
 */
async function setDunning(since: number, status = "past_due"): Promise<void> {
  await env.DB.prepare(
    `UPDATE organizations SET billing_status = ?, past_due_since = ?, plan = 'pro',
            billing_interval = 'month', stripe_subscription_id = 'sub_live',
            current_period_end = ?, cancel_at_period_end = 0
      WHERE id = ?`
  )
    .bind(status, since, since, ORG_ID)
    .run();
}

interface OrgRow {
  plan: string;
  billing_status: string;
  purge_after: number | null;
  purged_at: number | null;
}

async function org(): Promise<OrgRow> {
  const row = await env.DB.prepare(
    `SELECT plan, billing_status, purge_after, purged_at FROM organizations WHERE id = ?`
  )
    .bind(ORG_ID)
    .first<OrgRow>();
  if (row === null) throw new Error("organization missing");
  return row;
}

beforeEach(async () => {
  await seedTwoWorkspaces();
  await env.DB.prepare(`DELETE FROM notifications_sent`).run();
  await env.DB.prepare(
    `UPDATE organizations SET current_period_end = NULL, purge_after = NULL,
            billing_status = 'active', owner_user_id = 'usr_TESTUSER',
            past_due_since = NULL, billing_interval = NULL,
            cancel_at_period_end = 0, stripe_subscription_id = NULL
      WHERE id = ?`
  )
    .bind(ORG_ID)
    .run();
  // `seedTwoWorkspaces` inserts no slug, but migration 0009 backfills every
  // real row, so a slugless workspace is a fixture artefact rather than a state
  // this job will meet. Give them one, and let the fallback have its own test.
  await env.DB.prepare(
    `UPDATE workspaces SET slug = 'workspace-a' WHERE id = 'ws_AAAAAAAAAAAAAAAAAAAAAAAAAA'`
  ).run();
  // The catalogue is restored every time. One test below zeroes Pro's price to
  // prove the notice stays silent without one, and a leaked zero would silently
  // disable every reminder assertion after it — the failure would read as "the
  // reminder pass is broken" rather than "the fixture leaked".
  await env.DB.prepare(
    `UPDATE plans SET amount_cents = 2000, amount_cents_yearly = NULL,
            stripe_yearly_price_id = NULL WHERE id = 'pro'`
  ).run();
  sent = [];
  failNextSend = false;
});

describe("it reports before it acts", () => {
  it("defaults to a dry run, so a deploy cannot expire anything on its first tick", async () => {
    await setDunning(NOW - RENEWAL_GRACE_MS - DAY);

    // No `dryRun` at all — the default is what ships.
    const result = await runRenewalLadder({
      db: env.DB,
      email: emailStub(),
      dashboardUrl: DASHBOARD,
      now: NOW,
    });

    expect(result.dryRun).toBe(true);
    expect(result.candidates.expiry).toHaveLength(1);
    expect(result.expired).toBe(0);
    // Unchanged: still mid-dunning, not moved on to `expired`.
    expect((await org()).billing_status).toBe("past_due");
    expect(sent).toHaveLength(0);
  });

  it("names every candidate in a dry run, not just a count", async () => {
    // This is the artifact somebody reads before setting BILLING_EXPIRY_ENABLED.
    await setDunning(NOW - RENEWAL_GRACE_MS - DAY);
    const result = await run({ dryRun: true });

    expect(result.candidates.expiry[0]).toMatchObject({
      orgId: ORG_ID,
      plan: "pro",
      pastDueSince: NOW - RENEWAL_GRACE_MS - DAY,
    });
  });
});

describe("day -7 · notice of the renewal charge", () => {
  it("names the date and the amount, because that is the whole content", async () => {
    // Advance notice of a charge, not a request to act. A notice that says only
    // "your plan renews soon" leaves the customer unable to check it against
    // their statement, which is the one thing the message is for — and in
    // several jurisdictions the thing that makes it a compliant notice.
    await setPeriod(NOW + 3 * DAY);
    const result = await run();

    expect(result.reminded).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toMatch(/renews on/i);
    expect(sent[0]!.subject).toMatch(/\$/);
    expect(sent[0]!.body).toMatch(/renews automatically/i);
    expect(sent[0]!.body).toMatch(/\$\d/);
    expect(sent[0]!.body).toContain(`${DASHBOARD}/w/`);
  });

  it("says nothing to an account that has already cancelled", async () => {
    // The single most alarming message this product could send. Somebody who
    // cancelled last week, told their plan renews on the date it is actually
    // ending, reads it as the cancellation having failed.
    await setPeriod(NOW + 3 * DAY);
    await env.DB.prepare(`UPDATE organizations SET cancel_at_period_end = 1 WHERE id = ?`)
      .bind(ORG_ID)
      .run();

    const result = await run();
    expect(result.reminded).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("says nothing when it cannot quote a price", async () => {
    // Deliberately silent rather than sending an amount-less renewal warning:
    // the amount IS the message, and a notice without it fails the disclosure
    // it exists to satisfy.
    await setPeriod(NOW + 3 * DAY);
    await env.DB.prepare(`UPDATE plans SET amount_cents = 0 WHERE id = 'pro'`).run();

    const result = await run();
    expect(result.reminded).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("falls back to the dashboard root when the org has no live workspace", async () => {
    // A renew link that 404s is worse than a generic one.
    await env.DB.prepare(`UPDATE workspaces SET slug = NULL WHERE org_id = ?`).bind(ORG_ID).run();
    await setPeriod(NOW + 3 * DAY);
    await run();

    expect(sent[0]!.body).toContain(`${DASHBOARD}/app`);
  });

  it("leaves an account with weeks to go alone", async () => {
    await setPeriod(NOW + 20 * DAY);
    const result = await run();

    expect(result.reminded).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("sends once however often the hourly cron runs", async () => {
    // Without the unique index behind this, a week of hourly ticks is 168
    // copies of the same warning.
    await setPeriod(NOW + 3 * DAY);
    await run();
    await run();
    await run();

    expect(sent).toHaveLength(1);
  });

  it("retries next tick when the provider refuses", async () => {
    // The row is claimed AFTER a successful send, so a failure leaves nothing
    // behind and the message is not silently lost.
    await setPeriod(NOW + 3 * DAY);

    failNextSend = true;
    const first = await run();
    expect(first.emailsFailed).toBe(1);
    expect(sent).toHaveLength(0);

    const second = await run();
    expect(second.emailsSent).toBe(1);
    expect(sent).toHaveLength(1);
  });
});

describe("day +7 · dunning runs out", () => {
  it("does nothing to an account whose period merely ended", async () => {
    // The trap this design has to avoid. Under auto-renewal a period end is a
    // non-event — Stripe charges and mirrors in a new one — so an account
    // sitting past its period end is almost always one that renewed perfectly.
    // Expiring on that alone would lock out paying customers on renewal day.
    await setPeriod(NOW - 3 * DAY);

    const result = await run();
    expect(result.expired).toBe(0);
    expect((await org()).billing_status).toBe("active");
  });

  it("leaves an account inside the grace window alone", async () => {
    await setDunning(NOW - 2 * DAY);
    const result = await run();

    expect(result.expired).toBe(0);
    expect((await org()).billing_status).toBe("past_due");
  });

  it("locks writes and keeps the paid plan", async () => {
    await setDunning(NOW - RENEWAL_GRACE_MS - DAY);
    const result = await run();

    expect(result.expired).toBe(1);
    const row = await org();
    expect(row.billing_status).toBe("expired");
    // Deliberately NOT dropped to free. A 40 GB Pro account moved to Free's
    // 1 GB is instantly over quota through no act of its own, and every usage
    // screen would report a breach the customer cannot fix except by deleting
    // files during the exact window we are asking them to fix their card in.
    expect(row.plan).toBe("pro");
  });

  it("tells them the card failed, and that nothing has been deleted", async () => {
    // Sent while dunning is still running, which is the point: it turns "my
    // uploads stopped working" into "my card expired", and the earlier it lands
    // the more likely they fix it before the ladder reaches deletion.
    await setDunning(NOW - 2 * DAY);
    await run();

    const notice = sent.find(message => /payment failed/i.test(message.subject));
    expect(notice).toBeDefined();
    expect(notice!.body).toMatch(/nothing has been deleted/i);
    expect(notice!.body).toMatch(/readable and downloadable/i);
    expect(notice!.body).toMatch(/expired or replaced card/i);
  });

  it("expires even when the message cannot be sent", async () => {
    // A billing failure that quietly grants free service is the direction never
    // to fail in. An expired provider key must not stop accounts expiring.
    await setDunning(NOW - RENEWAL_GRACE_MS - DAY);
    const result = await run({ email: null });

    expect(result.expired).toBe(1);
    expect(result.emailSkipped).toBe(true);
    expect((await org()).billing_status).toBe("expired");
  });

  it("expires an account whose owner row has no address", async () => {
    // An inner join on `users` here would mean an organization with no
    // reachable owner never expires — service granted forever by an absence.
    await setDunning(NOW - RENEWAL_GRACE_MS - DAY);
    await env.DB.prepare(`UPDATE organizations SET owner_user_id = 'usr_GONE' WHERE id = ?`)
      .bind(ORG_ID)
      .run();

    const result = await run();
    expect(result.expired).toBe(1);
    expect(result.unreachable).toBeGreaterThan(0);
    expect((await org()).billing_status).toBe("expired");
  });

  it("is idempotent across ticks", async () => {
    await setDunning(NOW - RENEWAL_GRACE_MS - DAY);
    await run();
    const second = await run();

    expect(second.expired).toBe(0);
    expect(sent.filter(m => /payment failed/i.test(m.subject))).toHaveLength(1);
  });
});

describe("day +7 · deletion scheduling", () => {
  it("stamps an account Stripe has given up on", async () => {
    // `expired` is reached either by the webhook — when Stripe deletes the
    // subscription after exhausting its retries — or by the pass above from our
    // own clock. Both arrive here.
    await setDunning(NOW - RENEWAL_GRACE_MS - DAY, "expired");
    const result = await run();

    expect(result.deletionsScheduled).toBe(1);
    expect((await org()).purge_after).not.toBeNull();
  });

  it("leaves a still-dunning account alone", async () => {
    await setDunning(NOW - 2 * DAY);
    const result = await run();

    expect(result.deletionsScheduled).toBe(0);
    expect((await org()).purge_after).toBeNull();
  });

  it("tells them, and says starting a plan again still undoes it", async () => {
    // Scheduling the deletion of a customer's files without saying so at the
    // moment it happens is indefensible.
    await setDunning(NOW - RENEWAL_GRACE_MS - DAY, "expired");
    await run();

    const notice = sent.find(message => /scheduled for deletion/i.test(message.subject));
    expect(notice).toBeDefined();
    expect(notice!.body).toMatch(/nothing has been removed yet/i);
    expect(notice!.body).toMatch(/cancels the deletion/i);
  });

  it("never stamps an account twice", async () => {
    await setDunning(NOW - RENEWAL_GRACE_MS - DAY, "expired");
    await run();
    const stamped = (await org()).purge_after;

    const second = await run();
    expect(second.deletionsScheduled).toBe(0);
    expect((await org()).purge_after).toBe(stamped);
  });

  it("does not touch an account whose card cleared during the grace window", async () => {
    // **The worst failure this feature can have.** Under auto-renewal the
    // recovery is Stripe's own retry rather than a customer pressing a button,
    // which makes it easier to miss and no less important: the webhook clears
    // the stamp and restores `active`, and this pass must not re-apply it.
    await setDunning(NOW - RENEWAL_GRACE_MS - DAY, "expired");
    await run();
    expect((await org()).purge_after).not.toBeNull();

    // Exactly what `invoice.payment_succeeded` writes.
    await env.DB.prepare(
      `UPDATE organizations SET billing_status = 'active', purge_after = NULL,
              past_due_since = NULL, current_period_end = ? WHERE id = ?`
    )
      .bind(NOW + 30 * DAY, ORG_ID)
      .run();

    const after = await run();
    expect(after.deletionsScheduled).toBe(0);
    expect((await org()).purge_after).toBeNull();
    expect((await org()).billing_status).toBe("active");
  });
});

describe("crossing two boundaries in one tick", () => {
  it("expires before it schedules, so the warning is never skipped", async () => {
    // Possible after an outage, or on the first enabled run. An account that is
    // both past its grace and unswept must still pass through the expired state
    // and its message rather than jumping straight to deletion unannounced.
    await setDunning(NOW - RENEWAL_GRACE_MS - DAY);

    const result = await run();

    expect(result.expired).toBe(1);
    expect(result.deletionsScheduled).toBe(1);
    expect(sent.some(m => /payment failed/i.test(m.subject))).toBe(true);
    expect(sent.some(m => /scheduled for deletion/i.test(m.subject))).toBe(true);
  });
});

describe("what it leaves alone", () => {
  it("ignores an account that never bought anything", async () => {
    // NULL is "never had a period", which is every free account. Reading it as
    // expired would sweep the entire free tier.
    await env.DB.prepare(
      `UPDATE organizations SET current_period_end = NULL, past_due_since = NULL WHERE id = ?`
    )
      .bind(ORG_ID)
      .run();

    const result = await run();
    expect(result.expired).toBe(0);
    expect(result.deletionsScheduled).toBe(0);
    expect(result.reminded).toBe(0);
  });

  it("does not remind an account that has already expired", async () => {
    await setDunning(NOW - DAY, "expired");
    const result = await run();
    expect(result.reminded).toBe(0);
  });

  it("gives notice again for the next period after a renewal", async () => {
    // The guard is keyed on the period, not the account: the same three
    // messages are owed every month.
    await setPeriod(NOW + 3 * DAY);
    await run();
    expect(sent).toHaveLength(1);

    await setPeriod(NOW + RENEWAL_REMINDER_MS + 30 * DAY);
    await run();
    expect(sent).toHaveLength(1); // outside the window now

    await setPeriod(NOW + 2 * DAY);
    await run();
    expect(sent).toHaveLength(2);
  });
});

/**
 * Day +14 — the purge. The end of the lifecycle.
 *
 * This pass did not exist when the ladder shipped: `purge_after` was written and
 * read by nothing that acted, so the third email promised a deletion the product
 * could not perform. These tests are the proof that the story now has an ending,
 * and that the ending can still be called off by paying.
 */
describe("day +14 · the purge", () => {
  async function files(): Promise<R2Bucket> {
    return env.FILES;
  }

  async function scheduled(purgeAfter: number): Promise<void> {
    await env.DB.prepare(
      `UPDATE organizations SET billing_status = 'expired', plan = 'pro',
              current_period_end = ?, past_due_since = ?, purge_after = ?, purged_at = NULL
        WHERE id = ?`
    )
      .bind(NOW - 14 * DAY, NOW - 14 * DAY, purgeAfter, ORG_ID)
      .run();
  }

  async function orgFull(): Promise<{
    plan: string;
    billing_status: string;
    purge_after: number | null;
    purged_at: number | null;
    current_period_end: number | null;
  }> {
    const row = await env.DB.prepare(
      `SELECT plan, billing_status, purge_after, purged_at, current_period_end
         FROM organizations WHERE id = ?`
    )
      .bind(ORG_ID)
      .first<{
        plan: string;
        billing_status: string;
        purge_after: number | null;
        purged_at: number | null;
        current_period_end: number | null;
      }>();
    if (row === null) throw new Error("organization missing");
    return row;
  }

  async function workspaceCount(): Promise<number> {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM workspaces WHERE org_id = ?`
    )
      .bind(ORG_ID)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  it("leaves an account alone while its notice period is still running", async () => {
    // "Scheduled" has to mean scheduled. Before this, the stamp was written to
    // an instant that had already passed, so the third email and the deletion
    // would have landed in the same hour.
    await scheduled(NOW + 3 * DAY);
    const result = await run({ files: await files() });

    expect(result.purged).toBe(0);
    expect(await workspaceCount()).toBeGreaterThan(0);
    expect((await orgFull()).purged_at).toBeNull();
  });

  it("removes the data once the notice period is up", async () => {
    await scheduled(NOW - DAY);
    const result = await run({ files: await files() });

    expect(result.purged).toBe(1);
    expect(await workspaceCount()).toBe(0);
  });

  it("keeps the organization row, so the person can still sign in", async () => {
    // Deleting it would stop the audit trail resolving, and would silently
    // re-bootstrap them a fresh workspace with no explanation of where their
    // files went. The shell state has to be a real state.
    await scheduled(NOW - DAY);
    await run({ files: await files() });

    const org = await orgFull();
    expect(org.purged_at).toBe(NOW);
    expect(org.purge_after).toBeNull();
    expect(org.billing_status).toBe("canceled");
  });

  it("drops the plan back to the default, so a new workspace is not free Pro", async () => {
    await scheduled(NOW - DAY);
    await run({ files: await files() });
    expect((await orgFull()).plan).toBe("free");
  });

  it("keeps the period end, because the shell screen has to name a date", async () => {
    await scheduled(NOW - DAY);
    await run({ files: await files() });
    expect((await orgFull()).current_period_end).toBe(NOW - 14 * DAY);
  });

  it("never deletes on a dry run", async () => {
    await scheduled(NOW - DAY);
    const result = await run({ files: await files(), dryRun: true });

    expect(result.candidates.purge).toHaveLength(1);
    expect(result.purged).toBe(0);
    expect(await workspaceCount()).toBeGreaterThan(0);
  });

  it("reports and deletes nothing when the deployment has no bucket", async () => {
    // Deleting D1 rows while the objects they name survive would orphan the
    // bytes beyond recovery — the rows are the only record that they exist.
    await scheduled(NOW - DAY);
    const result = await run({ files: undefined });

    expect(result.purged).toBe(0);
    expect(await workspaceCount()).toBeGreaterThan(0);
  });

  it("does not touch an account that renewed after being stamped", async () => {
    // The unrecoverable mistake this job can make. The stamp is re-read inside
    // the loop, so a renewal that lands mid-run still wins.
    await scheduled(NOW - DAY);
    await env.DB.prepare(
      `UPDATE organizations SET billing_status = 'active', purge_after = NULL,
              current_period_end = ? WHERE id = ?`
    )
      .bind(NOW + 30 * DAY, ORG_ID)
      .run();

    const result = await run({ files: await files() });
    expect(result.purged).toBe(0);
    expect(await workspaceCount()).toBeGreaterThan(0);
  });

  it("is idempotent — a purged account is never purged twice", async () => {
    await scheduled(NOW - DAY);
    await run({ files: await files() });
    const second = await run({ files: await files() });

    expect(second.purged).toBe(0);
    expect(second.candidates.purge).toHaveLength(0);
  });
});

/**
 * The whole lifecycle, one account, start to finish.
 *
 * Every test above proves one transition. This one proves the transitions
 * compose — that an account can actually get from "bought a month" to "data
 * gone" by nothing but the clock, which is the property the product was
 * missing entirely.
 */
describe("the complete story", () => {
  it("walks an account from renewing to purged, one stage per tick", async () => {
    // The whole story in one test, because each stage was written separately
    // and the thing that breaks is the joins between them — a stamp nothing
    // reads, a message keyed on a state the previous pass already left.
    //
    // It does NOT assert the recovery; that has its own test above, where it
    // can be checked at the stage it actually matters.
    const periodEnd = NOW + 30 * DAY;

    await env.DB.prepare(
      `UPDATE organizations SET plan = 'pro', billing_status = 'active',
              billing_interval = 'month', stripe_subscription_id = 'sub_live',
              cancel_at_period_end = 0, current_period_end = ?,
              past_due_since = NULL, purge_after = NULL, purged_at = NULL
        WHERE id = ?`
    )
      .bind(periodEnd, ORG_ID)
      .run();

    const tick = (at: number) => run({ files: env.FILES, now: at });

    // Day -7: given notice of the charge. Still active, still writable.
    await tick(periodEnd - 7 * DAY);
    expect((await org()).billing_status).toBe("active");
    expect(sent.some(m => /renews on/i.test(m.subject))).toBe(true);

    // Day 0: the charge fails. Stripe's `invoice.payment_failed` opens the
    // dunning run — written here directly, because the webhook owns that write
    // and this job only reads it.
    const failedAt = periodEnd + 1000;
    await env.DB.prepare(
      `UPDATE organizations SET billing_status = 'past_due', past_due_since = ? WHERE id = ?`
    )
      .bind(failedAt, ORG_ID)
      .run();

    await tick(failedAt + 60_000);
    expect((await org()).billing_status).toBe("past_due");
    expect(sent.some(m => /payment failed/i.test(m.subject))).toBe(true);

    // Day +7: dunning runs out. Locked, plan deliberately retained, deletion
    // scheduled — and the bytes are still there.
    await tick(failedAt + RENEWAL_GRACE_MS + 1000);
    expect((await org()).billing_status).toBe("expired");
    expect((await org()).plan).toBe("pro");
    expect((await org()).purge_after).not.toBeNull();

    const stillThere = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM workspaces WHERE org_id = ?`
    )
      .bind(ORG_ID)
      .first<{ n: number }>();
    expect(stillThere!.n).toBeGreaterThan(0);

    // Day +14: gone.
    await tick(failedAt + RENEWAL_GRACE_MS + RENEWAL_NOTICE_MS + 2000);
    const gone = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM workspaces WHERE org_id = ?`
    )
      .bind(ORG_ID)
      .first<{ n: number }>();
    expect(gone!.n).toBe(0);
    expect((await org()).purged_at).not.toBeNull();

    // Three messages, one per stage, and no more. The guard is the unique
    // index: the cron is hourly, so a stage that sent per tick would send 168
    // copies a week.
    expect(sent).toHaveLength(3);
  });
});
