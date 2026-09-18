/**
 * The console's shared visual vocabulary.
 *
 * These are the helper functions the design file defines inside its own render
 * pass — `btn`, `pill`, `statusCell`, the table grids — lifted out so that every
 * screen builds a button or a status badge the same way. The design is the
 * source of truth for layout, structure and interaction shape; this is that
 * shape expressed once instead of twenty times.
 *
 * Everything resolves to `var(--*)`, never a literal colour. The theme toggle
 * swaps those variables and nothing here has to know it happened.
 *
 * **Colour never carries meaning alone.** Every `tone` below pairs with a word
 * in the cell beside it — `statusCell` renders a dot AND the caller renders the
 * label. A dot on its own is not a status.
 */

export const mono = { fontFamily: 'var(--mono)' };

export const label = {
  display: 'block',
  fontFamily: 'var(--mono)',
  fontSize: '9.5px',
  letterSpacing: '0.11em',
  color: 'var(--tx3)',
  marginBottom: '7px',
  textTransform: 'uppercase'
};

export const h1 = {
  margin: '0 0 5px',
  fontFamily: 'var(--fontHead)',
  fontSize: '22px',
  fontWeight: 600,
  letterSpacing: '-0.025em',
  color: 'var(--tx)'
};

export const card = {
  border: '1px solid var(--bd)',
  background: 'var(--surf)',
  borderRadius: '11px',
  overflow: 'hidden'
};

export const paneIn = { animation: 'adminPaneIn .18s ease both' };

export function btn(bg, color, border) {
  return {
    height: '32px',
    padding: '0 13px',
    borderRadius: '8px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '7px',
    fontFamily: 'var(--font)',
    fontSize: '12.5px',
    fontWeight: 600,
    background: bg,
    color,
    border: border || 'none',
    whiteSpace: 'nowrap',
    cursor: 'pointer'
  };
}

export const primaryBtn = btn('var(--acc)', 'var(--accInk)');
export const secondaryBtn = { ...btn('var(--surf)', 'var(--tx)', '1px solid var(--bd2)'), fontWeight: 500 };
export const dangerBtn = btn('var(--dngrSoft)', 'var(--dngrTx)', '1px solid var(--dngrBd)');

/** A control the current role may not use. Visible, explained, and inert. */
export const disabledBtn = {
  ...secondaryBtn,
  cursor: 'not-allowed',
  opacity: 0.5
};

export function pill(fg, bg, bd) {
  return {
    fontFamily: 'var(--mono)',
    fontSize: '9px',
    fontWeight: 600,
    letterSpacing: '0.07em',
    padding: '2px 6px',
    borderRadius: '4px',
    color: fg,
    background: bg,
    border: `1px solid ${bd}`,
    flex: '0 0 auto',
    whiteSpace: 'nowrap',
    textTransform: 'uppercase'
  };
}

export const pills = {
  ok: pill('var(--okTx)', 'var(--okSoft)', 'var(--okBd)'),
  warn: pill('var(--warnTx)', 'var(--warnSoft)', 'var(--warnBd)'),
  danger: pill('var(--dngrTx)', 'var(--dngrSoft)', 'var(--dngrBd)'),
  neutral: pill('var(--tx2)', 'var(--surf3)', 'var(--bd)'),
  accent: pill('var(--acc)', 'var(--accSoft)', 'var(--accBd)')
};

export function statusCell(tone) {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    fontSize: '12px',
    fontWeight: 500,
    color:
      tone === 'ok'
        ? 'var(--okTx)'
        : tone === 'warn'
          ? 'var(--warnTx)'
          : tone === 'danger'
            ? 'var(--dngrTx)'
            : 'var(--tx2)'
  };
}

export function statusDot(tone) {
  return {
    width: '6px',
    height: '6px',
    flex: '0 0 6px',
    // A circle for healthy, a square for everything else: the shape carries the
    // distinction for anyone who cannot separate the hues.
    borderRadius: tone === 'ok' ? '99px' : '2px',
    background:
      tone === 'ok'
        ? 'var(--ok)'
        : tone === 'warn'
          ? 'var(--warn)'
          : tone === 'danger'
            ? 'var(--dngr)'
            : 'var(--tx3)'
  };
}

/** Lifecycle and billing are two different things and never share a column. */
export function lifecycleTone(status) {
  if (status === 'active') return 'ok';
  if (status === 'suspended') return 'warn';
  if (status === 'deleted') return 'danger';
  return 'neutral';
}

export function billingTone(status) {
  if (status === 'active') return 'ok';
  if (status === 'past_due') return 'warn';
  if (status === 'canceled' || status === 'cancelled') return 'danger';
  return 'neutral';
}

export const th = {
  fontFamily: 'var(--mono)',
  fontSize: '9px',
  letterSpacing: '0.1em',
  color: 'var(--tx3)',
  textTransform: 'uppercase'
};

export const thR = { ...th, textAlign: 'right' };

/**
 * A vertical rule between columns.
 *
 * Spread into every cell of a `divided` row. The divider sits on the LEFT of
 * each cell and the first cell suppresses it, so a row never ends with a rule
 * hanging off its edge.
 *
 * Dividers need `gap: 0` on the grid - a rule floating in the middle of a 12px
 * gap reads as belonging to neither column. The padding here replaces that gap.
 */
export function cell(first = false) {
  return {
    minWidth: 0,
    padding: '0 10px',
    borderLeft: first ? 'none' : '1px solid var(--bd)',
    display: 'flex',
    alignItems: 'center'
  };
}

export function headRow(columns, divided = false) {
  return {
    display: 'grid',
    gridTemplateColumns: columns,
    gap: divided ? 0 : '12px',
    alignItems: 'center',
    padding: divided ? '0 4px' : '0 14px',
    height: '34px',
    background: 'var(--surf2)',
    borderBottom: '1px solid var(--bd)'
  };
}

export function dataRow(columns, asButton, divided = false) {
  return {
    display: 'grid',
    gridTemplateColumns: columns,
    gap: divided ? 0 : '12px',
    alignItems: 'center',
    padding: divided ? '10px 4px' : '10px 14px',
    borderBottom: '1px solid var(--bd)',
    width: '100%',
    ...(asButton
      ? {
          background: 'transparent',
          border: 'none',
          borderBottom: '1px solid var(--bd)',
          cursor: 'pointer',
          textAlign: 'left',
          fontFamily: 'var(--font)'
        }
      : {})
  };
}

export const input = {
  width: '100%',
  height: '38px',
  border: '1px solid var(--bd2)',
  borderRadius: '9px',
  background: 'var(--surf2)',
  color: 'var(--tx)',
  padding: '0 12px',
  fontSize: '13.5px',
  fontFamily: 'var(--font)'
};

export const textarea = { ...input, height: '72px', padding: '10px 12px', resize: 'vertical' };

export const ellipsis = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap'
};
