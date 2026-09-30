import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// The dev proxy sends /api to the NestJS backend so the browser stays same-origin
// (cookies + no CORS in dev). Flip VITE_USE_MOCKS=false once the API is running.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_API_ORIGIN ?? 'http://localhost:4000',
        changeOrigin: true,
        // Adds X-Forwarded-For. Without it every browser reaches the API from the
        // proxy's own address; run the API with TRUST_PROXY=1 to use it.
        xfwd: true,
      },
    },
  },
});
