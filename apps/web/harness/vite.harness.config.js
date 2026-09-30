// Vite config for the responsive harness: the real app, with Firebase swapped
// for a stub so the workspace shell renders without a sign-in. Never deployed.
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

function swapAuth() {
  return {
    name: 'harness-swap-auth',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer) return null;
      if (/(^|\/)auth\.jsx$/.test(source) && !importer.includes('harness')) {
        return resolve(here, 'auth-stub.jsx');
      }
      if (/(^|\/)lib\/firebase\.js$/.test(source)) return resolve(here, 'firebase-stub.js');
      return null;
    },
  };
}

export default defineConfig({
  root,
  plugins: [swapAuth(), react()],
  server: { port: 5199, strictPort: true, host: '127.0.0.1' },
  define: { 'import.meta.env.VITE_API_BASE': JSON.stringify('http://127.0.0.1:5199/__api') },
});
