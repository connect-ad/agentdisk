import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '../components/index.js';
import NewWorkspace from './NewWorkspace.jsx';

/**
 * The reference draws two letters in the mark — "Kessler Labs" is "KL" — which a
 * single-word name cannot supply, so it falls back to the one it has. Taken from
 * the words rather than the first two characters: "Kessler Labs" must not read
 * "KE", and the whole point of the second letter is that it names the second
 * word.
 */
function initials(name) {
  const words = String(name).trim().split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map(word => word[0].toUpperCase()).join('');
}

/**
 * The one place the product talks about which workspace you are in.
 *
 * It replaced three: an inert card in the sidebar that had a chevron and did
 * nothing, a raw `<select>` in the topbar that only appeared once you already
 * had two workspaces, and a "New workspace" button beside it. Between them they
 * managed to show the same fact twice and hide the way to act on it — the only
 * route to a second workspace sat next to a control that was invisible until
 * you had one.
 *
 * NOT part of the design system: the library has no menu that carries selection
 * state. Its `Menu` renders `role="menuitem"`, which is the right role for a
 * list of actions and the wrong one for "pick the current workspace out of a
 * set" — that is `menuitemradio` with `aria-checked`, so the tick is a fact the
 * screen reader can read rather than a glyph it cannot see. Styled with design
 * system tokens only (`.wsx__*` in app.css); should be upstreamed alongside the
 * Drawer rather than forked further.
 *
 * The trigger deliberately reuses the design system's own `.shell__wsbtn`
 * classes, because it stands exactly where AppShell's card used to and should
 * be indistinguishable from it.
 *
 * Data arrives as props rather than from `useWorkspace()` so this stays a piece
 * of UI with one job. `App.jsx` reads the context and decides what selecting
 * and creating actually mean.
 */
export default function WorkspaceSwitcher({ workspaces = [], currentId, onSelect, onCreate, compact = false }) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const root = useRef(null);
  const trigger = useRef(null);

  const current = workspaces.find(w => w.id === currentId) ?? null;
  const name = current?.name ?? 'Workspace';
  const role = current?.role ? `${current.role[0].toUpperCase()}${current.role.slice(1).toLowerCase()}` : '';

  // Escape closes and hands focus back, which is the one dismissal that owes
  // you the trigger — you never left it. A click elsewhere is a click at
  // something, so focus stays where it landed.
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

  return (
    <div className="wsx" ref={root}>
      <button
        type="button"
        className={compact ? "shell__wsbtn shell__wsbtn--bar" : "shell__wsbtn"}
        ref={trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
      >
        <span className="shell__wsmark" aria-hidden="true">{initials(name)}</span>
        <span className="shell__wsname">{name}</span>
        {role ? <span className="shell__wsmeta">{role}</span> : null}
        <Icon name="chevronDown" size={13} />
      </button>

      {open ? (
        <div className={['wsx__menu', workspaces.length >= 10 ? 'wsx__menu--scroll' : ''].filter(Boolean).join(' ')}
          role="menu" aria-label="Workspaces">
          {workspaces.map(w => (
            <button
              key={w.id}
              type="button"
              role="menuitemradio"
              aria-label={w.name}
              aria-checked={w.id === currentId}
              className="wsx__item"
              onClick={() => { setOpen(false); onSelect(w.id); }}
            >
              <span className="shell__wsmark" aria-hidden="true">{initials(w.name)}</span>
              <span className="wsx__details">
                <span className="wsx__label">{w.name}</span>
                <span className="wsx__meta">{w.id}</span>
              </span>
              <span className="wsx__tags">
                {w.role ? <span className="wsx__role">{w.role[0].toUpperCase()}{w.role.slice(1).toLowerCase()}</span> : null}
              </span>
              {w.id === currentId ? (
                <span className="wsx__check" aria-hidden="true"><Icon name="check" size={14} /></span>
              ) : null}
            </button>
          ))}

          <div className="wsx__sep" role="separator" />

          <button
            type="button"
            role="menuitem"
            className="wsx__item wsx__item--create"
            onClick={() => { setOpen(false); setCreating(true); }}
          >
            <span className="wsx__plus" aria-hidden="true"><Icon name="plus" size={14} /></span>
            <span className="wsx__label">New workspace</span>
          </button>
        </div>
      ) : null}

      <NewWorkspace open={creating} onClose={() => setCreating(false)} onCreate={onCreate} />
    </div>
  );
}
