import crypto from 'crypto';
import { rows, parseJson, pool } from './db.js';
import { sendTemplate, sendText, normalizePhone, WhatsAppError } from './whatsapp.js';
import { describeWhatsAppError } from './inbox.js';
import { channelSlug, tokenFor } from './channels.js';
import { isRecipientAllowed } from './sandbox.js';
import { T } from './tables.js';

// ~20 msg/s, muy por debajo de los 80 msg/s por número de la Cloud API.
export const SEND_PAUSE_MS = 50;
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Tras estos errores todo el resto de un lote fallaría igual (token, plantilla, pago).
const FATAL_CODES = new Set([190, 131042, 131031, 132001, 132000, 132012]);
const isFatal = (err) => err instanceof WhatsAppError && (err.status === 503 || err.status === 401 || FATAL_CODES.has(err.code));

export function toApi(r) {
  if (!r) return null;
  return {
    id: r.id,
    direction: r.direction,
    kind: r.kind,
    channel: channelSlug(r.channelId),
    phone: r.phone,
    template: r.template ?? null,
    parameters: parseJson(r.params),
    text: r.body ?? null,
    ref: r.ref ?? null,
    metadata: parseJson(r.metadata),
    idempotencyKey: r.idempotencyKey ?? null,
    status: r.status,
    waMessageId: r.waMessageId ?? null,
    contextWaId: r.contextWaId ?? null,
    error: r.status === 'failed'
      ? { code: r.errorCode, message: r.errorMessage, ...describeWhatsAppError(r.errorCode, r.errorMessage) }
      : null,
    msgType: r.msgType ?? null,
    profileName: r.profileName ?? null,
    readAt: r.readAt ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export async function updateMessage(id, fields) {
  const entries = Object.entries({ ...fields, updatedAt: new Date() });
  await pool.query(`UPDATE ${T.message} SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`, [...entries.map(([, v]) => v), id]);
}

export async function insertMessage(r) {
  const now = new Date();
  const row = { createdAt: now, updatedAt: now, ...r };
  const keys = Object.keys(row);
  await pool.query(`INSERT INTO ${T.message} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, keys.map((k) => row[k]));
  return row;
}

export const getMessage = async (id) => (await rows(`SELECT * FROM ${T.message} WHERE id = ?`, [id]))[0] ?? null;

async function dailyLimitReached(client) {
  if (!client.dailyLimit) return false;
  const [{ total }] = await rows(
    `SELECT COUNT(*) AS total FROM ${T.message}
      WHERE clientId = ? AND direction = 'out' AND status <> 'failed' AND createdAt >= ?`,
    [client.id, new Date(Date.now() - 24 * 3600000)],
  );
  return Number(total) >= client.dailyLimit;
}

// Mensaje de la API con los datos del intento de envío (no se guardan): en un fallo,
// error.retryable (bool) y error.httpStatus (status HTTP de Meta, o null).
export function toApiResult(r) {
  const message = toApi(r.message);
  if (r.status === 'failed' && message.error) {
    message.error = { ...message.error, retryable: r.retryable ?? false, httpStatus: r.httpStatus ?? null };
  }
  return message;
}

// Envía un mensaje (kind 'template' | 'text') en nombre de `client`. Nunca lanza por problemas
// del destinatario; devuelve { status, message?, reason?, fatal? }:
//   sent · duplicate (misma idempotencyKey) · failed · skipped (reason: invalid_phone | not_allowed | daily_limit)
// Se guarda el renglón ANTES de llamar a Meta: la llave única de idempotencia hace que reintentar
// la misma petición (incluso desde otro proceso) nunca mande dos veces el mismo mensaje.
export async function sendMessage(client, channel, { kind, to, template, language, parameters, text, ref, metadata, idempotencyKey }) {
  const phone = normalizePhone(to);
  if (!phone) return { status: 'skipped', reason: 'invalid_phone' };
  // Modo sandbox (SEND_ALLOWLIST): se rechaza ANTES de guardar o llamar a Meta.
  if (!isRecipientAllowed(phone)) return { status: 'skipped', reason: 'not_allowed' };

  // Repetir una petición ya hecha devuelve el mismo mensaje, incluso con el límite diario agotado.
  if (idempotencyKey) {
    const [existing] = await rows(`SELECT * FROM ${T.message} WHERE clientId = ? AND idempotencyKey = ?`, [client.id, idempotencyKey]);
    if (existing) return { status: 'duplicate', message: existing };
  }
  if (await dailyLimitReached(client)) return { status: 'skipped', reason: 'daily_limit', fatal: true };

  const id = crypto.randomUUID();
  try {
    await insertMessage({
      id,
      clientId: client.id,
      channelId: channel.id,
      direction: 'out',
      kind,
      phone,
      template: kind === 'template' ? template : null,
      params: kind === 'template' ? JSON.stringify({ language, ...parameters }) : null,
      body: kind === 'text' ? text : null,
      ref: ref ?? null,
      metadata: metadata ? JSON.stringify(metadata) : null,
      idempotencyKey: idempotencyKey ?? null,
      status: 'sending',
    });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY' && idempotencyKey) {
      const [existing] = await rows(`SELECT * FROM ${T.message} WHERE clientId = ? AND idempotencyKey = ?`, [client.id, idempotencyKey]);
      if (existing) return { status: 'duplicate', message: existing };
    }
    throw err;
  }

  const waChannel = { phoneNumberId: channel.phoneNumberId, token: tokenFor(channel) };
  try {
    const { messageId } = kind === 'template'
      ? await sendTemplate({ channel: waChannel, to: phone, template, language, parameters })
      : await sendText({ channel: waChannel, to: phone, text });
    await updateMessage(id, { status: 'sent', waMessageId: messageId });
    return { status: 'sent', message: await getMessage(id) };
  } catch (err) {
    const fatal = isFatal(err);
    const retryable = err instanceof WhatsAppError && err.retryable;
    await updateMessage(id, {
      status: 'failed',
      errorCode: err.code ?? null,
      errorMessage: String(err.message).slice(0, 500),
      // Libera la llave para poder reintentar la misma petición más tarde.
      ...(retryable || fatal ? { idempotencyKey: null } : {}),
    });
    // retryable = la misma decisión que libera la llave: el cliente puede reintentar con la misma idempotencyKey.
    return {
      status: 'failed',
      fatal,
      retryable: retryable || fatal,
      httpStatus: err instanceof WhatsAppError ? err.status : null,
      message: await getMessage(id),
    };
  }
}

const STATUS_RANK = { sending: 0, sent: 1, delivered: 2, read: 3 };

// Los estados de Meta pueden llegar desordenados o repetidos: solo se avanza.
export function nextStatus(current, incoming) {
  if (incoming === 'failed') return current === 'delivered' || current === 'read' ? current : 'failed';
  if (!(incoming in STATUS_RANK)) return current;
  if (current === 'failed') return incoming; // un éxito posterior gana a un fallo previo
  return (STATUS_RANK[incoming] ?? -1) > (STATUS_RANK[current] ?? -1) ? incoming : current;
}
