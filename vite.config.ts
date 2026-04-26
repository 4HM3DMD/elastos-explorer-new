import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {

  // In dev mode, always proxy to the live server.
  // VITE_API_BASE_URL stays as /api/v1 (relative) so the browser calls go through this proxy.
  const proxyTarget = 'https://explorer.elastos.io'
  const isProd = mode === 'production'

  return {
    plugins: [react()],
    server: {
      port: 3001,
      host: true,
      cors: true,
      proxy: {
        '/api': {
          target: proxyTarget,
          changeOrigin: true,
          secure: false,
          ws: true,
        },
        '/ws': {
          target: proxyTarget,
          changeOrigin: true,
          secure: false,
          ws: true,
        },
      },
    },
    // In production, drop console.* and debugger statements from the
    // bundle. Keeps the 17-odd stray log/warn calls scattered across
    // pages and hooks out of end-users' DevTools (noise, perf, and
    // occasionally leaks details useful for DoS / fingerprinting).
    // Dev builds (`npm run dev`) keep them intact so we can still
    // debug locally. `console.error` is preserved — it's the one call
    // that's actually useful in production for Sentry-style capture.
    esbuild: isProd
      ? { drop: ['debugger'], pure: ['console.log', 'console.warn', 'console.info', 'console.debug'] }
      : undefined,
    build: {
      // KEEP old asset files across rebuilds. Vite's default behaviour
      // is to wipe `dist/` before each build, which strands open browser
      // sessions: a user with the previous index.html in their tab
      // tries to lazy-load `/assets/Page-OLDHASH.js`, hits 404, and
      // their app dies with "Failed to fetch dynamically imported
      // module". Frontend has a `lazyWithReload` shim that catches
      // this and reloads, but BOTH layers — keeping old assets AND the
      // reload shim — give the smoothest UX (no flash on the user's
      // side, no surprise page-reload mid-action).
      //
      // Old assets accumulate over time; prune anything older than
      // 30 days with `find dist/assets -mtime +30 -delete`. The
      // scripts/prune-old-assets.sh helper wraps that.
      emptyOutDir: false,
      rollupOptions: {
        output: {
          manualChunks: {
            'react-vendor': ['react', 'react-dom', 'react-router-dom'],
            'charts': ['recharts'],
            'icons': ['lucide-react', '@phosphor-icons/react'],
          },
        },
      },
    },
  }
})
