import React, { useState } from 'react';
import { staffApi } from '../api.js';
import { useResource } from '../lib/useResource.js';
import { EmptyState, ErrorState, NotTracked, Skeleton } from '../components/States.jsx';
import { ConfirmModal, Modal } from '../components/Overlay.jsx';
import { holds } from '../components/Shell.jsx';
import { bytes, count, date, percentOf, planLabel, quota } from '../lib/format.js';
import {
  billingTone,
  card,
  dataRow,
  disabledBtn,
  ellipsis,
  headRow,
  input,
  label,
  lifecycleTone,
  mono,
  paneIn,
  pills,
  primaryBtn,
  secondaryBtn,
  statusCell,
  statusDot,
  th,
  thR
} from '../lib/ui.js';

/**
 * Workspaces: the list, its filtered sub-views, and one workspace's detail.
 *
 * ── Two status columns, because they are two different facts ───────────────
 * The design collapses `workspaces.status` and the organization's
 * `billing_status` into one column with invented labels, which is exactly why
 * its mock data shows a "Canceled" workspace sitting under the Suspended
 * filter. They are separate here: lifecycle is whether the workspace is live,
 * billing is whether the account behind it is paid up, and a workspace can be
 * active on a past-due organization.
 *
 * ── No MRR column ──────────────────────────────────────────────────────────
 * Billing attaches to an organization, and one organization owns many
 * workspaces. Per-workspace MRR would have to invent a split that nothing in
 * the product performs. It lives on the Billing screen, per org.
 *
 * ── No region ──────────────────────────────────────────────────────────────
 * There is no region column. There is no region.
 */

const COLS = 'minmax(0,1.5fr) 80px minmax(0,1.1fr) 92px 104px 104px';

function statusPair(workspace) {
  return (
    <>
      <span style={statusCell(lifecycleTone(workspace.status))}>
        <span style={statusDot(lifecycleTone(workspace.status))} />
        {workspace.status}
      </span>
      <span style={statusCell(billingTone(workspace.billingStatus))}>
        <span style={statusDot(billingTone(workspace.billingStatus))} />
        {workspace.billingStatus}
      </span>
    </>
  );
}

export function WorkspaceList({ view, onNavigate }) {
  const [search, setSearch] = useState('');
  const [applied, setApplied] = useState('');

  const resource = useResource(async () => {
    if (view === 'needs-attention') return staffApi.needsAttention();
    const result = await staffApi.listWorkspaces(applied || undefined);
    if (view === 'suspended') {
      return { workspaces: result.workspaces.filter(w => w.status === 'suspended') };
    }
    return result;
  }, [view, applied]);

  const workspaces = resource.data?.workspaces ?? [];

  return (
    <div style={paneIn}>
      {view === 'all' && (
        <form
          onSubmit={event => {
            event.preventDefault();
            setApplied(search.trim());
          }}
          style={{ display: 'flex', gap: '8px', marginBottom: '12px', flexWrap: 'wrap' }}
        >
          <input
            aria-label="Search workspaces"
            placeholder="Name, workspace ID or owner email"
            value={search}
            onChange={event => setSearch(event.target.value)}
            style={{ ...input, flex: 1, minWidth: '220px', maxWidth: '360px', height: '32px' }}
          />
          <button type="submit" style={secondaryBtn}>
            Search
          </button>
          {applied && (
            <button
              type="button"
              style={secondaryBtn}
              onClick={() => {
                setSearch('');
                setApplied('');
              }}
            >
              Clear
            </button>
          )}
          <span
            style={{
              marginLeft: 'auto',
              ...mono,
              fontSize: '10.5px',
              color: 'var(--tx3)',
              alignSelf: 'center'
            }}
          >
            {workspaces.length} SHOWN
          </span>
        </form>
      )}

      {resource.error && (
        <div style={{ marginBottom: '12px' }}>
          <ErrorState error={resource.error} onRetry={resource.refresh} />
        </div>
      )}

      {resource.loading ? (
        <Skeleton />
      ) : workspaces.length === 0 ? (
        <EmptyState
          title={
            view === 'needs-attention'
              ? 'Nothing needs attention'
              : view === 'suspended'
                ? 'No suspended workspaces'
                : applied
                  ? 'No workspace matched that search'
                  : 'No workspaces yet'
          }
          detail={
            view === 'needs-attention'
              ? 'No workspace is over 95% of a quota and no organization is past due.'
              : applied
                ? 'Search covers workspace name, workspace ID and owner email.'
                : undefined
          }
        />
      ) : (
        <div style={card}>
          <div style={{ overflowX: 'auto' }}>
            <div style={{ minWidth: '860px' }}>
              <div style={headRow(COLS)}>
                <span style={th}>Workspace</span>
                <span style={th}>Plan</span>
                <span style={th}>Organization</span>
                <span style={thR}>Storage</span>
                <span style={th}>Lifecycle</span>
                <span style={th}>Billing</span>
              </div>
              {workspaces.map(workspace => (
                <button
                  key={workspace.id}
                  type="button"
                  onClick={() => onNavigate(`/workspaces/${workspace.id}`)}
                  style={dataRow(COLS, true)}
                >
                  <span style={{ minWidth: 0 }}>
                    <span
                      style={{
                        display: 'block',
                        fontSize: '12.5px',
                        fontWeight: 500,
                        color: 'var(--tx)',
                        ...ellipsis
                      }}
                    >
                      {workspace.name}
                    </span>
                    <span
                      style={{ ...mono, display: 'block', fontSize: '10.5px', color: 'var(--tx3)' }}
                    >
                      {workspace.id}
                    </span>
                  </span>
                  <span style={pills.accent}>{planLabel(workspace.plan)}</span>
                  <span style={{ fontSize: '12px', color: 'var(--tx2)', ...ellipsis }}>
                    {workspace.orgName}
                  </span>
                  <span style={{ ...mono, fontSize: '11.5px', color: 'var(--tx2)', textAlign: 'right' }}>
                    {bytes(workspace.storageBytesUsed)}
                  </span>
                  {statusPair(workspace)}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------ the detail ------------------------------- */

function Fact({ name, children }) {
  return (
    <div style={{ display: 'flex', gap: '14px', padding: '10px 15px', borderBottom: '1px solid var(--bd)' }}>
      <span
        style={{
          width: '140px',
          flex: '0 0 140px',
          ...mono,
          fontSize: '9.5px',
          letterSpacing: '0.09em',
          color: 'var(--tx3)',
          paddingTop: '2px',
          textTransform: 'uppercase'
        }}
      >
        {name}
      </span>
      <span style={{ flex: 1, minWidth: 0, fontSize: '12.5px', color: 'var(--tx)', wordBreak: 'break-word' }}>
        {children}
      </span>
    </div>
  );
}

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'usage', label: 'Usage' },
  { key: 'activity', label: 'Workspace activity' },
  { key: 'webhooks', label: 'Webhooks' }
];

export function WorkspaceDetail({ workspaceId, role, onNavigate, onToast }) {
  const [tab, setTab] = useState('overview');
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);

  const resource = useResource(() => staffApi.getWorkspace(workspaceId), [workspaceId]);
  const activity = useResource(
    () => (tab === 'activity' ? staffApi.workspaceActivity(workspaceId) : Promise.resolve(null)),
    [workspaceId, tab]
  );
  const plans = useResource(() => staffApi.listPlans(), []);

  const workspace = resource.data?.workspace;

  async function act(fn, successMessage) {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
      setDialog(null);
      onToast?.(successMessage);
      await resource.refresh();
    } catch (err) {
      // Never an optimistic success. The dialog stays open with the real error.
      setActionError(err);
    } finally {
      setBusy(false);
    }
  }

  if (resource.loading) return <Skeleton rows={8} />;
  if (!workspace) return <ErrorState error={resource.error} onRetry={resource.refresh} />;

  const canSuspend = holds(role, 'admin');
  const canDelete = holds(role, 'super_admin');
  const suspended = workspace.status === 'suspended';
  const deleted = workspace.status === 'deleted';
  const planRow = (plans.data?.plans ?? []).find(p => p.id === workspace.plan);

  return (
    <div style={paneIn}>
      <button
        type="button"
        onClick={() => onNavigate('/workspaces')}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          background: 'transparent',
          border: 'none',
          padding: 0,
          marginBottom: '14px',
          cursor: 'pointer',
          fontFamily: 'var(--font)',
          fontSize: '12.5px',
          fontWeight: 600,
          color: 'var(--acc)'
        }}
      >
        ← Back to Workspaces
      </button>

      <div style={{ display: 'flex', gap: '2px', borderBottom: '1px solid var(--bd)', marginBottom: '18px' }}>
        {TABS.map(item => (
          <button
            key={item.key}
            type="button"
            onClick={() => setTab(item.key)}
            style={{
              background: 'transparent',
              border: 'none',
              borderBottom: `2px solid ${tab === item.key ? 'var(--acc)' : 'transparent'}`,
              padding: '9px 13px',
              cursor: 'pointer',
              fontFamily: 'var(--font)',
              fontSize: '12.5px',
              fontWeight: tab === item.key ? 600 : 500,
              color: tab === item.key ? 'var(--acc)' : 'var(--tx2)'
            }}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.4fr) minmax(280px,1fr)', gap: '14px' }}>
          <div style={card}>
            <div style={{ padding: '12px 15px', borderBottom: '1px solid var(--bd)', background: 'var(--surf2)' }}>
              <span style={{ ...mono, fontSize: '9.5px', letterSpacing: '0.11em', color: 'var(--tx3)' }}>
                WORKSPACE RECORD
              </span>
            </div>
            <Fact name="Name">{workspace.name}</Fact>
            <Fact name="Workspace ID">
              <span style={mono}>{workspace.id}</span>
            </Fact>
            <Fact name="Organization">
              {workspace.orgName} <span style={{ ...mono, color: 'var(--tx3)' }}>{workspace.orgId}</span>
            </Fact>
            <Fact name="Plan">{planLabel(workspace.plan)}</Fact>
            <Fact name="Lifecycle">
              <span style={statusCell(lifecycleTone(workspace.status))}>
                <span style={statusDot(lifecycleTone(workspace.status))} />
                {workspace.status}
              </span>
            </Fact>
            <Fact name="Billing">
              <span style={statusCell(billingTone(workspace.billingStatus))}>
                <span style={statusDot(billingTone(workspace.billingStatus))} />
                {workspace.billingStatus}
              </span>
            </Fact>
            <Fact name="Created">{date(workspace.createdAt)}</Fact>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ ...card, padding: '14px' }}>
              <div
                style={{
                  ...mono,
                  fontSize: '9.5px',
                  letterSpacing: '0.11em',
                  color: 'var(--tx3)',
                  marginBottom: '12px'
                }}
              >
                STAFF ACTIONS
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
                <button
                  type="button"
                  disabled={!canSuspend || deleted}
                  onClick={() => setDialog(suspended ? 'reinstate' : 'suspend')}
                  style={canSuspend && !deleted ? secondaryBtn : disabledBtn}
                >
                  {suspended ? 'Reinstate workspace' : 'Suspend workspace'}
                </button>
                <button
                  type="button"
                  disabled={!canSuspend || deleted}
                  onClick={() => setDialog('override')}
                  style={canSuspend && !deleted ? secondaryBtn : disabledBtn}
                >
                  Adjust plan override
                </button>
                {deleted ? (
                  <button
                    type="button"
                    disabled={!canDelete}
                    onClick={() => setDialog('restore')}
                    style={canDelete ? secondaryBtn : disabledBtn}
                  >
                    Restore workspace
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={!canDelete || !suspended}
                    onClick={() => setDialog('delete')}
                    style={canDelete && suspended ? secondaryBtn : disabledBtn}
                    title={
                      !suspended
                        ? 'Suspend the workspace first. Suspension is instant and reversible.'
                        : undefined
                    }
                  >
                    Delete workspace
                  </button>
                )}
              </div>

              {!canSuspend && (
                <p style={{ margin: '12px 0 0', fontSize: '11.5px', lineHeight: 1.5, color: 'var(--tx2)' }}>
                  Read-only role. These actions need admin or above — and every one of them is
                  written to the audit log against your account.
                </p>
              )}
              {canDelete && !suspended && !deleted && (
                <p style={{ margin: '12px 0 0', fontSize: '11.5px', lineHeight: 1.5, color: 'var(--tx3)' }}>
                  Delete is available once the workspace is suspended. Suspension is instant and
                  reversible, and gives the customer a chance to notice.
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {tab === 'usage' && (
        <div style={card}>
          <div style={{ padding: '12px 15px', borderBottom: '1px solid var(--bd)', background: 'var(--surf2)' }}>
            <span style={{ ...mono, fontSize: '9.5px', letterSpacing: '0.11em', color: 'var(--tx3)' }}>
              USAGE AGAINST THE PLAN
            </span>
          </div>
          <Fact name="Storage used">
            {bytes(workspace.storageBytesUsed)}
            {planRow?.storage_bytes > 0 && (
              <span style={{ color: 'var(--tx2)' }}>
                {' '}
                of {bytes(planRow.storage_bytes)} ·{' '}
                {percentOf(workspace.storageBytesUsed, planRow.storage_bytes)}%
              </span>
            )}
          </Fact>
          <Fact name="Files">
            {count(workspace.fileCount)}
            {planRow && <span style={{ color: 'var(--tx2)' }}> of {quota(planRow.file_count)}</span>}
          </Fact>
          <Fact name="Egress this period">
            {planRow ? quota(planRow.egress_bytes_period) : <NotTracked />}
          </Fact>
          <Fact name="Requests this period">
            {planRow ? quota(planRow.requests_period) : <NotTracked />}
          </Fact>
          {/*
            No overage row. Pricing here is hard-capped with no metered overage,
            which is a deliberate trust position - the design's "$12.40 overage"
            row contradicts the product it is describing.
          */}
          <div style={{ padding: '12px 15px', fontSize: '11.5px', color: 'var(--tx3)' }}>
            Pricing is hard-capped. There is no metered overage on any plan.
          </div>
        </div>
      )}

      {tab === 'activity' && (
        <div style={card}>
          <div style={{ padding: '12px 15px', borderBottom: '1px solid var(--bd)', background: 'var(--surf2)' }}>
            <span style={{ ...mono, fontSize: '9.5px', letterSpacing: '0.11em', color: 'var(--tx3)' }}>
              THIS WORKSPACE&apos;S OWN ACTIVITY LOG
            </span>
            <div style={{ fontSize: '11.5px', color: 'var(--tx3)', marginTop: '4px' }}>
              Every actor — the customer&apos;s users, their agents, and staff. Not the staff audit
              log, which is under Audit Log.
            </div>
          </div>
          {activity.loading ? (
            <Skeleton rows={5} />
          ) : (activity.data?.events ?? activity.data ?? []).length === 0 ? (
            <div style={{ padding: '28px 16px', textAlign: 'center', fontSize: '12.5px', color: 'var(--tx2)' }}>
              Nothing recorded for this workspace yet.
            </div>
          ) : (
            (activity.data?.events ?? activity.data ?? []).map((event, index) => (
              <div key={event.id ?? index} style={dataRow('150px 130px minmax(0,1fr)', false)}>
                <span style={{ ...mono, fontSize: '11px', color: 'var(--tx2)' }}>
                  {date(event.created_at)}
                </span>
                <span style={pills.neutral}>{event.actor_type}</span>
                <span style={{ ...mono, fontSize: '11px', color: 'var(--tx)', ...ellipsis }}>
                  {event.action}
                </span>
              </div>
            ))
          )}
        </div>
      )}

      {tab === 'webhooks' && (
        <EmptyState
          title="Delivery history not tracked yet"
          detail={
            'Nothing in this product records webhook delivery attempts, so there is no ' +
            'success or failure history to show and no redelivery to offer. This says so ' +
            'rather than rendering a number that would be invented.'
          }
        />
      )}

      {/* ------------------------------ dialogs ----------------------------- */}

      <ConfirmModal
        open={dialog === 'suspend' || dialog === 'reinstate'}
        destructive={dialog === 'suspend'}
        title={dialog === 'suspend' ? `Suspend ${workspace.name}?` : `Reinstate ${workspace.name}?`}
        description={
          dialog === 'suspend'
            ? 'Every API key in this workspace stops authenticating immediately. Reversible at any time.'
            : 'Access is restored immediately to every key and member in this workspace.'
        }
        requireReason
        confirmLabel={dialog === 'suspend' ? 'Suspend' : 'Reinstate'}
        busy={busy}
        onCancel={() => setDialog(null)}
        onConfirm={reason =>
          act(
            () =>
              staffApi.setWorkspaceStatus(
                workspace.id,
                dialog === 'suspend' ? 'suspended' : 'active',
                reason
              ),
            dialog === 'suspend' ? 'Workspace suspended.' : 'Workspace reinstated.'
          )
        }
      />

      <ConfirmModal
        open={dialog === 'delete'}
        title={`Delete ${workspace.name}?`}
        description={
          'Soft delete with a 30-day window. Nothing is destroyed now — the cascade runs from ' +
          'the purge job after 30 days, and Restore fully reverses it until then.'
        }
        blastRadius={
          <>
            <div>{count(workspace.fileCount)} files · {bytes(workspace.storageBytesUsed)}</div>
            <div>Organization: {workspace.orgName}</div>
          </>
        }
        confirmText={workspace.name}
        requireReason
        confirmLabel="Delete workspace"
        busy={busy}
        onCancel={() => setDialog(null)}
        // The modal has already checked the typed name matches; the server
        // checks it again, which is the one that counts.
        onConfirm={reason =>
          act(
            () => staffApi.deleteWorkspace(workspace.id, workspace.name, reason),
            'Workspace deleted. Restorable for 30 days.'
          )
        }
      />

      <ConfirmModal
        open={dialog === 'restore'}
        destructive={false}
        title={`Restore ${workspace.name}?`}
        description="It comes back suspended, not active — whatever caused the suspension has not been resolved by restoring it."
        requireReason
        confirmLabel="Restore"
        busy={busy}
        onCancel={() => setDialog(null)}
        onConfirm={reason =>
          act(() => staffApi.restoreWorkspace(workspace.id, reason), 'Workspace restored, suspended.')
        }
      />

      <PlanOverrideDialog
        open={dialog === 'override'}
        workspace={workspace}
        plans={plans.data?.plans ?? []}
        busy={busy}
        error={actionError}
        onCancel={() => setDialog(null)}
        onSubmit={(planId, reason) =>
          act(
            () => staffApi.setPlanOverride(workspace.id, planId, reason),
            planId ? `Override set to ${planId}.` : 'Override cleared.'
          )
        }
      />

      {actionError && dialog === null && (
        <div style={{ marginTop: '14px' }}>
          <ErrorState error={actionError} />
        </div>
      )}
    </div>
  );
}

function PlanOverrideDialog({ open, workspace, plans, busy, error, onCancel, onSubmit }) {
  const [planId, setPlanId] = useState('');
  const [reason, setReason] = useState('');

  return (
    <Modal
      open={open}
      title="Adjust plan override"
      description={
        'An override gives this one workspace another plan’s entitlements, whatever the ' +
        'organization is on. Clearing it returns the workspace to the organization’s plan.'
      }
      onClose={onCancel}
      onSubmit={() => onSubmit(planId === '' ? null : planId, reason)}
      submitLabel="Apply override"
      submitDisabled={reason.trim().length < 3}
      busy={busy}
      destructive={false}
    >
      <label htmlFor="override-plan" style={label}>
        Plan
      </label>
      <select
        id="override-plan"
        value={planId}
        onChange={event => setPlanId(event.target.value)}
        style={{ ...input, marginBottom: '14px' }}
      >
        <option value="">No override — use the organization&apos;s plan</option>
        {plans.map(plan => (
          <option key={plan.id} value={plan.id}>
            {plan.name} ({plan.id})
          </option>
        ))}
      </select>

      <label htmlFor="override-reason" style={label}>
        Reason (recorded in the audit log)
      </label>
      <input
        id="override-reason"
        value={reason}
        onChange={event => setReason(event.target.value)}
        style={input}
        placeholder="Support ticket, agreement, or why this is warranted"
      />

      {error && (
        <div style={{ marginTop: '14px' }}>
          <ErrorState error={error} />
        </div>
      )}
    </Modal>
  );
}
