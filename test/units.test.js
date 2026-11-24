import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone } from '../src/whatsapp.js';
import { parseInboundMessage, describeWhatsAppError, serviceWindowUntil } from '../src/inbox.js';
import { nextStatus } from '../src/messages.js';
import { isValidSignature } from '../src/meta-webhook.js';
import { signBody } from '../src/outbound-webhooks.js';
import { parseTemplateMessage, parseTextMessage, listParam } from '../src/validate.js';
import crypto from 'node:crypto';

test('normalizePhone: formatos mexicanos comunes', () => {
  assert.equal(normalizePhone('5512345678', '52'), '525512345678');
  assert.equal(normalizePhone('+52 (55) 1234-5678', '52'), '525512345678');
  assert.equal(normalizePhone('5215512345678', '52'), '525512345678');
  assert.equal(normalizePhone('044 55 1234 5678', '52'), '525512345678');
  assert.equal(normalizePhone('123', '52'), null);
  assert.equal(normalizePhone(null), null);
});

test('nextStatus solo avanza y un éxito posterior gana a un fallo', () => {
  assert.equal(nextStatus('sent', 'delivered'), 'delivered');
  assert.equal(nextStatus('read', 'delivered'), 'read');
  assert.equal(nextStatus('delivered', 'failed'), 'delivered');
  assert.equal(nextStatus('sent', 'failed'), 'failed');
  assert.equal(nextStatus('failed', 'delivered'), 'delivered');
  assert.equal(nextStatus('sent', 'rareza'), 'sent');
});

test('isValidSignature acepta la firma correcta y rechaza el resto', () => {
  const body = Buffer.from('{"a":1}');
  const good = `sha256=${crypto.createHmac('sha256', 's3').update(body).digest('hex')}`;
  assert.equal(isValidSignature(body, good, 's3'), true);
  assert.equal(isValidSignature(body, good, 'otro'), false);
  assert.equal(isValidSignature(body, 'sha256=00', 's3'), false);
  assert.equal(isValidSignature(body, undefined, 's3'), false);
  assert.equal(isValidSignature(undefined, good, 's3'), false);
});

test('signBody usa HMAC-SHA256 con prefijo sha256=', () => {
  assert.equal(signBody('k', 'x'), `sha256=${crypto.createHmac('sha256', 'k').update('x').digest('hex')}`);
});

test('parseInboundMessage: texto, botón y reacción', () => {
  const text = parseInboundMessage({ from: '5215512345678', id: 'wamid.1', type: 'text', text: { body: 'Hola' }, timestamp: '1700000000' }, [{ wa_id: '5215512345678', profile: { name: 'Ana' } }]);
  assert.equal(text.phone, '525512345678');
  assert.equal(text.body, 'Hola');
  assert.equal(text.profileName, 'Ana');
  assert.equal(parseInboundMessage({ from: '5512345678', id: 'w2', type: 'button', button: { text: 'Sí' } }).body, 'Sí');
  assert.match(parseInboundMessage({ from: '5512345678', id: 'w3', type: 'reaction', reaction: { emoji: '👍', message_id: 'w0' } }).body, /👍/);
  assert.equal(parseInboundMessage({ from: '5512345678' }), null);
});

test('describeWhatsAppError y ventana de 24 h', () => {
  assert.match(describeWhatsAppError(131047).reason, /24 h/);
  assert.equal(describeWhatsAppError(999999, 'x').reason, 'x');
  assert.equal(serviceWindowUntil(null), null);
  assert.equal(serviceWindowUntil('2026-01-01T00:00:00Z').toISOString(), '2026-01-02T00:00:00.000Z');
});

test('validación de plantillas y texto', () => {
  const ok = parseTemplateMessage({ to: '5512345678', template: 'recordatorio', parameters: { body: { nombre: 'Ana' }, buttonUrlSuffix: 'a/b' }, ref: 'event:1', metadata: { x: 1 } });
  assert.equal(ok.language, 'es_MX');
  assert.equal(ok.parameters.body.nombre, 'Ana');
  assert.throws(() => parseTemplateMessage({ to: '5512345678' }), /template/);
  assert.throws(() => parseTemplateMessage({ template: 't' }), /to/);
  assert.throws(() => parseTemplateMessage({ to: '1', template: 't', parameters: { body: { a: { b: 1 } } } }), /parameters\.body/);
  assert.throws(() => parseTemplateMessage({ to: '1', template: 't', parameters: { headerImageUrl: 'http://x' } }), /https/);
  assert.throws(() => parseTextMessage({ to: '1', text: '  ' }), /text/);
  assert.deepEqual(listParam(['a,b', 'c']), ['a', 'b', 'c']);
  assert.equal(listParam(undefined), undefined);
});

test('pickInboundOwner: contexto > último saliente > app por defecto del canal > nadie', async () => {
  const { pickInboundOwner } = await import('../src/inbound-owner.js');
  const channel = { defaultClientId: 9 };
  const replied = { clientId: 1, ref: 'a', metadata: '{"x":1}' };
  const latestOut = { clientId: 2, ref: 'b', metadata: null };
  assert.deepEqual(pickInboundOwner({ replied, latestOut, channel }), { clientId: 1, ref: 'a', metadata: '{"x":1}' });
  assert.deepEqual(pickInboundOwner({ replied: null, latestOut, channel }), { clientId: 2, ref: 'b', metadata: null });
  assert.deepEqual(pickInboundOwner({ latestOut: null, channel }), { clientId: 9, ref: null, metadata: null });
  assert.deepEqual(pickInboundOwner({ channel: { defaultClientId: null } }), { clientId: null, ref: null, metadata: null });
});

test('SEND_ALLOWLIST: vacía = sin sandbox; con lista solo pasan esos teléfonos normalizados', async () => {
  const { sendAllowlist, isRecipientAllowed } = await import('../src/sandbox.js');
  assert.equal(sendAllowlist({}), null);
  assert.equal(sendAllowlist({ SEND_ALLOWLIST: '  ' }), null);
  assert.equal(isRecipientAllowed('525512345678', {}), true);
  const env = { SEND_ALLOWLIST: '55 1234 5678, +52 55 9999 0000' };
  assert.equal(isRecipientAllowed('525512345678', env), true);
  assert.equal(isRecipientAllowed('525599990000', env), true);
  assert.equal(isRecipientAllowed('525500000001', env), false);
});

test('simulador de Meta: payloads con phone_number_id, firma y argumentos', async () => {
  const { buildStatusPayload, buildInboundPayload, signMetaBody, parseArgs } = await import('../scripts/simulate-meta-webhook.js');
  const st = buildStatusPayload({ phoneNumberId: '111', wamid: 'wamid.1', status: 'failed', code: '131030' });
  const value = st.entry[0].changes[0].value;
  assert.equal(value.metadata.phone_number_id, '111');
  assert.equal(value.statuses[0].errors[0].code, 131030);
  assert.throws(() => buildStatusPayload({ phoneNumberId: '1', wamid: 'w', status: 'raro' }));
  const inb = buildInboundPayload({ phoneNumberId: '222', from: '+52 55 1234 5678', text: 'Hola', context: 'wamid.9' });
  const m = inb.entry[0].changes[0].value.messages[0];
  assert.equal(m.from, '525512345678');
  assert.equal(m.context.id, 'wamid.9');
  assert.equal(inb.entry[0].changes[0].value.metadata.phone_number_id, '222');
  const { isValidSignature } = await import('../src/meta-webhook.js');
  const raw = Buffer.from(JSON.stringify(inb));
  assert.equal(isValidSignature(raw, signMetaBody('secreto', raw), 'secreto'), true);
  assert.deepEqual(parseArgs(['inbound', '5512', 'hola', '--context', 'w1']), { positional: ['inbound', '5512', 'hola'], flags: { context: 'w1' } });
});

test('tokenFor lee el token de la variable indicada en tokenEnv', async () => {
  const { tokenFor } = await import('../src/channels.js');
  process.env.WA_TOKEN_UNIT = 'abc';
  assert.equal(tokenFor({ tokenEnv: 'WA_TOKEN_UNIT' }), 'abc');
  assert.equal(tokenFor({ tokenEnv: 'NO_EXISTE_VAR' }), null);
  delete process.env.WA_TOKEN_UNIT;
});

test('validateTablePrefix: vacío y válidos pasan, inválidos lanzan error claro', async () => {
  const { validateTablePrefix, buildTables } = await import('../src/tables.js');
  assert.equal(validateTablePrefix(undefined), '');
  assert.equal(validateTablePrefix(''), '');
  assert.equal(validateTablePrefix('msg_'), 'msg_');
  assert.equal(validateTablePrefix('a'.repeat(20)), 'a'.repeat(20));
  for (const bad of ['Msg_', 'msg-', 'msg ', 'msg`', "m'; DROP", 'ñ_', 'a'.repeat(21)]) {
    assert.throws(() => validateTablePrefix(bad), /DB_TABLE_PREFIX inválido/, bad);
  }
  assert.equal(buildTables('msg_').client_channel, '`msg_client_channel`');
  assert.equal(buildTables('').message, '`message`');
});

test('findForeignTables: detecta tablas existentes que no son del mensajero', async () => {
  const { findForeignTables, foreignTablesMessage, EXPECTED_COLUMNS } = await import('../scripts/migrate.js');
  // nada existe, o existe completa (instalación propia): sin problemas
  assert.deepEqual(findForeignTables({}, 'msg_'), []);
  assert.deepEqual(findForeignTables({ msg_client: EXPECTED_COLUMNS.client, msg_message: [...EXPECTED_COLUMNS.message, 'channelId'] }, 'msg_'), []);
  // tabla "client" de otro sistema
  const problems = findForeignTables({ client: ['id', 'nombre', 'email'] }, '');
  assert.equal(problems.length, 1);
  assert.equal(problems[0].table, 'client');
  assert.ok(problems[0].missing.includes('apiKeyHash'));
  assert.match(foreignTablesMessage(problems), /no se tocó nada[\s\S]*client[\s\S]*DB_TABLE_PREFIX/);
  // con prefijo, la tabla ajena sin prefijo no estorba
  assert.deepEqual(findForeignTables({ client: ['id', 'nombre'] }, 'msg_'), []);
});
