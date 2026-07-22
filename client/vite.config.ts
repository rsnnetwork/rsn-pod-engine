import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  build: {
    target: 'esnext',
    commonjsOptions: {
      // @rsn/shared is an npm-workspace package, resolved through a
      // node_modules/@rsn/shared SYMLINK to ../shared. Vite/Rollup don't
      // preserve symlinks by default, so the module ends up at its real path
      // (…/shared/dist/index.js) — outside node_modules — which the
      // commonjs plugin's default `include: [/node_modules/]` doesn't match.
      // Without this, the plugin never runs its CJS→ESM conversion on that
      // file at all, and named value imports from it (e.g. OPENINGS from
      // '@rsn/shared') fail the production build even though `tsc --noEmit`
      // and the dev server are both fine. Type-only imports never hit this
      // (they're erased before Rollup ever sees them), which is why this
      // never surfaced until the client needed a real runtime value.
      include: [/node_modules/, /[\\/]shared[\\/]dist[\\/]/],
    },
  },
  optimizeDeps: {
    exclude: ['@livekit/track-processors'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/socket.io': {
        target: 'http://localhost:3001',
        ws: true,
      },
    },
  },
});
