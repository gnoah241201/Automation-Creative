import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vite';

export const devWatchIgnored = ['**/temp_superpowers/**', '**/src-tauri/**'];

// The webview is the only client of this server: `npm run app:dev` starts it
// (tauri.conf.json -> beforeDevCommand) and Tauri points the window at it.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(path.dirname(fileURLToPath(import.meta.url)), '.'),
    },
  },
  server: {
    watch: {
      ignored: devWatchIgnored,
    },
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
    // HMR is disabled in AI Studio via DISABLE_HMR env var.
    // Do not modify—file watching is disabled to prevent flickering during agent edits.
    hmr: process.env.DISABLE_HMR !== 'true',
  },
});
