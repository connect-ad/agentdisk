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
  const { api, workspaceId } = useWorkspace();
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
      <PageHead title="Profile" subtitle="How you appear in the activity log and to workspace members." />

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
