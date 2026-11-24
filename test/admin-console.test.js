// Prueba de integración del backoffice (/v1/admin/console y /admin). Necesita una MariaDB/MySQL
// vacía (TEST_DB_*), igual que test/api.test.js; se omite sin TEST_DB_NAME. Meta se simula.
import test from 'node:test';
import assert from 'node:assert/strict';
import { templateSpec, renderTemplate } from '../src/templates.js';

test('templateSpec: variables con nombre, botón con sufijo, encabezados no soportados', () => {
  const spec = templateSpec({
    name: 'recordatorio_evento', language: 'es_MX', category: 'UTILITY', status: 'APPROVED',
    components: [
      { type: 'HEADER', format: 'TEXT', text: '¡Ya casi es el gran día!' },
      { type: 'BODY', text: 'Hola {{nombre}}, *{{evento}}* es {{cuando}}. {{nombre}}' },
      { type: 'FOOTER', text: 'Eventopolis' },
      { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Ver mi invitación', url: 'https://e.mx/invitacion/{{1}}' }] },
    ],
  });
  assert.deepEqual(spec.params, ['nombre', 'evento', 'cuando']);
  assert.equal(spec.urlButton.hasSuffix, true);
  assert.equal(spec.sendable, true);
  assert.equal(renderTemplate(spec, { nombre: 'Ana', evento: 'La boda' }), 'Hola Ana, *La boda* es {{cuando}}. Ana');

  const numbered = templateSpec({ name: 'x', components: [{ type: 'BODY', text: 'Hola {{1}}' }] });
  assert.equal(numbered.sendable, false);
  const video = templateSpec({ name: 'y', components: [{ type: 'HEADER', format: 'VIDEO' }, { type: 'BODY', text: 'Hola' }] });
  assert.equal(video.sendable, false);
  const image = templateSpec({ name: 'z', components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Hola' }] });
  assert.equal(image.needsHeaderImage, true);
  assert.equal(image.sendable, true);
});

const enabled = Boolean(process.env.TEST_DB_NAME);

test('backoffice: resumen, por evento, mensajes, conversaciones y envío en nombre de una app', { skip: !enabled }, async (t) => {
  Object.assign(process.env, {
    DB_HOST: process.env.TEST_DB_HOST, DB_PORT: process.env.TEST_DB_PORT, DB_USER: process.env.TEST_DB_USER,
    DB_PASSWORD: process.env.TEST_DB_PASSWORD ?? '', DB_NAME: process.env.TEST_DB_NAME,
    ADMIN_API_KEY: 'admin-key-admin-key-admin-key-1234', WHATSAPP_TOKEN: 'tok',
    WHATSAPP_PHONE_NUMBER_ID: '111', WHATSAPP_BUSINESS_ACCOUNT_ID: '999',
    // Prefijo propio: node --test corre los archivos en paralelo y test/api.test.js borra sus tablas.
    DB_TABLE_PREFIX: `${process.env.TEST_DB_TABLE_PREFIX ?? ''}bo_`,
  });
  delete process.env.SEND_ALLOWLIST;

  const graph = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    if (!String(url).startsWith('https://graph.facebook.com')) return realFetch(url, opts);
    graph.push({ url: String(url), method: opts.method ?? 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    if (String(url).includes('/message_templates')) {
      return new Response(JSON.stringify({ data: [
        { name: 'recordatorio_evento', status: 'APPROVED', language: 'es_MX', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hola {{nombre}}' }] },
        { name: 'borrador', status: 'PENDING', language: 'es_MX', category: 'UTILITY', components: [{ type: 'BODY', text: 'x' }] },
      ] }), { status: 200 });
    }
    return new Response(JSON.stringify({ messages: [{ id: `wamid.bo${graph.length}` }] }), { status: 200 });
  };
  t.after(() => { globalThis.fetch = realFetch; });

  const { pool } = await import('../src/db.js');
  const { T } = await import('../src/tables.js');
  for (const table of [T.message, T.client_channel, T.channel, T.client]) await pool.query(`DROP TABLE IF EXISTS ${table}`);
  await (await import('../scripts/migrate.js')).migrate();
  const { app } = await import('../src/app.js');
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  t.after(async () => { server.close(); await pool.end(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const admin = process.env.ADMIN_API_KEY;
  const call = async (method, path, { key = admin, body } = {}) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json().catch(() => null), headers: res.headers };
  };

  // La página se sirve con cabeceras de seguridad; los datos piden la llave de administración
  const page = await fetch(`${base}/admin/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(await page.text(), /SofIA Messenger/);
  assert.equal((await call('GET', '/v1/admin/console/summary', { key: null })).status, 401);
  assert.equal((await call('GET', '/v1/admin/console/summary', { key: 'mala' })).status, 401);

  // Dos apps con el canal por defecto
  const a = (await call('POST', '/v1/admin/clients', { body: { name: 'Eventopolis', dailyLimit: 10 } })).json;
  const b = (await call('POST', '/v1/admin/clients', { body: { name: 'CEINVET' } })).json;
  await call('POST', '/v1/admin/channels', { body: { slug: 'default', name: 'Default', phoneNumberId: '111', wabaId: '999' } });
  await call('PUT', `/v1/admin/clients/${a.client.id}/channels`, { body: { channels: [{ slug: 'default', isDefault: true }] } });
  await call('PUT', `/v1/admin/clients/${b.client.id}/channels`, { body: { channels: [{ slug: 'default', isDefault: true }] } });

  // La app manda con su llave (con ref y el nombre del evento en metadata)
  const sent = await call('POST', '/v1/messages/template', {
    key: a.apiKey,
    body: { to: '5512345678', template: 'recordatorio_evento', parameters: { body: { nombre: 'Ana' } }, ref: 'event:14', metadata: { refLabel: 'Boda I&F' } },
  });
  assert.equal(sent.status, 201);
  // Un entrante que responde a ese mensaje (lo guarda el webhook de Meta; aquí directo en la BD)
  await pool.query(
    `INSERT INTO ${T.message} (id, clientId, channelId, direction, kind, phone, body, ref, metadata, status, msgType, profileName, createdAt, updatedAt)
     VALUES (UUID(), ?, (SELECT id FROM ${T.channel} WHERE slug = 'default'), 'in', 'text', '525512345678', '¿A qué hora?', 'event:14', ?, 'received', 'text', 'Ana', ?, ?)`,
    [a.client.id, JSON.stringify({ refLabel: 'Boda I&F' }), new Date(), new Date()],
  );

  // Resumen
  const sum = (await call('GET', '/v1/admin/console/summary')).json;
  const ev = sum.clients.find((c) => c.name === 'Eventopolis');
  assert.equal(ev.outTotal, 1);
  assert.equal(ev.in, 1);
  assert.equal(ev.unread, 1);
  assert.equal(ev.usage24h, 1);
  assert.equal(sum.totals.outTotal, 1);
  assert.equal(sum.channels[0].slug, 'default');

  // Por evento: agrupa por app y ref, con el nombre que mandó la app
  const refs = (await call('GET', '/v1/admin/console/refs')).json.data;
  assert.equal(refs.length, 1);
  assert.deepEqual([refs[0].ref, refs[0].label, refs[0].clientName, refs[0].outTotal, refs[0].inbound, refs[0].unread, refs[0].phones], ['event:14', 'Boda I&F', 'Eventopolis', 1, 1, 1, 1]);

  // Mensajes de todas las apps, con filtros
  const all = (await call('GET', '/v1/admin/console/messages')).json;
  assert.equal(all.total, 2);
  assert.equal(all.data[0].clientName, 'Eventopolis');
  assert.equal((await call('GET', `/v1/admin/console/messages?client=${b.client.id}`)).json.total, 0);
  assert.equal((await call('GET', '/v1/admin/console/messages?direction=in&ref=event:14')).json.total, 1);
  assert.equal((await call('GET', '/v1/admin/console/messages?client=none')).json.total, 0);

  // Conversaciones de una app y marcar como leído
  const convs = (await call('GET', `/v1/admin/console/clients/${a.client.id}/conversations`)).json.data;
  assert.equal(convs[0].phone, '525512345678');
  const thread = (await call('GET', `/v1/admin/console/clients/${a.client.id}/conversations/5512345678`)).json;
  assert.equal(thread.messages.length, 2);
  assert.ok(new Date(thread.windowUntil) > new Date());
  assert.equal((await call('POST', `/v1/admin/console/clients/${a.client.id}/conversations/5512345678/read`, { body: {} })).json.updated, 1);

  // Responder y enviar plantillas en nombre de la app: mismas reglas, marcado como del backoffice
  const reply = await call('POST', `/v1/admin/console/clients/${a.client.id}/messages/text`, { body: { to: '5512345678', text: 'A la 1:00 p.m.', ref: 'event:14' } });
  assert.equal(reply.status, 201);
  assert.equal(reply.json.message.metadata.origin, 'backoffice');
  assert.equal((await call('POST', `/v1/admin/console/clients/${b.client.id}/messages/text`, { body: { to: '5512345678', text: 'x' } })).status, 409); // CEINVET no tiene conversación abierta
  const batch = await call('POST', `/v1/admin/console/clients/${a.client.id}/messages/template/batch`, {
    body: { messages: [{ to: '5511111111', template: 'recordatorio_evento', parameters: { body: { nombre: 'Luis' } }, ref: 'event:14', idempotencyKey: 'bo:1:5511111111' }] },
  });
  assert.equal(batch.json.summary.sent, 1);
  const again = await call('POST', `/v1/admin/console/clients/${a.client.id}/messages/template/batch`, {
    body: { messages: [{ to: '5511111111', template: 'recordatorio_evento', parameters: { body: { nombre: 'Luis' } }, idempotencyKey: 'bo:1:5511111111' }] },
  });
  assert.equal(again.json.summary.duplicate, 1); // doble clic: no se manda dos veces

  // Una app desactivada no puede enviar ni desde el backoffice
  await call('PATCH', `/v1/admin/clients/${b.client.id}`, { body: { active: false } });
  assert.equal((await call('POST', `/v1/admin/console/clients/${b.client.id}/messages/template`, { body: { to: '5512345678', template: 'recordatorio_evento' } })).status, 403);

  // Plantillas aprobadas del canal, listas para llenar
  const tpls = (await call('GET', '/v1/admin/console/channels/default/templates')).json.data;
  assert.deepEqual(tpls.map((x) => x.name), ['recordatorio_evento']);
  assert.deepEqual(tpls[0].params, ['nombre']);
  assert.match(graph.find((g) => g.url.includes('/message_templates')).url, /\/999\/message_templates/);

  // Apps con sus canales
  const cl = (await call('GET', '/v1/admin/console/clients')).json.data;
  assert.deepEqual(cl.map((c) => [c.name, c.active, c.channels[0]?.slug]), [['Eventopolis', true, 'default'], ['CEINVET', false, 'default']]);
});
