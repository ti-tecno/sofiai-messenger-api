import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from './db.js';
import routes from './routes.js';
import adminConsole from './admin-console.js';
import metaWebhook from './meta-webhook.js';
import { errorHandler } from './errors.js';

export const app = express();
app.use(cors());
app.use(express.json({
  limit: '1mb',
  // La firma del webhook de Meta se calcula sobre los bytes exactos del cuerpo.
  verify: (req, _res, buf) => { if (req.originalUrl.startsWith('/webhooks/')) req.rawBody = buf; },
}));

app.get('/health', async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', uptime: process.uptime() });
  } catch {
    res.status(503).json({ status: 'db_error' });
  }
});

// Backoffice: página estática en /admin y sus datos en /v1/admin/console (llave ADMIN_API_KEY).
// Pensado para entrar por túnel SSH (HOST=127.0.0.1); ver README.
const adminDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'admin');
app.use('/admin', (_req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  });
  next();
}, express.static(adminDir, { index: 'index.html' }));
app.use('/v1/admin/console', adminConsole);
app.use('/v1', routes);
app.use('/webhooks/whatsapp', metaWebhook);
app.use((_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Ruta no encontrada' } }));
app.use(errorHandler);
