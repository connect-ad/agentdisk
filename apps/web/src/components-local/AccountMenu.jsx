import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '../components/index.js';

/**
 * The account menu in the sidebar footer.
 *
 * It replaced a real `<button>` that did nothing at all. That button carried the
 * same chevron as the workspace switcher directly above it, so it read as the
 * one place personal (rather than workspace) settings would live — and clicking
 * it produced no menu, no navigation, and no feedback of any kind. Sign out
 * existed only as a link in the far corner of the top bar, which is not where
 * anybody looks for it.
 *
 * Same reasoning as WorkspaceSwitcher, and deliberately the same shape: not part
 * of the design system, because the library's `Menu` does not carry the trigger,
 * and styled only with `.wsx__*` tokens so the two controls in this footer are
 * indistinguishable from one another. Both should be upstreamed together.
 *
 * `align` decides which way it opens. It was written for the sidebar footer,
 * where the shared `.wsx__menu` would have dropped off the bottom of the
 * viewport, so "up" is still the default. The top bar passes "down".
 *
 * Actions arrive as props rather than from `useAuth()` so this stays a piece of
 * UI with one job; `App.jsx` decides what signing out means.
 */
export default function AccountMenu({ name, email, items = [], onNavigate, onSignOut, align = "up" }) {
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  const trigger = useRef(null);

  // Escape closes and hands focus back — the one dismissal that owes you the
  // trigger, because you never left it. A click elsewhere is a click *at*
  // something, so focus stays where it landed. Matched to WorkspaceSwitcher.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = e => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      if (trigger.current) trigger.current.focus();
    };
    const onPointer = e => {
      if (root.current && !root.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  const label = name || email || 'Signed in';

  return (
    <div className="wsx" ref={root}>
      <button
        type="button"
        className={align === "up" ? "shell__user" : "shell__user shell__user--bar"}
        ref={trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        /*
         * Names the control, not just the person in it.
         *
         * In the sidebar this button sat under a heading and beside a workspace
         * switcher, and "Sign out" was additionally a button of its own in the
         * top bar, so nothing had to say what the card was for. In the top bar
         * it is a bare pill whose only text is the signed-in address, and sign
         * out now lives solely behind it — leaving the name as the address alone
         * gives a screen-reader user no reason to open it, and the regression
         * suite caught exactly that.
         *
         * The visible text is a substring of this label, which is what keeps
         * voice control working: "click kernelv5…" still matches.
         */
        aria-label={`Account menu for ${label}`}
        onClick={() => setOpen(o => !o)}
      >
        <span className="avatar" aria-hidden="true">{label.slice(0, 1).toUpperCase()}</span>
        <span style={{ minWidth: 0, flex: 1 }}>
          <span className="ad-truncate" style={{ display: 'block', fontSize: 13, fontWeight: 500 }}>{label}</span>
          <span className="ad-truncate" style={{ display: 'block', fontSize: 11, color: 'var(--ink-3)' }}>{email}</span>
        </span>
        <Icon name="chevronDown" size={12} />
      </button>

      {open ? (
        <div className={`wsx__menu ${align === "up" ? "wsx__menu--up" : "wsx__menu--right"}`} role="menu" aria-label="Account">
          {/* Who you are signed in as, before what you can do about it. The
              reference opens the menu with this block and a rule under it,
              which is also the only place the address is legible: the trigger
              truncates it to fit a top bar. */}
          <div className="wsx__head">
            <div className="wsx__headname">{name}</div>
            <div className="wsx__heademail">{email}</div>
          </div>

          {items.map(item => (
            <button
              type="button"
              role="menuitem"
              key={item.label}
              className="wsx__item"
              onClick={() => { setOpen(false); onNavigate(item.to); }}
            >
              <span className="wsx__label">{item.label}</span>
            </button>
          ))}

          {/* Toned as the destructive thing it is, and last, where the
              reference puts it — not because signing out destroys anything,
              but because it is the one item that ends the session rather than
              navigating within it. */}
          <button
            type="button"
            role="menuitem"
            className="wsx__item wsx__item--danger"
            onClick={() => { setOpen(false); onSignOut(); }}
          >
            <span className="wsx__label">Sign Out</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
