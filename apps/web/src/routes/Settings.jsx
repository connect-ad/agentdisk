import { useNavigate } from 'react-router-dom';
import { useWorkspace } from '../lib/workspace.jsx';
import { useAuth, describeAuthError } from '../lib/auth.jsx';
import React, { useState } from 'react';
import {
  PageHead, Panel, Tabs, Input, Button, Icon, Badge,
  Modal, ConfirmModal, Alert, EmptyState, Toast
} from '../components/index.js';
import { MembersTab, PrivacyTab, BillingTab } from './SettingsTabs.jsx';

/**
 * Settings. MVP-0 tabs are General (8.21) and Security (8.23).
 * Members (8.22), Privacy (8.24) and Billing (8.25) are MVP-1 — declared here so
 * the tablist is stable, and filled in Step 4.
 *
 * URL: /w/{ws}/settings
 */

/** How Firebase names the three sign-in methods this product enables. */
const PROVIDER_LABEL = {
  'password': 'Email and password',
  'google.com': 'Google',
  'github.com': 'GitHub'
};

/* ------------------------------ 8.23 Security ----------------------------- */

/**
 * Everything here belongs to Firebase, not to our API — doc 16 PART 30 is
 * explicit that the Worker never receives, stores or sees a password, and there
 * is no `refresh_tokens` table to enumerate devices from any more.
 *
 * So this screen shows two things and invents nothing:
 *
 *  - a password form **only** for an account that actually has a password
 *    provider. An account created with Google has no password to change, and a
 *    form offering to change one is a promise nothing can keep.
 *  - a single "sign out everywhere" action instead of a per-device table. Doc
 *    16 Phase 2 calls for exactly this and says to flag the simplification
 *    rather than build a fake device list; the table that used to sit here
 *    rendered zero rows on every account, including the session reading it.
 */
function SecurityTab({ onToast }) {
  const { api, workspaceId } = useWorkspace();
  const { user, providerIds, changePassword } = useAuth();

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const [dialog, setDialog] = useState(null);
  const [signingOut, setSigningOut] = useState(false);

  const hasPassword = providerIds.includes('password');
  const methods = providerIds.map(id => PROVIDER_LABEL[id] ?? id);

  const submit = async () => {
    if (!current || !next) { setError('Fill in your current and new password.'); return; }
    if (next !== confirm) { setError('The two new passwords do not match.'); return; }
    setBusy(true); setError(null);
    try {
      await changePassword(current, next);
      setCurrent(''); setNext(''); setConfirm('');
      onToast('Password changed');
    } catch (err) {
      setError(describeAuthError(err, 'reauth'));
    } finally {
      setBusy(false);
    }
  };

  const signOutOthers = async () => {
    setSigningOut(true);
    try {
      await api.logoutEverywhere(workspaceId);
      onToast('Other sessions will have to get a new token');
    } catch (err) {
      onToast(`Could not sign out other sessions: ${err.message}`);
    } finally {
      setSigningOut(false);
      setDialog(null);
    }
  };

  return (
    <>
      <Panel
        title="Password"
        subtitle="Handled by Firebase. AgentDisk never receives or stores your password."
        footer={hasPassword ? <Button onClick={submit} loading={busy}>Change password</Button> : null}
      >
        {/* No `role="alert"` wrapper: a danger-tone Alert already carries one,
            and nesting them announces the same sentence twice. */}
        {error ? <Alert tone="danger" title={error} /> : null}

        {hasPassword ? (
          <>
            <Input
              label="Current password"
              type="password"
              required
              autoComplete="current-password"
              hint="Asked for because Firebase requires a recent sign-in before it will accept a new password."
              value={current}
              onChange={e => setCurrent(e.target.value)}
            />
            <Input
              label="New password"
              type="password"
              required
              autoComplete="new-password"
              hint="At least 12 characters. A passphrase beats complexity rules."
              value={next}
              onChange={e => setNext(e.target.value)}
            />
            <Input
              label="Confirm new password"
              type="password"
              required
              autoComplete="new-password"
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
            />
          </>
        ) : (
          <EmptyState
            compact
            icon={<Icon name="link" size={19} />}
            title={`This account signs in with ${methods.join(' and ') || 'an external provider'}`}
          >
            There is no AgentDisk password to change. Your password, if you have one, lives with
            that provider and is changed there.
          </EmptyState>
        )}
      </Panel>

      <Panel
        title="Sessions"
        actions={
          <Button size="sm" variant="danger-outline" onClick={() => setDialog('revoke-all')}>
            Sign out other sessions
          </Button>
        }
      >
        {/* No per-device table, and that is the honest answer rather than a gap.
            Firebase holds the session and exposes no device inventory (16 PART
            30.4), so the only truthful things to show are who is signed in and
            the one action that actually exists. */}
        <dl className="kv">
          <dt>Signed in as</dt>
          <dd>{user?.email ?? '—'}</dd>
          <dt>Sign-in methods</dt>
          <dd>
            <span className="row" style={{ gap: 'var(--s-3)' }}>
              {methods.length
                ? methods.map(m => <Badge key={m}>{m}</Badge>)
                : <span className="ad-meta">—</span>}
            </span>
          </dd>
        </dl>
        <p className="ad-meta ad-measure" style={{ marginTop: 'var(--s-5)' }}>
          Per-device session records are not built yet. Firebase holds the session and does not
          expose a device inventory, so this screen shows the one action that genuinely exists
          rather than a list it would have to invent.
        </p>
      </Panel>

      <Panel title="Single sign-on">
        <EmptyState
          compact
          icon={<Icon name="shield" size={19} />}
          title="SSO is available on the Team plan"
          actions={<Button size="sm" variant="secondary" disabled>Configure SSO</Button>}
        >
          SAML and OIDC arrive with Team-tier workspaces in MVP-1. This is separate from the
          Google and GitHub buttons on the sign-in screen, which every plan already has.
        </EmptyState>
      </Panel>

      <ConfirmModal
        open={dialog === 'revoke-all'}
        title="Sign out your other sessions?"
        /* Worded to match what the endpoint actually does. Its own comment says
           a UI promising more than this is lying to the person clicking it. */
        description="Every other browser signed in as you has to obtain a new token on its next request. This does not end a session on a device someone else physically holds — that needs a Firebase-side revocation this product cannot do yet."
        confirmLabel="Sign out other sessions"
        loading={signingOut}
        onClose={() => setDialog(null)}
        onConfirm={signOutOthers}
      />
    </>
  );
}

export default function Settings() {
  const [tab, setTab] = useState('general');
  // The real workspace, so the delete confirmation asks you to type the name
  // of the thing you are actually about to destroy.
  const { api, workspace, workspaceId, workspaces, refresh } = useWorkspace();
  const navigate = useNavigate();
  const WORKSPACE_NAME = workspace?.name ?? '';
  const [name, setName] = useState(WORKSPACE_NAME);

  React.useEffect(() => { setName(WORKSPACE_NAME); }, [WORKSPACE_NAME]);
  const [saved, setSaved] = useState(false);
  const [dialog, setDialog] = useState(null); // 'delete-ws'
  const [confirmText, setConfirmText] = useState('');
  const [toast, setToast] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(null);

  // The API refuses this too — it is not a client-side-only rule — but saying so
  // before the button is pressed beats a 409 the person cannot act on.
  const isOnlyWorkspace = workspaces.length <= 1;

  const deleteWorkspace = async () => {
    setDeleting(true); setDeleteError(null);
    try {
      await api.deleteWorkspace(workspaceId, confirmText);
      setDialog(null);
      // Re-read the list before navigating, or `/app` resolves straight back to
      // the workspace that no longer exists.
      await refresh();
      navigate('/app', { replace: true });
    } catch (err) {
      setDeleteError(`${err.message}${err.requestId ? ` (request ${err.requestId})` : ''}`);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <PageHead title="Settings" subtitle="Workspace configuration, security, and membership." />

      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { value: 'general', label: 'General' },
          { value: 'security', label: 'Security' },
          { value: 'members', label: 'Members' },
          { value: 'privacy', label: 'Privacy' },
          { value: 'billing', label: 'Billing' }
        ]}
      />

      {/* --- 8.21 General --- */}
      {tab === 'general' ? (
        <>
          <Panel
            title="Workspace"
            footer={
              <>
                <Button onClick={() => { setSaved(true); setTimeout(() => setSaved(false), 2000); }}>Save changes</Button>
                {saved ? <span className="saved">Saved</span> : null}
              </>
            }
          >
            <Input
              label="Workspace name"
              value={name}
              onChange={e => setName(e.target.value)}
              hint="Cosmetic only. Renaming never changes URLs or API paths."
            />
            <Input
              label="Workspace ID"
              mono
              /* The real ID, from the same context the URL and every API call
                 use. It was a fixed string here for long enough that two
                 different workspaces showed the same value. */
              value={workspaceId ?? ''}
              disabled
              hint="This is what dashboard URLs and the API use to address the workspace, so renaming can never break a bookmark, a script, or an MCP config."
            />
          </Panel>

          <section aria-label="Danger zone">
            <Panel title="Danger zone" className="danger-zone">
              <Alert tone="danger" title="Delete this workspace">
                This permanently deletes all files, agents, and API keys in <strong>{WORKSPACE_NAME}</strong>. This cannot be undone.
              </Alert>
              {isOnlyWorkspace ? (
                <Alert tone="warn" title="This is your only workspace">
                  An account with no workspace has nowhere to land. Create another one first, then
                  come back and delete this.
                </Alert>
              ) : null}
              <div>
                <Button
                  variant="danger"
                  disabled={isOnlyWorkspace}
                  onClick={() => { setConfirmText(''); setDeleteError(null); setDialog('delete-ws'); }}
                >
                  Delete workspace
                </Button>
              </div>
            </Panel>
          </section>
        </>
      ) : null}

      {/* --- 8.23 Security --- */}
      {tab === 'security' ? <SecurityTab onToast={setToast} /> : null}

      {/* --- 8.22 / 8.24 / 8.25 --- */}
      {tab === 'members' ? <MembersTab /> : null}
      {tab === 'privacy' ? <PrivacyTab soleOwnerOf={0} /> : null}
      {tab === 'billing' ? <BillingTab /> : null}

      <Modal
        open={dialog === 'delete-ws'}
        title={`Delete ${WORKSPACE_NAME}?`}
        tone="danger"
        mark={<Icon name="alert" size={16} />}
        onClose={() => setDialog(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setDialog(null)}>Cancel</Button>
            <Button
              variant="danger"
              loading={deleting}
              disabled={confirmText !== WORKSPACE_NAME}
              onClick={deleteWorkspace}
            >
              Delete workspace
            </Button>
          </>
        }
      >
        <Alert tone="danger" title="This destroys everything in the workspace">
          All files, agents, and API keys are permanently removed. Agents using its keys lose access immediately.
        </Alert>
        {deleteError ? <Alert tone="danger" title={deleteError} /> : null}
        <Input
          label="Confirm"
          mono
          placeholder={`Type ${WORKSPACE_NAME} to confirm`}
          value={confirmText}
          onChange={e => setConfirmText(e.target.value)}
        />
      </Modal>

      {toast ? (
        <div style={{ position: 'fixed', top: 'var(--s-7)', right: 'var(--s-7)', zIndex: 90 }}>
          <Toast tone="ok" title={toast} onDismiss={() => setToast(null)} />
        </div>
      ) : null}
    </>
  );
}
