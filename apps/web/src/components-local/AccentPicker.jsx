import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '../components/index.js';
import { useTheme, ACCENTS } from '../lib/theme.jsx';

/**
 * The accent chooser in the top bar.
 *
 * `AgentDisk Dashboard.dc.html` ships four accents and applies the chosen one
 * over the base palette. Violet is the default and is stored as the *absence*
 * of a choice, so a reader who never opens this menu gets exactly what the
 * product shipped before it existed.
 *
 * Same dismissal contract as WorkspaceSwitcher and AccountMenu, deliberately:
 * Escape closes and hands focus back to the trigger — the one dismissal that
 * owes you the trigger, because you never left it — while a click elsewhere is
 * a click *at* something, so focus stays where it landed.
 *
 * The swatches are `menuitemradio` rather than `menuitem`: this is "pick the
 * current one out of a set", and `aria-checked` makes the selection a fact a
 * screen reader can read rather than a colour it cannot see.
 */
export default function AccentPicker() {
  const { accent, setAccent } = useTheme();
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  const trigger = useRef(null);

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

  const current = ACCENTS.find(a => a.id === accent) ?? ACCENTS[0];

  return (
    <div className="wsx shell__accent" ref={root}>
      <button
        type="button"
        ref={trigger}
        className="icon-btn icon-btn--bordered"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Accent colour: ${current.label}`}
        title={`Accent colour: ${current.label}`}
        onClick={() => setOpen(o => !o)}
      >
        <span className="accent-dot" aria-hidden="true" />
      </button>

      {open ? (
        <div className="wsx__menu wsx__menu--right" role="menu" aria-label="Accent colour">
          <div className="wsx__grouplabel">ACCENT</div>
          {ACCENTS.map(a => (
            <button
              key={a.id}
              type="button"
              role="menuitemradio"
              aria-checked={a.id === accent}
              className="wsx__item"
              onClick={() => { setAccent(a.id); setOpen(false); }}
            >
              <span className={`wsx__lead accent-swatch accent-swatch--${a.id}`} aria-hidden="true" />
              <span className="wsx__label">{a.label}</span>
              {a.id === accent ? (
                <span className="wsx__check"><Icon name="check" size={14} /></span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
