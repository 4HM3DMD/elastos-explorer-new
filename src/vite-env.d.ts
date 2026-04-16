/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL: string
  readonly VITE_API_TIMEOUT: string
  readonly VITE_BACKEND_URL: string
  readonly VITE_NODE_ENV: string
  readonly VITE_EXTERNAL_API_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
