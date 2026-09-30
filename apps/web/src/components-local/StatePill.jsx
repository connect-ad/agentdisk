import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../components/index.js';

/**
 * A state pill that is also the row's menu — the keys table's State column
 * (design, 22 Sept 2026): "● Active ⌄" in green, "⚠ Disabled ⌄" in amber, and
 * the things you can do to the key behind the chevron. One control where
 * there used to be a status badge and a row of buttons.
 *
 * Not part of the design system: the library's `Menu` carries no trigger
 * and no positioning, the same gap `AccountMenu` and `WorkspaceSwitcher`
 * fill for themselves. What is different here is *where* the menu renders.
 * The pill sits in a table inside a `.panel`, which is `overflow:hidden`,
 * and a table inside `.tbl-scroll`, which is `overflow:auto`; a menu
 * positioned inside either is clipped on the last row, which is the one
 * nearest the bottom edge and so the one it always happens to. The menu
 * is therefore portalled to `document.body` and placed from the trigger's
 * rectangle, and closed on scroll, because a fixed box does not follow the
 * row it belongs to.
 *
 * `items` empty means the pill is a label and nothing more: no chevron, no
 * popup, a plain `<span>` rather than a button that opens nothing.
 */
export default function StatePill({ tone = 'ok', icon = 'dot', label, title, items = [], className = '' }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const trigger = useRef(null);
  const menu = useRef(null);

  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const r = trigger.current.getBoundingClientRect();
    const right = Math.max(8, window.innerWidth - r.right);
    // Below the pill, unless that would put the menu under the bottom edge —
    // the keys table is the last thing on its screen, so on a phone the pill
    // is often in the bottom quarter, and a menu that opens off-screen reads
    // as a tap that did nothing. Three items and their padding are ~130px.
    if (r.bottom + 4 + 130 > window.innerHeight && r.top > 130) {
      setPos({ bottom: window.innerHeight - r.top + 4, right });
    } else {
      setPos({ top: r.bottom + 4, right });
    }
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = e => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      if (trigger.current) trigger.current.focus();
    };
    const onPointer = e => {
      const inTrigger = trigger.current && trigger.current.contains(e.target);
      const inMenu = menu.current && menu.current.contains(e.target);
      if (!inTrigger && !inMenu) setOpen(false);
    };
    const onScroll = () => setOpen(false);
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open]);

  const cls = ['kst', `kst--${tone}`, className].filter(Boolean).join(' ');
  const mark = icon === 'dot'
    ? <span className="kst__dot" aria-hidden="true" />
    : <Icon name={icon} size={13} aria-hidden="true" />;

  if (items.length === 0) {
    return (
      <span className={cls} title={title}>
        {mark}
        <span className="kst__label">{label}</span>
        {title && title !== label ? <span className="sr-only">{`, ${title}`}</span> : null}
      </span>
    );
  }

  return (
    <>
      <button
        type="button"
        ref={trigger}
        className={cls}
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${label}${title && title !== label ? `, ${title}` : ''}. Actions`}
        onClick={e => { e.stopPropagation(); setOpen(o => !o); }}
      >
        {mark}
        <span className="kst__label">{label}</span>
        <Icon name="chevronDown" size={12} aria-hidden="true" />
      </button>
      {open && pos ? createPortal(
        <div
          ref={menu}
          className="menu kst__menu"
          role="menu"
          aria-label={`${label} key`}
          style={{ position: 'fixed', top: pos.top, bottom: pos.bottom, right: pos.right, zIndex: 'var(--z-drawer)' }}
          onClick={e => e.stopPropagation()}
        >
          {items.map(it => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              disabled={it.disabled}
              className={['menu__item', it.danger ? 'menu__item--danger' : ''].filter(Boolean).join(' ')}
              onClick={() => { setOpen(false); it.onSelect(); }}
            >
              {it.icon ? <Icon name={it.icon} size={14} aria-hidden="true" /> : null}
              <span>{it.label}</span>
            </button>
          ))}
        </div>,
        document.body
      ) : null}
    </>
  );
}
