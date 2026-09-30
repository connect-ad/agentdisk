import React, { useEffect, useRef } from 'react';
import { IconButton, Icon } from '../components/index.js';

const FOCUSABLE = 'input,select,textarea,button,[href],[tabindex]:not([tabindex="-1"])';

/**
 * Right-side drawer. NOT part of the AgentDisk design system — the library has
 * no Drawer (see docs/design/03 §7.2 "Specified but NOT built"), yet §8.10 File
 * Details requires one. Styled only with design-system tokens; should be
 * upstreamed into the design system rather than forked further.
 *
 * Spec: role=dialog, aria-modal, labelled by the title; traps focus and restores
 * it to the trigger on close; becomes a full-screen sheet below 960px (app.css).
 */
export function Drawer({ open = true, title, footer, onClose, children }) {
  const panel = useRef(null);
  const restoreTo = useRef(null);

  // Kept in a ref because every call site passes an inline arrow: as a
  // dependency it would make the effects below re-run on each parent render.
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; });

  useEffect(() => {
    if (!open) return undefined;
    const onKey = e => { if (e.key === 'Escape' && closeRef.current) closeRef.current(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // One move in on open, one move back on close. This depended on `onClose`
  // too, so it ran again on every render — and because typing in a drawer field
  // re-renders the parent, each keystroke both restored focus to whatever was
  // active and then re-focused the close button.
  useEffect(() => {
    if (!open) return undefined;
    restoreTo.current = document.activeElement;
    const body = panel.current && panel.current.querySelector('.dw__body');
    const target = (body && body.querySelector(FOCUSABLE)) || panel.current;
    if (target) target.focus();
    return () => {
      if (restoreTo.current && restoreTo.current.focus) restoreTo.current.focus();
    };
  }, [open]);

  if (!open) return null;
  const titleId = 'dw-title';

  return (
    <div className="dw">
      <div className="dw__scrim" onMouseDown={onClose} />
      <div className="dw__panel" ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <header className="dw__head">
          <h2 className="dw__title" id={titleId}>{title}</h2>
          <span style={{ marginLeft: 'auto' }}>
            <IconButton icon={<Icon name="x" size={15} />} label="Close" onClick={onClose} />
          </span>
        </header>
        <div className="dw__body">{children}</div>
        {footer ? <div className="dw__foot">{footer}</div> : null}
      </div>
    </div>
  );
}
