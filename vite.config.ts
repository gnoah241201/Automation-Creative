import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

export const devWatchIgnored = ['**/temp_superpowers/**'];

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  
  // Backend URL for dev proxy. Default: http://localhost:3001
  // Can be overridden with VITE_BACKEND_URL environment variable
  const backendUrl = env.VITE_BACKEND_URL || 'http://localhost:3001';
  const devHost = env.VITE_DEV_HOST || '0.0.0.0';
  const allowedHosts = env.VITE_ALLOWED_HOSTS
    ? env.VITE_ALLOWED_HOSTS.split(',').map((host) => host.trim()).filter(Boolean)
    : undefined;
  
  return {
    plugins: [react(), tailwindcss()],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      host: devHost,
      watch: {
        ignored: devWatchIgnored,
      },
      headers: {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
      },
      allowedHosts,
      proxy: {
        '/api': {
          target: backendUrl,
          changeOrigin: true,
        },
      },
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
    },
  };
});
