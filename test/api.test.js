// Prueba de integración: necesita una MariaDB/MySQL vacía. Se omite sin TEST_DB_NAME.
// TEST_DB_HOST/PORT/USER/PASSWORD/NAME. Meta se simula parchando fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';

const enabled = Boolean(process.env.TEST_DB_NAME);

test('API completa: envío, idempotencia, webhooks, conversaciones', { skip: !enabled }, async (t) => {
  Object.assign(process.env, {
    DB_HOST: process.env.TEST_DB_HOST, DB_PORT: process.env.TEST_DB_PORT, DB_USER: process.env.TEST_DB_USER,
    DB_PASSWORD: process.env.TEST_DB_PASSWORD ?? '', DB_NAME: process.env.TEST_DB_NAME,
    ADMIN_API_KEY: 'admin-key-admin-key-admin-key-1234', WHATSAPP_TOKEN: 'tok', WHATSAPP_PHONE_NUMBER_ID: '111',
    WHATSAPP_APP_SECRET: 'appsecret', WHATSAPP_VERIFY_TOKEN: 'verify',
  });

  // Meta simulado
  const graphCalls = [];
  let graphFailWith = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (!String(url).startsWith('https://graph.facebook.com')) return realFetch(url, opts);
    graphCalls.push(JSON.parse(opts.body));
    if (graphFailWith) return new Response(JSON.stringify({ error: graphFailWith }), { status: 400 });
    return new Response(JSON.stringify({ messages: [{ id: `wamid.${graphCalls.length}` }] }), { status: 200 });
  };
  t.after(() => { globalThis.fetch = realFetch; });

  // Receptor del webhook de salida
  const received = [];
  const receiver = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => (b += d)).on('end', () => { received.push({ headers: req.headers, body: b }); res.end('ok'); });
  });
  await new Promise((r) => receiver.listen(0, r));
  t.after(() => receiver.close());

  const { pool } = await import('../src/db.js');
  await pool.query('DROP TABLE IF EXISTS message'); await pool.query('DROP TABLE IF EXISTS client');
  await (await import('../scripts/migrate.js')).migrate();
  const { app } = await import('../src/app.js');
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  t.after(async () => { server.close(); await pool.end(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { key, body, raw, headers } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}), ...headers },
      body: raw ?? (body ? JSON.stringify(body) : undefined),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };

  // Autenticación y administración
  assert.equal((await call('GET', '/v1/me')).status, 401);
  assert.equal((await call('POST', '/v1/admin/clients', { key: 'mala', body: { name: 'x' } })).status, 401);
  const created = await call('POST', '/v1/admin/clients', {
    key: process.env.ADMIN_API_KEY,
    body: { name: 'Eventopolis', webhookUrl: `http://127.0.0.1:${receiver.address().port}/hook`, dailyLimit: 4 },
  });
  assert.equal(created.status, 201);
  const { apiKey, webhookSecret } = created.json;
  assert.match(apiKey, /^msk_/);
  assert.equal((await call('GET', '/v1/me', { key: apiKey })).json.client.name, 'Eventopolis');
  assert.equal(JSON.stringify((await call('GET', '/v1/admin/clients', { key: process.env.ADMIN_API_KEY })).json).includes('apiKeyHash'), false);

  // Envío de plantilla + idempotencia
  const tpl = { to: '55 1234 5678', template: 'recordatorio_evento', parameters: { body: { nombre: 'Ana' }, buttonUrlSuffix: 'e/c' }, ref: 'event:14', metadata: { invitationId: 7 }, idempotencyKey: 'event_reminder:7:d7' };
  const first = await call('POST', '/v1/messages/template', { key: apiKey, body: tpl });
  assert.equal(first.status, 201);
  assert.equal(first.json.message.status, 'sent');
  assert.equal(first.json.message.phone, '525512345678');
  assert.deepEqual(first.json.message.metadata, { invitationId: 7 });
  assert.equal(graphCalls[0].to, '525512345678');
  assert.equal(graphCalls[0].template.components[0].parameters[0].parameter_name, 'nombre');
  const again = await call('POST', '/v1/messages/template', { key: apiKey, body: tpl });
  assert.equal(again.status, 200);
  assert.equal(again.json.duplicate, true);
  assert.equal(again.json.message.id, first.json.message.id);
  assert.equal(graphCalls.length, 1, 'la repetición no llama a Meta');

  // Validación y teléfono inválido
  assert.equal((await call('POST', '/v1/messages/template', { key: apiKey, body: { to: '5512345678' } })).status, 400);
  assert.equal((await call('POST', '/v1/messages/template', { key: apiKey, body: { to: '123', template: 't' } })).status, 422);
  assert.equal((await call('POST', '/v1/messages/template', { key: apiKey, raw: '{mal' })).status, 400);

  // Texto libre: ventana cerrada hasta que escriben
  assert.equal((await call('POST', '/v1/messages/text', { key: apiKey, body: { to: '5512345678', text: 'hola' } })).json.error.code, 'WINDOW_CLOSED');

  // Webhook de Meta: firma, estado y mensaje entrante
  const metaPost = (payload, secret = 'appsecret') => {
    const raw = JSON.stringify(payload);
    return call('POST', '/webhooks/whatsapp', { raw, headers: { 'X-Hub-Signature-256': `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}` } });
  };
  assert.equal((await metaPost({ entry: [] }, 'falsa')).status, 401);
  assert.equal((await fetch(`${base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify&hub.challenge=42`)).status, 200);
  await metaPost({ entry: [{ changes: [{ field: 'messages', value: { statuses: [{ id: 'wamid.1', status: 'delivered' }] } }] }] }).then((r) => assert.equal(r.status, 200));
  await metaPost({ entry: [{ changes: [{ field: 'messages', value: {
    contacts: [{ wa_id: '5215512345678', profile: { name: 'Ana' } }],
    messages: [{ from: '5215512345678', id: 'wamid.in1', type: 'text', text: { body: 'Allá estaremos' }, timestamp: String(Math.floor(Date.now() / 1000)) }],
  } }] }] });
  await new Promise((r) => setTimeout(r, 400));

  const msg = await call('GET', `/v1/messages/${first.json.message.id}`, { key: apiKey });
  assert.equal(msg.json.message.status, 'delivered');
  assert.deepEqual(received.map((r) => JSON.parse(r.body).event), ['message.status', 'message.received']);
  const hook = received[1];
  assert.equal(hook.headers['x-signature-256'], `sha256=${crypto.createHmac('sha256', webhookSecret).update(hook.body).digest('hex')}`);
  const inbound = JSON.parse(hook.body).data;
  assert.equal(inbound.ref, 'event:14', 'el mensaje entrante hereda ref y metadata del último envío');
  assert.deepEqual(inbound.metadata, { invitationId: 7 });
  assert.equal(inbound.text, 'Allá estaremos');

  // Conversaciones
  assert.equal((await call('GET', '/v1/conversations/unread?ref=event:14', { key: apiKey })).json.unread, 1);
  const convs = (await call('GET', '/v1/conversations?ref=event:14', { key: apiKey })).json.data;
  assert.equal(convs.length, 1);
  assert.equal(convs[0].profileName, 'Ana');
  const reply = await call('POST', '/v1/messages/text', { key: apiKey, body: { to: '5512345678', text: 'Gracias', ref: 'event:14' } });
  assert.equal(reply.status, 201);
  assert.equal(graphCalls.at(-1).type, 'text');
  const thread = (await call('GET', '/v1/conversations/5512345678', { key: apiKey })).json;
  assert.deepEqual(thread.messages.map((m) => m.direction).sort(), ['in', 'out', 'out']); // Meta da la hora entrante en segundos: el orden exacto dentro del mismo segundo no es estable
  assert.equal((await call('POST', '/v1/conversations/5512345678/read', { key: apiKey, body: {} })).json.updated, 1);
  assert.equal((await call('GET', '/v1/conversations/unread', { key: apiKey })).json.unread, 0);

  // Listado con filtros
  const list = (await call('GET', '/v1/messages?ref=event:14&direction=out&excludeStatus=failed', { key: apiKey })).json.data;
  assert.equal(list.length, 2);

  // Lote: uno nuevo, uno repetido, uno inválido
  const batch = await call('POST', '/v1/messages/template/batch', { key: apiKey, body: { messages: [
    { ...tpl, to: '5598765432', idempotencyKey: 'k2' }, tpl, { to: '12', template: 't' },
  ] } });
  assert.equal(batch.status, 200);
  assert.deepEqual(batch.json.results.map((r) => r.status), ['sent', 'duplicate', 'skipped']);

  // Error fatal de Meta detiene el lote y libera la llave de idempotencia
  graphFailWith = { code: 132001, message: 'template missing' };
  const fatal = await call('POST', '/v1/messages/template/batch', { key: apiKey, body: { messages: [
    { ...tpl, to: '5511111111', idempotencyKey: 'k3' }, { ...tpl, to: '5522222222', idempotencyKey: 'k4' },
  ] } });
  assert.equal(fatal.status, 502);
  assert.deepEqual(fatal.json.results.map((r) => r.status), ['failed', 'not_attempted']);
  assert.match(fatal.json.results[0].message.error.reason, /plantilla/);
  graphFailWith = null;
  assert.equal((await call('POST', '/v1/messages/template', { key: apiKey, body: { ...tpl, to: '5511111111', idempotencyKey: 'k3' } })).status, 201, 'tras un fallo se puede reintentar');

  // Límite diario (4): enviados no fallidos = original + texto + 1 del lote + el reintentado; el fallido no cuenta
  const limited = await call('POST', '/v1/messages/template', { key: apiKey, body: { ...tpl, to: '5533333333', idempotencyKey: 'k5' } });
  assert.equal(limited.status, 429);

  // Otra app no ve los mensajes de la primera
  const other = (await call('POST', '/v1/admin/clients', { key: process.env.ADMIN_API_KEY, body: { name: 'Otra' } })).json.apiKey;
  assert.equal((await call('GET', `/v1/messages/${first.json.message.id}`, { key: other })).status, 404);
  assert.equal((await call('GET', '/v1/messages', { key: other })).json.data.length, 0);

  // Rotar llave: la anterior deja de servir; desactivar bloquea
  const rotated = await call('PATCH', '/v1/admin/clients/1', { key: process.env.ADMIN_API_KEY, body: { rotateKey: true } });
  assert.equal((await call('GET', '/v1/me', { key: apiKey })).status, 401);
  assert.equal((await call('GET', '/v1/me', { key: rotated.json.apiKey })).status, 200);
  await call('PATCH', '/v1/admin/clients/1', { key: process.env.ADMIN_API_KEY, body: { active: false } });
  assert.equal((await call('GET', '/v1/me', { key: rotated.json.apiKey })).status, 403);
});
