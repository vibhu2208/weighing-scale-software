import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  base: '/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: Object.fromEntries(
      [
        '/auth',
        '/reports',
        '/settings',
        '/sync',
        '/media',
        '/remote-trips',
        '/slip-reservations',
        '/admin-builder',
        '/health',
      ].map((prefix) => [
        prefix,
        {
          target: 'http://127.0.0.1:3001',
          bypass(req) {
            if (req.headers.accept?.includes('text/html')) return '/index.html';
            return undefined;
          },
        },
      ]),
    ),
  },
});
