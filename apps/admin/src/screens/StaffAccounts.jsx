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
 * ── Two states, not three ──────────────────────────────────────────────────
 * TOTP is mandatory for every account, so a row can be *pending enrolment* —
 * created, credential shown once, never signed in — but never
 * *enrolled-without-TOTP*. The design's "2FA: OFF" is a state that cannot
 * exist here, and showing it would suggest it could.
 *
 * A pending account CAN sign in: enrolment is scanning the QR, there is no
 * separate confirm step, and presenting a valid code is the only proof it was
 * scanned. The first successful login flips the row to enrolled. Refusing a
 * pending account outright — which one reading of the brief asks for — would
 * produce an account that can never be used at all.
 *
 * ── Never deleted, only disabled ───────────────────────────────────────────
 * And the footer says so, truthfully: the audit log has to keep resolving a
 * historical actor, so the row survives whatever happens to the person.
 */

const COLS = 'minmax(0,1.5fr) 110px 130px 140px 100px 130px';

export function StaffAccounts({ currentStaffId, onToast }) {
  const resource = useResource(() => staffApi.listAccounts(), []);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState(null);
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
                <span style={th}>2FA</span>
                <span style={th}>Last sign-in</span>
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
                    <span style={account.totpConfirmedAt ? pills.ok : pills.warn}>
                      {account.totpConfirmedAt ? 'enrolled' : 'pending enrolment'}
                    </span>
                    <span style={{ fontSize: '12px', color: 'var(--tx2)', ...ellipsis }}>
                      {account.lastLoginAt ? dateTime(account.lastLoginAt) : 'never'}
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
        onSubmit={async (email, role, reason) => {
          setBusy(true);
          setError(null);
          try {
            const result = await staffApi.createAccount(email, role, reason);
            setCreating(false);
            setCreated(result);
            await resource.refresh();
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        }}
      />

      <CredentialOnce created={created} onClose={() => setCreated(null)} />

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
      description="Creates the account and shows its password and TOTP enrolment code once. Nothing stores them and no later call can retrieve them."
      onClose={onCancel}
      onSubmit={() => onSubmit(email.trim(), role, reason.trim())}
      submitLabel="Create account"
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

/**
 * The credential, shown once.
 *
 * Same contract as a customer API key: this response is the only place it ever
 * exists. There is no "show again", because there is nowhere to show it from —
 * the row holds a PBKDF2 hash and an AES-GCM ciphertext.
 */
function CredentialOnce({ created, onClose }) {
  const [acknowledged, setAcknowledged] = useState(false);

  if (!created) return null;

  const box = {
    ...mono,
    fontSize: '12.5px',
    color: 'var(--codeTx)',
    background: 'var(--code)',
    border: '1px solid var(--bd)',
    borderRadius: '8px',
    padding: '10px 12px',
    marginBottom: '12px',
    wordBreak: 'break-all'
  };

  return (
    <Modal
      open
      title="Shown once"
      description="Copy both of these now and send them to the new staff member through a channel you trust. Nothing here can show them again."
      onClose={() => {
        setAcknowledged(false);
        onClose();
      }}
      onSubmit={() => {
        setAcknowledged(false);
        onClose();
      }}
      submitLabel="I have copied them"
      submitDisabled={!acknowledged}
      destructive={false}
      width={560}
    >
      <label style={label}>Account</label>
      <div style={box}>
        {created.account.email} · {created.account.role}
      </div>

      <label style={label}>Password</label>
      <div style={box}>{created.secret.password}</div>

      <label style={label}>TOTP enrolment</label>
      <div style={box}>{created.secret.provisioningUri}</div>
      <div style={{ fontSize: '11.5px', color: 'var(--tx3)', marginBottom: '14px' }}>
        Or type the secret manually: <span style={mono}>{created.secret.totpSecret}</span>
      </div>

      <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={event => setAcknowledged(event.target.checked)}
        />
        <span style={{ fontSize: '12.5px', color: 'var(--tx)' }}>
          I have copied these and understand they cannot be shown again.
        </span>
      </label>
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
