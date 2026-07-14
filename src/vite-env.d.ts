/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GOOGLE_OAUTH_CLIENT_ID?: string;
  readonly VITE_GOOGLE_WORKSPACE_DOMAIN?: string;
  readonly VITE_BACKEND_URL?: string;
  readonly VITE_DEV_HOST?: string;
  readonly VITE_ALLOWED_HOSTS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}