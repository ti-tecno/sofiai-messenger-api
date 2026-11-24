import crypto from 'crypto';
import { rows } from './db.js';
import { toApi } from './messages.js';

export function signBody(secret, body) {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}

// shortcut: reintentos solo en memoria (3 intentos); si el proceso se reinicia en medio se pierden.
// Quien necesite certeza puede reconciliar con GET /v1/messages?since=<fecha>.
const RETRY_DELAYS_MS = [0, 1000, 5000];

async function post(client, payload) {
  const body = JSON.stringify(payload);
  for (const delay of RETRY_DELAYS_MS) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      const response = await fetch(client.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Signature-256': signBody(client.webhookSecret, body),
          'User-Agent': 'sofiai-messenger-api',
        },
        body,
        signal: AbortSignal.timeout(10000),
      });
      if (response.ok) return;
      if (response.status < 500 && response.status !== 429) break; // 4xx: reintentar no sirve
    } catch { /* red caída: se reintenta */ }
  }
  console.error(`[webhook] no se pudo entregar ${payload.event} a ${client.name}`);
}

// Avisa a la app cliente (sin esperar): 'message.status' cuando Meta cambia el estado de un
// mensaje suyo y 'message.received' cuando alguien le contesta.
export async function notifyClient(clientId, event, messageRow) {
  if (!clientId) return;
  const [client] = await rows('SELECT id, name, webhookUrl, webhookSecret FROM client WHERE id = ? AND active = 1', [clientId]);
  if (!client?.webhookUrl || !client.webhookSecret) return;
  post(client, { event, createdAt: new Date().toISOString(), data: toApi(messageRow) })
    .catch((err) => console.error('[webhook] error:', err));
}
