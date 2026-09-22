import React, { useEffect, useMemo, useState } from 'react';
import { btn, ellipsis, h1, mono, secondaryBtn } from '../lib/ui.js';

/**
 * The console shell: top strip, sidebar, pane header.
 *
 * ── What the design has that this does not ─────────────────────────────────
 * The prototype bar is gone entirely — the ROLE switcher and the "Login screen"
 * toggle were scaffolding for a mockup, and a role switcher in a real admin
 * console is a privilege-escalation control with a friendly label. The real
 * role comes from the authenticated session and nothing on screen can change
 * it. The theme toggle is the one piece kept, moved into the top strip.
 *
 * ── The sidebar tells you what your role cannot do ─────────────────────────
 * Rather than silently hiding everything, a support or admin session gets a
 * "limited view" note naming what is missing. Silent hiding teaches people that
 * the tool is incomplete; naming the restriction teaches them it is deliberate,
 * and tells them who to ask.
 */

/*
  One role. `support` and `super_admin` are gone from the server, so a nav item
  asking for either was asking for something nobody can hold - which made
  `holds('admin', 'super_admin')` false and hid Admin Accounts from everyone,
  including the person who could reach it.

  Kept as a map with one entry, and `holds` kept beside it, so restoring a tier
  is adding a line rather than rediscovering which screens were gated.
*/
const RANK = { admin: 0 };

export const NAV = [
  { key: 'overview', label: 'Overview', path: '/', role: 'admin' },
  {
    key: 'workspaces',
    label: 'Workspaces',
    path: '/workspaces',
    role: 'admin',
    kids: [
      { key: 'workspaces', label: 'All Workspaces', path: '/workspaces' },
      { key: 'ws_attention', label: 'Needs Attention', path: '/workspaces/needs-attention' },
      { key: 'ws_suspended', label: 'Suspended', path: '/workspaces/suspended' }
    ]
  },
  { key: 'users', label: 'Users', path: '/users', role: 'admin' },
  {
    key: 'billing',
    label: 'Billing',
    path: '/billing',
    // support+, not admin. The design gates this at admin, which is one notch
    // too strict: support is exactly who needs to see why a customer's writes
    // are blocked.
    role: 'admin',
    kids: [
      { key: 'billing', label: 'All', path: '/billing' },
      { key: 'bill_past', label: 'Past Due', path: '/billing/past-due' },
      { key: 'bill_cancel', label: 'Canceled', path: '/billing/canceled' }
    ]
  },
  {
    key: 'plans',
    label: 'Plans & Pricing',
    path: '/plans',
    role: 'admin',
    kids: [
      { key: 'plans', label: 'Plans', path: '/plans' },
      { key: 'sync', label: 'Sync History', path: '/plans/sync-history' }
    ]
  },
  { key: 'audit', label: 'Audit Log', path: '/audit', role: 'admin' },
  { key: 'deletions', label: 'Deletions', path: '/deletions', role: 'admin' },
  // Readable by support on purpose: support is who gets asked whether email
  // is down, and the answer is a boolean that grants nothing. Only the test
  // send is gated higher, and the screen and the server both check that.
  { key: 'email', label: 'Email', path: '/settings/email', role: 'admin' },
  { key: 'admin', label: 'Admin Accounts', path: '/admin', role: 'admin' }
];

export function holds(role, minimum) {
  return (RANK[role] ?? -1) >= (RANK[minimum] ?? 99);
}

function restrictionNote(role) {
  // Nothing to restrict: every console operator can do everything. Said
  // plainly rather than left blank, because the previous copy described three
  // tiers and a reader who remembers it needs to know it is gone, not absent.
  return role === 'admin'
    ? 'Every console operator can do everything here, including deletions. The only boundary is being in admin_users at all.'
    : null;
}

/** The tab title, so a browser with six console tabs open is navigable. */
function useDocumentTitle(title) {
  useEffect(() => {
    document.title = title ? `${title} · AgentDisk admin` : 'AgentDisk admin';
  }, [title]);
}

export function ThemeToggle() {
  const [theme, setTheme] = useState(() => {
    try {
      return window.localStorage.getItem('agentdisk.admin.theme') ?? 'dark';
    } catch {
      return 'dark';
    }
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      window.localStorage.setItem('agentdisk.admin.theme', theme);
    } catch {
      /* Per-viewer convenience. Nothing depends on it surviving. */
    }
  }, [theme]);

  return (
    <button
      type="button"
      onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
      style={{ ...secondaryBtn, height: '28px', fontSize: '12px' }}
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
    >
      {theme === 'dark' ? 'Light' : 'Dark'}
    </button>
  );
}

function Caret({ open }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      style={{ flex: '0 0 12px', transform: open ? 'none' : 'rotate(-90deg)' }}
      aria-hidden="true"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function Sidebar({ role, path, counts, onNavigate }) {
  const visible = useMemo(() => NAV.filter(item => holds(role, item.role)), [role]);
  const note = restrictionNote(role);

  const activeKey = (() => {
    if (path === '/' || path === '') return 'overview';
    const top = visible.find(item => path === item.path || path.startsWith(`${item.path}/`));
    return top?.key ?? 'overview';
  })();

  return (
    <nav
      aria-label="Console sections"
      style={{
        width: '210px',
        flex: '0 0 210px',
        borderRight: '1px solid var(--bd)',
        background: 'var(--surf2)',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0
      }}
    >
      <div style={{ flex: 1, padding: '12px 8px', overflowY: 'auto' }}>
        {visible.map(item => {
          const active = activeKey === item.key;
          const open = Boolean(item.kids) && active;
          return (
            <div key={item.key} style={{ marginBottom: '1px' }}>
              <button
                type="button"
                onClick={() => onNavigate(item.path)}
                aria-current={active ? 'page' : undefined}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '9px',
                  width: '100%',
                  height: '32px',
                  padding: '0 9px',
                  borderRadius: '7px',
                  cursor: 'pointer',
                  border: 'none',
                  fontFamily: 'var(--font)',
                  background: active ? 'var(--accSoft)' : 'transparent',
                  color: active ? 'var(--acc)' : 'var(--tx2)'
                }}
              >
                <span
                  style={{
                    width: '3px',
                    height: '14px',
                    borderRadius: '99px',
                    flex: '0 0 3px',
                    background: active ? 'var(--acc)' : 'transparent'
                  }}
                />
                <span
                  style={{
                    flex: 1,
                    textAlign: 'left',
                    fontSize: '12.5px',
                    fontWeight: active ? 600 : 500,
                    color: active ? 'var(--acc)' : 'var(--tx)',
                    ...ellipsis
                  }}
                >
                  {item.label}
                </span>
                {counts[item.key] !== undefined && (
                  <span style={{ ...mono, fontSize: '10px', color: 'var(--tx3)' }}>
                    {counts[item.key]}
                  </span>
                )}
                {item.kids && <Caret open={open} />}
              </button>

              {open && (
                <div
                  style={{
                    padding: '2px 0 6px 20px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '1px'
                  }}
                >
                  {item.kids.map(kid => {
                    const kidActive = path === kid.path;
                    return (
                      <button
                        key={kid.path}
                        type="button"
                        onClick={() => onNavigate(kid.path)}
                        aria-current={kidActive ? 'page' : undefined}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px',
                          width: '100%',
                          height: '28px',
                          padding: '0 9px',
                          borderRadius: '7px',
                          border: 'none',
                          cursor: 'pointer',
                          fontFamily: 'var(--font)',
                          fontSize: '12px',
                          fontWeight: kidActive ? 600 : 400,
                          color: kidActive ? 'var(--acc)' : 'var(--tx2)',
                          background: kidActive ? 'var(--surf3)' : 'transparent'
                        }}
                      >
                        <span
                          style={{
                            width: '4px',
                            height: '4px',
                            flex: '0 0 4px',
                            borderRadius: '99px',
                            background: kidActive ? 'var(--acc)' : 'var(--tx3)'
                          }}
                        />
                        <span style={{ flex: 1, textAlign: 'left', ...ellipsis }}>{kid.label}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ padding: '10px', borderTop: '1px solid var(--bd)' }}>
        {note ? (
          <div
            style={{
              border: '1px solid var(--bd)',
              background: 'var(--surf)',
              borderRadius: '9px',
              padding: '10px 11px'
            }}
          >
            <div
              style={{
                ...mono,
                fontSize: '9px',
                letterSpacing: '0.1em',
                color: 'var(--tx3)',
                marginBottom: '6px'
              }}
            >
              LIMITED VIEW
            </div>
            <div style={{ fontSize: '11.5px', lineHeight: 1.5, color: 'var(--tx2)' }}>{note}</div>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '2px 3px' }}>
            <span
              style={{
                width: '6px',
                height: '6px',
                borderRadius: '99px',
                background: 'var(--ok)',
                flex: '0 0 6px'
              }}
            />
            <span style={{ ...mono, fontSize: '10px', letterSpacing: '0.06em', color: 'var(--tx3)' }}>
              FULL ACCESS
            </span>
          </div>
        )}
      </div>
    </nav>
  );
}

export function Shell({
  admin,
  path,
  counts = {},
  attention = 0,
  onNavigate,
  onSignOut,
  title,
  subtitle,
  actions = null,
  freshness = null,
  onRefresh = null,
  busy = false,
  children
}) {
  useDocumentTitle(title);

  return (
    // `height`, not `min-height`. The shell is exactly the window, so the row
    // beneath the bar has a bounded height, and the content pane -- which has
    // carried `overflow-y: auto` all along -- finally has something to
    // overflow. With `min-height` the shell grew instead, the pane never
    // reached a limit, and a long table scrolled the whole document, carrying
    // the sidebar and the top bar off the screen with it.
    <div style={{ height: '100%', background: 'var(--bg)', display: 'flex', flexDirection: 'column' }}>
      <header
        style={{
          height: '46px',
          flex: '0 0 46px',
          borderBottom: '1px solid var(--bd)',
          background: 'var(--surf)',
          display: 'flex',
          alignItems: 'center',
          padding: '0 16px',
          gap: '12px',
          position: 'sticky',
          top: 0,
          zIndex: 'var(--z-topbar)'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '9px', flex: '0 0 auto' }}>
          <span
            style={{
              fontFamily: 'var(--fontHead)',
              fontSize: '14px',
              fontWeight: 600,
              letterSpacing: '-0.02em',
              color: 'var(--tx)'
            }}
          >
            AgentDisk
          </span>
          {/* The badge is not decoration: it is how somebody with both apps
              open knows which one they are about to act in. */}
          <span
            style={{
              ...mono,
              fontSize: '9px',
              letterSpacing: '0.1em',
              color: 'var(--warnTx)',
              background: 'var(--warnSoft)',
              border: '1px solid var(--warnBd)',
              borderRadius: '4px',
              padding: '2px 6px'
            }}
          >
            ADMIN
          </span>
        </div>

        <div style={{ height: '20px', width: '1px', background: 'var(--bd)' }} />
        <span style={{ ...mono, fontSize: '11px', color: 'var(--tx3)', ...ellipsis }}>{path}</span>

        <div
          style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '12px', flex: '0 0 auto' }}
        >
          {attention > 0 && (
            <button
              type="button"
              onClick={() => onNavigate('/workspaces/needs-attention')}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '7px',
                border: '1px solid var(--warnBd)',
                background: 'var(--warnSoft)',
                borderRadius: '7px',
                padding: '3px 9px',
                cursor: 'pointer'
              }}
            >
              <span
                style={{ width: '6px', height: '6px', borderRadius: '2px', background: 'var(--warn)' }}
              />
              <span style={{ ...mono, fontSize: '10px', letterSpacing: '0.06em', color: 'var(--warnTx)' }}>
                {attention} NEED ATTENTION
              </span>
            </button>
          )}

          <ThemeToggle />

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '12.5px', color: 'var(--tx)', ...ellipsis }}>{admin.email}</span>
            <span
              style={{
                ...mono,
                fontSize: '9px',
                letterSpacing: '0.07em',
                padding: '2px 6px',
                borderRadius: '4px',
                color: 'var(--acc)',
                background: 'var(--accSoft)',
                border: '1px solid var(--accBd)'
              }}
            >
              {admin.role}
            </span>
          </div>

          <button
            type="button"
            onClick={onSignOut}
            style={{
              background: 'transparent',
              border: 'none',
              padding: 0,
              fontFamily: 'var(--font)',
              fontSize: '12.5px',
              color: 'var(--tx2)',
              cursor: 'pointer'
            }}
          >
            Log out
          </button>
        </div>
      </header>

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <Sidebar role={admin.role} path={path} counts={counts} onNavigate={onNavigate} />

        <main style={{ flex: 1, minWidth: 0, padding: '22px 24px 48px', overflowX: 'hidden' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: '14px',
              flexWrap: 'wrap',
              marginBottom: '18px'
            }}
          >
            <div style={{ minWidth: 0, flex: 1 }}>
              <h1 style={h1}>{title}</h1>
              {subtitle && (
                <p style={{ margin: 0, fontSize: '13px', lineHeight: 1.5, color: 'var(--tx2)' }}>
                  {subtitle}
                </p>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '9px', flex: '0 0 auto' }}>
              {freshness && (
                <span style={{ ...mono, fontSize: '10px', letterSpacing: '0.06em', color: 'var(--tx3)' }}>
                  {freshness}
                </span>
              )}
              {onRefresh && (
                <button type="button" onClick={onRefresh} style={secondaryBtn} disabled={busy}>
                  {busy ? 'Refreshing…' : 'Refresh'}
                </button>
              )}
              {actions}
            </div>
          </div>

          {children}
        </main>
      </div>
    </div>
  );
}

export { btn };
