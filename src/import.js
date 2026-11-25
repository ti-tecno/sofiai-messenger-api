// Importar historial de una app (mensajes que mandó o recibió antes de usar el mensajero, o cuyos
// estados le llegaron por otro camino). Se puede repetir: cada mensaje se busca por waMessageId y
// luego por (app, idempotencyKey); si ya existe solo avanza su estado y llena lo que le falte.
import crypto from 'crypto';
import { rows, parseJson } from './db.js';
import { normalizePhone } from './whatsapp.js';
import { insertMessage, updateMessage, nextStatus } from './messages.js';
import { T } from './tables.js';

export const MAX_IMPORT = 500;
const OUT_STATUSES = new Set(['sending', 'sent', 'delivered', 'read', 'failed']);
const str = (v, max) => (v === undefined || v === null || v === '' ? null : String(v).slice(0, max));
const date = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
};

function parse(m) {
  if (!m || typeof m !== 'object') return { error: 'No es un objeto' };
  if (m.direction !== 'in' && m.direction !== 'out') return { error: 'direction debe ser "in" u "out"' };
  const phone = normalizePhone(m.phone);
  if (!phone) return { error: 'Teléfono inválido' };
  const status = m.direction === 'in' ? 'received' : String(m.status ?? '');
  if (m.direction === 'out' && !OUT_STATUSES.has(status)) return { error: `status inválido: ${m.status}` };
  const createdAt = date(m.createdAt);
  if (!createdAt) return { error: 'createdAt inválido o ausente' };
  const readAt = date(m.readAt);
  const updatedAt = date(m.updatedAt);
  if (readAt === undefined || updatedAt === undefined) return { error: 'Fecha inválida' };
  if (m.metadata !== undefined && m.metadata !== null && (typeof m.metadata !== 'object' || Array.isArray(m.metadata))) {
    return { error: 'metadata debe ser un objeto' };
  }
  const template = str(m.template, 100);
  return {
    row: {
      direction: m.direction,
      kind: str(m.kind, 10) ?? (template ? 'template' : 'text'),
      phone,
      template,
      params: m.parameters ? JSON.stringify(m.parameters) : null,
      body: str(m.text, 65000),
      ref: str(m.ref, 100),
      metadata: m.metadata ?? {},
      idempotencyKey: str(m.idempotencyKey, 100),
      status,
      errorCode: Number.isInteger(m.errorCode) ? m.errorCode : null,
      errorMessage: str(m.errorMessage, 500),
      waMessageId: str(m.waMessageId, 128),
      contextWaId: str(m.contextWaId, 128),
      msgType: str(m.msgType, 20),
      profileName: str(m.profileName, 255),
      readAt,
      createdAt,
      updatedAt: updatedAt ?? createdAt,
    },
  };
}

async function findExisting(clientId, row) {
  if (row.waMessageId) {
    const [hit] = await rows(`SELECT * FROM ${T.message} WHERE waMessageId = ?`, [row.waMessageId]);
    if (hit) return hit;
  }
  if (row.idempotencyKey) {
    const [hit] = await rows(`SELECT * FROM ${T.message} WHERE clientId = ? AND idempotencyKey = ?`, [clientId, row.idempotencyKey]);
    if (hit) return hit;
  }
  return null;
}

// Lo que cambia en un mensaje que ya existe: estado (solo avanza), datos que le falten y llaves de
// metadata que no tenga. Nunca se pisa lo que ya guardó el mensajero.
function mergeFields(existing, row, clientId) {
  const fields = {};
  if (existing.direction === 'out') {
    const status = nextStatus(existing.status, row.status);
    if (status !== existing.status) fields.status = status;
    if (status === 'failed' && existing.errorCode == null && row.errorCode != null) {
      fields.errorCode = row.errorCode;
      fields.errorMessage = row.errorMessage;
    }
  } else if (row.readAt && !existing.readAt) {
    fields.readAt = row.readAt;
  }
  if (existing.clientId == null) fields.clientId = clientId;
  for (const k of ['waMessageId', 'ref', 'profileName', 'contextWaId', 'body', 'template', 'msgType']) {
    if (row[k] && !existing[k]) fields[k] = row[k];
  }
  const current = parseJson(existing.metadata) ?? {};
  const missing = Object.entries(row.metadata).filter(([k]) => !(k in current));
  if (missing.length) fields.metadata = JSON.stringify({ ...current, ...Object.fromEntries(missing) });
  return fields;
}

export async function importMessages(client, channel, list) {
  const summary = { inserted: 0, updated: 0, unchanged: 0, invalid: 0 };
  const errors = [];
  for (const [index, input] of list.entries()) {
    const { row, error } = parse(input);
    if (error) { summary.invalid++; errors.push({ index, reason: error }); continue; }
    const existing = await findExisting(client.id, row);
    if (existing) {
      if (existing.clientId != null && existing.clientId !== client.id) {
        summary.invalid++; errors.push({ index, reason: 'El mensaje pertenece a otra app' }); continue;
      }
      const fields = mergeFields(existing, row, client.id);
      if (Object.keys(fields).length) { await updateMessage(existing.id, fields); summary.updated++; } else summary.unchanged++;
      continue;
    }
    try {
      await insertMessage({
        ...row,
        id: crypto.randomUUID(),
        clientId: client.id,
        channelId: channel.id,
        metadata: JSON.stringify({ ...row.metadata, origin: 'import' }),
      });
      summary.inserted++;
    } catch (err) {
      if (err.code !== 'ER_DUP_ENTRY') throw err;
      summary.unchanged++; // otro proceso lo guardó al mismo tiempo
    }
  }
  return { summary, errors };
}
