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
  'minmax(120px,1.1fr) 68px 84px 58px 70px 86px minmax(90px,1fr) 128px 104px';

const DIMENSIONS = [
  { key: 'storage_bytes', label: 'Storage', format: bytes, unit: 'bytes' },
  { key: 'max_file_bytes', label: 'Max single file', format: bytes, unit: 'bytes' },
  { key: 'agents', label: 'Agent identities', format: quota },
  { key: 'members', label: 'Members', format: quota },
  { key: 'workspaces', label: 'Workspaces', format: quota },
  { key: 'api_keys', label: 'API keys', format: quota },
  { key: 'file_count', label: 'Files', format: quota },
  { key: 'egress_bytes_period', label: 'Egress / period', format: quota },
  { key: 'requests_period', label: 'Requests / period', format: quota }
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
                      The badge and when it happened, stacked. A status with no
                      time attached cannot be told apart from a stale one.
                    */}
                    <span style={{ ...cell(), flexDirection: 'column', alignItems: 'flex-start', gap: '3px' }}>
                      <span style={state.tone}>{state.text}</span>
                      {state.at && (
                        <span
                          style={{ ...mono, fontSize: '9.5px', color: 'var(--tx3)' }}
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
function QuotaField({ id, name, value, onChange }) {
  const mode = value === null || value === undefined ? 'default' : value < 0 ? 'unlimited' : 'value';

  return (
    <div style={{ marginBottom: '12px' }}>
      <label htmlFor={id} style={label}>
        {name}
      </label>
      <div style={{ display: 'flex', gap: '8px' }}>
        <select
          aria-label={`${name} mode`}
          value={mode}
          onChange={event => {
            if (event.target.value === 'default') onChange(null);
            else if (event.target.value === 'unlimited') onChange(-1);
            else onChange(0);
          }}
          style={{ ...input, width: '150px', height: '34px' }}
        >
          {/* null and -1 are different answers and must stay different: one is
              "the row did not say", which defers to the code floor, and the
              other is a decision. */}
          <option value="default">From code default</option>
          <option value="unlimited">Unlimited</option>
          <option value="value">Set a value</option>
        </select>
        {mode === 'value' && (
          <input
            id={id}
            type="number"
            min="0"
            value={value ?? 0}
            onChange={event => onChange(Number(event.target.value))}
            style={{ ...input, ...mono, flex: 1, height: '34px' }}
          />
        )}
      </div>
    </div>
  );
}

function PlanEditor({
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
  }

  const set = (key, value) => setDraft(current => ({ ...current, [key]: value }));
  const repriced = !creating && plan && draft.amount_cents !== plan.amount_cents;
  const ready = reason.trim().length >= 3 && (!creating || String(draft.id ?? '').length >= 2);

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
      {creating && (
        <>
          <label htmlFor="plan-id" style={label}>
            Plan id (lowercase, permanent)
          </label>
          <input
            id="plan-id"
            value={draft.id ?? ''}
            onChange={event => set('id', event.target.value.toLowerCase())}
            style={{ ...input, ...mono, marginBottom: '12px' }}
          />
        </>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(200px, 2fr) minmax(140px, 1fr)',
          columnGap: '14px'
        }}
      >
        <div>
          <label htmlFor="plan-name" style={label}>
            Name
          </label>
          <input
            id="plan-name"
            value={draft.name ?? ''}
            onChange={event => set('name', event.target.value)}
            style={{ ...input, marginBottom: '12px' }}
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
            style={{ ...input, ...mono, marginBottom: repriced ? '8px' : '12px' }}
          />
        </div>
      </div>

      {repriced && (
        <div
          style={{
            border: '1px solid var(--warnBd)',
            background: 'var(--warnSoft)',
            borderRadius: '9px',
            padding: '10px 12px',
            marginBottom: '12px',
            fontSize: '12px',
            lineHeight: 1.55,
            color: 'var(--warnTx)'
          }}
        >
          A Stripe Price cannot be changed. Saving mints a <strong>new</strong> price at{' '}
          {money(draft.amount_cents)} and archives the old one. Everyone already subscribed keeps
          billing the archived price until they change plan.
        </div>
      )}

      <div style={{ borderTop: '1px solid var(--bd)', margin: '6px 0 14px' }} />

      {/*
        Two columns, not nine stacked rows.

        The form carries fourteen fields and the dialog is bounded by the
        viewport, so on a short window the body became a 90px slot scrolling
        through a very long list - technically correct and miserable to use.
        Halving the height is the fix that helps at every window size, rather
        than trying to win more height from a viewport that does not have it.
      */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
          columnGap: '14px'
        }}
      >
        {DIMENSIONS.map(dimension => (
          <QuotaField
            key={dimension.key}
            id={`plan-${dimension.key}`}
            name={dimension.label}
            value={draft[dimension.key]}
            onChange={value => set(dimension.key, value)}
          />
        ))}
      </div>

      <label style={{ ...label, display: 'flex', alignItems: 'center', gap: '8px', textTransform: 'none' }}>
        <input
          type="checkbox"
          checked={draft.priority_support === 1}
          onChange={event => set('priority_support', event.target.checked ? 1 : 0)}
        />
        <span style={{ fontSize: '12.5px', color: 'var(--tx)', letterSpacing: 0 }}>
          Priority support (display only — nothing enforces it)
        </span>
      </label>

      <label htmlFor="plan-reason" style={{ ...label, marginTop: '14px' }}>
        Reason (recorded in the audit log)
      </label>
      <input
        id="plan-reason"
        value={reason}
        onChange={event => setReason(event.target.value)}
        style={input}
      />

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
