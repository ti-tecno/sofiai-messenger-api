import express from 'express';
import { rows, pool } from './db.js';
import { ApiError, wrap } from './errors.js';
import { requireClient, requireAdmin, hashKey, newApiKey, newWebhookSecret } from './auth.js';
import { createTemplate, normalizePhone } from './whatsapp.js';
import { toApi, getMessage } from './messages.js';
import { listConversations, getThread, markRead } from './conversations.js';
import { channelFilter, messageFilters } from './queries.js';
import { sendTemplateAs, sendTextAs, sendBatchAs } from './send-handlers.js';
import {
  ensureChannels, invalidateChannels, channelBySlug, clientChannels, isChannelConfigured, tokenFor,
} from './channels.js';
import { isSandbox } from './sandbox.js';
import { listParam, intParam } from './validate.js';
import { T } from './tables.js';

const router = express.Router();

// toApi necesita el mapa de canales cargado (id -> slug).
router.use(wrap(async (_req, _res, next) => { await ensureChannels(); next(); }));

// ── Envío ────────────────────────────────────────────────────────────────────

// POST /v1/messages/template — plantilla aprobada por Meta
router.post('/messages/template', requireClient, wrap((req, res) => sendTemplateAs(req.client, req.body, res)));

// POST /v1/messages/text — texto libre; solo dentro de las 24 h posteriores a que el destinatario escribió
router.post('/messages/text', requireClient, wrap((req, res) => sendTextAs(req.client, req.body, res)));

// POST /v1/messages/template/batch — hasta 100 plantillas; secuencial, y se detiene ante errores
// que harían fallar todo (token, plantilla, pago, límite diario).
router.post('/messages/template/batch', requireClient, wrap((req, res) => sendBatchAs(req.client, req.body, res)));

// ── Consulta ─────────────────────────────────────────────────────────────────

// GET /v1/messages?channel=&ref=&phone=&direction=&kind=&template=&status=&excludeStatus=&since=&until=&limit=&offset=
router.get('/messages', requireClient, wrap(async (req, res) => {
  const q = req.query;
  const { where, params } = await messageFilters(q, { clientId: req.client.id });

  const limit = intParam(q.limit, { name: 'limit', min: 1, max: 1000, fallback: 50 });
  const offset = intParam(q.offset, { name: 'offset', min: 0, max: 1e9, fallback: 0 });
  const data = await rows(
    `SELECT * FROM ${T.message} WHERE ${where.join(' AND ')} ORDER BY createdAt DESC, id LIMIT ? OFFSET ?`,
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
  const channelId = req.query.channel !== undefined ? await channelFilter(req.query.channel) : undefined;
  res.json({ data: await listConversations(req.client.id, listParam(req.query.ref), channelId) });
}));

// GET /v1/conversations/unread?ref=a&ref=b — mensajes recibidos sin leer (sin ref: todos los de la app)
router.get('/conversations/unread', requireClient, wrap(async (req, res) => {
  const refs = listParam(req.query.ref);
  const params = [req.client.id];
  let refSql = '';
  if (refs) { refSql = ` AND ref IN (${refs.map(() => '?').join(',')})`; params.push(...refs); }
  if (req.query.channel !== undefined) { refSql += ' AND channelId = ?'; params.push(await channelFilter(req.query.channel)); }
  const [{ total }] = await rows(`SELECT COUNT(*) AS total FROM ${T.message} WHERE clientId = ? AND direction = 'in' AND readAt IS NULL${refSql}`, params);
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
  const channelId = req.query.channel !== undefined ? await channelFilter(req.query.channel) : undefined;
  const { rows: thread, ...rest } = await getThread(req.client.id, phone, listParam(req.query.ref), channelId);
  res.json({ ...rest, messages: thread.map(toApi) });
}));

// POST /v1/conversations/:phone/read — body opcional { ref }
router.post('/conversations/:phone/read', requireClient, wrap(async (req, res) => {
  const phone = phoneParam(req);
  const channelId = req.body?.channel !== undefined ? await channelFilter(req.body.channel) : undefined;
  res.json({ updated: await markRead(req.client.id, phone, listParam(req.body?.ref), channelId) });
}));

// GET /v1/me — quién soy y cómo está configurada mi app (sirve para probar la llave)
router.get('/me', requireClient, wrap(async (req, res) => {
  const c = req.client;
  const channels = await clientChannels(c.id);
  res.json({
    client: { id: c.id, name: c.name, webhookUrl: c.webhookUrl, dailyLimit: c.dailyLimit },
    channels: channels.map((ch) => ({ slug: ch.slug, name: ch.name, displayPhone: ch.displayPhone, isDefault: ch.isDefault })),
    whatsappConfigured: channels.some(isChannelConfigured),
    sandbox: isSandbox(),
  });
}));

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
    `INSERT INTO ${T.client} (name, apiKeyHash, webhookUrl, webhookSecret, dailyLimit, active, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?)`,
    [fields.name, hashKey(apiKey), fields.webhookUrl ?? null, webhookSecret, fields.dailyLimit ?? null, fields.active ?? 1, now, now],
  );
  const [client] = await rows(`SELECT * FROM ${T.client} WHERE id = ?`, [result.insertId]);
  res.status(201).json({ client: publicClient(client), apiKey, webhookSecret });
}));

router.get('/admin/clients', requireAdmin, wrap(async (_req, res) => {
  res.json({ data: (await rows(`SELECT * FROM ${T.client} ORDER BY id`)).map(publicClient) });
}));

// PATCH /v1/admin/clients/:id — { name?, webhookUrl?, dailyLimit?, active?, rotateKey?, rotateWebhookSecret? }
router.patch('/admin/clients/:id', requireAdmin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const [existing] = await rows(`SELECT * FROM ${T.client} WHERE id = ?`, [id]);
  if (!existing) throw new ApiError(404, 'NOT_FOUND', 'App cliente no encontrada');

  const fields = clientFields(req.body ?? {}, { creating: false });
  const secrets = {};
  if (req.body?.rotateKey === true) { secrets.apiKey = newApiKey(); fields.apiKeyHash = hashKey(secrets.apiKey); }
  if (req.body?.rotateWebhookSecret === true) { secrets.webhookSecret = newWebhookSecret(); fields.webhookSecret = secrets.webhookSecret; }
  if (!Object.keys(fields).length) throw new ApiError(400, 'VALIDATION', 'No se indicó nada que cambiar');

  fields.updatedAt = new Date();
  await pool.query(`UPDATE ${T.client} SET ${Object.keys(fields).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...Object.values(fields), id]);
  const [client] = await rows(`SELECT * FROM ${T.client} WHERE id = ?`, [id]);
  res.json({ client: publicClient(client), ...secrets });
}));

// POST /v1/admin/templates — crea una plantilla en la cuenta (WABA) del canal indicado en `channel` (Meta la revisa)
router.post('/admin/templates', requireAdmin, wrap(async (req, res) => {
  const { channel: slug, ...definition } = req.body ?? {};
  if (typeof slug !== 'string' || !slug) throw new ApiError(400, 'VALIDATION', 'channel (slug) es requerido: las plantillas son de la cuenta de cada canal');
  if (typeof definition.name !== 'string' || !Array.isArray(definition.components)) {
    throw new ApiError(400, 'VALIDATION', 'Se espera la definición de plantilla de Meta: { name, language, category, components } más channel');
  }
  const channel = await channelBySlug(slug);
  if (!channel) throw new ApiError(404, 'NOT_FOUND', 'Canal no encontrado');
  if (!channel.wabaId) throw new ApiError(503, 'NOT_CONFIGURED', `El canal "${slug}" no tiene wabaId`);
  if (!tokenFor(channel)) throw new ApiError(503, 'NOT_CONFIGURED', `Falta el token del canal "${slug}" (variable ${channel.tokenEnv || 'WHATSAPP_TOKEN'})`);
  res.status(201).json(await createTemplate(channel.wabaId, definition, tokenFor(channel)));
}));

// ── Canales ──────────────────────────────────────────────────────────────────

const publicChannel = (c) => ({
  id: c.id, slug: c.slug, type: c.type, name: c.name, phoneNumberId: c.phoneNumberId, wabaId: c.wabaId,
  displayPhone: c.displayPhone, tokenEnv: c.tokenEnv, tokenConfigured: Boolean(tokenFor(c)),
  defaultClientId: c.defaultClientId, active: Boolean(c.active), createdAt: c.createdAt, updatedAt: c.updatedAt,
});

function channelFields(body, { creating }) {
  const out = {};
  const text = (key, max, { required = false, pattern, hint } = {}) => {
    const v = body[key];
    if (v === undefined && !(creating && required)) return;
    if (v === null && !required) { out[key] = null; return; }
    if (typeof v !== 'string' || !v.trim() || v.length > max || (pattern && !pattern.test(v.trim()))) {
      throw new ApiError(400, 'VALIDATION', `${key} ${hint ?? `debe ser un texto de 1 a ${max} caracteres`}`);
    }
    out[key] = v.trim();
  };
  text('slug', 50, { required: true, pattern: /^[a-z0-9][a-z0-9-]*$/, hint: 'debe ser minúsculas, números y guiones (máx. 50)' });
  text('name', 100, { required: true });
  text('phoneNumberId', 40, { pattern: /^\d+$/, hint: 'debe ser el id numérico del número en Meta' });
  text('wabaId', 40, { pattern: /^\d+$/, hint: 'debe ser el id numérico de la cuenta de WhatsApp Business' });
  text('displayPhone', 20);
  text('tokenEnv', 64, { pattern: /^[A-Z][A-Z0-9_]*$/, hint: 'debe ser el NOMBRE de una variable de entorno (MAYUSCULAS_Y_GUIONES_BAJOS), no el token' });
  if (body.defaultClientId !== undefined) {
    if (body.defaultClientId !== null && !Number.isInteger(body.defaultClientId)) throw new ApiError(400, 'VALIDATION', 'defaultClientId debe ser el id de una app o null');
    out.defaultClientId = body.defaultClientId;
  }
  if (body.active !== undefined) {
    if (typeof body.active !== 'boolean') throw new ApiError(400, 'VALIDATION', 'active debe ser true o false');
    out.active = body.active ? 1 : 0;
  }
  return out;
}

async function assertClientExists(id) {
  if (id == null) return;
  const [c] = await rows(`SELECT id FROM ${T.client} WHERE id = ?`, [id]);
  if (!c) throw new ApiError(400, 'VALIDATION', `defaultClientId ${id}: la app no existe`);
}

const duplicateAs409 = (err) => {
  if (err.code === 'ER_DUP_ENTRY') throw new ApiError(409, 'CONFLICT', 'Ya existe un canal con ese slug o phoneNumberId');
  throw err;
};

// POST /v1/admin/channels
router.post('/admin/channels', requireAdmin, wrap(async (req, res) => {
  const f = channelFields(req.body ?? {}, { creating: true });
  await assertClientExists(f.defaultClientId);
  const now = new Date();
  const row = { type: 'whatsapp', active: 1, createdAt: now, updatedAt: now, ...f };
  const keys = Object.keys(row);
  const [result] = await pool.query(`INSERT INTO ${T.channel} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map((k) => row[k])).catch(duplicateAs409);
  invalidateChannels();
  const [channel] = await rows(`SELECT * FROM ${T.channel} WHERE id = ?`, [result.insertId]);
  res.status(201).json({ channel: publicChannel(channel) });
}));

router.get('/admin/channels', requireAdmin, wrap(async (_req, res) => {
  res.json({ data: (await rows(`SELECT * FROM ${T.channel} ORDER BY id`)).map(publicChannel) });
}));

// PATCH /v1/admin/channels/:slug
router.patch('/admin/channels/:slug', requireAdmin, wrap(async (req, res) => {
  const [existing] = await rows(`SELECT * FROM ${T.channel} WHERE slug = ?`, [req.params.slug]);
  if (!existing) throw new ApiError(404, 'NOT_FOUND', 'Canal no encontrado');
  const f = channelFields(req.body ?? {}, { creating: false });
  if (!Object.keys(f).length) throw new ApiError(400, 'VALIDATION', 'No se indicó nada que cambiar');
  await assertClientExists(f.defaultClientId);
  f.updatedAt = new Date();
  await pool.query(`UPDATE ${T.channel} SET ${Object.keys(f).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...Object.values(f), existing.id]).catch(duplicateAs409);
  invalidateChannels();
  const [channel] = await rows(`SELECT * FROM ${T.channel} WHERE id = ?`, [existing.id]);
  res.json({ channel: publicChannel(channel) });
}));

// PUT /v1/admin/clients/:id/channels — { channels: [{ slug, isDefault }] } reemplaza las asignaciones de la app
router.put('/admin/clients/:id/channels', requireAdmin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const [client] = await rows(`SELECT id FROM ${T.client} WHERE id = ?`, [id]);
  if (!client) throw new ApiError(404, 'NOT_FOUND', 'App cliente no encontrada');
  const list = req.body?.channels;
  if (!Array.isArray(list)) throw new ApiError(400, 'VALIDATION', 'channels debe ser una lista [{ slug, isDefault }]');

  const links = [];
  for (const item of list) {
    const channel = typeof item?.slug === 'string' ? await channelBySlug(item.slug) : null;
    if (!channel) throw new ApiError(400, 'VALIDATION', `Canal desconocido: ${item?.slug}`);
    if (links.some((l) => l.channelId === channel.id)) throw new ApiError(400, 'VALIDATION', `Canal repetido: ${item.slug}`);
    links.push({ channelId: channel.id, isDefault: item.isDefault === true });
  }
  const defaults = links.filter((l) => l.isDefault).length;
  if (defaults > 1) throw new ApiError(400, 'VALIDATION', 'Solo un canal puede ser isDefault');
  if (links.length === 1) links[0].isDefault = true;
  else if (links.length > 1 && defaults === 0) throw new ApiError(400, 'VALIDATION', 'Con varios canales, uno debe ser isDefault');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(`DELETE FROM ${T.client_channel} WHERE clientId = ?`, [id]);
    for (const l of links) await conn.query(`INSERT INTO ${T.client_channel} (clientId, channelId, isDefault) VALUES (?,?,?)`, [id, l.channelId, l.isDefault ? 1 : 0]);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  res.json({ channels: (await clientChannels(id)).map((c) => ({ slug: c.slug, isDefault: c.isDefault })) });
}));

export default router;
