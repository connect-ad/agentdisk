import React, { useState } from 'react';
import { Icon } from '../Icon/Icon.jsx';
import { IconButton } from '../Button/IconButton.jsx';

export function AppShell({
  nav = [], active, workspace, workspaces = [], user, topbar, topbarActions, children, flush = false,
  onNavigate, onWorkspaceChange, className = '', ...rest
}) {
  const [open, setOpen] = useState(false);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [selectedWorkspace, setSelectedWorkspace] = useState(workspace || workspaces[0]);
  return (
    <div className={['shell', open ? 'is-open' : '', className].filter(Boolean).join(' ')} {...rest}>
      <nav className="shell__nav" aria-label="Primary">
        <div className="shell__brand">
          <span className="shell__logo" aria-hidden="true">A</span>
          <span className="shell__wordmark">AgentDrive</span>
        </div>
        {selectedWorkspace ? (
          <div className="shell__ws">
            <button type="button" className="shell__wsbtn" aria-expanded={workspaceMenuOpen}
              aria-haspopup="listbox" onClick={() => setWorkspaceMenuOpen(!workspaceMenuOpen)}>
              <span className="shell__wsmark" aria-hidden="true">{(selectedWorkspace.name || 'W').slice(0, 1).toUpperCase()}</span>
              <span style={{ minWidth: 0, flex: 1 }}>
                <span className="shell__wsname" style={{ display: 'block' }}>{selectedWorkspace.name}</span>
                <span className="shell__wsmeta">{selectedWorkspace.meta}</span>
              </span>
              <Icon name="chevronUpDown" size={14} />
            </button>
            {workspaces.length > 0 && workspaceMenuOpen ? (
              <div className="shell__wsmenu" role="listbox" aria-label="Workspaces">
                <p className="shell__wsmenu-label">Workspaces</p>
                {workspaces.map(item => (
                  <button type="button" role="option" aria-selected={item.name === selectedWorkspace.name}
                    className={['shell__wsitem', item.name === selectedWorkspace.name ? 'is-selected' : ''].filter(Boolean).join(' ')}
                    key={item.name} onClick={() => {
                      setSelectedWorkspace(item);
                      onWorkspaceChange?.(item);
                      setWorkspaceMenuOpen(false);
                    }}>
                    <span className="shell__wsmark" aria-hidden="true">{(item.name || 'W').slice(0, 1).toUpperCase()}</span>
                    <span className="shell__wsitem-body">
                      <span className="shell__wsitem-name">{item.name}</span>
                      <span className="shell__wsitem-meta">{item.meta}</span>
                    </span>
                    <span className="shell__wsitem-side">
                      <span className="shell__wstag">{item.type}</span>
                      {item.role ? <span className="shell__wsrole">{item.role}</span> : null}
                    </span>
                    {item.name === selectedWorkspace.name ? <Icon name="check" size={14} /> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="shell__scroll">
          {nav.map((group, gi) => (
            <div className="shell__group" key={group.label || gi}>
              {group.label ? <p className="shell__grouplabel">{group.label}</p> : null}
              {group.items.map(it => (
                <a key={it.id} href={it.href || '#'} className="shell__link"
                  aria-current={it.id === active ? 'page' : undefined}
                  onClick={onNavigate ? (e) => { e.preventDefault(); onNavigate(it.id); setOpen(false); } : undefined}>
                  <span className="shell__linkico"><Icon name={it.icon} size={15} /></span>
                  <span className="ad-truncate">{it.label}</span>
                  {it.badge != null ? <span className="shell__badge">{it.badge}</span> : null}
                </a>
              ))}
            </div>
          ))}
        </div>
        {user ? (
          <div className="shell__foot">
            <button type="button" className="shell__user">
              <span className="avatar" aria-hidden="true">{(user.name || 'U').slice(0, 1).toUpperCase()}</span>
              <span style={{ minWidth: 0, flex: 1 }}>
                <span className="ad-truncate" style={{ display: 'block', fontSize: 13, fontWeight: 500 }}>{user.name}</span>
                <span className="ad-truncate" style={{ display: 'block', fontSize: 11, color: 'var(--ink-3)' }}>{user.email}</span>
              </span>
              <Icon name="chevronUpDown" size={14} />
            </button>
          </div>
        ) : null}
      </nav>
      <div className="shell__main">
        <header className="shell__top">
          <IconButton className="shell__burger" icon={<Icon name={open ? 'x' : 'menu'} size={17} />}
            label={open ? 'Close navigation' : 'Open navigation'} onClick={() => setOpen(!open)} />
          {topbar}
          {topbarActions ? <div className="shell__topactions">{topbarActions}</div> : null}
        </header>
        <main className={['shell__page', flush ? 'shell__page--flush' : ''].filter(Boolean).join(' ')}>{children}</main>
      </div>
    </div>
  );
}
