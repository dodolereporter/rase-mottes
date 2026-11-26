import { defineConfig, type Plugin } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { resolve } from 'node:path';

// Réécrit /pad et /pad?... vers la page manette (comme le fait le serveur en prod).
const padRewrite: Plugin = {
  name: 'pad-rewrite',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url && /^\/pad(\?|$)/.test(req.url)) req.url = req.url.replace(/^\/pad/, '/pad/');
      next();
    });
  },
};

const backend = `http://127.0.0.1:${process.env.API_PORT ?? 3000}`;

export default defineConfig({
  root: resolve(__dirname, 'client'),
  publicDir: false,
  plugins: [basicSsl(), padRewrite],
  build: {
    outDir: resolve(__dirname, 'dist/public'),
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'client/index.html'),
        pad: resolve(__dirname, 'client/pad/index.html'),
      },
    },
  },
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': backend,
      '/healthz': backend,
      '/ws': { target: backend.replace('http', 'ws'), ws: true },
    },
  },
});
