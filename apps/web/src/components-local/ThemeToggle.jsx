import React from 'react';
import { useTheme } from '../lib/theme.jsx';

/**
 * The light/dark control in the top bar, as the design draws it.
 *
 * Not a design-system component: the library has no icon-only toggle that
 * carries state, and this one needs to say which mode it will switch *to*
 * rather than which it is in — an icon alone cannot be read either way round.
 * `aria-label` carries that; the icon is decoration.
 *
 * The sun/moon glyphs are the design's own paths.
 */
export default function ThemeToggle() {
  const { theme, toggle } = useTheme();

  // What the button does, not what is currently showing. With theme "system"
  // we cannot know from React state alone which way it will go, so the label
  // stays neutral rather than promising the wrong direction.
  const label = theme === 'dark' ? 'Switch to light mode'
    : theme === 'light' ? 'Switch to dark mode'
      : 'Switch colour mode';

  return (
    <button
      type="button"
      className="icon-btn icon-btn--bordered"
      onClick={toggle}
      aria-label={label}
      title={label}
    >
      {theme === 'dark' ? (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4.2" />
          <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4" />
        </svg>
      ) : (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
        </svg>
      )}
    </button>
  );
}
