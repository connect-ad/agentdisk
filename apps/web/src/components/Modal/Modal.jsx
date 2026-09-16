import React, { useEffect, useRef } from 'react';
import { Icon } from '../Icon/Icon.jsx';
import { IconButton } from '../Button/IconButton.jsx';

const FOCUSABLE = 'input,select,textarea,button,[href],[tabindex]:not([tabindex="-1"])';

export function Modal({ open = true, title, description, mark, tone = 'neutral', size = 'sm', footer, onClose, children, className = '', ...rest }) {
  const ref = useRef(null);

  // `onClose` is an inline arrow at every call site, so it is a different
  // function on every render of the parent. Held in a ref it can be current
  // inside the key handler without being a dependency that re-runs an effect.
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; });

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape' && closeRef.current) closeRef.current(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // Focus moves once, when the dialog opens, which is why this depends on
  // `open` alone. With `onClose` in the dependencies it re-ran on every render,
  // and since typing re-renders the parent that holds the field's state, every
  // keystroke tore focus out of the field and put it on the close button.
  useEffect(() => {
    if (!open || !ref.current) return;
    // Not simply the first focusable: the close button leads in the DOM, so
    // "first" means a keyboard user opens a dialog with "dismiss" selected and
    // a form they have to tab into. Prefer the body, fall back to the dialog.
    const body = ref.current.querySelector('.modal__body');
    const target = (body && body.querySelector(FOCUSABLE)) || ref.current;
    target.focus();
  }, [open]);

  if (!open) return null;
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && onClose) onClose(); }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}
        className={['modal', size !== 'sm' ? 'modal--' + size : '', className].filter(Boolean).join(' ')} {...rest}>
        <header className="modal__head">
          {mark ? <div className={['modal__mark', tone !== 'neutral' ? 'modal__mark--' + tone : ''].filter(Boolean).join(' ')}>{mark}</div> : null}
          <div style={{ minWidth: 0, flex: 1 }}>
            <h2 className="modal__title">{title}</h2>
            {description ? <p className="modal__desc">{description}</p> : null}
          </div>
          {onClose ? <div className="modal__x"><IconButton icon={<Icon name="x" size={15} />} label="Close" onClick={onClose} /></div> : null}
        </header>
        {children ? <div className="modal__body">{children}</div> : null}
        {footer ? <div className="modal__foot">{footer}</div> : null}
      </div>
    </div>
  );
}
