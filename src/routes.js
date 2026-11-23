import express from 'express';
import { rows, pool } from './db.js';
import { ApiError, wrap } from './errors.js';
import { requireClient, requireAdmin, hashKey, newApiKey, newWebhookSecret } from './auth.js';
import { createTemplate, isWhatsAppConfigured, normalizePhone } from './whatsapp.js';
import { sendMessage, toApi, SEND_PAUSE_MS, sleep, getMessage } from './messages.js';
import { listConversations, windowOpen } from './conversations.js';
import { parseTemplateMessage, parseTextMessage, listParam, dateParam, intParam } from './validate.js';

const router = express.Router();
const MAX_BATCH = 100;

// ── Envío ────────────────────────────────────────────────────────────────────

function requireConfigured(_req, _res, next) {
  if (!isWhatsAppConfigured()) return next(new ApiError(503, 'NOT_CONFIGURED', 'WhatsApp no está configurado en el servidor'));
  next();
}

// Traduce el resultado de sendMessage a la respuesta HTTP de un envío individual.
function respondSend(res, result) {
  const message = toApi(result.message);
  switch (result.status) {
    case 'sent': return res.status(201).json({ message });
    case 'duplicate': return res.status(200).json({ message, duplicate: true });
    case 'skipped':
      if (result.reason === 'daily_limit') throw new ApiError(429, 'DAILY_LIMIT', 'Se alcanzó el límite diario de mensajes de esta app');
      throw new ApiError(422, 'INVALID_PHONE', 'El teléfono no es válido para WhatsApp');
    default:
      return res.status(502).json({ error: { code: 'SEND_FAILED', ...message.error }, message });
  }
}

// POST /v1/messages/template — plantilla aprobada por Meta
router.post('/messages/template', requireClient, requireConfigured, wrap(async (req, res) => {
  respondSend(res, await sendMessage(req.client, parseTemplateMessage(req.body)));
}));

// POST /v1/messages/text — texto libre; solo dentro de las 24 h posteriores a que el destinatario escribió
router.post('/messages/text', requireClient, requireConfigured, wrap(async (req, res) => {
  const input = parseTextMessage(req.body);
  const phone = normalizePhone(input.to);
  if (phone && !(await windowOpen(req.client.id, phone))) {
    throw new ApiError(409, 'WINDOW_CLOSED', 'Pasaron más de 24 h desde el último mensaje del destinatario: solo se pueden enviar plantillas.');
  }
  respondSend(res, await sendMessage(req.client, input));
}));

// POST /v1/messages/template/batch — hasta 100 plantillas; secuencial, y se detiene ante errores
// que harían fallar todo (token, plantilla, pago, límite diario).
router.post('/messages/template/batch', requireClient, requireConfigured, wrap(async (req, res) => {
  const list = req.body?.messages;
  if (!Array.isArray(list) || !list.length || list.length > MAX_BATCH) {
    throw new ApiError(400, 'VALIDATION', `messages debe ser una lista de 1 a ${MAX_BATCH} mensajes`);
  }
  const inputs = list.map((item, i) => {
    try { return parseTemplateMessage(item); } catch (err) { throw new ApiError(400, 'VALIDATION', `messages[${i}]: ${err.message}`); }
  });

  const results = [];
  let aborted = null;
  for (let i = 0; i < inputs.length; i += 1) {
    if (aborted) { results.push({ index: i, status: 'not_attempted' }); continue; }
    const r = await sendMessage(req.client, inputs[i]);
    results.push({
      index: i,
      status: r.status,
      ...(r.reason ? { reason: r.reason } : {}),
      ...(r.message ? { message: toApi(r.message) } : {}),
    });
    if (r.fatal) aborted = r.message?.errorMessage ?? r.reason;
    else if (i < inputs.length - 1) await sleep(SEND_PAUSE_MS);
  }
  const count = (s) => results.filter((r) => r.status === s).length;
  res.status(aborted ? 502 : 200).json({
    summary: { sent: count('sent'), duplicate: count('duplicate'), skipped: count('skipped'), failed: count('failed'), notAttempted: count('not_attempted') },
    aborted: aborted !== null,
    ...(aborted ? { abortReason: aborted } : {}),
    results,
  });
}));

// ── Consulta ─────────────────────────────────────────────────────────────────

// GET /v1/messages?ref=&phone=&direction=&kind=&template=&status=&excludeStatus=&since=&until=&limit=&offset=
router.get('/messages', requireClient, wrap(async (req, res) => {
  const q = req.query;
  const where = ['clientId = ?'];
  const params = [req.client.id];
  const add = (sql, ...values) => { where.push(sql); params.push(...values); };
  const inList = (col, list) => add(`${col} IN (${list.map(() => '?').join(',')})`, ...list);

  const refs = listParam(q.ref); if (refs) inList('ref', refs);
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

  const limit = intParam(q.limit, { name: 'limit', min: 1, max: 1000, fallback: 50 });
  const offset = intParam(q.offset, { name: 'offset', min: 0, max: 1e9, fallback: 0 });
  const data = await rows(
    `SELECT * FROM message WHERE ${where.join(' AND ')} ORDER BY createdAt DESC, id LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  res.json({ data: data.map(toApi), limit, offset });
}));

router.get('/messages/:id', requireClient, wrap(async (req, res) => {
  const row = await getMessage(req.params.id);
  if (!row || row.clientId !== req.client.id) throw new ApiError(404, 'NOT_FOUND', 'Mensaje no encontrado');
  res.json({ message: toApi(row) });
}));

// ── Conversaciones (lo que contestan los destinatarios) ──────────────────────

// GET /v1/conversations?ref=
router.get('/conversations', requireClient, wrap(async (req, res) => {
  res.json({ data: await listConversations(req.client.id, listParam(req.query.ref)) });
}));

// GET /v1/conversations/unread?ref=a&ref=b — mensajes recibidos sin leer (sin ref: todos los de la app)
router.get('/conversations/unread', requireClient, wrap(async (req, res) => {
  const refs = listParam(req.query.ref);
  const params = [req.client.id];
  let refSql = '';
  if (refs) { refSql = ` AND ref IN (${refs.map(() => '?').join(',')})`; params.push(...refs); }
  const [{ total }] = await rows(`SELECT COUNT(*) AS total FROM message WHERE clientId = ? AND direction = 'in' AND readAt IS NULL${refSql}`, params);
  res.json({ unread: Number(total) });
}));

function phoneParam(req) {
  const phone = normalizePhone(req.params.phone);
  if (!phone) throw new ApiError(400, 'VALIDATION', 'Teléfono inválido');
  return phone;
}

// GET /v1/conversations/:phone?ref= — hilo completo, el más viejo primero
router.get('/conversations/:phone', requireClient, wrap(async (req, res) => {
  const phone = phoneParam(req);
  const refs = listParam(req.query.ref);
  const params = [req.client.id, phone];
  let refSql = '';
  if (refs) { refSql = ` AND ref IN (${refs.map(() => '?').join(',')})`; params.push(...refs); }
  const thread = await rows(`SELECT * FROM message WHERE clientId = ? AND phone = ?${refSql} ORDER BY createdAt ASC LIMIT 1000`, params);
  const [last] = await rows("SELECT MAX(createdAt) AS at FROM message WHERE clientId = ? AND phone = ? AND direction = 'in'", [req.client.id, phone]);
  res.json({
    phone,
    profileName: [...thread].reverse().find((m) => m.profileName)?.profileName ?? null,
    windowUntil: last?.at ? new Date(new Date(last.at).getTime() + 24 * 3600000) : null,
    messages: thread.map(toApi),
  });
}));

// POST /v1/conversations/:phone/read — body opcional { ref }
router.post('/conversations/:phone/read', requireClient, wrap(async (req, res) => {
  const phone = phoneParam(req);
  const refs = listParam(req.body?.ref);
  const params = [new Date(), req.client.id, phone];
  let refSql = '';
  if (refs) { refSql = ` AND ref IN (${refs.map(() => '?').join(',')})`; params.push(...refs); }
  const [result] = await pool.query(
    `UPDATE message SET readAt = ? WHERE clientId = ? AND phone = ? AND direction = 'in' AND readAt IS NULL${refSql}`,
    params,
  );
  res.json({ updated: result.affectedRows });
}));

// GET /v1/me — quién soy y cómo está configurada mi app (sirve para probar la llave)
router.get('/me', requireClient, (req, res) => {
  const c = req.client;
  res.json({
    client: { id: c.id, name: c.name, webhookUrl: c.webhookUrl, dailyLimit: c.dailyLimit },
    whatsappConfigured: isWhatsAppConfigured(),
  });
});

// ── Administración (ADMIN_API_KEY) ───────────────────────────────────────────

const publicClient = (c) => ({
  id: c.id, name: c.name, webhookUrl: c.webhookUrl, dailyLimit: c.dailyLimit, active: Boolean(c.active),
  createdAt: c.createdAt, updatedAt: c.updatedAt,
});

function clientFields(body, { creating }) {
  const out = {};
  if (body.name !== undefined || creating) {
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 100) throw new ApiError(400, 'VALIDATION', 'name es requerido (máx. 100 caracteres)');
    out.name = body.name.trim();
  }
  if (body.webhookUrl !== undefined) {
    if (body.webhookUrl !== null && !/^https?:\/\/\S{3,490}$/.test(body.webhookUrl)) throw new ApiError(400, 'VALIDATION', 'webhookUrl debe ser una URL http(s) o null');
    out.webhookUrl = body.webhookUrl;
  }
  if (body.dailyLimit !== undefined) {
    if (body.dailyLimit !== null && !(Number.isInteger(body.dailyLimit) && body.dailyLimit > 0)) throw new ApiError(400, 'VALIDATION', 'dailyLimit debe ser un entero positivo o null (sin límite)');
    out.dailyLimit = body.dailyLimit;
  }
  if (body.active !== undefined) {
    if (typeof body.active !== 'boolean') throw new ApiError(400, 'VALIDATION', 'active debe ser true o false');
    out.active = body.active ? 1 : 0;
  }
  return out;
}

// POST /v1/admin/clients — la llave de API se muestra UNA vez
router.post('/admin/clients', requireAdmin, wrap(async (req, res) => {
  const fields = clientFields(req.body ?? {}, { creating: true });
  const apiKey = newApiKey();
  const webhookSecret = newWebhookSecret();
  const now = new Date();
  const [result] = await pool.query(
    'INSERT INTO client (name, apiKeyHash, webhookUrl, webhookSecret, dailyLimit, active, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?)',
    [fields.name, hashKey(apiKey), fields.webhookUrl ?? null, webhookSecret, fields.dailyLimit ?? null, fields.active ?? 1, now, now],
  );
  const [client] = await rows('SELECT * FROM client WHERE id = ?', [result.insertId]);
  res.status(201).json({ client: publicClient(client), apiKey, webhookSecret });
}));

router.get('/admin/clients', requireAdmin, wrap(async (_req, res) => {
  res.json({ data: (await rows('SELECT * FROM client ORDER BY id')).map(publicClient) });
}));

// PATCH /v1/admin/clients/:id — { name?, webhookUrl?, dailyLimit?, active?, rotateKey?, rotateWebhookSecret? }
router.patch('/admin/clients/:id', requireAdmin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const [existing] = await rows('SELECT * FROM client WHERE id = ?', [id]);
  if (!existing) throw new ApiError(404, 'NOT_FOUND', 'App cliente no encontrada');

  const fields = clientFields(req.body ?? {}, { creating: false });
  const secrets = {};
  if (req.body?.rotateKey === true) { secrets.apiKey = newApiKey(); fields.apiKeyHash = hashKey(secrets.apiKey); }
  if (req.body?.rotateWebhookSecret === true) { secrets.webhookSecret = newWebhookSecret(); fields.webhookSecret = secrets.webhookSecret; }
  if (!Object.keys(fields).length) throw new ApiError(400, 'VALIDATION', 'No se indicó nada que cambiar');

  fields.updatedAt = new Date();
  await pool.query(`UPDATE client SET ${Object.keys(fields).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...Object.values(fields), id]);
  const [client] = await rows('SELECT * FROM client WHERE id = ?', [id]);
  res.json({ client: publicClient(client), ...secrets });
}));

// POST /v1/admin/templates — crea una plantilla en la cuenta de WhatsApp Business (Meta la revisa)
router.post('/admin/templates', requireAdmin, requireConfigured, wrap(async (req, res) => {
  const waba = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
  if (!waba) throw new ApiError(503, 'NOT_CONFIGURED', 'Falta WHATSAPP_BUSINESS_ACCOUNT_ID');
  if (!req.body || typeof req.body.name !== 'string' || !Array.isArray(req.body.components)) {
    throw new ApiError(400, 'VALIDATION', 'Se espera la definición de plantilla de Meta: { name, language, category, components }');
  }
  res.status(201).json(await createTemplate(waba, req.body));
}));

export default router;
