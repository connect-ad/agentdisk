import { useAuth, describeAuthError } from '../lib/auth.jsx';
import React, { useState } from 'react';
import { PageHead, Panel, Input, Button, Icon, Alert, EmptyState } from '../components/index.js';
import { useWorkspace } from '../lib/workspace.jsx';

/**
 * 8.26 Profile — MVP-0
 * URL: /account/profile
 * Changing email requires re-verification; the current address stays active
 * until the new one is confirmed, so a typo can never lock the user out.
 */

export default function Profile() {
  // Both fields are owned by Firebase, not by our API: the Worker reads the
  // display name off the token's `name` claim and syncs the address from the
  // token on the next request. So these edits are the whole change, and there
  // is no endpoint of ours missing behind them.
  const { user, updateDisplayName, requestEmailChange } = useAuth();
  const { api, workspaceId, role, workspace } = useWorkspace();
  // 'owner' | 'admin' | 'reader' -> the design's own casing ('Owner').
  const roleLabel = role ? role.charAt(0).toUpperCase() + role.slice(1) : '';
  const workspaceName = workspace?.name ?? '';
  const [name, setName] = useState(user?.displayName ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [pendingEmail, setPendingEmail] = useState(null);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);
  const [endingSessions, setEndingSessions] = useState(false);
  const [sessionsEnded, setSessionsEnded] = useState(false);

  const currentEmail = user?.email ?? '';

  /**
   * Ends every session but this one.
   *
   * Reports failure rather than swallowing it: a security control that says
   * nothing when it did nothing is worse than one that is absent, because the
   * person walks away believing their other sessions are gone.
   *
   * The endpoint is workspace-scoped, and this screen is routed both inside a
   * workspace and standalone at /account/profile. Without one the control is
   * disabled rather than firing a call that cannot succeed.
   */
  const endOtherSessions = async () => {
    if (!workspaceId) return;
    setEndingSessions(true);
    setError(null);
    try {
      await api.logoutEverywhere(workspaceId);
      setSessionsEnded(true);
      setTimeout(() => setSessionsEnded(false), 4000);
    } catch (err) {
      setError(err?.message ?? 'Could not end your other sessions.');
    } finally {
      setEndingSessions(false);
    }
  };

  const save = async () => {
    setSaving(true); setError(null);
    try {
      await updateDisplayName(name.trim());
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(describeAuthError(err));
    } finally {
      setSaving(false);
    }
  };

  const sendVerification = async () => {
    const next = email.trim();
    if (!next || next === currentEmail) {
      setError('Enter a different address to move this account to.');
      return;
    }
    setSending(true); setError(null);
    try {
      await requestEmailChange(next);
      setPendingEmail(next);
    } catch (err) {
      setError(describeAuthError(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      {/*
        Title matches the profile-menu label and the account-area return bar
        above it ("ACCOUNT AREA · Account") rather than the older MVP-0 spec's
        "Profile" (doc 03 §22) — both named this screen at the top of it before
        the redesign renamed the entry point to "Account" (`AgentDisk
        Dashboard.dc.html`'s profile menu and its `accountLabel`). Leaving the
        on-page heading as "Profile" while the bar right above it says
        "Account" is the same class of self-contradiction as the tab-bar fix
        in App.jsx: two labels for one screen, visible on screen at once.
      */}
      <PageHead title="Account" subtitle="How you appear in the activity log and to workspace members." />

      {error ? <div role="alert"><Alert tone="danger" title={error} /></div> : null}

      {pendingEmail ? (
        <Alert
          tone="warn"
          title="Verify your new email address"
          actions={
            <Button size="sm" variant="secondary" loading={sending} onClick={sendVerification}>
              Resend link
            </Button>
          }
        >
          We sent a verification link to <strong>{pendingEmail}</strong>. Your current email stays active until you confirm.
        </Alert>
      ) : null}

      <Panel
        title="Account"
        footer={
          <>
            <Button onClick={save} loading={saving}>Save changes</Button>
            {saved ? <span className="saved">Saved</span> : null}
          </>
        }
      >
        <div className="row" style={{ gap: 'var(--s-6)' }}>
          <span className="avatar avatar--lg" aria-hidden="true">{(name || currentEmail).slice(0, 1).toUpperCase()}</span>
          <div style={{ minWidth: 0 }}>
            <p style={{ fontSize: 'var(--t-14)', fontWeight: 'var(--w-med)', color: 'var(--ink)' }}>{name}</p>
            <p className="ad-meta">{currentEmail}</p>
          </div>
          <span className="toolbar__spacer" />
        </div>

        <Input label="Display name" value={name} onChange={e => setName(e.target.value)} hint="Shown next to your actions in the audit log." />
        <Input
          label="Email"
          type="email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          hint="We'll send a verification link to your new email. Your current email stays active until you confirm."
        />
        <div>
          <Button variant="secondary" size="sm" loading={sending} onClick={sendVerification}>
            Send verification link
          </Button>
        </div>

        {/*
          Role, time zone and user ID, from the design's account-rows list
          (`accountRows` in `AgentDisk Dashboard.dc.html`) — all four besides
          Display name and Email were missing here entirely, not just styled
          differently. Role and User ID are rendered static (design marks both
          `editable: false`) because both already exist on data this screen
          already has — `role` from the open workspace's membership, `user.uid`
          from the signed-in Firebase user — so there is no reason to invent
          them. Time zone is left out on purpose: unlike those two, nothing in
          apps/api stores or reads a time zone for a user, so rendering it
          — editable or not — would be a field that silently discards
          whatever somebody typed into it. Add it once there is an endpoint
          behind it, not before.
        */}
        <div className="row" style={{ gap: 'var(--s-6)', paddingTop: 'var(--s-5)', borderTop: '1px solid var(--line)' }}>
          <span style={{ width: '104px', flex: '0 0 104px', fontFamily: 'var(--font-mono)', fontSize: 'var(--t-9-5)', letterSpacing: 'var(--tr-caps)', color: 'var(--ink-3)' }}>ROLE</span>
          <span style={{ flex: 1, minWidth: 0, fontSize: 'var(--t-13-5)', color: 'var(--ink)' }}>
            {role ? (workspaceName ? `${roleLabel} · ${workspaceName}` : roleLabel) : 'Open this from inside a workspace'}
          </span>
        </div>
        <div className="row" style={{ gap: 'var(--s-6)', paddingTop: 'var(--s-5)', borderTop: '1px solid var(--line)' }}>
          <span style={{ width: '104px', flex: '0 0 104px', fontFamily: 'var(--font-mono)', fontSize: 'var(--t-9-5)', letterSpacing: 'var(--tr-caps)', color: 'var(--ink-3)' }}>USER ID</span>
          <span style={{ flex: 1, minWidth: 0, fontSize: 'var(--t-13-5)', color: 'var(--ink)', fontFamily: 'var(--font-mono)' }}>{user?.uid ?? '—'}</span>
        </div>
        <div className="row" style={{ gap: 'var(--s-6)', paddingTop: 'var(--s-5)', borderTop: '1px solid var(--line)' }}>
          <span style={{ width: '104px', flex: '0 0 104px', fontFamily: 'var(--font-mono)', fontSize: 'var(--t-9-5)', letterSpacing: 'var(--tr-caps)', color: 'var(--ink-3)' }}>TIME ZONE</span>
          <span className="ad-meta" style={{ flex: 1, minWidth: 0 }}>Not available yet — not collected by the API</span>
        </div>
      </Panel>

      <Panel title="Connected accounts">
        <EmptyState
          compact
          icon={<Icon name="link" size={19} />}
          title="Sign-in methods live in your provider"
        >
          Google and GitHub accounts are linked at sign-in. Use the same method you signed up with.
        </EmptyState>
      </Panel>

      {/*
        Active sessions, from the design.

        The design draws three devices — "MacBook Pro · Chrome", "iPhone 17 ·
        Safari", "adk CLI 3.1.0" — each with its own REVOKE. There is no
        endpoint that lists sessions and none that revokes one, so those rows
        would be invented device history a person could not tell from the real
        thing. They are not rendered.

        What does exist is POST /v1/me/logout-all, which has been in api.js
        since it was written and which no screen has ever called. So the panel
        shows the honest state and offers the one action that is real.
      */}
      <Panel title="Active sessions">
        <EmptyState
          compact
          icon={<Icon name="shield" size={19} />}
          title="Per-device sessions aren't listed yet"
        >
          We can't show which devices are signed in, but you can end every session
          except this one. Anything signed in elsewhere — a browser, an agent CLI —
          will have to sign in again.
        </EmptyState>
        <div>
          <Button
            variant="secondary"
            size="sm"
            loading={endingSessions}
            disabled={!workspaceId}
            aria-disabled={!workspaceId || undefined}
            onClick={endOtherSessions}
          >
            Sign out other sessions
          </Button>
          {sessionsEnded ? <span className="saved">Other sessions ended</span> : null}
          {!workspaceId ? (
            <span className="ad-meta" style={{ marginLeft: 'var(--s-5)' }}>
              Open this from inside a workspace
            </span>
          ) : null}
        </div>
      </Panel>

      {/*
        The design's delete-account panel. No endpoint deletes an account, so
        the control is visibly disabled and says why rather than opening a
        dialog that cannot finish — the failure backlog/023 tracks.
      */}
      {/* Panel takes no `tone`; an unknown prop would spread onto the section
          and do nothing at all, so the danger border comes from a class. */}
      <Panel title="Delete account" className="panel--danger">
        <p className="ad-small ad-measure">
          Deleting an account removes it and every workspace it owns. This is not
          available from the dashboard yet — contact support and we will do it by hand.
        </p>
        <div>
          <Button variant="danger-outline" size="sm" disabled aria-disabled="true">
            Delete account…
          </Button>
          <span className="ad-meta" style={{ marginLeft: 'var(--s-5)' }}>Not available yet</span>
        </div>
      </Panel>

    </>
  );
}
