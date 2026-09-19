import React, { useState } from 'react';
import { staffApi } from '../api.js';
import { useResource } from '../lib/useResource.js';
import { ConfirmModal, Modal } from '../components/Overlay.jsx';
import { EmptyState, ErrorState, Skeleton } from '../components/States.jsx';
import { date, dateTime } from '../lib/format.js';
import {
  card,
  dataRow,
  ellipsis,
  headRow,
  input,
  label,
  mono,
  paneIn,
  pills,
  primaryBtn,
  secondaryBtn,
  th
} from '../lib/ui.js';

/**
 * Staff accounts. super_admin only, all of it.
 *
 * ── An account is an address and a role ────────────────────────────────────
 * Nothing secret is created here, so nothing is shown once. Adding somebody
 * grants an email address a role; they sign in with Google like everybody else
 * and the API reads this row to decide what they may do. That also means a row
 * can exist for an address that has never signed in — which is how you onboard
 * somebody before their first day, and equally how you could grant access to an
 * address you do not control. Hence super_admin only, and audited.
 *
 * ── No 2FA column ──────────────────────────────────────────────────────────
 * The design has one. Firebase owns authentication now, so whether a staff
 * member has two-factor set up is a fact about their Google account and not
 * something this database knows. Showing a column we cannot fill would be
 * exactly the invented data the rest of this console refuses to render.
 *
 * ── Never deleted, only disabled ───────────────────────────────────────────
 * Unchanged: the audit log has to keep resolving a historical actor.
 */

const COLS = 'minmax(0,1.6fr) 110px 150px 110px 130px';

export function StaffAccounts({ currentStaffId, onToast }) {
  const resource = useResource(() => staffApi.listAccounts(), []);
  const [creating, setCreating] = useState(false);
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const accounts = resource.data?.accounts ?? [];

  async function act(fn, message) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setDialog(null);
      onToast?.(message);
      await resource.refresh();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (resource.loading) return <Skeleton rows={5} />;
  if (resource.error && !resource.data) {
    return <ErrorState error={resource.error} onRetry={resource.refresh} />;
  }

  return (
    <div style={paneIn}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '14px' }}>
        <button type="button" style={primaryBtn} onClick={() => setCreating(true)}>
          Invite staff
        </button>
      </div>

      {error && (
        <div style={{ marginBottom: '14px' }}>
          <ErrorState error={error} />
        </div>
      )}

      {accounts.length === 0 ? (
        <EmptyState title="No staff accounts" detail="This cannot normally happen — you are signed in as one." />
      ) : (
        <div style={card}>
          <div style={{ overflowX: 'auto' }}>
            <div style={{ minWidth: '840px' }}>
              <div style={headRow(COLS)}>
                <span style={th}>Staff member</span>
                <span style={th}>Role</span>
                <span style={th}>Last seen</span>
                <span style={th}>Status</span>
                <span style={th}>Actions</span>
              </div>
              {accounts.map(account => {
                const self = account.id === currentStaffId;
                return (
                  <div key={account.id} style={dataRow(COLS, false)}>
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
                        {account.email}
                        {self && <span style={{ color: 'var(--tx3)' }}> (you)</span>}
                      </span>
                      <span style={{ ...mono, display: 'block', fontSize: '10.5px', color: 'var(--tx3)' }}>
                        joined {date(account.createdAt)}
                      </span>
                    </span>
                    <span style={pills.accent}>{account.role}</span>
                    <span style={{ fontSize: '12px', color: 'var(--tx2)', ...ellipsis }}>
                      {account.lastLoginAt ? dateTime(account.lastLoginAt) : 'never signed in'}
                    </span>
                    <span style={account.disabledAt ? pills.danger : pills.ok}>
                      {account.disabledAt ? 'disabled' : 'active'}
                    </span>
                    <span style={{ display: 'flex', gap: '8px' }}>
                      <button
                        type="button"
                        disabled={self}
                        onClick={() => setDialog({ kind: 'role', account })}
                        style={{
                          background: 'none',
                          border: 'none',
                          padding: 0,
                          color: self ? 'var(--tx3)' : 'var(--acc)',
                          cursor: self ? 'not-allowed' : 'pointer',
                          fontSize: '12px',
                          fontFamily: 'var(--font)'
                        }}
                        title={self ? 'You cannot change your own role.' : undefined}
                      >
                        Role
                      </button>
                      <button
                        type="button"
                        disabled={self && !account.disabledAt}
                        onClick={() => setDialog({ kind: 'disable', account })}
                        style={{
                          background: 'none',
                          border: 'none',
                          padding: 0,
                          color: self && !account.disabledAt ? 'var(--tx3)' : 'var(--tx2)',
                          cursor: self && !account.disabledAt ? 'not-allowed' : 'pointer',
                          fontSize: '12px',
                          fontFamily: 'var(--font)'
                        }}
                        title={
                          self && !account.disabledAt
                            ? 'You cannot disable your own account — it would remove the only role that can re-enable it.'
                            : undefined
                        }
                      >
                        {account.disabledAt ? 'Enable' : 'Disable'}
                      </button>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
          <div
            style={{
              padding: '11px 14px',
              background: 'var(--surf2)',
              fontSize: '11.5px',
              color: 'var(--tx3)'
            }}
          >
            Staff accounts are never deleted, only disabled — the audit log has to keep resolving a
            historical actor.
          </div>
        </div>
      )}

      <InviteDialog
        open={creating}
        busy={busy}
        error={error}
        onCancel={() => {
          setCreating(false);
          setError(null);
        }}
        onSubmit={(email, role, reason) =>
          act(() => staffApi.createAccount(email, role, reason), `${email} can now sign in as ${role}.`)
        }
      />

      <ConfirmModal
        open={dialog?.kind === 'disable'}
        destructive={!dialog?.account?.disabledAt}
        title={
          dialog?.account?.disabledAt
            ? `Re-enable ${dialog?.account?.email}?`
            : `Disable ${dialog?.account?.email}?`
        }
        description={
          dialog?.account?.disabledAt
            ? 'They can sign in again with the same password and TOTP.'
            : 'Every live session for this account ends immediately — without that, a disabled staff member keeps cross-tenant reach for the remaining hours of a session already open.'
        }
        requireReason
        confirmLabel={dialog?.account?.disabledAt ? 'Re-enable' : 'Disable'}
        busy={busy}
        onCancel={() => setDialog(null)}
        onConfirm={reason =>
          act(
            () =>
              staffApi.setAccountDisabled(dialog.account.id, !dialog.account.disabledAt, reason),
            dialog.account.disabledAt ? 'Account re-enabled.' : 'Account disabled and signed out.'
          )
        }
      />

      <RoleDialog
        open={dialog?.kind === 'role'}
        account={dialog?.account}
        busy={busy}
        error={error}
        onCancel={() => setDialog(null)}
        onSubmit={(role, reason) =>
          act(() => staffApi.setAccountRole(dialog.account.id, role, reason), 'Role changed.')
        }
      />
    </div>
  );
}

function InviteDialog({ open, busy, error, onCancel, onSubmit }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('support');
  const [reason, setReason] = useState('');

  return (
    <Modal
      open={open}
      title="Invite a staff member"
      description="Grants an email address a staff role. They sign in with Google like everybody else — there is no invitation to send and no credential to deliver."
      onClose={onCancel}
      onSubmit={() => onSubmit(email.trim(), role, reason.trim())}
      submitLabel="Grant access"
      submitDisabled={!email.includes('@') || reason.trim().length < 3}
      destructive={false}
      busy={busy}
    >
      <label htmlFor="invite-email" style={label}>
        Staff email
      </label>
      <input
        id="invite-email"
        type="email"
        value={email}
        onChange={event => setEmail(event.target.value)}
        style={{ ...input, marginBottom: '12px' }}
      />

      <label htmlFor="invite-role" style={label}>
        Role
      </label>
      <select
        id="invite-role"
        value={role}
        onChange={event => setRole(event.target.value)}
        style={{ ...input, marginBottom: '12px' }}
      >
        <option value="support">support — read everything, act on agents and keys</option>
        <option value="admin">admin — also suspend, override quotas, edit plans</option>
        <option value="super_admin">super_admin — also delete, and manage staff</option>
      </select>

      <label htmlFor="invite-reason" style={label}>
        Reason (recorded in the audit log)
      </label>
      <input
        id="invite-reason"
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

function RoleDialog({ open, account, busy, error, onCancel, onSubmit }) {
  const [role, setRole] = useState(account?.role ?? 'support');
  const [reason, setReason] = useState('');
  const [seeded, setSeeded] = useState(null);

  if (open && seeded !== account?.id) {
    setSeeded(account?.id ?? null);
    setRole(account?.role ?? 'support');
    setReason('');
  }

  return (
    <Modal
      open={open}
      title={`Change the role of ${account?.email}`}
      description="Takes effect on their next request. Their current session keeps working; the role it carries is re-read from the row."
      onClose={onCancel}
      onSubmit={() => onSubmit(role, reason.trim())}
      submitLabel="Change role"
      submitDisabled={reason.trim().length < 3 || role === account?.role}
      destructive={false}
      busy={busy}
    >
      <label htmlFor="role-select" style={label}>
        Role
      </label>
      <select
        id="role-select"
        value={role}
        onChange={event => setRole(event.target.value)}
        style={{ ...input, marginBottom: '12px' }}
      >
        <option value="support">support</option>
        <option value="admin">admin</option>
        <option value="super_admin">super_admin</option>
      </select>

      <label htmlFor="role-reason" style={label}>
        Reason (recorded in the audit log)
      </label>
      <input
        id="role-reason"
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
