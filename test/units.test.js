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
