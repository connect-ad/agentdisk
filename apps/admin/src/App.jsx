import React, { useCallback, useEffect, useState } from 'react';
import { staffApi, storeToken, storedToken, StaffApiError } from './api.js';

/**
 * The staff console — 14 PART 28.
 *
 * Deliberately plain. This is internal tooling for a small team, and it does
 * not import the customer design system: that package is vendored from a
 * byte-verified mirror and its components carry the product's brand, which is
 * the wrong thing to put in front of somebody about to suspend a customer.
 * Looking obviously different from the customer dashboard is a feature — it is
 * how a support engineer knows which one they are typing into.
 *
 * There is no impersonation and there never will be (14 PART 28.3). Every
 * action here is *on* a workspace, never *as* the customer.
 */

const styles = {
  page: { font: '14px/1.5 system-ui, sans-serif', color: '#111', background: '#f7f7f8', minHeight: '100vh' },
  bar: {
    display: 'flex', alignItems: 'center', gap: 16, padding: '12px 20px',
    background: '#111', color: '#fff', position: 'sticky', top: 0, zIndex: 10
  },
  main: { maxWidth: 1100, margin: '0 auto', padding: 20 },
  card: { background: '#fff', border: '1px solid #e3e3e6', borderRadius: 8, padding: 16, marginBottom: 16 },
  input: { padding: '8px 10px', border: '1px solid #ccc', borderRadius: 6, font: 'inherit', width: '100%' },
  button: {
    padding: '8px 14px', border: 0, borderRadius: 6, background: '#111', color: '#fff',
    font: 'inherit', cursor: 'pointer'
  },
  danger: { background: '#a11', color: '#fff' },
  muted: { color: '#666', fontSize: 13 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th: { textAlign: 'left', padding: '8px 10px', borderBottom: '2px solid #e3e3e6', color: '#555' },
  td: { padding: '8px 10px', borderBottom: '1px solid #f0f0f2' },
  error: { background: '#fdeaea', border: '1px solid #f5c2c2', color: '#8a1f1f', padding: 12, borderRadius: 6, marginBottom: 12 },
  mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 }
};

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function ErrorNote({ error }) {
  if (!error) return null;
  return (
    <div style={styles.error} role="alert">
      {error.message}
      {error.requestId ? <div style={styles.mono}>request {error.requestId}</div> : null}
    </div>
  );
}

/* --------------------------------- login --------------------------------- */

function Login({ onSignedIn }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async e => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const result = await staffApi.login(email.trim(), password, totp.trim());
      storeToken(result.token);
      onSignedIn(result.staff);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <div style={{ ...styles.page, display: 'grid', placeItems: 'center' }}>
      <form onSubmit={submit} style={{ ...styles.card, width: 360 }}>
        <h1 style={{ font: '600 18px/1.3 system-ui', margin: '0 0 4px' }}>AgentDisk staff</h1>
        <p style={{ ...styles.muted, marginTop: 0 }}>
          Internal console. Every action you take here is recorded against the workspace it
          touches, including the ones that only read.
        </p>

        <ErrorNote error={error} />

        <label style={{ display: 'block', marginBottom: 10 }}>
          Email
          <input style={styles.input} type="email" required value={email} onChange={e => setEmail(e.target.value)} />
        </label>
        <label style={{ display: 'block', marginBottom: 10 }}>
          Password
          <input style={styles.input} type="password" required value={password} onChange={e => setPassword(e.target.value)} />
        </label>
        <label style={{ display: 'block', marginBottom: 14 }}>
          Authenticator code
          {/* Required, always. There is no path through this form without one. */}
          <input
            style={styles.input}
            required
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            value={totp}
            onChange={e => setTotp(e.target.value)}
          />
        </label>
        <button style={styles.button} disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
}

/* ------------------------------- workspaces ------------------------------ */

function WorkspaceDetail({ id, onBack, role }) {
  const [data, setData] = useState(null);
  const [events, setEvents] = useState([]);
  const [error, setError] = useState(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [w, a] = await Promise.all([staffApi.getWorkspace(id), staffApi.workspaceActivity(id)]);
      setData(w.workspace);
      setEvents(a.events ?? []);
    } catch (err) {
      setError(err);
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  const setStatus = async status => {
    if (!reason.trim()) {
      setError(new StaffApiError(400, 'VALIDATION_ERROR', 'Say why. This is recorded.'));
      return;
    }
    setBusy(true); setError(null);
    try {
      await staffApi.setWorkspaceStatus(id, status, reason.trim());
      setReason('');
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const canAct = role === 'admin' || role === 'super_admin';

  return (
    <>
      <button style={{ ...styles.button, background: '#555', marginBottom: 12 }} onClick={onBack}>
        ← All workspaces
      </button>
      <ErrorNote error={error} />

      {data ? (
        <>
          <div style={styles.card}>
            <h2 style={{ margin: '0 0 8px', font: '600 16px/1.3 system-ui' }}>{data.name}</h2>
            <div style={styles.mono}>{data.id}</div>
            <table style={{ ...styles.table, marginTop: 12 }}>
              <tbody>
                <tr><td style={styles.td}>Account</td><td style={styles.td}>{data.orgName}</td></tr>
                <tr><td style={styles.td}>Status</td><td style={styles.td}><strong>{data.status}</strong></td></tr>
                <tr><td style={styles.td}>Plan</td><td style={styles.td}>{data.plan}</td></tr>
                <tr><td style={styles.td}>Billing</td><td style={styles.td}>{data.billingStatus}</td></tr>
                <tr><td style={styles.td}>Storage</td><td style={styles.td}>{formatBytes(data.storageBytesUsed)}</td></tr>
                <tr><td style={styles.td}>Files</td><td style={styles.td}>{data.fileCount}</td></tr>
              </tbody>
            </table>
          </div>

          <div style={styles.card}>
            <h3 style={{ margin: '0 0 8px', font: '600 15px/1.3 system-ui' }}>Status</h3>
            {canAct ? (
              <>
                <p style={styles.muted}>
                  Suspending stops every API key in this workspace on its next call. The keys
                  themselves are untouched, so reinstating needs no re-minting.
                </p>
                <input
                  style={{ ...styles.input, marginBottom: 10 }}
                  placeholder="Why? This is recorded against the workspace."
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                />
                <div style={{ display: 'flex', gap: 8 }}>
                  {data.status === 'active' ? (
                    <button style={{ ...styles.button, ...styles.danger }} disabled={busy} onClick={() => setStatus('suspended')}>
                      Suspend
                    </button>
                  ) : (
                    <button style={styles.button} disabled={busy} onClick={() => setStatus('active')}>
                      Reinstate
                    </button>
                  )}
                </div>
              </>
            ) : (
              /* Absent, not disabled. A disabled control implies the action is
                 available somewhere; for support it is not available at all. */
              <p style={styles.muted}>The support role cannot change a workspace's status.</p>
            )}
          </div>

          <div style={styles.card}>
            <h3 style={{ margin: '0 0 8px', font: '600 15px/1.3 system-ui' }}>Activity</h3>
            <p style={styles.muted}>
              The customer's own audit trail, including anything staff have done here.
            </p>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>When</th>
                  <th style={styles.th}>Action</th>
                  <th style={styles.th}>Actor</th>
                  <th style={styles.th}>Result</th>
                </tr>
              </thead>
              <tbody>
                {events.map(e => (
                  <tr key={e.id}>
                    <td style={styles.td}>{new Date(e.createdAt).toLocaleString()}</td>
                    <td style={{ ...styles.td, ...styles.mono }}>{e.action}</td>
                    <td style={styles.td}>{e.actorType} · <span style={styles.mono}>{e.actorId}</span></td>
                    <td style={styles.td}>{e.result}</td>
                  </tr>
                ))}
                {events.length === 0 ? (
                  <tr><td style={styles.td} colSpan={4}>Nothing recorded yet.</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <p style={styles.muted}>Loading…</p>
      )}
    </>
  );
}

function Fleet({ role }) {
  const [summary, setSummary] = useState(null);
  const [workspaces, setWorkspaces] = useState([]);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async search => {
    setError(null);
    try {
      const [o, w] = await Promise.all([staffApi.overview(), staffApi.listWorkspaces(search)]);
      setSummary(o.summary);
      setWorkspaces(w.workspaces ?? []);
    } catch (err) {
      setError(err);
    }
  }, []);

  useEffect(() => { void load(''); }, [load]);

  if (selected) {
    return <WorkspaceDetail id={selected} role={role} onBack={() => { setSelected(null); void load(query); }} />;
  }

  return (
    <>
      <ErrorNote error={error} />

      {summary ? (
        <div style={{ ...styles.card, display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 12 }}>
          {[
            ['Workspaces', summary.workspaces],
            ['Suspended', summary.suspended],
            ['Users', summary.users],
            ['Active agents', summary.agents],
            ['Live keys', summary.activeKeys],
            ['Storage', formatBytes(summary.storageBytes)],
            ['Billing problems', summary.billingProblems]
          ].map(([label, value]) => (
            <div key={label}>
              <div style={styles.muted}>{label}</div>
              <div style={{ font: '600 20px/1.2 system-ui' }}>{value ?? '—'}</div>
            </div>
          ))}
        </div>
      ) : null}

      <div style={styles.card}>
        <form
          onSubmit={e => { e.preventDefault(); void load(query); }}
          style={{ display: 'flex', gap: 8, marginBottom: 12 }}
        >
          <input
            style={styles.input}
            placeholder="Search workspaces or accounts"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
          <button style={styles.button}>Search</button>
        </form>

        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Workspace</th>
              <th style={styles.th}>Account</th>
              <th style={styles.th}>Plan</th>
              <th style={styles.th}>Status</th>
              <th style={styles.th}>Storage</th>
              <th style={styles.th}>Files</th>
            </tr>
          </thead>
          <tbody>
            {workspaces.map(w => (
              <tr key={w.id} style={{ cursor: 'pointer' }} onClick={() => setSelected(w.id)}>
                <td style={styles.td}>
                  {w.name}
                  <div style={{ ...styles.mono, color: '#888' }}>{w.id}</div>
                </td>
                <td style={styles.td}>{w.orgName}</td>
                <td style={styles.td}>{w.plan}</td>
                <td style={{ ...styles.td, color: w.status === 'active' ? '#127' : '#a11' }}>{w.status}</td>
                <td style={styles.td}>{formatBytes(w.storageBytesUsed)}</td>
                <td style={styles.td}>{w.fileCount}</td>
              </tr>
            ))}
            {workspaces.length === 0 ? (
              <tr><td style={styles.td} colSpan={6}>No workspaces match.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ---------------------------------- app ---------------------------------- */

export default function App() {
  const [staff, setStaff] = useState(null);
  const [checking, setChecking] = useState(Boolean(storedToken()));

  useEffect(() => {
    if (!storedToken()) return;
    staffApi
      .whoami()
      .then(r => setStaff(r.staff))
      .catch(() => storeToken(null))
      .finally(() => setChecking(false));
  }, []);

  if (checking) {
    return <div style={{ ...styles.page, padding: 40 }}>Checking your session…</div>;
  }

  if (!staff) return <Login onSignedIn={setStaff} />;

  return (
    <div style={styles.page}>
      <div style={styles.bar}>
        <strong>AgentDisk staff</strong>
        <span style={{ opacity: 0.7, fontSize: 13 }}>{staff.email} · {staff.role}</span>
        <span style={{ flex: 1 }} />
        <button
          style={{ ...styles.button, background: '#333' }}
          onClick={async () => {
            await staffApi.logout().catch(() => undefined);
            storeToken(null);
            setStaff(null);
          }}
        >
          Sign out
        </button>
      </div>
      <div style={styles.main}>
        <Fleet role={staff.role} />
      </div>
    </div>
  );
}
