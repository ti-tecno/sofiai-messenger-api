// Filtros de consulta de mensajes compartidos por la API de las apps (/v1/messages, siempre de una
// app) y por el backoffice (/v1/admin/console/messages, de cualquier app o de todas).
import { ApiError } from './errors.js';
import { normalizePhone } from './whatsapp.js';
import { channelBySlug } from './channels.js';
import { listParam, dateParam } from './validate.js';

// Slug -> id para filtrar; un slug desconocido da 400 (no una lista vacía engañosa).
export async function channelFilter(slug) {
  const channel = await channelBySlug(String(slug));
  if (!channel) throw new ApiError(400, 'VALIDATION', `channel "${slug}" no existe`);
  return channel.id;
}

// `q` = query string (channel, ref, phone, direction, kind, template, status, excludeStatus, since, until).
// `clientId`: undefined = todas las apps (solo admin); null = mensajes sin app (entrantes sin dueño).
// Devuelve { where: ['...'], params: [...] } para usar con `WHERE ${where.join(' AND ')}`.
export async function messageFilters(q, { clientId } = {}) {
  const where = [];
  const params = [];
  const add = (sql, ...values) => { where.push(sql); params.push(...values); };
  const inList = (col, list) => add(`${col} IN (${list.map(() => '?').join(',')})`, ...list);

  if (clientId === null) where.push('clientId IS NULL');
  else if (clientId !== undefined) add('clientId = ?', clientId);

  const refs = listParam(q.ref); if (refs) inList('ref', refs);
  if (q.channel !== undefined) add('channelId = ?', await channelFilter(q.channel));
  if (q.phone !== undefined) {
    const phone = normalizePhone(q.phone);
    if (!phone) throw new ApiError(400, 'VALIDATION', 'phone no es un teléfono válido');
    add('phone = ?', phone);
  }
  if (q.direction !== undefined) {
    if (!['in', 'out'].includes(q.direction)) throw new ApiError(400, 'VALIDATION', 'direction debe ser in u out');
    add('direction = ?', q.direction);
  }
  if (q.kind !== undefined) {
    if (!['template', 'text'].includes(q.kind)) throw new ApiError(400, 'VALIDATION', 'kind debe ser template o text');
    add('kind = ?', q.kind);
  }
  const templates = listParam(q.template); if (templates) inList('template', templates);
  const statuses = listParam(q.status); if (statuses) inList('status', statuses);
  const excluded = listParam(q.excludeStatus);
  if (excluded) add(`status NOT IN (${excluded.map(() => '?').join(',')})`, ...excluded);
  const since = dateParam(q.since, 'since'); if (since) add('createdAt >= ?', since);
  const until = dateParam(q.until, 'until'); if (until) add('createdAt < ?', until);
  return { where, params };
}
