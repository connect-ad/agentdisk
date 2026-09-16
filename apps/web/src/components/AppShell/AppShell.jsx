import React from 'react';
import { Icon } from '../Icon/Icon.jsx';

/**
 * The workspace shell: top bar, workspace strip, tab bar, page.
 *
 * ── Why this file diverges from the design-system mirror ──────────────────
 * `design-system/` is read-only and every other component here is byte-identical
 * to it. This one is not, and already was not: CLAUDE.md records three earlier
 * divergences awaiting the same upstream trip (backlog 015, 016, 026). The new
 * design replaces the left sidebar with a top bar and a tab bar, which is a
 * change of structure rather than of style, so it cannot be made by redefining
 * a token. This is the fourth divergence and belongs in that same trip.
 *
 * ── Tabs are links, not ARIA tabs ─────────────────────────────────────────
 * The design draws a tab bar and marks it up with role="tablist"/role="tab".
 * Rendered here as real <a href> inside a <nav> instead, because these do not
 * switch panels within a page — they change the address. Announcing them as
 * tabs would tell a screen-reader user that focus stays put while the whole
 * location changes underneath them, and role="tab" on a link suppresses the
 * link affordances the href exists to restore. `aria-current="page"` carries
 * the selected state that aria-selected would have.
 *
 * That href matters beyond semantics. Every nav entry in the old sidebar was
 * <a href="#"> driven by an onClick, so middle-click and ctrl-click opened
 * nothing, "Copy link address" yielded "#", and a screen reader announced nine
 * links to the same place. `onNavigate` still handles the plain click so
 * routing stays client-side, but it now steps aside for modified clicks.
 */

/** A click the browser should handle itself: new tab, new window, download. */
function isModifiedClick(e) {
  return e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0;
}

export function AppShell({
  nav = [], active, workspaceSlot, userSlot, infoStrip, statsBand, accountBand, topbarActions,
  children, flush = false, onNavigate, className = '', ...rest
}) {
  // The old shell grouped nav into three labelled sections down a sidebar. A
  // tab bar has no room for group labels, so the groups flatten — the order is
  // preserved, which is the part that carried meaning.
  const tabs = nav.flatMap(group => group.items || []);

  return (
    <div className={['shell', className].filter(Boolean).join(' ')} {...rest}>
      <header className="shell__top">
        <div className="shell__brand">
          {/* The reference draws the mark itself in the shell header, the same
              28px white tile the marketing header and the design-system sheet
              use. The wordmark beside it carries the accessible name, so this
              is decorative. */}
          <img className="shell__logo" src="/agentdisk-logo.png" alt="" aria-hidden="true" />
          <span className="shell__wordmark">AgentDisk</span>
        </div>

        <span className="shell__rule" aria-hidden="true" />

        {workspaceSlot ? <div className="shell__ws">{workspaceSlot}</div> : null}

        <div className="shell__topactions">
          {topbarActions}
          {userSlot}
        </div>

      </header>

      {infoStrip ? <div className="shell__strip">{infoStrip}</div> : null}

      {/*
        Layer 2 in the design: the workspace's headline figures, above the tab
        bar and therefore present on every screen rather than only the overview.
        The host supplies the content; the shell only places it.
      */}
      {statsBand ? <div className="shell__stats">{statsBand}</div> : null}

      <nav className="shell__tabs" aria-label="Workspace sections">
        <div className="shell__tablist">
          {tabs.map(it => (
            <a
              key={it.id}
              href={it.href || '#'}
              className="shell__tab"
              aria-current={it.id === active ? 'page' : undefined}
              target={it.external ? '_blank' : undefined}
              rel={it.external ? 'noreferrer' : undefined}
              onClick={onNavigate ? (e) => {
                // Let the browser own ctrl/cmd/shift/middle clicks, and let an
                // external link behave like one.
                if (isModifiedClick(e) || it.external) return;
                e.preventDefault();
                onNavigate(it.id);
              } : undefined}
            >
              <span className="shell__tabico"><Icon name={it.icon} size={15} /></span>
              <span className="ad-truncate">{it.label}</span>
              {it.badge != null ? <span className="shell__badge">{it.badge}</span> : null}
            </a>
          ))}
        </div>
      </nav>

      {/*
        The account-area return bar, which the reference places here — after
        the tab bar, before the content — and NOT in place of any layer above
        it. The workspace strip, the stats and the tabs all stay: you have not
        left the workspace, you have stepped sideways into the account that
        owns it, and the way back is this bar rather than a browser Back.

        Fourth deliberate divergence from the design-system mirror, alongside
        workspaceSlot, userSlot and the info strip.
      */}
      {accountBand ? accountBand : null}

      <main className={['shell__page', flush ? 'shell__page--flush' : ''].filter(Boolean).join(' ')}>
        {children}
      </main>
    </div>
  );
}
