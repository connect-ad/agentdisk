/**
 * The key glyph the design draws in the reveal-key dialog's mark.
 *
 * `Icon name="key"` is a *horizontal* key on a single path whose artwork sits
 * small and left of centre inside the 24 viewBox. That is what the block's
 * `width:2rem;transform:translate(-9%,2.7%)` was compensating for: a 17px icon
 * blown up to 32px in a 36px box and nudged by percentages until it looked
 * centred. The design's key is diagonal, drawn to the edges of the same
 * viewBox and already centred, so it needs neither the upsize nor the nudge.
 *
 * Local rather than a correction to `Icon.jsx`, for three reasons: that file is
 * vendored from design-system/ and changing it would add a fourth divergence to
 * the three CLAUDE.md already tracks; the glyph is used outside these dialogs
 * (the keys table's empty state, the MCP connection page, two places on agent
 * details) and none of those asked to change; and the design file uses this
 * drawing exactly once, in the popup.
 *
 * `currentColor` rather than the design's `var(--acc)`, so the mark's tone
 * class keeps deciding the colour -- `.modal__mark--accent` sets
 * `color:var(--accent-ink)`, which is the same ink by another name and still
 * the right one if this ever sits in a danger or ok mark.
 */
import React from 'react';

export function KeyMark({ size = 17 }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="8.5" cy="14" r="4.2" />
      <path d="m11.6 11 8.4-8.4M16.4 6.2l2.4 2.4" />
    </svg>
  );
}
