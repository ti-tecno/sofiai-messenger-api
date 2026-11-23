import express from 'express';
import cors from 'cors';
import fs from 'fs';
import http from 'http';
import https from 'https';
import { pool } from './src/db.js';
import routes from './src/routes.js';
import metaWebhook from './src/meta-webhook.js';
import { errorHandler } from './src/errors.js';

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

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const { SSL_KEY_PATH, SSL_CERT_PATH, PORT } = process.env;
  const secure = SSL_KEY_PATH && SSL_CERT_PATH && fs.existsSync(SSL_KEY_PATH) && fs.existsSync(SSL_CERT_PATH);
  const server = secure
    ? https.createServer({ key: fs.readFileSync(SSL_KEY_PATH), cert: fs.readFileSync(SSL_CERT_PATH) }, app)
    : http.createServer(app);
  server.listen(PORT, () => console.log(`Messaging API en puerto ${PORT} (${secure ? 'https' : 'http'})`));
}
