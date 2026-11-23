import { rows } from './db.js';
import { serviceWindowUntil } from './inbox.js';

// Último mensaje recibido de ese teléfono por esta app cliente (la ventana de 24 h es por conversación).
export async function lastInboundAt(clientId, phone) {
  const [row] = await rows(
    "SELECT createdAt FROM message WHERE clientId = ? AND phone = ? AND direction = 'in' ORDER BY createdAt DESC LIMIT 1",
    [clientId, phone],
  );
  return row?.createdAt ?? null;
}

export async function windowOpen(clientId, phone) {
  const until = serviceWindowUntil(await lastInboundAt(clientId, phone));
  return Boolean(until && until > new Date());
}

// shortcut: se leen hasta 5000 mensajes y se agrupan en memoria; pasar a GROUP BY en SQL si una app
// llega a tener conversaciones de ese tamaño.
export async function listConversations(clientId, refs) {
  const params = [clientId];
  let refSql = '';
  if (refs) { refSql = ` AND ref IN (${refs.map(() => '?').join(',')})`; params.push(...refs); }
  const messages = await rows(
    `SELECT phone, direction, kind, template, body, status, ref, profileName, readAt, createdAt
       FROM message WHERE clientId = ?${refSql} ORDER BY createdAt ASC LIMIT 5000`,
    params,
  );
  const byPhone = new Map();
  for (const m of messages) {
    const c = byPhone.get(m.phone) ?? { phone: m.phone, ref: null, profileName: null, unread: 0, lastInboundAt: null, last: null };
    if (m.ref) c.ref = m.ref;
    if (m.profileName) c.profileName = m.profileName;
    if (m.direction === 'in') {
      c.lastInboundAt = m.createdAt;
      if (!m.readAt) c.unread += 1;
    }
    c.last = { direction: m.direction, kind: m.kind, text: m.body ?? m.template, status: m.status, at: m.createdAt };
    byPhone.set(m.phone, c);
  }
  // Solo conversaciones: teléfonos que alguna vez escribieron.
  return [...byPhone.values()]
    .filter((c) => c.lastInboundAt)
    .map((c) => ({ ...c, windowUntil: serviceWindowUntil(c.lastInboundAt) }))
    .sort((a, b) => new Date(b.last.at) - new Date(a.last.at));
}
