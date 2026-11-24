// Backoffice del mensajero (/v1/admin/console/*, llave ADMIN_API_KEY): ver los mensajes de todas
// las apps, agrupados por app, canal y `ref` (p. ej. el evento de Eventopolis), contestar
// conversaciones y enviar plantillas en nombre de cualquier app. La página está en public/admin/
// y se sirve en /admin (pensada para usarse por túnel SSH: el servidor escucha en 127.0.0.1).
//
// Los envíos pasan por las mismas funciones que la API de las apps (src/send-handlers.js): canal
// asignado a la app, límite diario, sandbox, idempotencia y ventana de 24 h. Llevan
// metadata.origin = 'backoffice' para que la app (y este panel) sepan de dónde salieron.
import express from 'express';
import { rows, parseJson } from './db.js';
import { ApiError, wrap } from './errors.js';
import { requireAdmin } from './auth.js';
import { normalizePhone, listTemplates, WhatsAppError } from './whatsapp.js';
import { toApi } from './messages.js';
import { listConversations, getThread, markRead } from './conversations.js';
import { ensureChannels, channelBySlug, tokenFor, isChannelConfigured } from './channels.js';
import { channelFilter, messageFilters } from './queries.js';
import { sendTemplateAs, sendTextAs, sendBatchAs } from './send-handlers.js';
import { listParam, dateParam, intParam } from './validate.js';
import { sendAllowlist } from './sandbox.js';
import { templateSpec } from './templates.js';
import { T } from './tables.js';

const router = express.Router();
router.use(requireAdmin);
router.use(wrap(async (_req, _res, next) => { await ensureChannels(); next(); }));

const DAY = 24 * 3600000;
const num = (v) => Number(v ?? 0);
const STATUSES = ['sending', 'sent', 'delivered', 'read', 'failed'];

async function loadClient(id, { mustBeActive = false } = {}) {
  const [client] = await rows(`SELECT * FROM ${T.client} WHERE id = ?`, [Number(id)]);
  if (!client) throw new ApiError(404, 'NOT_FOUND', 'App cliente no encontrada');
  if (mustBeActive && !client.active) throw new ApiError(403, 'CLIENT_DISABLED', 'Esta app está desactivada: actívala para enviar en su nombre');
  return client;
}

function phoneParam(req) {
  const phone = normalizePhone(req.params.phone);
  if (!phone) throw new ApiError(400, 'VALIDATION', 'Teléfono inválido');
  return phone;
}

// Rango de fechas de los resúmenes: ?since=&until= (por defecto, los últimos 30 días).
function range(q) {
  const until = dateParam(q.until, 'until') ?? new Date(Date.now() + 60000);
  const since = dateParam(q.since, 'since') ?? new Date(until.getTime() - 30 * DAY);
  return { since, until };
}

const emptyCounts = () => ({ out: Object.fromEntries(STATUSES.map((s) => [s, 0])), outTotal: 0, in: 0, unread: 0, lastAt: null });
function addCounts(target, r) {
  if (r.direction === 'out') {
    target.out[r.status] = (target.out[r.status] ?? 0) + num(r.n);
    target.outTotal += num(r.n);
  } else {
    target.in += num(r.n);
    target.unread += num(r.unread);
  }
  if (r.lastAt && (!target.lastAt || new Date(r.lastAt) > new Date(target.lastAt))) target.lastAt = r.lastAt;
}

// GET /v1/admin/console/clients — apps con sus canales (para los selectores del panel)
router.get('/clients', wrap(async (_req, res) => {
  const [clients, links] = await Promise.all([
    rows(`SELECT id, name, webhookUrl, dailyLimit, active, createdAt FROM ${T.client} ORDER BY id`),
    rows(`SELECT clientId, channelId, isDefault FROM ${T.client_channel}`),
  ]);
  const { byId } = await ensureChannels();
  res.json({
    data: clients.map((c) => ({
      ...c,
      active: Boolean(c.active),
      channels: links.filter((l) => l.clientId === c.id && byId.has(l.channelId)).map((l) => {
        const ch = byId.get(l.channelId);
        return { slug: ch.slug, name: ch.name, displayPhone: ch.displayPhone, isDefault: Boolean(l.isDefault), configured: isChannelConfigured(ch) };
      }),
    })),
  });
}));

// GET /v1/admin/console/summary?since=&until= — totales por app y por canal, uso del límite diario
router.get('/summary', wrap(async (req, res) => {
  const { since, until } = range(req.query);
  const grouped = await rows(
    `SELECT clientId, channelId, direction, status, COUNT(*) AS n,
            SUM(direction = 'in' AND readAt IS NULL) AS unread, MAX(createdAt) AS lastAt
       FROM ${T.message} WHERE createdAt >= ? AND createdAt < ?
      GROUP BY clientId, channelId, direction, status`,
    [since, until],
  );
  const usage = await rows(
    `SELECT clientId, COUNT(*) AS n FROM ${T.message}
      WHERE direction = 'out' AND status <> 'failed' AND createdAt >= ? GROUP BY clientId`,
    [new Date(Date.now() - DAY)],
  );
  const clients = await rows(`SELECT id, name, dailyLimit, active FROM ${T.client} ORDER BY id`);
  const { list: channels } = await ensureChannels();

  const byClient = new Map(clients.map((c) => [c.id, { id: c.id, name: c.name, active: Boolean(c.active), dailyLimit: c.dailyLimit, usage24h: 0, ...emptyCounts() }]));
  const byChannel = new Map(channels.map((c) => [c.id, { slug: c.slug, name: c.name, displayPhone: c.displayPhone, configured: isChannelConfigured(c), ...emptyCounts() }]));
  const unassigned = emptyCounts(); // entrantes sin app (canal sin app por defecto)
  const totals = emptyCounts();
  for (const r of grouped) {
    addCounts(totals, r);
    if (r.clientId == null) addCounts(unassigned, r);
    else if (byClient.has(r.clientId)) addCounts(byClient.get(r.clientId), r);
    if (r.channelId != null && byChannel.has(r.channelId)) addCounts(byChannel.get(r.channelId), r);
  }
  for (const u of usage) if (byClient.has(u.clientId)) byClient.get(u.clientId).usage24h = num(u.n);
  const allow = sendAllowlist();
  res.json({
    since, until,
    sandbox: allow ? { recipients: allow.size } : null,
    totals,
    clients: [...byClient.values()],
    channels: [...byChannel.values()],
    unassigned,
  });
}));

// GET /v1/admin/console/refs?client=&since=&until= — actividad agrupada por app y ref (p. ej. "event:14").
// `label` sale de metadata.refLabel del mensaje más reciente que lo traiga (Eventopolis manda el nombre del evento).
router.get('/refs', wrap(async (req, res) => {
  const { since, until } = range(req.query);
  const where = ['ref IS NOT NULL', 'createdAt >= ?', 'createdAt < ?'];
  const params = [since, until];
  if (req.query.client !== undefined) { where.push('clientId = ?'); params.push(Number(req.query.client)); }
  const groups = await rows(
    `SELECT clientId, ref,
            SUM(direction = 'out') AS outTotal,
            SUM(direction = 'out' AND status = 'failed') AS failed,
            SUM(direction = 'out' AND status IN ('delivered','read')) AS delivered,
            SUM(direction = 'out' AND status = 'read') AS readCount,
            SUM(direction = 'in') AS inbound,
            SUM(direction = 'in' AND readAt IS NULL) AS unread,
            COUNT(DISTINCT phone) AS phones,
            MIN(createdAt) AS firstAt, MAX(createdAt) AS lastAt
       FROM ${T.message} WHERE ${where.join(' AND ')}
      GROUP BY clientId, ref ORDER BY lastAt DESC LIMIT 500`,
    params,
  );
  const labelRows = await rows(
    `SELECT clientId, ref, metadata FROM ${T.message}
      WHERE ${where.join(' AND ')} AND metadata IS NOT NULL ORDER BY createdAt DESC LIMIT 5000`,
    params,
  );
  const labels = new Map();
  for (const r of labelRows) {
    const key = `${r.clientId}|${r.ref}`;
    const label = parseJson(r.metadata)?.refLabel;
    if (!labels.has(key) && typeof label === 'string' && label.trim()) labels.set(key, label.trim().slice(0, 120));
  }
  const names = new Map((await rows(`SELECT id, name FROM ${T.client}`)).map((c) => [c.id, c.name]));
  res.json({
    since, until,
    data: groups.map((g) => ({
      clientId: g.clientId,
      clientName: names.get(g.clientId) ?? null,
      ref: g.ref,
      label: labels.get(`${g.clientId}|${g.ref}`) ?? null,
      outTotal: num(g.outTotal), failed: num(g.failed), delivered: num(g.delivered), read: num(g.readCount),
      inbound: num(g.inbound), unread: num(g.unread), phones: num(g.phones),
      firstAt: g.firstAt, lastAt: g.lastAt,
    })),
  });
}));

// GET /v1/admin/console/messages?client=<id|none>&ref=&channel=&phone=&direction=&kind=&template=&status=&since=&until=&limit=&offset=
router.get('/messages', wrap(async (req, res) => {
  const q = req.query;
  let clientId;
  if (q.client === 'none') clientId = null;
  else if (q.client !== undefined) clientId = (await loadClient(q.client)).id;
  const { where, params } = await messageFilters(q, { clientId });
  const limit = intParam(q.limit, { name: 'limit', min: 1, max: 500, fallback: 50 });
  const offset = intParam(q.offset, { name: 'offset', min: 0, max: 1e9, fallback: 0 });
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [data, [{ total }]] = await Promise.all([
    rows(`SELECT * FROM ${T.message} ${whereSql} ORDER BY createdAt DESC, id LIMIT ? OFFSET ?`, [...params, limit, offset]),
    rows(`SELECT COUNT(*) AS total FROM ${T.message} ${whereSql}`, params),
  ]);
  const names = new Map((await rows(`SELECT id, name FROM ${T.client}`)).map((c) => [c.id, c.name]));
  res.json({
    data: data.map((r) => ({ ...toApi(r), clientId: r.clientId, clientName: names.get(r.clientId) ?? null })),
    total: num(total), limit, offset,
  });
}));

// ── Conversaciones de una app ────────────────────────────────────────────────

router.get('/clients/:id/conversations', wrap(async (req, res) => {
  const client = await loadClient(req.params.id);
  const channelId = req.query.channel !== undefined ? await channelFilter(req.query.channel) : undefined;
  res.json({ data: await listConversations(client.id, listParam(req.query.ref), channelId) });
}));

router.get('/clients/:id/conversations/:phone', wrap(async (req, res) => {
  const client = await loadClient(req.params.id);
  const channelId = req.query.channel !== undefined ? await channelFilter(req.query.channel) : undefined;
  const { rows: thread, ...rest } = await getThread(client.id, phoneParam(req), listParam(req.query.ref), channelId);
  res.json({ ...rest, messages: thread.map(toApi) });
}));

router.post('/clients/:id/conversations/:phone/read', wrap(async (req, res) => {
  const client = await loadClient(req.params.id);
  const channelId = req.body?.channel !== undefined ? await channelFilter(req.body.channel) : undefined;
  res.json({ updated: await markRead(client.id, phoneParam(req), listParam(req.body?.ref), channelId) });
}));

// ── Enviar en nombre de una app ──────────────────────────────────────────────
const fromBackoffice = (input) => ({ ...input, metadata: { ...(input.metadata ?? {}), origin: 'backoffice' } });

router.post('/clients/:id/messages/template', wrap(async (req, res) => {
  await sendTemplateAs(await loadClient(req.params.id, { mustBeActive: true }), req.body, res, fromBackoffice);
}));
router.post('/clients/:id/messages/text', wrap(async (req, res) => {
  await sendTextAs(await loadClient(req.params.id, { mustBeActive: true }), req.body, res, fromBackoffice);
}));
router.post('/clients/:id/messages/template/batch', wrap(async (req, res) => {
  await sendBatchAs(await loadClient(req.params.id, { mustBeActive: true }), req.body, res, fromBackoffice);
}));

// GET /v1/admin/console/channels/:slug/templates — plantillas aprobadas de la cuenta del canal, listas para llenar
router.get('/channels/:slug/templates', wrap(async (req, res) => {
  const channel = await channelBySlug(req.params.slug);
  if (!channel) throw new ApiError(404, 'NOT_FOUND', 'Canal no encontrado');
  if (!channel.wabaId) throw new ApiError(503, 'NOT_CONFIGURED', `El canal "${channel.slug}" no tiene wabaId: no se pueden listar sus plantillas`);
  try {
    const list = await listTemplates(channel.wabaId, tokenFor(channel));
    const all = req.query.all === 'true';
    res.json({ data: list.map(templateSpec).filter((t) => all || t.status === 'APPROVED').sort((a, b) => a.name.localeCompare(b.name)) });
  } catch (err) {
    if (err instanceof WhatsAppError) throw new ApiError(502, 'META_ERROR', `Meta no devolvió las plantillas: ${err.message}`);
    throw err;
  }
}));

export default router;
