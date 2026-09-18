import React, { useState } from 'react';
import { staffApi } from '../api.js';
import { useResource } from '../lib/useResource.js';
import { ConfirmModal, Modal } from '../components/Overlay.jsx';
import { EmptyState, ErrorState, Skeleton } from '../components/States.jsx';
import { holds } from '../components/Shell.jsx';
import { bytes, count, dateTime, money, quota, since } from '../lib/format.js';
import {
  card,
  cell,
  dataRow,
  disabledBtn,
  ellipsis,
  headRow,
  input,
  label,
  mono,
  paneIn,
  pills,
  primaryBtn,
  secondaryBtn,
  th,
  thR
} from '../lib/ui.js';

/**
 * Plans and pricing.
 *
 * ── The editable dimensions are the ones that exist ────────────────────────
 * The design's three-column summary (Storage / Requests / Identities) is a
 * summary of the wrong things. "Identities" is not a dimension — it is agents
 * and API keys, which are two separate limits — and requests, egress and file
 * count are UNLIMITED on every current plan, so a number in those columns would
 * be describing a product we do not sell. They render as Unlimited and are
 * editable, because a future plan might cap them; they are not presented as
 * though they currently do.
 *
 * ── Saving pushes to Stripe in the same request ────────────────────────────
 * And if Stripe refuses, the local row is not written either. The modal shows
 * Stripe's own error rather than a local-only save that is now silently out of
 * sync. A price change mints a NEW Stripe Price and archives the old one,
 * because Stripe prices are immutable — the modal warns before saving, not
 * after.
 *
 * ── Sync is two steps and will stay two steps ──────────────────────────────
 * The diff is the safety mechanism. Where both sides changed, the operator is
 * shown both values and picks per field; nothing auto-resolves, because a wrong
 * resolution here bills real customers the wrong amount.
 */

/**
 * Nine tracks, with the actions split out from the status.
 *
 * Two things were wrong before. The last track was 86px and held a status pill
 * plus Edit plus Retire, so its contents overflowed and widened the row into a
 * horizontal scrollbar - a grid track does not shrink what is inside it. And
 * the SYNC header sat above a right-aligned group, so the label and the thing
 * it labelled were at opposite ends of the same cell.
 *
 * Giving the actions their own track fixes both: SYNC now labels only the
 * status, and the buttons have room to sit without pushing anything.
 */
const COLS =
  'minmax(120px,1.1fr) 68px 84px 58px 70px 86px minmax(90px,1fr) 160px 76px';

/**
 * The nine limits, with the two things the design asks each row to state.
 *
 * `unit` is what the number means, shown beside the field so nobody has to
 * infer it from the label. `codeDefault` is what `lib/plans.ts` falls back to
 * when the column is null - the Default mode is not "no limit", it is "this
 * plan did not say", and showing the value it defers to is the difference
 * between the two being legible and being a guess.
 *
 * The values are the Free tier's floor, which is what a plan with nothing set
 * would actually get.
 */
const DIMENSIONS = [
  { key: 'storage_bytes', label: 'Storage', unit: 'bytes', codeDefault: '1 GB' },
  { key: 'max_file_bytes', label: 'Max single file', unit: 'bytes', codeDefault: '100 MB' },
  { key: 'agents', label: 'Agent identities', unit: 'count', codeDefault: '1' },
  { key: 'members', label: 'Members', unit: 'count', codeDefault: '1' },
  { key: 'workspaces', label: 'Workspaces', unit: 'count', codeDefault: '1' },
  { key: 'api_keys', label: 'API keys', unit: 'count', codeDefault: '2' },
  { key: 'file_count', label: 'Files', unit: 'count', codeDefault: 'unlimited' },
  { key: 'egress_bytes_period', label: 'Egress / period', unit: 'bytes', codeDefault: 'unlimited' },
  { key: 'requests_period', label: 'Requests / period', unit: 'count', codeDefault: 'unlimited' }
];

/**
 * What the SYNC column says, and when it last happened.
 *
 * `last_synced_at` is stamped by the shared product-to-plan upsert, so a
 * webhook and a Reconcile all both move it. It was previously written only by
 * the console's own edit paths - which meant this column read "not synced"
 * forever however many times somebody synced, and a status that cannot change
 * reads as a problem to chase.
 */
function syncState(plan) {
  if (!plan.stripe_product_id) return { tone: pills.warn, text: 'no product', at: null };
  if (!plan.last_synced_at) return { tone: pills.neutral, text: 'not synced', at: null };
  return plan.last_synced_direction === 'inbound'
    ? { tone: pills.neutral, text: 'from stripe', at: plan.last_synced_at }
    : { tone: pills.ok, text: 'pushed', at: plan.last_synced_at };
}

export function Plans({ role, onToast }) {
  const resource = useResource(() => staffApi.listPlans(), []);
  const [editing, setEditing] = useState(null);
  const [creating, setCreating] = useState(false);
  const [retiring, setRetiring] = useState(null);
  const [diff, setDiff] = useState(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);

  const canEdit = holds(role, 'admin');
  const canCreate = holds(role, 'super_admin');
  const plans = resource.data?.plans ?? [];

  async function act(fn, message) {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
      setEditing(null);
      setCreating(false);
      setRetiring(null);
      onToast?.(message);
      await resource.refresh();
    } catch (err) {
      setActionError(err);
    } finally {
      setBusy(false);
    }
  }

  async function openDiff() {
    setBusy(true);
    setActionError(null);
    try {
      const result = await staffApi.stripeDiff();
      setDiff(result.diffs);
    } catch (err) {
      setActionError(err);
    } finally {
      setBusy(false);
    }
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
        <span style={{ flex: 1, minWidth: '180px', fontSize: '12.5px', lineHeight: 1.5, color: 'var(--tx2)' }}>
          <strong style={{ color: 'var(--tx)' }}>Compare</strong> shows what differs and lets you
          take it field by field. <strong style={{ color: 'var(--tx)' }}>Pull everything</strong>{' '}
          overwrites every plan from Stripe with no confirmation.
        </span>
        <button type="button" style={canEdit ? secondaryBtn : disabledBtn} disabled={!canEdit || busy} onClick={openDiff}>
          {busy ? 'Working…' : 'Compare with Stripe'}
        </button>
        <button
          type="button"
          style={canEdit ? secondaryBtn : disabledBtn}
          disabled={!canEdit || busy}
          onClick={() =>
            act(
              () => staffApi.syncCatalogue('Reconciling every plan against Stripe'),
              'Catalogue reconciled from Stripe.'
            )
          }
          title="Overwrites every plan row from its Stripe product, with no confirmation step. The same upsert the webhook runs."
        >
          Pull everything
        </button>
        {canCreate && (
          <button type="button" style={primaryBtn} onClick={() => setCreating(true)}>
            New plan
          </button>
        )}
      </div>

      {actionError && (
        <div style={{ marginBottom: '14px' }}>
          <ErrorState error={actionError} onRetry={resource.refresh} />
        </div>
      )}

      {plans.length === 0 ? (
        <EmptyState
          title="No plans yet"
          detail="Migration 0012 seeds four. If this is empty, the migration has not run in this environment."
        />
      ) : (
        <div style={card}>
          <div style={{ overflowX: 'auto' }}>
            <div style={{ minWidth: '820px' }}>
              <div style={headRow(COLS, true)}>
                <span style={{ ...cell(true), ...th }}>Plan</span>
                <span style={{ ...cell(), ...th, justifyContent: 'flex-end' }}>Price</span>
                <span style={{ ...cell(), ...th, justifyContent: 'flex-end' }}>Storage</span>
                <span style={{ ...cell(), ...th, justifyContent: 'flex-end' }}>Agents</span>
                <span style={{ ...cell(), ...th, justifyContent: 'flex-end' }}>Members</span>
                <span style={{ ...cell(), ...th, justifyContent: 'flex-end' }}>Workspaces</span>
                <span style={{ ...cell(), ...th }}>Stripe price</span>
                <span style={{ ...cell(), ...th }}>Sync</span>
                <span style={{ ...cell(), ...th }}>Actions</span>
              </div>
              {plans.map(plan => {
                const state = syncState(plan);
                return (
                  <div key={plan.id} style={dataRow(COLS, false, true)}>
                    <span style={{ ...cell(true), gap: '8px' }}>
                      <span
                        style={{
                          fontSize: '12.5px',
                          fontWeight: 500,
                          color: 'var(--tx)',
                          ...ellipsis
                        }}
                      >
                        {plan.name}
                      </span>
                      {plan.is_default === 1 && <span style={pills.accent}>default</span>}
                      {plan.is_public === 0 && <span style={pills.neutral}>retired</span>}
                    </span>

                    <span style={{ ...cell(), ...mono, fontSize: '11.5px', color: 'var(--tx)', justifyContent: 'flex-end' }}>
                      {money(plan.amount_cents, plan.currency)}
                    </span>
                    <span style={{ ...cell(), ...mono, fontSize: '11.5px', color: 'var(--tx2)', justifyContent: 'flex-end' }}>
                      {quota(plan.storage_bytes) === 'Unlimited' ? 'Unlimited' : bytes(plan.storage_bytes)}
                    </span>
                    <span style={{ ...cell(), ...mono, fontSize: '11.5px', color: 'var(--tx2)', justifyContent: 'flex-end' }}>
                      {quota(plan.agents)}
                    </span>
                    <span style={{ ...cell(), ...mono, fontSize: '11.5px', color: 'var(--tx2)', justifyContent: 'flex-end' }}>
                      {quota(plan.members)}
                    </span>
                    <span style={{ ...cell(), ...mono, fontSize: '11.5px', color: 'var(--tx2)', justifyContent: 'flex-end' }}>
                      {quota(plan.workspaces)}
                    </span>
                    <span
                      style={{ ...cell(), ...mono, fontSize: '10.5px', color: 'var(--tx3)' }}
                      title={plan.stripe_price_id ?? undefined}
                    >
                      <span style={ellipsis}>{plan.stripe_price_id ?? '—'}</span>
                    </span>

                    {/*
                      Badge and time on ONE line. Stacking them made this the
                      only two-line cell in the table, so every row grew to fit
                      it and the column rules ran past the other cells' content
                      - one cell dictating the height of a whole row is what
                      "the columns look broken" actually was.
                    */}
                    <span style={{ ...cell(), gap: '7px' }}>
                      <span style={state.tone}>{state.text}</span>
                      {state.at && (
                        <span
                          style={{ ...mono, fontSize: '10px', color: 'var(--tx3)', ...ellipsis }}
                          title={dateTime(state.at)}
                        >
                          {since(state.at)}
                        </span>
                      )}
                    </span>

                    <span style={{ ...cell(), gap: '10px' }}>
                      {canEdit && (
                        <button
                          type="button"
                          onClick={() => setEditing(plan)}
                          style={{
                            background: 'none',
                            border: 'none',
                            padding: 0,
                            color: 'var(--acc)',
                            cursor: 'pointer',
                            fontSize: '12px',
                            fontFamily: 'var(--font)'
                          }}
                        >
                          Edit
                        </button>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      <PlanEditor
        plan={editing}
        open={Boolean(editing)}
        busy={busy}
        error={actionError}
        // Retire lives in here now rather than on the row. It is a rare,
        // consequential act and it was sitting one stray click from Edit in a
        // dense table; inside the dialog the plan is already named and the
        // consequence can be spelled out beside the button.
        canRetire={canCreate && editing?.is_public === 1}
        onRetire={() => {
          const plan = editing;
          setEditing(null);
          setRetiring(plan);
        }}
        onCancel={() => {
          setEditing(null);
          setActionError(null);
        }}
        onSubmit={(patch, reason) =>
          act(
            () => staffApi.updatePlan(editing.id, { ...patch, reason }),
            'Plan saved and pushed to Stripe.'
          )
        }
      />

      <PlanEditor
        plan={null}
        creating
        open={creating}
        busy={busy}
        error={actionError}
        onCancel={() => {
          setCreating(false);
          setActionError(null);
        }}
        onSubmit={(patch, reason) =>
          act(() => staffApi.createPlan({ ...patch, reason }), 'Plan created in Stripe.')
        }
      />

      <ConfirmModal
        open={Boolean(retiring)}
        title={`Retire ${retiring?.name}?`}
        description="It disappears from new signups. Existing subscribers are NOT changed — they keep the plan and its entitlements, and keep being billed, until they change it themselves."
        requireReason
        confirmLabel="Retire plan"
        busy={busy}
        onCancel={() => setRetiring(null)}
        onConfirm={reason => act(() => staffApi.retirePlan(retiring.id, reason), 'Plan retired.')}
      />

      <DiffDialog
        open={diff !== null}
        diffs={diff ?? []}
        busy={busy}
        error={actionError}
        onCancel={() => setDiff(null)}
        onApply={(selections, reason) =>
          act(async () => {
            await staffApi.syncFromStripe(selections, reason);
            setDiff(null);
          }, 'Selected fields pulled from Stripe.')
        }
      />
    </div>
  );
}

/** A number field that keeps `null` and `-1` distinguishable. */
/**
 * One limit: a segmented control and a number, per the design.
 *
 * The three modes are buttons rather than a `<select>` because all three are
 * then visible at once, and these three are genuinely different answers that a
 * reader has to be able to tell apart at a glance:
 *
 *   Default   -> null, "this plan did not say", defers to the lib/plans.ts floor
 *   Unlimited -> -1, a decision that there is no ceiling
 *   Value     -> the ceiling
 *
 * The number stays on screen when the mode is not Value, dimmed rather than
 * removed. It shows what WOULD apply without implying it currently does, and a
 * field that disappears takes its value with it - somebody switching to
 * Unlimited and back would otherwise lose what they had typed.
 */
function QuotaField({ id, name, unit, codeDefault, value, onChange }) {
  const mode = value === null || value === undefined ? 'default' : value < 0 ? 'unlimited' : 'value';

  const modes = [
    ['default', 'Default'],
    ['unlimited', 'Unlimited'],
    ['value', 'Value']
  ];

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        border: '1px solid var(--bd)',
        borderRadius: '10px',
        padding: '7px 10px',
        minWidth: 0
      }}
    >
      <span style={{ width: '104px', flex: '0 0 104px', minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: '12px', fontWeight: 500, color: 'var(--tx)', ...ellipsis }}>
          {name}
        </span>
        <span
          style={{
            ...mono,
            display: 'block',
            fontSize: '9.5px',
            letterSpacing: '0.06em',
            color: 'var(--tx3)',
            marginTop: '1px',
            textTransform: 'uppercase',
            ...ellipsis
          }}
        >
          Default {codeDefault}
        </span>
      </span>

      <span
        role="radiogroup"
        aria-label={`${name} mode`}
        style={{
          display: 'flex',
          gap: '2px',
          background: 'var(--surf2)',
          border: '1px solid var(--bd)',
          borderRadius: '8px',
          padding: '2px',
          flex: '0 0 auto'
        }}
      >
        {modes.map(([key, label]) => {
          const active = mode === key;
          return (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(key === 'default' ? null : key === 'unlimited' ? -1 : 0)}
              style={{
                height: '24px',
                padding: '0 8px',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer',
                fontFamily: 'var(--font)',
                fontSize: '11px',
                fontWeight: active ? 600 : 500,
                background: active ? 'var(--acc)' : 'transparent',
                color: active ? 'var(--accInk)' : 'var(--tx2)'
              }}
            >
              {label}
            </button>
          );
        })}
      </span>

      <span
        style={{
          height: '28px',
          flex: '1 1 auto',
          minWidth: '86px',
          border: `1px solid ${mode === 'value' ? 'var(--bd2)' : 'var(--bd)'}`,
          borderRadius: '8px',
          background: mode === 'value' ? 'var(--surf2)' : 'var(--surf)',
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          padding: '0 8px',
          // Dimmed, not hidden: it shows what the value would be without
          // claiming it applies, and keeps what was typed across a mode change.
          opacity: mode === 'value' ? 1 : 0.45
        }}
      >
        <input
          id={id}
          type="number"
          min="0"
          disabled={mode !== 'value'}
          value={mode === 'value' ? (value ?? 0) : ''}
          placeholder={mode === 'unlimited' ? '∞' : '—'}
          onChange={event => onChange(Number(event.target.value))}
          style={{
            ...mono,
            flex: '1 1 auto',
            minWidth: 0,
            width: '100%',
            border: 'none',
            background: 'transparent',
            color: mode === 'value' ? 'var(--tx)' : 'var(--tx3)',
            fontSize: '12px',
            padding: 0,
            outline: 'none'
          }}
        />
        <span style={{ ...mono, fontSize: '9px', letterSpacing: '0.07em', color: 'var(--tx3)', textTransform: 'uppercase' }}>
          {unit}
        </span>
      </span>
    </div>
  );
}

// Exported for `test/fixtures/plan-editor-harness.jsx`. The row count this
// dialog shows is a layout outcome, and jsdom does not lay out - so the check
// that it shows five and scrolls has to drive the real editor in a real
// browser, not a stand-in with approximately the same rows in it.
export function PlanEditor({
  plan,
  open,
  creating = false,
  busy,
  error,
  onCancel,
  onSubmit,
  canRetire = false,
  onRetire
}) {
  const [draft, setDraft] = useState({});
  const [reason, setReason] = useState('');
  const [initialised, setInitialised] = useState(null);
  const [tab, setTab] = useState('plan');

  // Seed from the plan the first time this opens for it, without a useEffect
  // whose dependency array would re-seed on every parent render and throw away
  // what the operator has typed.
  const seedKey = creating ? 'new' : (plan?.id ?? null);
  if (open && initialised !== seedKey) {
    setInitialised(seedKey);
    setDraft(
      creating
        ? { id: '', name: '', amount_cents: 0, is_public: 1 }
        : {
            name: plan.name,
            description: plan.description,
            amount_cents: plan.amount_cents,
            ...Object.fromEntries(DIMENSIONS.map(d => [d.key, plan[d.key]])),
            priority_support: plan.priority_support,
            is_public: plan.is_public,
            is_default: plan.is_default,
            sort_order: plan.sort_order
          }
    );
    setReason('');
    setTab('plan');
  }

  const set = (key, value) => setDraft(current => ({ ...current, [key]: value }));
  const repriced = !creating && plan && draft.amount_cents !== plan.amount_cents;
  const reasonOk = reason.trim().length >= 3;
  const ready = reasonOk && (!creating || String(draft.id ?? '').length >= 2);

  return (
    <Modal
      open={open}
      title={creating ? 'New plan' : `Edit ${plan?.name}`}
      description={
        creating
          ? 'Creates the product in Stripe and the row here. A price above zero also creates a Stripe Price.'
          : 'Saving pushes to Stripe first. If Stripe refuses, nothing is written here either.'
      }
      onClose={onCancel}
      onSubmit={() => onSubmit(draft, reason.trim())}
      submitLabel={creating ? 'Create plan' : 'Save and push to Stripe'}
      submitDisabled={!ready}
      destructive={false}
      busy={busy}
      width={620}
      // The dialog is this tall when the window allows it, and the body scrolls
      // inside it - it does not grow to fit nine limit rows.
      //
      // Deliberate, and the design's own behaviour: the Limits tab shows five
      // rows with the sixth cut off at the fold, which is what tells somebody
      // there are more. A dialog sized to its content shows all nine with no
      // scrollbar on a tall window and silently loses the last four on a short
      // one, because nothing is left to absorb the difference.
      //
      // 556 = the chrome (header, tab strip, footer) plus a body holding the
      // intro and five 44px rows at an 11px gap. Measured in
      // `test/verify-layout.mjs`, not estimated.
      height={556}
      // Between the header and the body, so scrolling the content cannot carry
      // the way back to the other tab off the screen with it.
      tabs={[
        { key: 'plan', label: 'Plan' },
        { key: 'limits', label: 'Limits' }
      ].map(item => (
        <button
          key={item.key}
          type="button"
          role="tab"
          aria-selected={tab === item.key}
          onClick={() => setTab(item.key)}
          style={{
            height: '34px',
            padding: '0 14px',
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            fontFamily: 'var(--font)',
            fontSize: '12.5px',
            fontWeight: tab === item.key ? 600 : 500,
            color: tab === item.key ? 'var(--acc)' : 'var(--tx2)',
            boxShadow: tab === item.key ? 'inset 0 -2px 0 0 var(--acc)' : 'none'
          }}
        >
          {item.label}
        </button>
      ))}
      footer={
        canRetire ? (
          <button
            type="button"
            onClick={onRetire}
            style={{
              background: 'none',
              border: 'none',
              padding: 0,
              color: 'var(--dngrTx)',
              cursor: 'pointer',
              fontSize: '12.5px',
              fontFamily: 'var(--font)'
            }}
          >
            Retire this plan
          </button>
        ) : null
      }
    >
      <div hidden={tab !== 'plan'}>
        {creating && (
          <div style={{ marginBottom: '12px' }}>
            <label htmlFor="plan-id" style={label}>
              Plan id
            </label>
            <input
              id="plan-id"
              value={draft.id ?? ''}
              onChange={event => set('id', event.target.value.toLowerCase())}
              style={{ ...input, ...mono, height: '34px', fontSize: '12.5px' }}
            />
            <p style={{ margin: '5px 0 0', fontSize: '11px', color: 'var(--tx3)' }}>
              Lowercase, and permanent. It is the key every subscription resolves through.
            </p>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div>
            <label htmlFor="plan-name" style={label}>
              Name
            </label>
            <input
              id="plan-name"
              value={draft.name ?? ''}
              onChange={event => set('name', event.target.value)}
              style={{ ...input, fontSize: '13.5px' }}
            />
          </div>
          <div>
            <label htmlFor="plan-price" style={label}>
              Price, cents / month
            </label>
            <input
              id="plan-price"
              type="number"
              min="0"
              step="1"
              value={draft.amount_cents ?? 0}
              onChange={event => set('amount_cents', Number(event.target.value))}
              style={{ ...input, ...mono, fontSize: '13px' }}
            />
            {/*
              Cents, not dollars, because that is what Stripe stores - and the
              one mistake this invites is entering 49 for $49. Showing the
              rendered price as they type is cheaper than explaining it.
            */}
            <p style={{ margin: '6px 0 0', fontSize: '11.5px', color: 'var(--tx3)' }}>
              Integer only. {(draft.amount_cents ?? 0).toLocaleString('en-US')} renders as{' '}
              {money(draft.amount_cents ?? 0)} on the pricing page.
            </p>
          </div>

        {repriced && (
          <div
            style={{
              border: '1px solid var(--warnBd)',
              background: 'var(--warnSoft)',
              borderRadius: '9px',
              padding: '9px 11px',
              margin: 0,
              fontSize: '11.5px',
              lineHeight: 1.5,
              color: 'var(--warnTx)'
            }}
          >
            A Stripe price cannot be changed. Saving mints a <strong>new</strong> price at{' '}
            {money(draft.amount_cents)} and archives the old one — everyone already subscribed keeps
            billing the archived price until they change plan.
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '11px' }}>
          <button
            type="button"
            role="checkbox"
            aria-checked={draft.priority_support === 1}
            onClick={() => set('priority_support', draft.priority_support === 1 ? 0 : 1)}
            style={{
              width: '18px',
              height: '18px',
              flex: '0 0 18px',
              marginTop: '1px',
              borderRadius: '5px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: draft.priority_support === 1 ? 'var(--acc)' : 'transparent',
              border: draft.priority_support === 1 ? 'none' : '1.5px solid var(--bd2)',
              color: 'var(--accInk)',
              fontSize: '11px',
              lineHeight: 1,
              padding: 0
            }}
          >
            {draft.priority_support === 1 ? '✓' : ''}
          </button>
          <span>
            <span style={{ display: 'block', fontSize: '12.5px', fontWeight: 500, color: 'var(--tx)' }}>
              Priority support
            </span>
            <span style={{ display: 'block', fontSize: '11px', color: 'var(--tx3)', marginTop: '1px' }}>
              Display only — shown on the pricing page, enforces nothing.
            </span>
          </span>
        </div>

        <div>
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              marginBottom: '7px'
            }}
          >
            <label htmlFor="plan-reason" style={{ ...label, margin: 0 }}>
              Reason
            </label>
            {/*
              Red until filled. This is the field people try to skip, and an
              inert Save with no explanation is how they end up believing the
              dialog is broken.
            */}
            <span
              style={{
                ...mono,
                fontSize: '8.5px',
                fontWeight: 600,
                letterSpacing: '0.07em',
                padding: '2px 5px',
                borderRadius: '4px',
                color: reasonOk ? 'var(--tx3)' : 'var(--dngrTx)',
                background: reasonOk ? 'var(--surf3)' : 'var(--dngrSoft)',
                border: `1px solid ${reasonOk ? 'var(--bd)' : 'var(--dngrBd)'}`
              }}
            >
              REQUIRED
            </span>
          </div>
          <input
            id="plan-reason"
            value={reason}
            onChange={event => setReason(event.target.value)}
            placeholder="Why is this plan changing?"
            style={{
              ...input,
              fontSize: '13px',
              border: `1px solid ${reasonOk ? 'var(--bd2)' : 'var(--dngrBd)'}`
            }}
          />
          <p style={{ margin: '6px 0 0', fontSize: '11.5px', color: 'var(--tx3)' }}>
            Written verbatim to the audit log against your staff account.
          </p>
        </div>
        </div>
      </div>

      <div hidden={tab !== 'limits'}>
        <p style={{ margin: '0 0 16px', fontSize: '12.5px', lineHeight: 1.55, color: 'var(--tx2)' }}>
          <strong style={{ color: 'var(--tx)' }}>Default</strong> inherits the fallback in our
          source. <strong style={{ color: 'var(--tx)' }}>Unlimited</strong> removes the ceiling.{' '}
          <strong style={{ color: 'var(--tx)' }}>Value</strong> sets an explicit number for this
          plan.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '11px' }}>
          {DIMENSIONS.map(dimension => (
            <QuotaField
              key={dimension.key}
              id={`plan-${dimension.key}`}
              name={dimension.label}
              unit={dimension.unit}
              codeDefault={dimension.codeDefault}
              value={draft[dimension.key]}
              onChange={value => set(dimension.key, value)}
            />
          ))}
        </div>
      </div>

      {error && (
        <div style={{ marginTop: '14px' }}>
          <ErrorState error={error} />
        </div>
      )}
    </Modal>
  );
}

/**
 * The diff, field by field.
 *
 * Nothing is ticked by default. An operator has to choose each field they want
 * to take from Stripe, which is the entire difference between this and the
 * one-click pull the brief refuses.
 */
function DiffDialog({ open, diffs, busy, error, onCancel, onApply }) {
  const [picked, setPicked] = useState({});
  const [reason, setReason] = useState('');

  const toggle = (planId, field) =>
    setPicked(current => {
      const fields = new Set(current[planId] ?? []);
      if (fields.has(field)) fields.delete(field);
      else fields.add(field);
      return { ...current, [planId]: [...fields] };
    });

  const selections = Object.entries(picked)
    .filter(([, fields]) => fields.length > 0)
    .map(([planId, fields]) => ({ planId, fields }));

  return (
    <Modal
      open={open}
      title="Pull from Stripe"
      description="Stripe on the right, this database on the left. Tick only what you want to take."
      onClose={onCancel}
      onSubmit={() => onApply(selections, reason.trim())}
      submitLabel={`Apply ${selections.length === 0 ? 'nothing' : `${selections.length} plan(s)`}`}
      submitDisabled={selections.length === 0 || reason.trim().length < 3}
      destructive={false}
      busy={busy}
      width={640}
    >
      {diffs.length === 0 ? (
        <p style={{ margin: 0, fontSize: '13px', lineHeight: 1.6, color: 'var(--tx2)' }}>
          Nothing differs. Stripe and this database agree on every plan.
          <br />
          <span style={{ color: 'var(--tx3)' }}>
            This was a comparison, so nothing was written and the sync time is unchanged.
          </span>
        </p>
      ) : (
        diffs.map(diff => (
          <div key={diff.planId} style={{ ...card, marginBottom: '12px' }}>
            <div
              style={{
                padding: '10px 12px',
                borderBottom: '1px solid var(--bd)',
                background: 'var(--surf2)',
                display: 'flex',
                gap: '8px',
                alignItems: 'center'
              }}
            >
              <span style={{ fontSize: '12.5px', fontWeight: 600, color: 'var(--tx)' }}>
                {diff.name}
              </span>
              <span style={{ ...mono, fontSize: '10.5px', color: 'var(--tx3)' }}>{diff.planId}</span>
              {diff.unknownLocally && <span style={pills.warn}>no local row</span>}
            </div>
            {diff.fields.length === 0 ? (
              <div style={{ padding: '10px 12px', fontSize: '12px', color: 'var(--tx2)' }}>
                Present in Stripe with no row here. Use Reconcile all to create it.
              </div>
            ) : (
              diff.fields.map(field => (
                <label
                  key={field.field}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '22px minmax(0,150px) minmax(0,1fr) minmax(0,1fr)',
                    gap: '10px',
                    alignItems: 'center',
                    padding: '9px 12px',
                    borderBottom: '1px solid var(--bd)',
                    cursor: 'pointer'
                  }}
                >
                  <input
                    type="checkbox"
                    checked={(picked[diff.planId] ?? []).includes(field.field)}
                    onChange={() => toggle(diff.planId, field.field)}
                  />
                  <span style={{ ...mono, fontSize: '11px', color: 'var(--tx2)', ...ellipsis }}>
                    {field.field}
                  </span>
                  <span style={{ ...mono, fontSize: '11px', color: 'var(--tx3)', ...ellipsis }}>
                    here: {String(field.local ?? 'null')}
                  </span>
                  <span style={{ ...mono, fontSize: '11px', color: 'var(--acc)', ...ellipsis }}>
                    stripe: {String(field.remote ?? 'null')}
                  </span>
                </label>
              ))
            )}
          </div>
        ))
      )}

      {diffs.length > 0 && (
        <>
          <label htmlFor="sync-reason" style={{ ...label, marginTop: '14px' }}>
            Reason (recorded in the audit log)
          </label>
          <input
            id="sync-reason"
            value={reason}
            onChange={event => setReason(event.target.value)}
            style={input}
          />
        </>
      )}

      {error && (
        <div style={{ marginTop: '14px' }}>
          <ErrorState error={error} />
        </div>
      )}
    </Modal>
  );
}

/**
 * Sync history.
 *
 * A saved filter over the staff audit log — `action LIKE 'plan.%'` — and not a
 * table of its own. The audit rows already record who changed what, when, which
 * fields and the result, so a `plan_sync_events` table would be a second copy
 * of facts already held, kept in step by hand.
 */
export function SyncHistory() {
  const resource = useResource(() => staffApi.audit({ action: 'plan.', limit: 100 }), []);
  const rows = resource.data?.rows ?? [];

  if (resource.loading) return <Skeleton rows={6} />;
  if (resource.error) return <ErrorState error={resource.error} onRetry={resource.refresh} />;

  if (rows.length === 0) {
    return (
      <EmptyState
        title="No plan changes recorded"
        detail="Every plan edit, push, retire and pull writes a row here. An empty list means the catalogue has not been changed from this console."
      />
    );
  }

  const COLS_SYNC = '150px minmax(0,150px) 110px minmax(0,1fr) 80px';

  return (
    <div style={paneIn}>
      <div style={card}>
        <div style={{ overflowX: 'auto' }}>
          <div style={{ minWidth: '780px' }}>
            <div style={headRow(COLS_SYNC)}>
              <span style={th}>When (UTC)</span>
              <span style={th}>Staff</span>
              <span style={th}>Action</span>
              <span style={th}>Plan &amp; fields</span>
              <span style={th}>Result</span>
            </div>
            {rows.map(row => {
              let metadata = {};
              try {
                metadata = JSON.parse(row.metadata ?? '{}');
              } catch {
                /* A row whose metadata will not parse still has everything else. */
              }
              return (
                <div key={row.id} style={dataRow(COLS_SYNC, false)}>
                  <span style={{ ...mono, fontSize: '11px', color: 'var(--tx2)' }}>
                    {dateTime(row.createdAt)}
                  </span>
                  <span style={{ fontSize: '12px', color: 'var(--tx)', ...ellipsis }}>
                    {row.actorEmail}
                  </span>
                  <span style={{ ...mono, fontSize: '11px', color: 'var(--acc)', ...ellipsis }}>
                    {row.action.replace('plan.', '')}
                  </span>
                  <span style={{ ...mono, fontSize: '11px', color: 'var(--tx2)', ...ellipsis }}>
                    {row.targetId ?? '—'}
                    {metadata.fields ? ` · ${metadata.fields}` : ''}
                    {metadata.repriced ? ' · repriced' : ''}
                  </span>
                  <span style={row.result === 'success' ? pills.ok : pills.danger}>{row.result}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
