import React, { useState } from 'react';
import { adminApi } from '../api.js';
import { useResource } from '../lib/useResource.js';
import { ConfirmModal, Modal } from '../components/Overlay.jsx';
import { EmptyState, ErrorState, NotTracked, Skeleton } from '../components/States.jsx';
import { count, date, dateTime } from '../lib/format.js';
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
  secondaryBtn,
  th,
  thR
} from '../lib/ui.js';

/**
 * Customer accounts.
 *
 * ── A browsable list, audited per page ─────────────────────────────────────
 * This screen used to be exact-match lookup only, so the console could not
 * enumerate the customer base. On 2 October 2026 the owner asked for a full
 * list with a filter and page sizes of 10, 20, 50 and 100. The server writes
 * every page read to the audit log as `user.list`, with the filter that
 * produced it, so browsing is possible but never invisible. Sandbox
 * placeholders are hidden except under their own filter.
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

export function UserDetail({ userId, onNavigate, onToast }) {
  const resource = useResource(() => adminApi.getUser(userId), [userId]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState(null);
  const [check, setCheck] = useState(null);

  const result = resource.data;
  const user = result?.user ?? null;

  async function reload() {
    await resource.refresh();
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
      setCheck(await adminApi.deletionCheck(user.id));
      setDialog('delete');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (resource.loading) return <Skeleton rows={6} />;

  return (
    <div style={paneIn}>
      <button
        type="button"
        onClick={() => onNavigate('/users')}
        style={{
          background: 'none',
          border: 'none',
          padding: 0,
          marginBottom: '14px',
          color: 'var(--acc)',
          cursor: 'pointer',
          fontSize: '12.5px',
          fontFamily: 'var(--font)'
        }}
      >
        Back to all users
      </button>

      {resource.error && !result && (
        <div style={{ marginBottom: '14px' }}>
          <ErrorState error={resource.error} onRetry={resource.refresh} />
        </div>
      )}

      {!resource.error && !user && (
        <EmptyState title="No such user" detail="Nothing has this ID. It may have been purged." />
      )}

      {error && (
        <div style={{ marginBottom: '14px' }}>
          <ErrorState error={error} />
        </div>
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
              ADMIN ACTIONS
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
                /*
                  Deleted, and there is no way back. Restore was removed with
                  the thirty-day window: the org, its workspaces, its keys and
                  its members go in the delete request, so a restore could only
                  ever have returned an empty shell and reported success.
                  Saying so is more use than a button that lies.
                */
                <span className="ad-meta">
                  Deleted {'—'} not recoverable
                </span>
              ) : (
                <button
                  type="button"
                  style={busy ? disabledBtn : secondaryBtn}
                  disabled={busy}
                  onClick={openDelete}
                >
                  Delete account
                </button>
              )}
            </div>
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
                () => adminApi.setUserDisabled(user.id, dialog === 'disable', reason),
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
              act(() => adminApi.forceLogout(user.id, result.memberships?.[0]?.workspaceId), 'Signed out everywhere.')
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
              act(() => adminApi.forcePasswordReset(user.id, reason), 'Reset link sent to the account holder.')
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
            onConfirm={() => act(() => adminApi.revokeUserKeys(user.id), 'Keys revoked.')}
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
                () => adminApi.deleteUser(user.id, user.email, reason, revokeKeys),
                'Account deleted. Restorable for 30 days.'
              )
            }
          />
        </>
      )}
    </div>
  );
}

/* ------------------------------- the list -------------------------------- */

export const PAGE_SIZES = [10, 20, 50, 100];

const STATUS_FILTERS = [
  { value: 'all', label: 'All users' },
  { value: 'active', label: 'Active' },
  { value: 'disabled', label: 'Disabled' },
  { value: 'unverified', label: 'Email not verified' },
  { value: 'deleted', label: 'Deleted' },
  { value: 'sandbox', label: 'Sandbox placeholders' }
];

const LIST_COLS = 'minmax(0,1.8fr) 120px 110px 100px 110px';

/**
 * Where the operator was, kept across a visit to a user and back. Module
 * scope, not storage: it lasts for the tab and goes when the console reloads.
 */
let remembered = { search: '', status: 'all', limit: 20, offset: 0 };

/** Back to the first page of everyone. Used by the tests. */
export function resetUserListFilter() {
  remembered = { search: '', status: 'all', limit: 20, offset: 0 };
}

function statusOf(user) {
  if (user.isProvisional) return { text: 'sandbox', style: pills.neutral };
  if (user.deletedAt) return { text: 'deleted', style: pills.danger };
  if (user.disabledAt) return { text: 'disabled', style: pills.warn };
  return { text: 'active', style: pills.ok };
}

export function Users({ onNavigate }) {
  const [draft, setDraft] = useState(remembered.search);
  const [filter, setFilterState] = useState(remembered);

  function setFilter(next) {
    remembered = next;
    setFilterState(next);
  }

  const resource = useResource(
    () =>
      adminApi.listUsers({
        q: filter.search || undefined,
        status: filter.status,
        limit: filter.limit,
        offset: filter.offset
      }),
    [filter.search, filter.status, filter.limit, filter.offset]
  );

  const users = resource.data?.users ?? [];
  const total = resource.data?.total ?? 0;
  const first = total === 0 ? 0 : filter.offset + 1;
  const last = Math.min(filter.offset + users.length, total);
  const page = Math.floor(filter.offset / filter.limit) + 1;
  const pages = Math.max(1, Math.ceil(total / filter.limit));
  const filtered = filter.search !== '' || filter.status !== 'all';

  return (
    <div style={paneIn}>
      <form
        onSubmit={event => {
          event.preventDefault();
          setFilter({ ...filter, search: draft.trim(), offset: 0 });
        }}
        style={{ display: 'flex', gap: '8px', marginBottom: '12px', flexWrap: 'wrap', alignItems: 'center' }}
      >
        <input
          aria-label="Filter users"
          placeholder="Email or user ID"
          value={draft}
          onChange={event => setDraft(event.target.value)}
          style={{ ...input, flex: 1, minWidth: '220px', maxWidth: '360px', height: '32px' }}
        />
        <select
          aria-label="Status"
          value={filter.status}
          onChange={event => setFilter({ ...filter, status: event.target.value, offset: 0 })}
          style={{ ...input, width: 'auto', height: '32px' }}
        >
          {STATUS_FILTERS.map(option => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <button type="submit" style={secondaryBtn}>
          Filter
        </button>
        {filtered && (
          <button
            type="button"
            style={secondaryBtn}
            onClick={() => {
              setDraft('');
              setFilter({ ...filter, search: '', status: 'all', offset: 0 });
            }}
          >
            Clear
          </button>
        )}
      </form>

      {resource.error && (
        <div style={{ marginBottom: '12px' }}>
          <ErrorState error={resource.error} onRetry={resource.refresh} />
        </div>
      )}

      {resource.loading && !resource.data ? (
        <Skeleton />
      ) : users.length === 0 && !resource.error ? (
        <EmptyState
          title={filtered ? 'No users match this filter' : 'No users yet'}
          detail={
            filtered
              ? 'The filter matches part of an address, or a whole user ID.'
              : 'Accounts appear here once somebody signs up.'
          }
        />
      ) : (
        <div style={card}>
          <div style={{ overflowX: 'auto' }}>
            <div style={{ minWidth: '720px' }}>
              <div style={headRow(LIST_COLS)}>
                <span style={th}>User</span>
                <span style={th}>Status</span>
                <span style={th}>Email</span>
                <span style={thR}>Memberships</span>
                <span style={thR}>Joined</span>
              </div>
              {users.map(user => {
                const status = statusOf(user);
                return (
                  <button
                    key={user.id}
                    type="button"
                    onClick={() => onNavigate(`/users/${user.id}`)}
                    style={{ ...dataRow(LIST_COLS, true), cursor: 'pointer', width: '100%', textAlign: 'left' }}
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
                        {user.email}
                      </span>
                      <span style={{ ...mono, display: 'block', fontSize: '10.5px', color: 'var(--tx3)', ...ellipsis }}>
                        {user.id}
                      </span>
                    </span>
                    <span>
                      <span style={status.style}>{status.text}</span>
                    </span>
                    <span style={{ fontSize: '12px', color: user.emailVerifiedAt ? 'var(--tx2)' : 'var(--warnTx)' }}>
                      {user.emailVerifiedAt ? 'verified' : 'not verified'}
                    </span>
                    <span style={{ ...mono, fontSize: '12px', color: 'var(--tx2)', textAlign: 'right' }}>
                      {count(user.memberships)}
                    </span>
                    <span style={{ fontSize: '12px', color: 'var(--tx2)', textAlign: 'right' }}>
                      {date(user.createdAt)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              flexWrap: 'wrap',
              padding: '10px 14px',
              background: 'var(--surf2)',
              borderTop: '1px solid var(--bd)',
              fontSize: '12px',
              color: 'var(--tx2)'
            }}
          >
            <label htmlFor="users-page-size" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              Rows per page
              <select
                id="users-page-size"
                value={filter.limit}
                onChange={event => setFilter({ ...filter, limit: Number(event.target.value), offset: 0 })}
                style={{ ...input, width: 'auto', height: '28px', padding: '0 8px' }}
              >
                {PAGE_SIZES.map(size => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
            </label>
            <span style={{ marginLeft: 'auto' }}>
              {count(first)}–{count(last)} of {count(total)}
            </span>
            <span style={{ color: 'var(--tx3)' }}>
              Page {count(page)} of {count(pages)}
            </span>
            <button
              type="button"
              style={filter.offset === 0 || resource.busy ? disabledBtn : secondaryBtn}
              disabled={filter.offset === 0 || resource.busy}
              onClick={() => setFilter({ ...filter, offset: Math.max(0, filter.offset - filter.limit) })}
            >
              Previous
            </button>
            <button
              type="button"
              style={last >= total || resource.busy ? disabledBtn : secondaryBtn}
              disabled={last >= total || resource.busy}
              onClick={() => setFilter({ ...filter, offset: filter.offset + filter.limit })}
            >
              Next
            </button>
          </div>
        </div>
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
