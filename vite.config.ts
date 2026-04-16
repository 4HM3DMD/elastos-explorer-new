import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(() => {

  // In dev mode, always proxy to the live server.
  // VITE_API_BASE_URL stays as /api/v1 (relative) so the browser calls go through this proxy.
  const proxyTarget = 'https://explorer.elastos.io'

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
