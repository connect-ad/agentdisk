import React, { useState } from 'react';
import { staffApi } from '../api.js';
import { useResource } from '../lib/useResource.js';
import { ConfirmModal, Modal } from '../components/Overlay.jsx';
import { EmptyState, ErrorState, Skeleton } from '../components/States.jsx';
import { holds } from '../components/Shell.jsx';
import { bytes, count, dateTime, money, quota } from '../lib/format.js';
import {
  card,
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

const COLS = 'minmax(0,1fr) 84px 92px 74px 74px 76px minmax(0,140px) 86px';

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

function syncState(plan) {
  if (!plan.stripe_product_id) return { tone: pills.warn, text: 'not in stripe' };
  if (!plan.last_synced_at) return { tone: pills.neutral, text: 'never synced' };
  return plan.last_synced_direction === 'inbound'
    ? { tone: pills.neutral, text: 'from stripe' }
    : { tone: pills.ok, text: 'pushed' };
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
      {/*
        Stated on every render rather than left to be discovered. Terraform still
        declares these products, so an apply after an edit here reverts it.
      */}
      {resource.data?.catalogueOwner === 'terraform' && (
        <div
          style={{
            border: '1px solid var(--warnBd)',
            background: 'var(--warnSoft)',
            borderRadius: '10px',
            padding: '11px 14px',
            marginBottom: '14px',
            fontSize: '12.5px',
            lineHeight: 1.55,
            color: 'var(--warnTx)'
          }}
        >
          <strong>Terraform still owns this catalogue.</strong> {resource.data.catalogueNote}
        </div>
      )}

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
        <span style={{ flex: 1, minWidth: '180px', fontSize: '12.5px', color: 'var(--tx2)' }}>
          Plans are synced with Stripe both ways. Pulling in is always a diff you confirm field by
          field.
        </span>
        <button type="button" style={canEdit ? secondaryBtn : disabledBtn} disabled={!canEdit || busy} onClick={openDiff}>
          {busy ? 'Working…' : 'Sync from Stripe'}
        </button>
        <button
          type="button"
          style={canEdit ? secondaryBtn : disabledBtn}
          disabled={!canEdit || busy}
          onClick={() =>
            act(
              () => staffApi.syncCatalogue('Reconciling the catalogue after a Terraform apply'),
              'Catalogue reconciled from Stripe.'
            )
          }
          title="Replays the same product→plan upsert the webhook uses, for every product in Stripe."
        >
          Reconcile all
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
            <div style={{ minWidth: '900px' }}>
              <div style={headRow(COLS)}>
                <span style={th}>Plan</span>
                <span style={thR}>Price</span>
                <span style={thR}>Storage</span>
                <span style={thR}>Agents</span>
                <span style={thR}>Members</span>
                <span style={thR}>Workspaces</span>
                <span style={th}>Stripe price</span>
                <span style={th}>Sync</span>
              </div>
              {plans.map(plan => {
                const state = syncState(plan);
                return (
                  <div key={plan.id} style={dataRow(COLS, false)}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                      <span style={{ fontSize: '12.5px', fontWeight: 500, color: 'var(--tx)' }}>
                        {plan.name}
                      </span>
                      {plan.is_default === 1 && <span style={pills.accent}>default</span>}
                      {plan.is_public === 0 && <span style={pills.neutral}>retired</span>}
                    </span>
                    <span style={{ ...mono, fontSize: '11.5px', color: 'var(--tx)', textAlign: 'right' }}>
                      {money(plan.amount_cents, plan.currency)}
                    </span>
                    <span style={{ ...mono, fontSize: '11.5px', color: 'var(--tx2)', textAlign: 'right' }}>
                      {quota(plan.storage_bytes) === 'Unlimited' ? 'Unlimited' : bytes(plan.storage_bytes)}
                    </span>
                    <span style={{ ...mono, fontSize: '11.5px', color: 'var(--tx2)', textAlign: 'right' }}>
                      {quota(plan.agents)}
                    </span>
                    <span style={{ ...mono, fontSize: '11.5px', color: 'var(--tx2)', textAlign: 'right' }}>
                      {quota(plan.members)}
                    </span>
                    <span style={{ ...mono, fontSize: '11.5px', color: 'var(--tx2)', textAlign: 'right' }}>
                      {quota(plan.workspaces)}
                    </span>
                    <span style={{ ...mono, fontSize: '10.5px', color: 'var(--tx3)', ...ellipsis }}>
                      {plan.stripe_price_id ?? '—'}
                    </span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span style={state.tone}>{state.text}</span>
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
                      {canCreate && plan.is_public === 1 && (
                        <button
                          type="button"
                          onClick={() => setRetiring(plan)}
                          style={{
                            background: 'none',
                            border: 'none',
                            padding: 0,
                            color: 'var(--tx3)',
                            cursor: 'pointer',
                            fontSize: '12px',
                            fontFamily: 'var(--font)'
                          }}
                        >
                          Retire
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

function PlanEditor({ plan, open, creating = false, busy, error, onCancel, onSubmit }) {
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

      <label htmlFor="plan-name" style={label}>
        Name
      </label>
      <input
        id="plan-name"
        value={draft.name ?? ''}
        onChange={event => set('name', event.target.value)}
        style={{ ...input, marginBottom: '12px' }}
      />

      <label htmlFor="plan-price" style={label}>
        Price, in cents per month
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

      {DIMENSIONS.map(dimension => (
        <QuotaField
          key={dimension.key}
          id={`plan-${dimension.key}`}
          name={dimension.label}
          value={draft[dimension.key]}
          onChange={value => set(dimension.key, value)}
        />
      ))}

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
        <p style={{ margin: 0, fontSize: '13px', color: 'var(--tx2)' }}>
          Nothing differs. Stripe and this database agree on every plan.
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
