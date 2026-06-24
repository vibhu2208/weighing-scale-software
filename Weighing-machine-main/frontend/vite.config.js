import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const MEDIA_ROOTS = [
  path.join(projectRoot, 'uploads'),
  path.join(projectRoot, 'images'),
].map((p) => path.normalize(p));

function contentTypeFor(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    default:
      return 'application/octet-stream';
  }
}

function localMediaDevPlugin() {
  return {
    name: 'weighbridge-local-media',
    configureServer(server) {
      server.middlewares.use('/media', (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          next();
          return;
        }

        try {
          const encoded = (req.url || '').replace(/^\//, '').split('?')[0];
          if (!encoded) {
            res.statusCode = 400;
            res.end('Bad Request');
            return;
          }

          let filePath = decodeURIComponent(encoded);
          if (
            process.platform === 'win32' &&
            filePath.startsWith('/') &&
            /^\/[A-Za-z]:/.test(filePath)
          ) {
            filePath = filePath.slice(1);
          }

          if (/^(uploads|images)\//i.test(filePath)) {
            const bucket = filePath.split(/[\\/]/)[0].toLowerCase();
            const root = bucket === 'uploads' ? MEDIA_ROOTS[0] : MEDIA_ROOTS[1];
            filePath = path.normalize(
              path.join(root, ...filePath.split(/[\\/]/).slice(1)),
            );
          } else {
            filePath = path.normalize(filePath);
          }

          const allowed = MEDIA_ROOTS.some((root) => filePath.startsWith(root));
          if (!allowed) {
            res.statusCode = 403;
            res.end('Forbidden');
            return;
          }
          if (!fs.existsSync(filePath)) {
            res.statusCode = 404;
            res.end('Not Found');
            return;
          }

          res.setHeader('Content-Type', contentTypeFor(filePath));
          res.setHeader('Cache-Control', 'no-cache');
          if (req.method === 'HEAD') {
            res.statusCode = 200;
            res.end();
            return;
          }
          fs.createReadStream(filePath).pipe(res);
        } catch (err) {
          next(err);
        }
      });
    },
  };
}

export default defineConfig({
  root: __dirname,
  plugins: [react(), localMediaDevPlugin()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    strictPort: false,
    host: '127.0.0.1',
  },
  build: {
    outDir: path.resolve(__dirname, '..', 'dist', 'renderer'),
    emptyOutDir: true,
    sourcemap: true,
  },
  base: './',
});
