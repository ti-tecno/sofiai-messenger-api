import crypto from 'crypto';
import express from 'express';
import { rows } from './db.js';
import { parseInboundMessage } from './inbox.js';
import { getMessage, insertMessage, nextStatus, updateMessage } from './messages.js';
import { notifyClient } from './outbound-webhooks.js';

const router = express.Router();

// X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(app secret, cuerpo crudo).
export function isValidSignature(rawBody, header, appSecret) {
  if (!rawBody || !header || !appSecret || !header.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest();
  const received = Buffer.from(header.slice('sha256='.length), 'hex');
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

// Apretón de manos al guardar el webhook en el panel de Meta.
router.get('/', (req, res) => {
  const token = req.query['hub.verify_token'];
  if (req.query['hub.mode'] === 'subscribe' && token && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).type('text/plain').send(String(req.query['hub.challenge']));
  }
  res.sendStatus(403);
});

async function applyStatus(status) {
  const [row] = await rows('SELECT * FROM message WHERE waMessageId = ? AND direction = \'out\'', [status.id]);
  if (!row) return;
  const updated = nextStatus(row.status, status.status);
  const changes = {};
  if (updated !== row.status) changes.status = updated;
  if (status.status === 'failed' && updated === 'failed') {
    const e = status.errors?.[0];
    changes.errorCode = e?.code ?? null;
    changes.errorMessage = String(e?.error_data?.details || e?.title || e?.message || 'Error de entrega').slice(0, 500);
  }
  if (!Object.keys(changes).length) return;
  await updateMessage(row.id, changes);
  await notifyClient(row.clientId, 'message.status', await getMessage(row.id));
}

// A qué app cliente (y ref/metadata) pertenece un mensaje entrante:
//   1. el mensaje al que contestó (context.id): exacto;
//   2. el último mensaje que se le mandó a ese teléfono.
// Sin coincidencia queda sin dueño (clientId null) y nadie lo recibe.
async function resolveInboundOwner(phone, contextWaId) {
  if (contextWaId) {
    const [sent] = await rows('SELECT clientId, ref, metadata FROM message WHERE waMessageId = ?', [contextWaId]);
    if (sent?.clientId) return sent;
  }
  const [latest] = await rows(
    "SELECT clientId, ref, metadata FROM message WHERE phone = ? AND direction = 'out' AND clientId IS NOT NULL ORDER BY createdAt DESC LIMIT 1",
    [phone],
  );
  return latest ?? { clientId: null, ref: null, metadata: null };
}

async function storeInbound(parsed) {
  const owner = await resolveInboundOwner(parsed.phone, parsed.contextWaId);
  const id = crypto.randomUUID();
  try {
    await insertMessage({
      id,
      clientId: owner.clientId,
      direction: 'in',
      kind: 'text',
      phone: parsed.phone,
      body: parsed.body,
      ref: owner.ref,
      metadata: owner.metadata == null ? null : (typeof owner.metadata === 'string' ? owner.metadata : JSON.stringify(owner.metadata)),
      status: 'received',
      waMessageId: parsed.waMessageId,
      contextWaId: parsed.contextWaId,
      msgType: parsed.msgType,
      profileName: parsed.profileName,
      createdAt: parsed.at,
    });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return null; // Meta puede entregar el mismo webhook dos veces
    throw err;
  }
  const row = await getMessage(id);
  await notifyClient(row.clientId, 'message.received', row);
  return row;
}

router.post('/', (req, res) => {
  if (!isValidSignature(req.rawBody, req.get('x-hub-signature-256'), process.env.WHATSAPP_APP_SECRET)) {
    return res.sendStatus(401);
  }
  // Responder ya: Meta reintenta hasta 7 días si tardamos o fallamos.
  res.sendStatus(200);

  const entries = Array.isArray(req.body?.entry) ? req.body.entry : [];
  (async () => {
    for (const entry of entries) {
      for (const change of entry.changes || []) {
        if (change.field !== 'messages') continue;
        const value = change.value || {};
        for (const status of value.statuses || []) await applyStatus(status);
        for (const message of value.messages || []) {
          const parsed = parseInboundMessage(message, value.contacts || []);
          if (parsed) await storeInbound(parsed);
        }
      }
    }
  })().catch((err) => console.error('[whatsapp] error procesando webhook:', err));
});

export default router;
