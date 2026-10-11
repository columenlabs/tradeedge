import { URL, fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import viteReact from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Dev only: a Cloudflare Access service token lets the proxy reach an Access-gated API
// (e.g. a preview version). Read from the repo-root .env; never shipped in the bundle.
const accessHeaders: Record<string, string> =
  process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET
    ? {
        'CF-Access-Client-Id': process.env.CF_ACCESS_CLIENT_ID,
        'CF-Access-Client-Secret': process.env.CF_ACCESS_CLIENT_SECRET,
      }
    : {};

export default defineConfig({
  base: '/app/',
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: process.env.API_ORIGIN ?? 'http://localhost:8080',
        changeOrigin: true,
        headers: accessHeaders,
      },
    },
  },
  plugins: [viteReact(), tailwindcss()],
});
