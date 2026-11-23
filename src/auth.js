import crypto from 'crypto';
import { rows } from './db.js';
import { ApiError } from './errors.js';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

export const hashKey = sha256;
export const newApiKey = () => `msk_${crypto.randomBytes(24).toString('hex')}`;
export const newWebhookSecret = () => `whsec_${crypto.randomBytes(24).toString('hex')}`;

function bearer(req) {
  const header = req.get('authorization');
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  return req.get('x-api-key') || null;
}

// Cada app cliente tiene su propia llave. Se guarda solo el hash: si se pierde, se rota.
export async function requireClient(req, _res, next) {
  try {
    const key = bearer(req);
    if (!key) throw new ApiError(401, 'UNAUTHORIZED', 'Falta la llave de API (Authorization: Bearer <llave>)');
    const [client] = await rows('SELECT * FROM client WHERE apiKeyHash = ?', [hashKey(key)]);
    if (!client) throw new ApiError(401, 'UNAUTHORIZED', 'Llave de API inválida');
    if (!client.active) throw new ApiError(403, 'CLIENT_DISABLED', 'Esta app cliente está desactivada');
    req.client = client;
    next();
  } catch (err) {
    next(err);
  }
}

// Llave de administración (variable ADMIN_API_KEY): crea y gestiona apps cliente.
export function requireAdmin(req, _res, next) {
  const expected = process.env.ADMIN_API_KEY;
  if (!expected || expected.length < 24) {
    return next(new ApiError(503, 'ADMIN_DISABLED', 'ADMIN_API_KEY no está configurada (mínimo 24 caracteres)'));
  }
  const given = bearer(req) || '';
  // Comparar hashes: mismo largo siempre, tiempo constante.
  const ok = crypto.timingSafeEqual(Buffer.from(sha256(given), 'hex'), Buffer.from(sha256(expected), 'hex'));
  if (!ok) return next(new ApiError(401, 'UNAUTHORIZED', 'Llave de administración inválida'));
  next();
}
