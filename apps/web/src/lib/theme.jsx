import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

/**
 * Light/dark, as the design's top bar specifies.
 *
 * Three states, not two. "system" is the default and is not the same as
 * picking light: it follows the reader's OS setting and keeps following it if
 * they change it. Choosing light or dark stamps `data-theme` on <html>, which
 * `styles.css` reads, and that choice outranks the media query in both
 * directions.
 *
 * Persisted per browser in localStorage. It is a display preference, not
 * account state — syncing it to the API would mean a write on every toggle and
 * a read before first paint, for something the browser can answer instantly.
 *
 * Every storage access is wrapped: Safari in private mode throws on
 * localStorage rather than returning null, and a theme control is not worth a
 * blank page.
 */

const KEY = 'agentdisk:theme';
const ACCENT_KEY = 'agentdisk:accent';

/**
 * The four accents AgentDisk Dashboard.dc.html ships.
 *
 * Violet is the design's default and what the product shipped before the
 * picker existed, so it is stored as the absence of a choice: no attribute on
 * <html>, no localStorage key. That keeps an unchosen accent identical to the
 * old behaviour rather than merely equivalent to it.
 */
export const ACCENTS = [
  { id: 'violet', label: 'Violet' },
  { id: 'indigo', label: 'Indigo' },
  { id: 'teal', label: 'Teal' },
  { id: 'blue', label: 'Blue' },
];
const ACCENT_IDS = ACCENTS.map(a => a.id);
const ThemeContext = createContext(null);

function read() {
  try {
    const v = localStorage.getItem(KEY);
    // No stored choice means dark, not "follow the OS".
    //
    // This followed prefers-color-scheme at first, on the reasoning that the
    // prototype's colourMode default was a canvas preview setting. It is not:
    // every mockup in the design is dark, and a reader on a light OS was
    // getting the light palette and reading it as the old theme still being
    // live. The design's default is the product's default.
    //
    // Light is still one click away in the top bar, and an explicit choice
    // still wins over everything.
    return v === 'light' || v === 'dark' ? v : 'dark';
  } catch {
    return 'system';
  }
}

function write(value) {
  try {
    if (value === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, value);
  } catch {
    /* Private mode, or site data blocked. The choice just will not persist. */
  }
}

/** Reflect the choice onto <html> so the CSS can see it. */
function apply(value) {
  const root = document.documentElement;
  if (value === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', value);
}

function readAccent() {
  try {
    const v = localStorage.getItem(ACCENT_KEY);
    return ACCENT_IDS.includes(v) ? v : 'violet';
  } catch {
    return 'violet';
  }
}

function writeAccent(value) {
  try {
    if (value === 'violet') localStorage.removeItem(ACCENT_KEY);
    else localStorage.setItem(ACCENT_KEY, value);
  } catch {
    /* Private mode, or site data blocked. The choice will not persist. */
  }
}

function applyAccent(value) {
  const root = document.documentElement;
  if (value === 'violet') root.removeAttribute('data-accent');
  else root.setAttribute('data-accent', value);
}

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(read);
  const [accent, setAccent] = useState(readAccent);

  useEffect(() => { apply(theme); }, [theme]);
  useEffect(() => { applyAccent(accent); }, [accent]);

  const choose = useCallback(value => {
    setTheme(value);
    write(value);
  }, []);

  /**
   * What the toggle flips to. From "system" it resolves what the OS is
   * currently showing and picks the opposite, so the first click always
   * visibly changes something — which is not true if "system" is treated as
   * light on a dark machine.
   */
  const toggle = useCallback(() => {
    setTheme(current => {
      let effective = current;
      if (current === 'system') {
        const prefersDark = typeof window.matchMedia === 'function'
          && window.matchMedia('(prefers-color-scheme: dark)').matches;
        effective = prefersDark ? 'dark' : 'light';
      }
      const next = effective === 'dark' ? 'light' : 'dark';
      write(next);
      return next;
    });
  }, []);

  const chooseAccent = useCallback(value => {
    if (!ACCENT_IDS.includes(value)) return;
    setAccent(value);
    writeAccent(value);
  }, []);

  const value = useMemo(
    () => ({ theme, setTheme: choose, toggle, accent, setAccent: chooseAccent }),
    [theme, choose, toggle, accent, chooseAccent]
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  // Screens outside the provider (the marketing pages) still render; they just
  // follow the system setting with no control to change it.
  return ctx ?? { theme: 'system', setTheme: () => {}, toggle: () => {}, accent: 'violet', setAccent: () => {} };
}
