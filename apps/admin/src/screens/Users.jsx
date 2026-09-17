import React, { useState } from 'react';
import { staffApi } from '../api.js';
import { ConfirmModal, Modal } from '../components/Overlay.jsx';
import { EmptyState, ErrorState, NotTracked } from '../components/States.jsx';
import { holds } from '../components/Shell.jsx';
import { count, date, dateTime } from '../lib/format.js';
import {
  card,
  dataRow,
  disabledBtn,
  ellipsis,
  input,
  label,
  mono,
  paneIn,
  pills,
  primaryBtn,
  secondaryBtn
} from '../lib/ui.js';

/**
 * Customer accounts.
 *
 * ── Exact-match lookup, deliberately ───────────────────────────────────────
 * No prefix or partial search. The design file's own note says so and it is a
 * better privacy posture than the spec had, so it is the actual behaviour: a
 * staff tool that can search `%@gmail.com` is a staff tool that can enumerate
 * the customer base, and every real support request starts from an address
 * somebody already has.
 *
 * ── No geography ───────────────────────────────────────────────────────────
 * The design shows "LAST ACTIVE … Berlin, DE". We do not store location. Last
 * active is derived from the newest audit event by that actor, and the place is
 * simply absent.
 *
 * ── Deleting is blocked before it is offered ───────────────────────────────
 * The blocking conditions are fetched and shown BEFORE the confirm dialog, so
 * an operator learns that an account is the sole owner of a shared organization
 * at the point they are deciding, not after typing an email address to confirm.
 */

function Fact({ name, children }) {
  return (
    <div style={{ display: 'flex', gap: '14px', padding: '10px 15px', borderBottom: '1px solid var(--bd)' }}>
      <span
        style={{
          width: '160px',
          flex: '0 0 160px',
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

export function Users({ role, onNavigate, onToast }) {
  const [email, setEmail] = useState('');
  const [result, setResult] = useState(null);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState(null);
  const [check, setCheck] = useState(null);

  const user = result?.user ?? null;
  const canDelete = holds(role, 'super_admin');

  async function search(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setCheck(null);
    try {
      setResult(await staffApi.findUser(email.trim()));
      setSearched(true);
    } catch (err) {
      setError(err);
      setResult(null);
    } finally {
      setBusy(false);
    }
  }

  async function reload() {
    if (!user) return;
    setResult(await staffApi.getUser(user.id));
  }

  async function act(fn, message) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setDialog(null);
      onToast?.(message);
      await reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function openDelete() {
    setBusy(true);
    setError(null);
    try {
      setCheck(await staffApi.deletionCheck(user.id));
      setDialog('delete');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={paneIn}>
      <form onSubmit={search} style={{ ...card, padding: '15px', marginBottom: '14px' }}>
        <label htmlFor="user-email" style={label}>
          Search by email
        </label>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <input
            id="user-email"
            type="email"
            required
            value={email}
            onChange={event => setEmail(event.target.value)}
            placeholder="person@example.com"
            style={{ ...input, ...mono, flex: 1, minWidth: '220px' }}
          />
          <button type="submit" style={primaryBtn} disabled={busy}>
            {busy ? 'Searching…' : 'Search'}
          </button>
        </div>
        <p style={{ margin: '10px 0 0', fontSize: '11.5px', color: 'var(--tx3)' }}>
          Exact match only. Partial email search is deliberately unavailable to staff.
        </p>
      </form>

      {error && (
        <div style={{ marginBottom: '14px' }}>
          <ErrorState error={error} />
        </div>
      )}

      {searched && !user && !error && (
        <EmptyState
          title="No account with that address"
          detail="The address has to match exactly, including the domain. An invited colleague who has never signed in still has a row, so a miss here means there is genuinely no account."
        />
      )}

      {user && (
        <>
          <div style={{ ...card, marginBottom: '14px' }}>
            <div
              style={{
                padding: '12px 15px',
                borderBottom: '1px solid var(--bd)',
                background: 'var(--surf2)',
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                flexWrap: 'wrap'
              }}
            >
              <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--tx)' }}>
                {user.email}
              </span>
              <span style={{ ...mono, fontSize: '10.5px', color: 'var(--tx3)' }}>{user.id}</span>
              {user.deletedAt && <span style={pills.danger}>pending deletion</span>}
              {user.disabledAt && !user.deletedAt && <span style={pills.warn}>disabled</span>}
            </div>

            <Fact name="Joined">{date(user.createdAt)}</Fact>
            <Fact name="Email verified">
              {user.emailVerifiedAt ? date(user.emailVerifiedAt) : 'Not verified'}
            </Fact>
            <Fact name="Sign-in identity">
              {user.firebaseUid ? (
                <span style={mono}>{user.firebaseUid}</span>
              ) : (
                'Invited, never signed in'
              )}
            </Fact>
            <Fact name="Last active">
              {user.lastActiveAt ? dateTime(user.lastActiveAt) : <NotTracked>no recorded activity</NotTracked>}
            </Fact>
            <Fact name="Live API keys">
              {count(result.keys?.keys ?? 0)} across {count(result.keys?.workspaces ?? 0)} workspace(s)
              {result.keys?.foreignWorkspaces > 0 && (
                <span style={{ color: 'var(--warnTx)' }}>
                  {' '}
                  — {count(result.keys.foreignWorkspaces)} in organizations this person does not
                  belong to
                </span>
              )}
            </Fact>
            {user.deletedAt && (
              <Fact name="Deleted at">
                {dateTime(user.deletedAt)} · restorable for 30 days from then
              </Fact>
            )}
          </div>

          <div style={{ ...card, marginBottom: '14px' }}>
            <div style={{ padding: '12px 15px', borderBottom: '1px solid var(--bd)', background: 'var(--surf2)' }}>
              <span style={{ ...mono, fontSize: '9.5px', letterSpacing: '0.11em', color: 'var(--tx3)' }}>
                WORKSPACE MEMBERSHIPS
              </span>
            </div>
            {(result.memberships ?? []).length === 0 ? (
              <div style={{ padding: '20px 15px', fontSize: '12.5px', color: 'var(--tx2)' }}>
                No memberships.
              </div>
            ) : (
              result.memberships.map((membership, index) => (
                <button
                  key={`${membership.orgId}-${membership.workspaceId ?? 'org'}-${index}`}
                  type="button"
                  disabled={!membership.workspaceId}
                  onClick={() =>
                    membership.workspaceId && onNavigate(`/workspaces/${membership.workspaceId}`)
                  }
                  style={{
                    ...dataRow('minmax(0,1fr) minmax(0,1fr) 90px', Boolean(membership.workspaceId)),
                    cursor: membership.workspaceId ? 'pointer' : 'default'
                  }}
                >
                  <span style={{ fontSize: '12.5px', color: 'var(--tx)', ...ellipsis }}>
                    {membership.workspaceName ?? `Whole organization — ${membership.orgName}`}
                  </span>
                  <span style={{ ...mono, fontSize: '10.5px', color: 'var(--tx3)', ...ellipsis }}>
                    {membership.workspaceId ?? membership.orgId}
                  </span>
                  <span style={pills.neutral}>{membership.role}</span>
                </button>
              ))
            )}
          </div>

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
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <button
                type="button"
                style={secondaryBtn}
                disabled={busy || Boolean(user.deletedAt)}
                onClick={() => setDialog(user.disabledAt ? 'enable' : 'disable')}
              >
                {user.disabledAt ? 'Re-enable account' : 'Disable account'}
              </button>
              <button type="button" style={secondaryBtn} disabled={busy} onClick={() => setDialog('logout')}>
                Force logout everywhere
              </button>
              <button type="button" style={secondaryBtn} disabled={busy} onClick={() => setDialog('reset')}>
                Force password reset
              </button>
              <button type="button" style={secondaryBtn} disabled={busy} onClick={() => setDialog('keys')}>
                Revoke every key they created
              </button>
              {user.deletedAt ? (
                <button
                  type="button"
                  style={canDelete ? secondaryBtn : disabledBtn}
                  disabled={!canDelete || busy}
                  onClick={() => setDialog('restore')}
                >
                  Restore account
                </button>
              ) : (
                <button
                  type="button"
                  style={canDelete ? secondaryBtn : disabledBtn}
                  disabled={!canDelete || busy}
                  onClick={openDelete}
                >
                  Delete account
                </button>
              )}
            </div>
            {!canDelete && (
              <p style={{ margin: '12px 0 0', fontSize: '11.5px', color: 'var(--tx2)' }}>
                Deleting or restoring an account needs super_admin.
              </p>
            )}
          </div>

          {/* ---------------------------- dialogs ---------------------------- */}

          <ConfirmModal
            open={dialog === 'disable' || dialog === 'enable'}
            destructive={dialog === 'disable'}
            title={dialog === 'disable' ? `Disable ${user.email}?` : `Re-enable ${user.email}?`}
            description={
              dialog === 'disable'
                ? 'They stop being able to authenticate immediately — every existing session too, not only new sign-ins. Their Firebase identity is disabled as well, never deleted. Fully reversible.'
                : 'They can sign in again immediately.'
            }
            requireReason
            confirmLabel={dialog === 'disable' ? 'Disable' : 'Re-enable'}
            busy={busy}
            onCancel={() => setDialog(null)}
            onConfirm={reason =>
              act(
                () => staffApi.setUserDisabled(user.id, dialog === 'disable', reason),
                dialog === 'disable' ? 'Account disabled.' : 'Account re-enabled.'
              )
            }
          />

          <ConfirmModal
            open={dialog === 'logout'}
            title={`Sign ${user.email} out everywhere?`}
            description="Every session ends now. They can sign back in immediately with the same password — this ends sessions, it does not block the account."
            requireReason
            confirmLabel="Force logout"
            busy={busy}
            onCancel={() => setDialog(null)}
            onConfirm={() =>
              act(() => staffApi.forceLogout(user.id, result.memberships?.[0]?.workspaceId), 'Signed out everywhere.')
            }
          />

          <ConfirmModal
            open={dialog === 'reset'}
            destructive={false}
            title={`Send ${user.email} a password reset?`}
            description="The link goes to their address and nowhere else. It is a bearer credential equal to owning the account, so it is never shown here and never written to the audit log."
            requireReason
            confirmLabel="Send reset"
            busy={busy}
            onCancel={() => setDialog(null)}
            onConfirm={reason =>
              act(() => staffApi.forcePasswordReset(user.id, reason), 'Reset link sent to the account holder.')
            }
          />

          <ConfirmModal
            open={dialog === 'keys'}
            title="Revoke every API key this person created?"
            description="This reaches across every workspace they have ever created a key in, including organizations they no longer belong to. Agents holding those keys stop working immediately."
            blastRadius={
              <>
                <div>
                  {count(result.keys?.keys ?? 0)} live keys across {count(result.keys?.workspaces ?? 0)}{' '}
                  workspace(s)
                </div>
                {result.keys?.foreignWorkspaces > 0 && (
                  <div style={{ color: 'var(--warnTx)' }}>
                    {count(result.keys.foreignWorkspaces)} of those belong to other customers
                  </div>
                )}
              </>
            }
            requireReason
            confirmLabel="Revoke keys"
            busy={busy}
            onCancel={() => setDialog(null)}
            onConfirm={() => act(() => staffApi.revokeUserKeys(user.id), 'Keys revoked.')}
          />

          <ConfirmModal
            open={dialog === 'restore'}
            destructive={false}
            title={`Restore ${user.email}?`}
            description="They can sign in again immediately. Keys revoked alongside the deletion are NOT reissued — a revoked key has already been published as revoked to every agent holding it, and reissuing is the customer's call."
            requireReason
            confirmLabel="Restore"
            busy={busy}
            onCancel={() => setDialog(null)}
            onConfirm={reason => act(() => staffApi.restoreUser(user.id, reason), 'Account restored.')}
          />

          <DeleteUserDialog
            open={dialog === 'delete'}
            user={user}
            check={check}
            busy={busy}
            error={error}
            onCancel={() => setDialog(null)}
            onNavigate={onNavigate}
            onSubmit={(reason, revokeKeys) =>
              act(
                () => staffApi.deleteUser(user.id, user.email, reason, revokeKeys),
                'Account deleted. Restorable for 30 days.'
              )
            }
          />
        </>
      )}
    </div>
  );
}

/**
 * The delete dialog, which is mostly a list of reasons not to.
 *
 * Blockers are rendered before anything can be typed, and the submit is
 * disabled while any exist. The resolution path for the commonest one is
 * transfer ownership, so the organization is named and linkable rather than
 * described.
 */
function DeleteUserDialog({ open, user, check, busy, error, onCancel, onSubmit, onNavigate }) {
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  // Defaulted on for a for-cause deletion, but the operator can turn it off: an
  // automatic cascade here can silently break another tenant's production
  // agents.
  const [revokeKeys, setRevokeKeys] = useState(true);

  const blocked = (check?.blockers ?? []).length > 0;
  const ready = !blocked && reason.trim().length >= 3 && typed === user.email;

  return (
    <Modal
      open={open}
      title={`Delete ${user.email}?`}
      description="Soft delete. Nothing is destroyed now — the cascade and the PII scrub run from the purge job after 30 days, and Restore fully reverses it until then."
      onClose={onCancel}
      onSubmit={() => onSubmit(reason.trim(), revokeKeys)}
      submitLabel="Delete account"
      submitDisabled={!ready}
      destructive
      busy={busy}
      width={560}
    >
      {blocked && (
        <div
          style={{
            border: '1px solid var(--dngrBd)',
            background: 'var(--dngrSoft)',
            borderRadius: '9px',
            padding: '12px',
            marginBottom: '16px'
          }}
        >
          <div
            style={{
              ...mono,
              fontSize: '9.5px',
              letterSpacing: '0.11em',
              color: 'var(--dngrTx)',
              marginBottom: '8px'
            }}
          >
            BLOCKED — RESOLVE THESE FIRST
          </div>
          {check.blockers.map((blocker, index) => (
            <div key={index} style={{ fontSize: '12.5px', color: 'var(--dngrTx)', marginBottom: '8px' }}>
              <strong>{blocker.orgName}</strong> — {blocker.detail}
              {blocker.kind !== 'live_billing' && (
                <button
                  type="button"
                  onClick={() => onNavigate(`/workspaces?org=${blocker.orgId}`)}
                  style={{
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    marginLeft: '6px',
                    color: 'var(--acc)',
                    cursor: 'pointer',
                    fontSize: '12.5px',
                    fontFamily: 'var(--font)'
                  }}
                >
                  Open organization
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {!blocked && (check?.cascadingOrgs ?? []).length > 0 && (
        <div
          style={{
            border: '1px solid var(--warnBd)',
            background: 'var(--warnSoft)',
            borderRadius: '9px',
            padding: '12px',
            marginBottom: '16px',
            fontSize: '12.5px',
            color: 'var(--warnTx)'
          }}
        >
          After 30 days the purge job will also take{' '}
          {check.cascadingOrgs.map(org => `${org.orgName} (${org.workspaces} workspaces)`).join(', ')}.
        </div>
      )}

      <label style={{ ...label, display: 'flex', alignItems: 'center', gap: '8px', textTransform: 'none' }}>
        <input
          type="checkbox"
          checked={revokeKeys}
          onChange={event => setRevokeKeys(event.target.checked)}
        />
        <span style={{ fontSize: '12.5px', color: 'var(--tx)', letterSpacing: 0 }}>
          Also revoke every API key this person created ({count(check?.keys?.keys ?? 0)} keys
          {check?.keys?.foreignWorkspaces > 0
            ? `, ${count(check.keys.foreignWorkspaces)} in other customers' workspaces`
            : ''}
          )
        </span>
      </label>

      <label htmlFor="delete-reason" style={{ ...label, marginTop: '14px' }}>
        Reason (recorded in the audit log)
      </label>
      <input
        id="delete-reason"
        value={reason}
        onChange={event => setReason(event.target.value)}
        style={input}
        disabled={blocked}
      />

      <label htmlFor="delete-confirm" style={{ ...label, marginTop: '14px' }}>
        Type {user.email} to confirm
      </label>
      <input
        id="delete-confirm"
        value={typed}
        onChange={event => setTyped(event.target.value)}
        style={{ ...input, ...mono }}
        disabled={blocked}
        autoComplete="off"
      />

      <p style={{ margin: '14px 0 0', fontSize: '11.5px', lineHeight: 1.6, color: 'var(--tx2)' }}>
        On confirming: their sessions end immediately, their Firebase identity is disabled (never
        deleted), and the account becomes unusable. The customer is not emailed by this action —
        see the note in the handover report.
      </p>

      {error && (
        <div style={{ marginTop: '14px' }}>
          <ErrorState error={error} />
        </div>
      )}
    </Modal>
  );
}
