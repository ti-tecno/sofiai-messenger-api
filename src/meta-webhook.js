import crypto from 'crypto';
import express from 'express';
import { rows } from './db.js';
import { parseInboundMessage } from './inbox.js';
import { getMessage, insertMessage, nextStatus, updateMessage } from './messages.js';
import { notifyClient } from './outbound-webhooks.js';
import { channelByPhoneNumberId } from './channels.js';
import { pickInboundOwner } from './inbound-owner.js';
import { T } from './tables.js';

const router = express.Router();

// X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(app secret, cuerpo crudo).
export function isValidSignature(rawBody, header, appSecret) {
  if (!rawBody || !header || !appSecret || !header.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest();
  const received = Buffer.from(header.slice('sha256='.length), 'hex');
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

// Claves de las apps de Meta cuyos eventos se aceptan: WHATSAPP_APP_SECRET (la principal) y, separadas por comas,
// las de WHATSAPP_APP_SECRETS_EXTRA. Hace falta más de una cuando hay números en apps de Meta distintas
// (cada app firma sus eventos con su propia clave). Sin la variable extra, el comportamiento es el de siempre.
export function appSecrets(env = process.env) {
  const extra = String(env.WHATSAPP_APP_SECRETS_EXTRA || '').split(',').map((s) => s.trim()).filter(Boolean);
  return [env.WHATSAPP_APP_SECRET, ...extra].filter(Boolean);
}

export const isValidSignatureAny = (rawBody, header, secrets) => secrets.some((s) => isValidSignature(rawBody, header, s));

// Apretón de manos al guardar el webhook en el panel de Meta.
router.get('/', (req, res) => {
  const token = req.query['hub.verify_token'];
  if (req.query['hub.mode'] === 'subscribe' && token && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).type('text/plain').send(String(req.query['hub.challenge']));
  }
  res.sendStatus(403);
});

async function applyStatus(status) {
  const [row] = await rows(`SELECT * FROM ${T.message} WHERE waMessageId = ? AND direction = 'out'`, [status.id]);
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

// A qué app cliente (y ref/metadata) pertenece un mensaje entrante, dentro del canal que lo recibió
// (ver pickInboundOwner para las reglas).
async function resolveInboundOwner(channel, phone, contextWaId) {
  let replied = null;
  if (contextWaId) {
    [replied] = await rows(`SELECT clientId, ref, metadata FROM ${T.message} WHERE waMessageId = ? AND channelId = ?`, [contextWaId, channel.id]);
  }
  const [latestOut] = await rows(
    `SELECT clientId, ref, metadata FROM ${T.message} WHERE channelId = ? AND phone = ? AND direction = 'out' AND clientId IS NOT NULL ORDER BY createdAt DESC LIMIT 1`,
    [channel.id, phone],
  );
  return pickInboundOwner({ replied, latestOut, channel });
}

async function storeInbound(channel, parsed) {
  const owner = await resolveInboundOwner(channel, parsed.phone, parsed.contextWaId);
  const id = crypto.randomUUID();
  try {
    await insertMessage({
      id,
      clientId: owner.clientId,
      channelId: channel.id,
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
  if (!isValidSignatureAny(req.rawBody, req.get('x-hub-signature-256'), appSecrets())) {
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
        // El canal se identifica por el número que recibió el evento; si no es nuestro, se ignora.
        const channel = await channelByPhoneNumberId(value.metadata?.phone_number_id);
        if (!channel) {
          console.log(`[whatsapp] evento ignorado: phone_number_id desconocido (${value.metadata?.phone_number_id ?? 'ausente'})`);
          continue;
        }
        for (const status of value.statuses || []) await applyStatus(status);
        for (const message of value.messages || []) {
          const parsed = parseInboundMessage(message, value.contacts || []);
          if (parsed) await storeInbound(channel, parsed);
        }
      }
    }
  })().catch((err) => console.error('[whatsapp] error procesando webhook:', err));
});

export default router;
