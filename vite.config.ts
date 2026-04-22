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
