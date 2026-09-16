import { useAuth, describeAuthError } from '../lib/auth.jsx';
import React, { useState } from 'react';
import { Input, Button, Badge, Alert } from '../components/index.js';
import { useWorkspace } from '../lib/workspace.jsx';

/**
 * 8.26 Account — MVP-0
 * URL: /w/:ws/profile, and /account/profile standalone.
 *
 * ── Laid out from `AgentDisk Dashboard.dc.html` ───────────────────────────
 * The reference gives this screen a 680px measure and three plain cards: the
 * details card (an avatar header over a five-row key/value list), Active
 * sessions, and Delete account. `.acct--account` had been sitting in app.css
 * unused since the account area was built — only Billing.jsx ever wrapped
 * itself — so this page rendered full-bleed across the whole content column
 * while the reference holds it to a readable one. A five-row list stretched
 * to 1200px is the layout that measure exists to prevent: 104px of key, then
 * a name floating a screen's width away from it.
 *
 * ── Which of the reference's five rows are real ───────────────────────────
 * FULL NAME, EMAIL and USER ID come from the Firebase user; ROLE from the
 * open workspace's membership. TIME ZONE is read from the browser rather than
 * from us, and carries no Edit, because nothing in apps/api stores a time zone
 * — an Edit link there would open a field that discards whatever was typed
 * into it. What the browser reports is true, and it is what this app would
 * format a date with, so it is worth showing; what it is not is a preference
 * anybody can set here.
 *
 * Changing email requires re-verification; the current address stays active
 * until the new one is confirmed, so a typo can never lock the user out. The
 * reference marks EMAIL `editable: false` and draws no Edit on it. That one is
 * deliberately not followed: this screen has a working email-change flow
 * behind it, and dropping a live security-relevant control to match a
 * mockup's fixture flag would be removing function for cosmetics.
 */

/**
 * The signed-in person's initials, the way the reference draws them ("RK").
 * Two letters from a display name, one from an email when that is all there
 * is, and never the "@" — an avatar reading "@" tells you nothing.
 */
function initialsOf(name, email) {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[words.length - 1][0]).toUpperCase();
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  const local = (email ?? '').split('@')[0];
  return local ? local.slice(0, 2).toUpperCase() : '—';
}

/**
 * The browser's own time zone, formatted the way the reference writes it:
 * "Europe / Berlin (GMT+2)". Everything here is read from Intl rather than
 * derived — `shortOffset` gets the offset right across DST without a table of
 * our own to keep current. Wrapped because a locked-down browser can throw on
 * `resolvedOptions`, and a profile screen that dies over a time zone would be
 * a poor trade.
 */
function browserTimeZone() {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!zone) return null;
    const offset = new Intl.DateTimeFormat(undefined, { timeZone: zone, timeZoneName: 'shortOffset' })
      .formatToParts(new Date())
      .find(part => part.type === 'timeZoneName')?.value;
    const name = zone.replace('/', ' / ').replace(/_/g, ' ');
    return offset ? `${name} (${offset})` : name;
  } catch {
    return null;
  }
}

/**
 * The current session, described from what the browser will actually say.
 *
 * The reference lists three devices with cities and IP addresses. There is no
 * endpoint that lists sessions and none that revokes one, so those rows would
 * be invented device history — see the Active sessions card below. This one
 * row is not invented: it is the session you are reading it in, and "active
 * now" is true by construction.
 */
function thisDevice() {
  if (typeof navigator === 'undefined') return { device: 'This device', where: null };
  const ua = navigator.userAgent ?? '';
  const data = navigator.userAgentData;
  const brands = (data?.brands ?? []).filter(b => !/not.a.brand/i.test(b.brand));
  const brand = brands[brands.length - 1];
  const browser = brand
    ? `${brand.brand} ${brand.version}`
    : (/(Firefox|Edg|Chrome|Safari)\/(\d+)/.exec(ua)?.slice(1).join(' ') ?? null);
  const platform = data?.platform ?? (/Windows|Macintosh|Linux|Android|iPhone|iPad/.exec(ua)?.[0] ?? null);
  const device = [platform === 'Macintosh' ? 'Mac' : platform, browser].filter(Boolean).join(' · ');
  // Location and IP are the reference's second line and we have neither, so
  // this carries what the browser does report about itself instead.
  let where = null;
  try {
    where = [Intl.DateTimeFormat().resolvedOptions().timeZone, navigator.language]
      .filter(Boolean).join(' · ');
  } catch {
    where = navigator.language ?? null;
  }
  return { device: device || 'This device', where: where || null };
}

export default function Profile() {
  // Both editable fields are owned by Firebase, not by our API: the Worker
  // reads the display name off the token's `name` claim and syncs the address
  // from the token on the next request. So these edits are the whole change,
  // and there is no endpoint of ours missing behind them.
  const { user, updateDisplayName, requestEmailChange } = useAuth();
  const { api, workspaceId, role, workspace } = useWorkspace();
  // 'owner' | 'admin' | 'reader' -> the design's own casing ('Owner').
  const roleLabel = role ? role.charAt(0).toUpperCase() + role.slice(1) : '';
  const workspaceName = workspace?.name ?? '';
  const currentEmail = user?.email ?? '';
  const currentName = user?.displayName ?? '';

  // One row at a time holds the edit, so a half-typed name cannot sit behind a
  // half-typed address waiting for somebody to notice neither was saved.
  const [editing, setEditing] = useState(null);
  const [name, setName] = useState(currentName);
  const [email, setEmail] = useState(currentEmail);
  const [pendingEmail, setPendingEmail] = useState(null);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);
  const [endingSessions, setEndingSessions] = useState(false);
  const [sessionsEnded, setSessionsEnded] = useState(false);

  const timeZone = browserTimeZone();
  const session = thisDevice();

  // Opening an editor re-reads the live value, so cancelling one row and
  // opening it again cannot hand back an abandoned draft.
  const openEditor = which => {
    setError(null);
    setName(currentName);
    setEmail(currentEmail);
    setEditing(which);
  };

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
      setEditing(null);
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
      setEditing(null);
    } catch (err) {
      setError(describeAuthError(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="acct acct--account">
      {/*
        Title matches the profile-menu label and the account-area return bar
        above it ("ACCOUNT AREA · Account") rather than the older MVP-0 spec's
        "Profile" (doc 03 §22) — both named this screen at the top of it before
        the redesign renamed the entry point to "Account" (`AgentDisk
        Dashboard.dc.html`'s profile menu and its `accountLabel`). Written as
        the reference's own h2 + sub rather than PageHead, because the card
        below no longer carries a panel title and the reference gives this
        screen exactly one heading.
      */}
      <div>
        <h2 className="ds__h2">Account</h2>
        <p className="ds__sub acct__sub">Personal details for this user, separate from any workspace.</p>
      </div>

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

      <section className="acctcard">
        <div className="acctcard__head">
          <span className="acctcard__avatar" aria-hidden="true">{initialsOf(currentName, currentEmail)}</span>
          <div style={{ minWidth: 0 }}>
            {/*
              The reference's "Upload photo". No endpoint stores an avatar —
              nothing in apps/api accepts one and Firebase's photoURL is never
              written — so the control is visibly disabled with the reason
              beside it rather than opening a file picker that leads nowhere.
            */}
            <Button variant="secondary" size="sm" disabled aria-disabled="true">Upload photo</Button>
            <p className="acctcard__hint">Profile photos aren't stored yet — your initials are used everywhere instead.</p>
          </div>
        </div>

        {editing === 'name' ? (
          <div className="acctrow acctrow--editing">
            <span className="acctrow__k">FULL NAME</span>
            <div className="acctrow__form">
              <div className="acctrow__field">
                <Input
                  label="Full name"
                  value={name}
                  autoFocus
                  onChange={e => setName(e.target.value)}
                  hint="Shown next to your actions in the audit log."
                />
              </div>
              <Button size="sm" onClick={save} loading={saving}>Save</Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
            </div>
          </div>
        ) : (
          <div className="acctrow">
            <span className="acctrow__k">FULL NAME</span>
            <span className="acctrow__v">
              {currentName || <span className="acctrow__v--quiet">Not set</span>}
            </span>
            {saved ? <span className="saved">Saved</span> : null}
            <button type="button" className="acctrow__edit" onClick={() => openEditor('name')}>Edit</button>
          </div>
        )}

        {editing === 'email' ? (
          <div className="acctrow acctrow--editing">
            <span className="acctrow__k">EMAIL</span>
            <div className="acctrow__form">
              <div className="acctrow__field">
                <Input
                  label="Email"
                  type="email"
                  value={email}
                  autoFocus
                  onChange={e => setEmail(e.target.value)}
                  hint="We'll send a verification link to the new address. Your current one stays active until you confirm."
                />
              </div>
              <Button size="sm" onClick={sendVerification} loading={sending}>Send link</Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
            </div>
          </div>
        ) : (
          <div className="acctrow">
            <span className="acctrow__k">EMAIL</span>
            <span className="acctrow__v">{currentEmail || '—'}</span>
            {user?.emailVerified
              ? <Badge tone="ok" mono>VERIFIED</Badge>
              : <Badge tone="warn" mono>UNVERIFIED</Badge>}
            <button type="button" className="acctrow__edit" onClick={() => openEditor('email')}>Edit</button>
          </div>
        )}

        <div className="acctrow">
          <span className="acctrow__k">ROLE</span>
          <span className="acctrow__v">
            {role
              ? (workspaceName ? `${roleLabel} · ${workspaceName}` : roleLabel)
              : <span className="acctrow__v--quiet">Open this from inside a workspace</span>}
          </span>
        </div>

        <div className="acctrow">
          <span className="acctrow__k">TIME ZONE</span>
          <span className="acctrow__v">
            {timeZone ?? <span className="acctrow__v--quiet">Your browser didn't report one</span>}
          </span>
          {/* Said out loud, because a row that looks like every other row in
              this list looks like something this account remembers. */}
          <span className="ad-meta">From this browser</span>
        </div>

        <div className="acctrow">
          <span className="acctrow__k">USER ID</span>
          <span className="acctrow__v acctrow__v--mono">{user?.uid ?? '—'}</span>
        </div>
      </section>

      {/*
        Active sessions.

        The reference draws three devices — "MacBook Pro · Chrome 141", "iPhone
        17 · Safari", "adk CLI 3.1.0" — each with a city, an IP and its own
        REVOKE. There is no endpoint that lists sessions and none that revokes
        one, so two of those three rows would be device history a person could
        not tell from the real thing, on the one screen where believing it
        matters most. The current session is real and is drawn in the
        reference's own row; the rest is said plainly.

        What does exist is POST /v1/me/logout-all, which had been in api.js
        since it was written and which no screen ever called.
      */}
      <section className="acctcard">
        <h3 className="acctcard__h3">Active sessions</h3>
        <div className="acctcard__body">
          <div className="sessrow">
            <span style={{ flex: 1, minWidth: 0 }}>
              <span className="sessrow__dev">{session.device}</span>
              {session.where ? <span className="sessrow__where">{session.where}</span> : null}
            </span>
            <span className="sessrow__when">Active now</span>
            <Badge tone="ok" mono>THIS DEVICE</Badge>
          </div>
          <p className="ad-meta" style={{ marginTop: 'var(--s-5)' }}>
            Other devices aren't listed — nothing records them yet. You can still end every
            session except this one; anything signed in elsewhere, a browser or an agent CLI,
            will have to sign in again.
          </p>
        </div>
        <div className="acctcard__foot">
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
          {!workspaceId ? <span className="ad-meta">Open this from inside a workspace</span> : null}
        </div>
      </section>

      {/*
        The reference's delete-account card. Its copy — "You own one workspace.
        Transfer it first, or it is deleted with the account." — describes a
        transfer-or-delete flow that does not exist: no endpoint deletes an
        account. So the control is visibly disabled and says why rather than
        opening a dialog that cannot finish, the failure backlog/023 tracks.
      */}
      <section className="acctcard acctcard--danger">
        <h3 className="acctcard__h3">Delete account</h3>
        <div className="acctcard__body">
          <p className="ad-small ad-measure">
            Deleting an account removes it and every workspace it owns. This is not
            available from the dashboard yet — contact support and we will do it by hand.
          </p>
        </div>
        <div className="acctcard__foot">
          <Button variant="danger-outline" size="sm" disabled aria-disabled="true">
            Delete account…
          </Button>
          <span className="ad-meta">Not available yet</span>
        </div>
      </section>
    </div>
  );
}
