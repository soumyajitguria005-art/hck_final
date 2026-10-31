import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { createExpressApp } from './server/app.js';
import { PORT, HOST, ROOT_DIR } from './server/config.js';

async function startServer() {
  const app = createExpressApp();
  const isProduction = process.env.NODE_ENV === 'production';

  if (isProduction) {
    const distDir = path.join(ROOT_DIR, 'dist');
    app.use(express.static(distDir));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api')) {
        return next();
      }
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
      root: ROOT_DIR,
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, HOST, () => {
    console.log(`CIT Campus Scheduling server running at http://${HOST}:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
