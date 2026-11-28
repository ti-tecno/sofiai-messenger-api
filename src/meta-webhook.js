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

// Claves de las apps de Meta cuyos eventos se aceptan. Cada app firma sus eventos con su propia clave.
// - WHATSAPP_APP_SECRET: la app principal (la de siempre). Vale para cualquier cuenta de WhatsApp que no sea de otra app.
// - WHATSAPP_APP_SECRETS_EXTRA: apps adicionales, separadas por comas, cada una ATADA a su cuenta de WhatsApp Business:
//   "<waba_id>:<clave>". Una clave adicional solo vale para los eventos de su cuenta, y la principal ya no vale para esas
//   cuentas: así, si se filtra la clave de una app, no sirve para fabricar mensajes de los números de la otra.
//   Una entrada sin "<waba_id>:" se ignora (con aviso), para que nunca quede una clave sin atar.
// Sin la variable extra, el comportamiento es el de siempre.
export function appSecrets(env = process.env, warn = console.warn) {
  const list = env.WHATSAPP_APP_SECRET ? [{ secret: env.WHATSAPP_APP_SECRET, wabaId: null }] : [];
  for (const item of String(env.WHATSAPP_APP_SECRETS_EXTRA || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d{5,30}):(.+)$/.exec(item);
    if (m) list.push({ wabaId: m[1], secret: m[2].trim() });
    else warn('[whatsapp] WHATSAPP_APP_SECRETS_EXTRA: entrada ignorada, falta "<waba_id>:" antes de la clave');
  }
  return list;
}

// La clave (de la lista de appSecrets) con la que viene firmado el cuerpo, o null.
export const matchingSecret = (rawBody, header, secrets) => secrets.find((s) => isValidSignature(rawBody, header, s.secret)) ?? null;

// ¿Puede la app de esa clave mandar eventos de esta cuenta de WhatsApp (entry.id = waba_id)?
export function entryAllowed(entryId, matched, secrets) {
  const waba = entryId == null ? null : String(entryId);
  if (matched.wabaId) return waba === matched.wabaId;
  return !secrets.some((s) => s.wabaId && s.wabaId === waba);
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
  const secrets = appSecrets();
  const matched = matchingSecret(req.rawBody, req.get('x-hub-signature-256'), secrets);
  if (!matched) return res.sendStatus(401);
  // Responder ya: Meta reintenta hasta 7 días si tardamos o fallamos.
  res.sendStatus(200);

  const entries = Array.isArray(req.body?.entry) ? req.body.entry : [];
  (async () => {
    for (const entry of entries) {
      // Cada clave solo vale para su cuenta de WhatsApp: un evento de otra cuenta se descarta.
      if (!entryAllowed(entry?.id, matched, secrets)) {
        console.warn(`[whatsapp] evento descartado: la cuenta ${entry?.id ?? '(sin id)'} no corresponde a la app que lo firmó`);
        continue;
      }
      for (const change of entry.changes || []) {
        if (change.field !== 'messages') continue;
        const value = change.value || {};
        // El canal se identifica por el número que recibió el evento; si no es nuestro, se ignora.
        const channel = await channelByPhoneNumberId(value.metadata?.phone_number_id);
        if (!channel) {
          console.log(`[whatsapp] evento ignorado: phone_number_id desconocido (${value.metadata?.phone_number_id ?? 'ausente'})`);
          continue;
        }
        // Si el canal tiene registrada su cuenta de WhatsApp, el evento debe venir de esa misma cuenta.
        if (channel.wabaId && entry?.id != null && String(entry.id) !== String(channel.wabaId)) {
          console.warn(`[whatsapp] evento descartado: el número ${channel.slug} no pertenece a la cuenta ${entry.id}`);
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
