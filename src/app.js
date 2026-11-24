import express from 'express';
import cors from 'cors';
import { pool } from './db.js';
import routes from './routes.js';
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

app.use('/v1', routes);
app.use('/webhooks/whatsapp', metaWebhook);
app.use((_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Ruta no encontrada' } }));
app.use(errorHandler);
