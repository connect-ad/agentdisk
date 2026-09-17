/**
 * Tests for the staff console.
 *
 * Separate from vite.config.js so the build config stays the build config:
 * nothing here is loaded when `npm run build` runs. Same split, and the same
 * reasoning, as apps/web.
 *
 * jsdom rather than happy-dom because what is under test is focus — which
 * element `document.activeElement` is after a render, and whether it moves
 * again on the next keystroke. jsdom implements focus and blur semantics more
 * faithfully, and the bug these tests exist to prevent is invisible in an
 * environment that does not.
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./test/setup.js'],
    // `.js` as well as `.jsx`: not every test here renders a component, and a
    // pattern that silently collects nothing is how a test file gets written,
    // committed, and never run.
    include: ['test/**/*.test.{js,jsx}']
  }
});
