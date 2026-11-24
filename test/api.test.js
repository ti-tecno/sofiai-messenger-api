// Prueba de integración: necesita una MariaDB/MySQL vacía. Se omite sin TEST_DB_NAME.
// TEST_DB_HOST/PORT/USER/PASSWORD/NAME. TEST_DB_TABLE_PREFIX (opcional, p. ej. msg_) corre con prefijo de tablas. Meta se simula parchando fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';

const enabled = Boolean(process.env.TEST_DB_NAME);

test('API completa: envío, idempotencia, webhooks, conversaciones', { skip: !enabled }, async (t) => {
  Object.assign(process.env, {
    DB_HOST: process.env.TEST_DB_HOST, DB_PORT: process.env.TEST_DB_PORT, DB_USER: process.env.TEST_DB_USER,
    DB_PASSWORD: process.env.TEST_DB_PASSWORD ?? '', DB_NAME: process.env.TEST_DB_NAME,
    ADMIN_API_KEY: 'admin-key-admin-key-admin-key-1234', WHATSAPP_TOKEN: 'tok', WA_TOKEN_SECOND: 'tok2',
    WHATSAPP_APP_SECRET: 'appsecret', WHATSAPP_VERIFY_TOKEN: 'verify',
    DB_TABLE_PREFIX: process.env.TEST_DB_TABLE_PREFIX ?? '',
  });

  // Meta simulado
  const graphCalls = [];
  const graphMeta = []; // { url, auth } de cada llamada, en el mismo orden
  let graphFailWith = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (!String(url).startsWith('https://graph.facebook.com')) return realFetch(url, opts);
    graphCalls.push(JSON.parse(opts.body));
    graphMeta.push({ url: String(url), auth: opts.headers.Authorization });
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
  const { T } = await import('../src/tables.js');
  for (const table of [T.message, T.client_channel, T.channel, T.client]) await pool.query(`DROP TABLE IF EXISTS ${table}`);
  const migrate = (await import('../scripts/migrate.js')).migrate;
  await migrate();
  await migrate(); // repetible
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

  // Sin canal asignado no se puede enviar (503 NOT_CONFIGURED)
  assert.equal((await call('POST', '/v1/messages/template', { key: apiKey, body: { to: '5512345678', template: 't' } })).json.error.code, 'NOT_CONFIGURED');

  // Canales: alta, validación, asignación
  const admin = process.env.ADMIN_API_KEY;
  assert.equal((await call('POST', '/v1/admin/channels', { key: admin, body: { slug: 'main', name: 'Principal', phoneNumberId: '111', tokenEnv: 'tok-secreto' } })).status, 400, 'tokenEnv es un nombre, no un token');
  const main = await call('POST', '/v1/admin/channels', { key: admin, body: { slug: 'main', name: 'Principal', phoneNumberId: '111', wabaId: '900', defaultClientId: 1 } });
  assert.equal(main.status, 201);
  assert.equal(main.json.channel.tokenConfigured, true);
  assert.equal((await call('POST', '/v1/admin/channels', { key: admin, body: { slug: 'main2', name: 'X', phoneNumberId: '111' } })).status, 409);
  const second = await call('POST', '/v1/admin/channels', { key: admin, body: { slug: 'second', name: 'Segundo', phoneNumberId: '222', tokenEnv: 'WA_TOKEN_SECOND', displayPhone: '5500000002' } });
  assert.equal(second.status, 201);
  assert.equal((await call('PUT', '/v1/admin/clients/1/channels', { key: admin, body: { channels: [{ slug: 'nope' }] } })).status, 400);
  assert.equal((await call('PUT', '/v1/admin/clients/1/channels', { key: admin, body: { channels: [{ slug: 'main' }] } })).status, 200);
  const me = (await call('GET', '/v1/me', { key: apiKey })).json;
  assert.deepEqual(me.channels, [{ slug: 'main', name: 'Principal', displayPhone: null, isDefault: true }]);
  assert.equal(me.sandbox, false);
  assert.equal(me.whatsappConfigured, true);
  assert.equal(JSON.stringify((await call('GET', '/v1/admin/clients', { key: process.env.ADMIN_API_KEY })).json).includes('apiKeyHash'), false);

  // Envío de plantilla + idempotencia
  const tpl = { to: '55 1234 5678', template: 'recordatorio_evento', parameters: { body: { nombre: 'Ana' }, buttonUrlSuffix: 'e/c' }, ref: 'event:14', metadata: { invitationId: 7 }, idempotencyKey: 'event_reminder:7:d7' };
  const first = await call('POST', '/v1/messages/template', { key: apiKey, body: tpl });
  assert.equal(first.status, 201);
  assert.equal(first.json.message.status, 'sent');
  assert.equal(first.json.message.phone, '525512345678');
  assert.deepEqual(first.json.message.metadata, { invitationId: 7 });
  assert.equal(graphCalls[0].to, '525512345678');
  assert.equal(first.json.message.channel, 'main');
  assert.equal(first.json.message.waMessageId, 'wamid.1');
  assert.match(graphMeta[0].url, /\/111\/messages$/);
  assert.equal(graphMeta[0].auth, 'Bearer tok');
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
  await metaPost({ entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: '111' }, statuses: [{ id: 'wamid.1', status: 'delivered' }] } }] }] }).then((r) => assert.equal(r.status, 200));
  await metaPost({ entry: [{ changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: '111' },
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

  // ── Varios canales y varias apps ──────────────────────────────────────────
  const mk = async (name) => (await call('POST', '/v1/admin/clients', { key: admin, body: { name, webhookUrl: `http://127.0.0.1:${receiver.address().port}/${name}` } })).json;
  const appA = await mk('appA');
  const appB = await mk('appB');
  const idA = appA.client.id; const idB = appB.client.id;
  await call('PUT', `/v1/admin/clients/${idA}/channels`, { key: admin, body: { channels: [{ slug: 'main' }] } });
  await call('PUT', `/v1/admin/clients/${idB}/channels`, { key: admin, body: { channels: [{ slug: 'second', isDefault: true }] } });
  await call('PATCH', '/v1/admin/channels/second', { key: admin, body: { defaultClientId: idB } });

  // Una app no puede usar un canal que no tiene
  const notAllowed = await call('POST', '/v1/messages/template', { key: appA.apiKey, body: { to: '5544444444', template: 't', channel: 'second' } });
  assert.equal(notAllowed.status, 403);
  assert.equal(notAllowed.json.error.code, 'CHANNEL_NOT_ALLOWED');

  const callsBefore = graphCalls.length;
  const person = '5544444444';
  const sentA = (await call('POST', '/v1/messages/template', { key: appA.apiKey, body: { to: person, template: 'cita', ref: 'a:1', metadata: { x: 1 } } })).json.message;
  const sentB = (await call('POST', '/v1/messages/template', { key: appB.apiKey, body: { to: person, template: 'pago', ref: 'b:9' } })).json.message;
  assert.equal(sentA.channel, 'main');
  assert.equal(sentB.channel, 'second');
  const metaB = graphMeta[callsBefore + 1];
  assert.match(metaB.url, /\/222\/messages$/, 'sale por el número del canal de B');
  assert.equal(metaB.auth, 'Bearer tok2', 'con el token indicado en tokenEnv');

  const nowSec = () => String(Math.floor(Date.now() / 1000));
  const inboundTo = (phoneNumberId, from, text, extra = {}) => metaPost({ entry: [{ changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: phoneNumberId },
    messages: [{ from, id: `wamid.in.${phoneNumberId}.${text}`, type: 'text', text: { body: text }, timestamp: nowSec(), ...extra }],
  } }] }] });
  const incoming = async (key, query = '') => (await call('GET', `/v1/messages?direction=in${query}`, { key })).json.data;

  // La misma persona contesta a cada app por el número al que escribió
  await inboundTo('222', person, 'para B');
  await inboundTo('111', person, 'para A');
  await inboundTo('222', person, 'contexto de A pero en el canal de B', { context: { id: sentA.waMessageId } });
  await new Promise((r) => setTimeout(r, 500));
  assert.deepEqual((await incoming(appA.apiKey)).map((m) => m.text), ['para A']);
  assert.equal((await incoming(appA.apiKey))[0].ref, 'a:1');
  assert.deepEqual((await incoming(appA.apiKey))[0].metadata, { x: 1 });
  const bIn = await incoming(appB.apiKey);
  assert.deepEqual(bIn.map((m) => m.text).sort(), ['contexto de A pero en el canal de B', 'para B']);
  assert.ok(bIn.every((m) => m.channel === 'second' && m.ref === 'b:9'), 'en el canal de B el context de A no cuenta');
  assert.equal((await incoming(appB.apiKey, '&channel=main')).length, 0);
  assert.equal((await call('GET', '/v1/messages?channel=nope', { key: appB.apiKey })).status, 400);

  // La ventana de 24 h es por canal: A abrió la suya en 'main'; B en 'second'
  assert.equal((await call('POST', '/v1/messages/text', { key: appA.apiKey, body: { to: person, text: 'hola A' } })).status, 201);
  assert.equal((await call('POST', '/v1/messages/text', { key: appB.apiKey, body: { to: person, text: 'hola B' } })).status, 201);
  assert.match(graphMeta.at(-1).url, /\/222\/messages$/);

  // Entrante sin envío previo: va a la app por defecto del canal (sin ref ni metadata)
  await inboundTo('222', '5577777777', 'primero yo');
  // Canal desconocido: se ignora
  await inboundTo('999', '5577777777', 'canal ajeno');
  await new Promise((r) => setTimeout(r, 400));
  const first777 = (await incoming(appB.apiKey)).find((m) => m.text === 'primero yo');
  assert.ok(first777);
  assert.equal(first777.ref, null);
  assert.equal((await incoming(appB.apiKey)).some((m) => m.text === 'canal ajeno'), false);
  const [{ n }] = await pool.query(`SELECT COUNT(*) AS n FROM ${T.message} WHERE body = 'canal ajeno'`).then(([r]) => r);
  assert.equal(Number(n), 0, 'un canal desconocido no se guarda');

  // Sandbox: SEND_ALLOWLIST rechaza antes de guardar o llamar a Meta
  process.env.SEND_ALLOWLIST = '55 4444 4444';
  const callsSandbox = graphCalls.length;
  assert.equal((await call('GET', '/v1/me', { key: appA.apiKey })).json.sandbox, true);
  const blocked = await call('POST', '/v1/messages/template', { key: appA.apiKey, body: { to: '5588888888', template: 't', idempotencyKey: 'sb1' } });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json.error.code, 'RECIPIENT_NOT_ALLOWED');
  assert.equal((await call('POST', '/v1/messages/text', { key: appB.apiKey, body: { to: '5588888888', text: 'x' } })).json.error.code, 'RECIPIENT_NOT_ALLOWED');
  const sbBatch = await call('POST', '/v1/messages/template/batch', { key: appA.apiKey, body: { messages: [
    { to: '5588888888', template: 't' }, { to: person, template: 't', idempotencyKey: 'sb2' },
  ] } });
  assert.deepEqual(sbBatch.json.results.map((x) => [x.status, x.reason]), [['skipped', 'not_allowed'], ['sent', undefined]]);
  assert.equal(graphCalls.length, callsSandbox + 1, 'solo el permitido llama a Meta');
  assert.equal((await incoming(appA.apiKey, '')).length, 1);
  assert.equal((await call('GET', '/v1/messages?phone=5588888888', { key: appA.apiKey })).json.data.length, 0, 'lo rechazado no se guarda');
  delete process.env.SEND_ALLOWLIST;

  // Contrato 502: error de nivel superior SEND_FAILED y código numérico de Meta en message.error
  graphFailWith = { code: 131026, message: 'undeliverable' };
  const failed = await call('POST', '/v1/messages/template', { key: appA.apiKey, body: { to: '5599999999', template: 't', idempotencyKey: 'f1' } });
  graphFailWith = null;
  assert.equal(failed.status, 502);
  assert.equal(failed.json.error.code, 'SEND_FAILED');
  assert.equal(failed.json.message.status, 'failed');
  assert.equal(failed.json.message.error.code, 131026);

  // Webhook: el Mensaje trae canal, waMessageId, contextWaId y metadata
  const hookA = received.map((r2) => ({ url: r2.headers, ...JSON.parse(r2.body) })).find((e) => e.event === 'message.received' && e.data.text === 'para A');
  assert.equal(hookA.data.channel, 'main');
  assert.equal(hookA.data.waMessageId, 'wamid.in.111.para A');
  assert.ok('contextWaId' in hookA.data && hookA.data.createdAt);

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
