import React, { useState } from 'react';
import { adminApi } from '../api.js';
import { useResource } from '../lib/useResource.js';
import { ConfirmModal, Modal } from '../components/Overlay.jsx';
import { EmptyState, ErrorState, Skeleton } from '../components/States.jsx';
import { holds } from '../components/Shell.jsx';
import { date, money } from '../lib/format.js';
import {
  card,
  cell,
  dataRow,
  disabledBtn,
  headRow,
  input,
  label,
  mono,
  paneIn,
  pill,
  primaryBtn,
  secondaryBtn,
  th
} from '../lib/ui.js';

/**
 * Promotion codes.
 *
 * ── Stripe holds these, and nothing is mirrored ────────────────────────────
 * There is no `promos` table. Stripe counts redemptions atomically at the
 * moment a payment succeeds, so two people racing to claim the last use of a
 * code cannot both win. A local copy would have to reproduce that from a
 * database that is not on the payment path and cannot see the charge clear —
 * and the number it got wrong would be the one that decides whether somebody
 * gets a discount they are not entitled to.
 *
 * So every row here is read live. A failed Stripe read empties the screen
 * rather than showing a stale list, which is the honest failure: a list of
 * codes that might no longer work is worse than no list.
 *
 * ── One-time versus unlimited is the distinction this form exists to make ──
 * `max_redemptions` absent means unlimited; `1` means single-use. An empty
 * numeric box standing for "no limit" is exactly the NULL-versus-minus-one
 * ambiguity the plan catalogue already forbids, so the choice is a radio with
 * both cases written out in words and the number only appears once a cap is
 * chosen.
 *
 * ── Deactivate, never delete ───────────────────────────────────────────────
 * Stripe does not allow deleting a promotion code at all, and it should not:
 * the discounts already redeemed under one stay attached to real invoices, and
 * a code that vanished would leave those unexplained a year later.
 */

/** Code · Discount · Lasts · Redeemed · Expires · Created by · actions */
const COLUMNS = '150px 120px 120px 110px 120px 1fr 110px';

/** How a discount reads on one line. */
function discountOf(promo) {
  if (typeof promo.percentOff === 'number') return `${promo.percentOff}% off`;
  if (typeof promo.amountOffCents === 'number') {
    return `${money(promo.amountOffCents, promo.currency ?? 'usd')} off`;
  }
  // Neither, which means the coupon came back unexpanded. Said plainly rather
  // than rendered as a zero, which would read as "no discount".
  return 'unavailable';
}

function lastsOf(promo) {
  if (promo.duration === 'forever') return 'Every month';
  if (promo.duration === 'repeating') {
    return `${promo.durationMonths ?? '?'} month${promo.durationMonths === 1 ? '' : 's'}`;
  }
  return 'First payment';
}

/**
 * Redemptions used against the cap.
 *
 * `null` is unlimited and is drawn as the infinity word rather than a blank,
 * because a blank in this column reads as "nobody has used it".
 */
function redeemedOf(promo) {
  return promo.maxRedemptions === null
    ? `${promo.timesRedeemed} · unlimited`
    : `${promo.timesRedeemed} / ${promo.maxRedemptions}`;
}

const BLANK = {
  code: '',
  kind: 'percent',
  percentOff: '20',
  amountOffCents: '',
  currency: 'usd',
  duration: 'once',
  durationMonths: '3',
  limit: 'unlimited',
  maxRedemptions: '1',
  expiresAt: ''
};

export function Promos({ role, onToast }) {
  const resource = useResource(() => adminApi.listPromos(), []);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState(BLANK);
  const [deactivating, setDeactivating] = useState(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);

  const canEdit = holds(role, 'admin');
  const promos = resource.data?.promos ?? [];

  async function act(fn, message) {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
      setCreating(false);
      setDeactivating(null);
      onToast?.(message);
      await resource.refresh();
    } catch (err) {
      setActionError(err);
    } finally {
      setBusy(false);
    }
  }

  function submitDraft() {
    const payload = { code: draft.code.trim().toUpperCase(), duration: draft.duration };

    if (draft.kind === 'percent') payload.percentOff = Number(draft.percentOff);
    else {
      payload.amountOffCents = Math.round(Number(draft.amountOffCents) * 100);
      payload.currency = draft.currency;
    }

    if (draft.duration === 'repeating') payload.durationMonths = Number(draft.durationMonths);
    // Omitted entirely for unlimited. Sending 0 would be a limit of zero — a
    // code nobody can ever redeem.
    if (draft.limit === 'capped') payload.maxRedemptions = Number(draft.maxRedemptions);
    if (draft.expiresAt !== '') payload.expiresAt = new Date(draft.expiresAt).getTime();

    return act(() => adminApi.createPromo(payload), `Created ${payload.code}.`);
  }

  if (resource.loading) return <Skeleton rows={5} />;

  return (
    <div style={paneIn}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '9px',
          ...card,
          padding: '11px 14px',
          marginBottom: '14px',
          flexWrap: 'wrap'
        }}
      >
        <span
          style={{ flex: 1, minWidth: '200px', fontSize: '12.5px', lineHeight: 1.5, color: 'var(--tx2)' }}
        >
          Codes live in Stripe, not here — customers type them on the payment page and Stripe
          counts the redemptions. A code can be switched off but never deleted, because the
          discounts already taken under it stay on real invoices.
        </span>
        <button
          type="button"
          style={canEdit ? primaryBtn : disabledBtn}
          disabled={!canEdit || busy}
          onClick={() => {
            setDraft(BLANK);
            setActionError(null);
            setCreating(true);
          }}
        >
          New code
        </button>
      </div>

      <ErrorState error={resource.error} onRetry={resource.refresh} />

      {resource.error ? null : promos.length === 0 ? (
        <EmptyState
          title="No promotion codes"
          detail="Nothing has been created in this Stripe account yet."
        />
      ) : (
        <div style={card}>
          <div style={headRow(COLUMNS, true)}>
            <div style={th}>Code</div>
            <div style={th}>Discount</div>
            <div style={th}>Lasts</div>
            <div style={th}>Redeemed</div>
            <div style={th}>Expires</div>
            <div style={th}>Created by</div>
            <div style={th} />
          </div>

          {promos.map(promo => (
            <div key={promo.id} style={dataRow(COLUMNS, false, true)}>
              <div style={{ ...cell(true), ...mono, fontWeight: 600 }}>{promo.code}</div>
              <div style={cell()}>{discountOf(promo)}</div>
              <div style={cell()}>{lastsOf(promo)}</div>
              <div style={cell()}>{redeemedOf(promo)}</div>
              <div style={cell()}>
                {promo.expiresAt === null ? 'No expiry' : date(promo.expiresAt)}
              </div>
              <div style={cell()}>{promo.createdBy ?? 'Created in Stripe'}</div>
              <div style={{ ...cell(), display: 'flex', justifyContent: 'flex-end', gap: '6px' }}>
                {/* The state is a word, never a colour alone. */}
                {promo.active ? (
                  <button
                    type="button"
                    style={canEdit ? secondaryBtn : disabledBtn}
                    disabled={!canEdit || busy}
                    onClick={() => {
                      setActionError(null);
                      setDeactivating(promo);
                    }}
                  >
                    Switch off
                  </button>
                ) : (
                  <span style={pill('var(--tx2)', 'var(--surf2)', '1px solid var(--bd2)')}>Off</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal
        open={creating}
        title="New promotion code"
        description="Created in Stripe. Customers enter it on the payment page."
        onClose={() => setCreating(false)}
        onSubmit={submitDraft}
        submitLabel="Create"
        submitDisabled={draft.code.trim().length < 4}
        busy={busy}
      >
        {actionError ? <ErrorState error={actionError} /> : null}

        <label style={label} htmlFor="promo-code">
          Code
        </label>
        <input
          id="promo-code"
          style={{ ...input, ...mono }}
          value={draft.code}
          onChange={event => setDraft({ ...draft, code: event.target.value })}
          placeholder="WELCOME50"
        />
        <p style={{ fontSize: '11.5px', color: 'var(--tx2)', margin: '4px 0 14px' }}>
          4 to 32 characters. Letters, numbers, dashes and underscores. Saved in capitals, so
          one code cannot exist twice in two cases.
        </p>

        <fieldset style={{ border: 0, padding: 0, margin: '0 0 14px' }}>
          <legend style={label}>Discount</legend>
          <label style={{ display: 'block', marginBottom: '6px' }}>
            <input
              type="radio"
              checked={draft.kind === 'percent'}
              onChange={() => setDraft({ ...draft, kind: 'percent' })}
            />{' '}
            Percentage off
          </label>
          {draft.kind === 'percent' ? (
            <input
              style={input}
              type="number"
              min="1"
              max="100"
              value={draft.percentOff}
              onChange={event => setDraft({ ...draft, percentOff: event.target.value })}
              aria-label="Percentage off"
            />
          ) : null}

          <label style={{ display: 'block', margin: '8px 0 6px' }}>
            <input
              type="radio"
              checked={draft.kind === 'amount'}
              onChange={() => setDraft({ ...draft, kind: 'amount' })}
            />{' '}
            Fixed amount off
          </label>
          {draft.kind === 'amount' ? (
            <input
              style={input}
              type="number"
              min="0.01"
              step="0.01"
              value={draft.amountOffCents}
              onChange={event => setDraft({ ...draft, amountOffCents: event.target.value })}
              aria-label="Amount off in dollars"
              placeholder="5.00"
            />
          ) : null}
        </fieldset>

        <label style={label} htmlFor="promo-duration">
          How long it lasts
        </label>
        <select
          id="promo-duration"
          style={input}
          value={draft.duration}
          onChange={event => setDraft({ ...draft, duration: event.target.value })}
        >
          <option value="once">The first payment only</option>
          <option value="repeating">A number of months</option>
          <option value="forever">Every payment, forever</option>
        </select>
        {draft.duration === 'repeating' ? (
          <input
            style={{ ...input, marginTop: '6px' }}
            type="number"
            min="1"
            max="36"
            value={draft.durationMonths}
            onChange={event => setDraft({ ...draft, durationMonths: event.target.value })}
            aria-label="Number of months"
          />
        ) : null}

        <fieldset style={{ border: 0, padding: 0, margin: '14px 0' }}>
          {/* Both cases in words. An empty box meaning "no limit" is the
              ambiguity the plan catalogue already rules out between NULL and
              -1, and it is worse here: the wrong reading gives away unlimited
              discounts. */}
          <legend style={label}>How many times it can be used</legend>
          <label style={{ display: 'block', marginBottom: '6px' }}>
            <input
              type="radio"
              checked={draft.limit === 'unlimited'}
              onChange={() => setDraft({ ...draft, limit: 'unlimited' })}
            />{' '}
            Unlimited — anyone can use it, any number of times
          </label>
          <label style={{ display: 'block', marginBottom: '6px' }}>
            <input
              type="radio"
              checked={draft.limit === 'capped'}
              onChange={() => setDraft({ ...draft, limit: 'capped' })}
            />{' '}
            Limited — set a total number of redemptions
          </label>
          {draft.limit === 'capped' ? (
            <>
              <input
                style={input}
                type="number"
                min="1"
                value={draft.maxRedemptions}
                onChange={event => setDraft({ ...draft, maxRedemptions: event.target.value })}
                aria-label="Total redemptions allowed"
              />
              <p style={{ fontSize: '11.5px', color: 'var(--tx2)', margin: '4px 0 0' }}>
                Set this to 1 for a single-use code.
              </p>
            </>
          ) : null}
        </fieldset>

        <label style={label} htmlFor="promo-expires">
          Expires (optional)
        </label>
        <input
          id="promo-expires"
          style={input}
          type="date"
          value={draft.expiresAt}
          onChange={event => setDraft({ ...draft, expiresAt: event.target.value })}
        />
      </Modal>

      <ConfirmModal
        open={deactivating !== null}
        title={`Switch off ${deactivating?.code ?? ''}?`}
        description="Nobody will be able to redeem it again. Discounts already taken under it are unaffected, and this cannot be undone — Stripe does not allow a code to be switched back on."
        requireReason
        confirmLabel="Switch off"
        busy={busy}
        onCancel={() => setDeactivating(null)}
        onConfirm={reason =>
          act(
            () => adminApi.deactivatePromo(deactivating.id, reason),
            `${deactivating.code} switched off.`
          )
        }
      />
    </div>
  );
}
