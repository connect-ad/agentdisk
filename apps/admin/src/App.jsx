import React, { useCallback, useEffect, useState } from 'react';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { auth, firebaseConfigured } from './lib/firebase.js';
import { onSessionLost, adminApi } from './api.js';
import { Shell, holds } from './components/Shell.jsx';
import { SessionExpired } from './components/States.jsx';
import { ToastDock } from './components/Overlay.jsx';
import { Login } from './screens/Login.jsx';
import { Overview } from './screens/Overview.jsx';
import { WorkspaceDetail, WorkspaceList } from './screens/Workspaces.jsx';
import { Users } from './screens/Users.jsx';
import { Billing } from './screens/Billing.jsx';
import { Plans, SyncHistory } from './screens/Plans.jsx';
import { Audit } from './screens/Audit.jsx';
import { Deletions } from './screens/Deletions.jsx';
import { ClaimLinks } from './screens/ClaimLinks.jsx';
import { AdminAccounts } from './screens/AdminAccounts.jsx';
import { EmailSettings } from './screens/EmailSettings.jsx';
import { freshnessLabel } from './lib/useResource.js';

/**
 * The console shell and its routing.
 *
 * ── Routing is the History API and one `useState`, not a router library ────
 * Nine routes, all inside one authenticated shell, none of them nested more
 * than one level. `react-router-dom` is in package.json and is not used here:
 * for this shape it buys a dependency and a mental model in exchange for
 * matching nine strings. Deep links work, Back works, and no route reloads the
 * page — which is the whole of what the design asks for.
 *
 * ── Two different "signed out" states, and they are not the same ───────────
 * **Not signed in** shows the Google button. **Signed in but not admin** shows
 * the same screen with the address named and an explanation, because that is
 * what happens when somebody's admin row is removed, or when they use their
 * personal Google account by mistake. Collapsing the two would present a
 * sign-in button to somebody already signed in, which reads as broken.
 *
 * A 401 mid-task now means either an expired token or a admin row that was just
 * disabled — disable takes effect on the very next request. Either way the
 * prompt keeps the current route, so signing back in returns to the same
 * screen rather than losing the operator's place.
 *
 * ── Role gating happens here AND on the server ─────────────────────────────
 * A route the session's role cannot reach renders a refusal rather than a blank
 * screen, and the endpoints behind every screen re-check independently. This
 * gate is a convenience; the server's is the control.
 */

function usePath() {
  const [path, setPath] = useState(() => window.location.pathname || '/');

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname || '/');
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback(next => {
    if (next === window.location.pathname) return;
    window.history.pushState({}, '', next);
    setPath(next);
  }, []);

  return [path, navigate];
}

/** What each route is called, so the shell header does not have to guess. */
function describe(path) {
  if (path === '/' || path === '') {
    return { key: 'overview', title: 'Fleet overview', subtitle: 'Refreshed on activation, not polled.' };
  }
  if (path === '/workspaces') {
    return {
      key: 'workspaces',
      title: 'All workspaces',
      subtitle: 'Search by name, workspace ID or owner email.'
    };
  }
  if (path === '/workspaces/needs-attention') {
    return {
      key: 'workspaces',
      title: 'Needs attention',
      subtitle: 'Above 95% of a quota, or an organization that is not billing-active.'
    };
  }
  if (path === '/workspaces/suspended') {
    return { key: 'workspaces', title: 'Suspended', subtitle: 'Suspended by admin action.' };
  }
  if (path.startsWith('/workspaces/')) {
    return { key: 'workspaces', title: 'Workspace', subtitle: null };
  }
  if (path === '/users') {
    return {
      key: 'users',
      title: 'Users',
      subtitle: 'Exact-match lookup by email. Returns the account and its memberships.'
    };
  }
  if (path === '/billing') {
    return {
      key: 'billing',
      title: 'Billing — all organizations',
      subtitle: 'Subscription state, per billing account. Read-only here.'
    };
  }
  if (path === '/billing/past-due') {
    return { key: 'billing', title: 'Billing — past due', subtitle: 'One or more failed charges.' };
  }
  if (path === '/billing/canceled') {
    return { key: 'billing', title: 'Billing — canceled', subtitle: 'Subscription ended.' };
  }
  if (path === '/plans') {
    return {
      key: 'plans',
      title: 'Plans',
      subtitle: 'Plan definitions and their Stripe mapping.'
    };
  }
  if (path === '/plans/sync-history') {
    return {
      key: 'plans',
      title: 'Sync history',
      subtitle: 'Every plan change, from the admin audit log.'
    };
  }
  if (path === '/audit') {
    return { key: 'audit', title: 'Audit log', subtitle: 'Every admin action across the fleet.' };
  }
  if (path === '/admin') {
    return { key: 'admin', title: 'Admin accounts', subtitle: 'Internal accounts and their roles.' };
  }
  if (path === '/settings/email') {
    return {
      key: 'email',
      title: 'Email delivery',
      subtitle: 'The channel this product sends its own mail through. Firebase sends its own.'
    };
  }
  return { key: 'overview', title: 'Not found', subtitle: null };
}

/** The minimum role a route needs, mirrored from the server's own gates. */
const ROUTE_ROLE = { admin: 'super_admin' };

export default function App() {
  const [admin, setAdmin] = useState(null);
  const [identity, setIdentity] = useState(null);
  const [authError, setAuthError] = useState(null);
  const [checking, setChecking] = useState(firebaseConfigured);
  const [expired, setExpired] = useState(false);
  const [toasts, setToasts] = useState([]);
  const [counts, setCounts] = useState({});
  const [attention, setAttention] = useState(0);
  const [path, navigate] = usePath();

  const toast = useCallback(message => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts(current => [...current, { id, message }]);
    window.setTimeout(() => setToasts(current => current.filter(item => item.id !== id)), 6000);
  }, []);

  /**
   * Follow Firebase, then ask the API whether this identity is admin.
   *
   * Two questions, deliberately in that order and deliberately not merged. The
   * SDK answers the first locally and instantly; only the API can answer the
   * second, and it is the one that matters.
   */
  useEffect(() => {
    if (!auth) return undefined;
    return onAuthStateChanged(auth, async user => {
      if (!user) {
        setIdentity(null);
        setAdmin(null);
        setChecking(false);
        return;
      }

      setIdentity(user.email ?? null);
      setChecking(true);
      setAuthError(null);
      try {
        const result = await adminApi.whoami();
        setAdmin(result.admin);
        setExpired(false);
      } catch (err) {
        setAdmin(null);
        // **Only a 401 means "not admin".** Anything else — a blocked CORS
        // preflight, a 500, the API being unreachable — is a failure to ASK the
        // question, and reporting it as the answer sends somebody hunting for a
        // missing database row that is sitting right there. That is exactly
        // what happened the first time this shipped: the console's origin was
        // absent from CORS_ALLOWED_ORIGINS, every call was blocked by the
        // browser, and the screen said "no admin access" with great confidence.
        if (err?.status !== 401) setAuthError(err);
      } finally {
        setChecking(false);
      }
    });
  }, []);

  // One subscription for every 401 in the app.
  useEffect(
    () =>
      onSessionLost(() => {
        if (admin) setExpired(true);
      }),
    [admin]
  );

  if (checking) {
    return (
      <div
        style={{
          // Percentage, never `100vh` -- app.css's full-height chain says why.
          minHeight: '100%',
          background: 'var(--bg)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--tx2)',
          fontFamily: 'var(--font)',
          fontSize: '13px'
        }}
      >
        Checking your admin access…
      </div>
    );
  }

  if (!admin) {
    // `identity` present means signed in but not admin, which the screen says
    // in those words rather than looping them back to a button.
    return <Login notAdmin={authError ? null : identity} error={authError} />;
  }

  const route = describe(path);
  const needed = ROUTE_ROLE[route.key];
  const permitted = !needed || holds(admin.role, needed);

  async function endSession() {
    // Signing out IS discarding the Firebase token; there is no server call.
    try {
      if (auth) await signOut(auth);
    } catch {
      /* The local state is cleared regardless. */
    }
    setAdmin(null);
    setIdentity(null);
    navigate('/');
  }

  function screen() {
    if (!permitted) {
      return (
        <div
          style={{
            border: '1px solid var(--warnBd)',
            background: 'var(--warnSoft)',
            borderRadius: '11px',
            padding: '20px'
          }}
        >
          <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--warnTx)', marginBottom: '6px' }}>
            Your role cannot open this screen
          </div>
          <div style={{ fontSize: '12.5px', lineHeight: 1.6, color: 'var(--warnTx)' }}>
            This needs {needed}. You are signed in as {admin.role}. The endpoints behind it refuse
            independently, so this is not the only thing stopping you.
          </div>
        </div>
      );
    }

    if (path === '/' || path === '') {
      return (
        <Overview
          onNavigate={navigate}
          onData={data => {
            setAttention(data.attention);
            setCounts(current => ({ ...current, workspaces: data.workspaces }));
          }}
        />
      );
    }
    if (path === '/workspaces') return <WorkspaceList view="all" onNavigate={navigate} />;
    if (path === '/workspaces/needs-attention') {
      return <WorkspaceList view="needs-attention" onNavigate={navigate} />;
    }
    if (path === '/workspaces/suspended') {
      return <WorkspaceList view="suspended" onNavigate={navigate} />;
    }
    if (path.startsWith('/workspaces/')) {
      return (
        <WorkspaceDetail
          workspaceId={path.slice('/workspaces/'.length)}
          role={admin.role}
          onNavigate={navigate}
          onToast={toast}
        />
      );
    }
    if (path === '/users') return <Users role={admin.role} onNavigate={navigate} onToast={toast} />;
    if (path === '/billing') return <Billing filter="all" />;
    if (path === '/billing/past-due') return <Billing filter="past_due" />;
    if (path === '/billing/canceled') return <Billing filter="canceled" />;
    if (path === '/plans') return <Plans role={admin.role} onToast={toast} />;
    if (path === '/plans/sync-history') return <SyncHistory />;
    if (path === '/audit') return <Audit onToast={toast} />;
    if (path === '/deletions') return <Deletions onToast={toast} />;
    if (path === '/claim-links') return <ClaimLinks />;
    if (path === '/admin') return <AdminAccounts currentAdminId={admin.id} onToast={toast} />;
    if (path === '/settings/email') return <EmailSettings role={admin.role} onToast={toast} />;

    return (
      <div style={{ color: 'var(--tx2)', fontSize: '13px' }}>
        No such screen. <button type="button" onClick={() => navigate('/')}>Back to the overview</button>
      </div>
    );
  }

  return (
    <>
      <Shell
        admin={admin}
        path={path}
        counts={counts}
        attention={attention}
        onNavigate={navigate}
        onSignOut={endSession}
        title={route.title}
        subtitle={route.subtitle}
      >
        {screen()}
      </Shell>

      {expired && (
        <SessionExpired
          onReauthenticate={() => {
            // The path is untouched, so signing in returns to this same screen.
            setAdmin(null);
            setExpired(false);
          }}
        />
      )}

      <ToastDock toasts={toasts} onDismiss={id => setToasts(c => c.filter(t => t.id !== id))} />
    </>
  );
}

export { freshnessLabel };
