import { rows, pool } from './db.js';
import { serviceWindowUntil } from './inbox.js';
import { channelSlug } from './channels.js';
import { T } from './tables.js';

// Último mensaje recibido de ese teléfono por esta app en ese canal (la ventana de 24 h es por conversación).
export async function lastInboundAt(clientId, channelId, phone) {
  const [row] = await rows(
    `SELECT createdAt FROM ${T.message} WHERE clientId = ? AND channelId = ? AND phone = ? AND direction = 'in' ORDER BY createdAt DESC LIMIT 1`,
    [clientId, channelId, phone],
  );
  return row?.createdAt ?? null;
}

export async function windowOpen(clientId, channelId, phone) {
  const until = serviceWindowUntil(await lastInboundAt(clientId, channelId, phone));
  return Boolean(until && until > new Date());
}

// shortcut: se leen hasta 5000 mensajes y se agrupan en memoria; pasar a GROUP BY en SQL si una app
// llega a tener conversaciones de ese tamaño.
// Una conversación es (canal, teléfono). `channelId` opcional filtra por canal.
export async function listConversations(clientId, refs, channelId) {
  const params = [clientId];
  let refSql = '';
  if (refs) { refSql = ` AND ref IN (${refs.map(() => '?').join(',')})`; params.push(...refs); }
  if (channelId) { refSql += ' AND channelId = ?'; params.push(channelId); }
  const messages = await rows(
    `SELECT channelId, phone, direction, kind, template, body, status, ref, profileName, readAt, createdAt
       FROM ${T.message} WHERE clientId = ?${refSql} ORDER BY createdAt ASC LIMIT 5000`,
    params,
  );
  const byPhone = new Map();
  for (const m of messages) {
    const key = `${m.channelId ?? ''}:${m.phone}`;
    const c = byPhone.get(key) ?? { phone: m.phone, channel: channelSlug(m.channelId), ref: null, profileName: null, unread: 0, lastInboundAt: null, last: null };
    if (m.ref) c.ref = m.ref;
    if (m.profileName) c.profileName = m.profileName;
    if (m.direction === 'in') {
      c.lastInboundAt = m.createdAt;
      if (!m.readAt) c.unread += 1;
    }
    c.last = { direction: m.direction, kind: m.kind, text: m.body ?? m.template, status: m.status, at: m.createdAt };
    byPhone.set(key, c);
  }
  // Solo conversaciones: teléfonos que alguna vez escribieron.
  return [...byPhone.values()]
    .filter((c) => c.lastInboundAt)
    .map((c) => ({ ...c, windowUntil: serviceWindowUntil(c.lastInboundAt) }))
    .sort((a, b) => new Date(b.last.at) - new Date(a.last.at));
}

// Hilo completo de un teléfono para una app (plantillas y texto, entrantes y salientes), el más
// viejo primero. `refs` y `channelId` opcionales. Devuelve filas crudas (usar toApi para la API).
export async function getThread(clientId, phone, refs, channelId) {
  const params = [clientId, phone];
  let refSql = '';
  if (refs) { refSql = ` AND ref IN (${refs.map(() => '?').join(',')})`; params.push(...refs); }
  let chSql = '';
  const chParams = [];
  if (channelId !== undefined) { chSql = ' AND channelId = ?'; chParams.push(channelId); }
  const thread = await rows(`SELECT * FROM ${T.message} WHERE clientId = ? AND phone = ?${refSql}${chSql} ORDER BY createdAt ASC LIMIT 1000`, [...params, ...chParams]);
  const [last] = await rows(`SELECT MAX(createdAt) AS at FROM ${T.message} WHERE clientId = ? AND phone = ? AND direction = 'in'${chSql}`, [clientId, phone, ...chParams]);
  return {
    phone,
    profileName: [...thread].reverse().find((m) => m.profileName)?.profileName ?? null,
    windowUntil: serviceWindowUntil(last?.at ?? null),
    rows: thread,
  };
}

// Marca como leídos los entrantes de un teléfono para una app. Devuelve cuántos cambiaron.
export async function markRead(clientId, phone, refs, channelId) {
  const params = [new Date(), clientId, phone];
  let refSql = '';
  if (refs) { refSql = ` AND ref IN (${refs.map(() => '?').join(',')})`; params.push(...refs); }
  if (channelId !== undefined) { refSql += ' AND channelId = ?'; params.push(channelId); }
  const [result] = await pool.query(
    `UPDATE ${T.message} SET readAt = ? WHERE clientId = ? AND phone = ? AND direction = 'in' AND readAt IS NULL${refSql}`,
    params,
  );
  return result.affectedRows;
}
