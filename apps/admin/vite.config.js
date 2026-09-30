import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // No source map: the console's comments describe the admin surface and its
  // guards, and a map served beside the bundle hands that to every visitor.
  // Same rule as apps/web. Set 'hidden' for local debugging only.
  build: { outDir: 'dist', sourcemap: false }
});
