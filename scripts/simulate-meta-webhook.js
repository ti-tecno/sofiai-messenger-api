// Simulador del webhook de Meta para probar en local sin túnel ni mensajes reales.
// Firma con WHATSAPP_APP_SECRET y hace POST a /webhooks/whatsapp del mensajero local.
//
//   node --env-file=.env scripts/simulate-meta-webhook.js status <wamid> delivered|read|failed [codigo] [--channel slug]
//   node --env-file=.env scripts/simulate-meta-webhook.js inbound <telefono> "<texto>" [--context <wamid>] [--name "Ana"] [--channel slug]
//
// Opciones: --channel <slug> (canal cuyo phone_number_id se usa; sin ella, WHATSAPP_PHONE_NUMBER_ID o el único canal),
//           --phone-number-id <id>, --url <url> (por defecto http://127.0.0.1:$PORT/webhooks/whatsapp).
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const sign = (secret, body) => `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
export { sign as signMetaBody };

const envelope = (phoneNumberId, value) => ({
  object: 'whatsapp_business_account',
  entry: [{
    id: 'SIMULADO',
    changes: [{
      field: 'messages',
      value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '0000000000', phone_number_id: String(phoneNumberId) }, ...value },
    }],
  }],
});

export function buildStatusPayload({ phoneNumberId, wamid, status, code, now = Date.now() }) {
  if (!['sent', 'delivered', 'read', 'failed'].includes(status)) throw new Error('status debe ser sent, delivered, read o failed');
  const entry = { id: wamid, status, timestamp: String(Math.floor(now / 1000)), recipient_id: '0000000000' };
  if (status === 'failed') {
    entry.errors = [{ code: Number(code ?? 131026), title: 'Error simulado', message: 'Error simulado', error_data: { details: 'Error simulado por simulate-meta-webhook' } }];
  }
  return envelope(phoneNumberId, { statuses: [entry] });
}

export function buildInboundPayload({ phoneNumberId, from, text, context, name = 'Simulado', now = Date.now(), id = `wamid.SIM${crypto.randomBytes(8).toString('hex')}` }) {
  const message = { from: String(from).replace(/\D/g, ''), id, timestamp: String(Math.floor(now / 1000)), type: 'text', text: { body: text } };
  if (context) message.context = { id: context };
  return envelope(phoneNumberId, { contacts: [{ wa_id: message.from, profile: { name } }], messages: [message] });
}

export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) { flags[argv[i].slice(2)] = argv[i + 1]; i += 1; } else positional.push(argv[i]);
  }
  return { positional, flags };
}

async function resolvePhoneNumberId(flags) {
  if (flags['phone-number-id']) return flags['phone-number-id'];
  if (!flags.channel && process.env.WHATSAPP_PHONE_NUMBER_ID) return process.env.WHATSAPP_PHONE_NUMBER_ID;
  const { pool } = await import('../src/db.js');
  const { T } = await import('../src/tables.js');
  try {
    const list = flags.channel
      ? (await pool.query(`SELECT phoneNumberId FROM ${T.channel} WHERE slug = ?`, [flags.channel]))[0]
      : (await pool.query(`SELECT phoneNumberId FROM ${T.channel} WHERE active = 1 AND phoneNumberId IS NOT NULL`))[0];
    if (!list.length) throw new Error(flags.channel ? `No existe el canal "${flags.channel}"` : 'No hay canales; usa --channel o --phone-number-id');
    if (list.length > 1) throw new Error('Hay varios canales; indica --channel <slug>');
    if (!list[0].phoneNumberId) throw new Error('El canal no tiene phoneNumberId');
    return list[0].phoneNumberId;
  } finally {
    await pool.end();
  }
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [kind, ...rest] = positional;
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) throw new Error('Falta WHATSAPP_APP_SECRET (usa: node --env-file=.env scripts/simulate-meta-webhook.js …)');
  const phoneNumberId = await resolvePhoneNumberId(flags);

  let payload;
  if (kind === 'status' && rest.length >= 2) {
    payload = buildStatusPayload({ phoneNumberId, wamid: rest[0], status: rest[1], code: rest[2] });
  } else if (kind === 'inbound' && rest.length >= 2) {
    payload = buildInboundPayload({ phoneNumberId, from: rest[0], text: rest.slice(1).join(' '), context: flags.context, name: flags.name });
  } else {
    console.error('Uso:\n  status <wamid> delivered|read|failed [codigo] [--channel slug]\n  inbound <telefono> "<texto>" [--context <wamid>] [--name nombre] [--channel slug]');
    process.exit(2);
  }

  const url = flags.url || `http://127.0.0.1:${process.env.PORT || 5100}/webhooks/whatsapp`;
  const body = JSON.stringify(payload);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sign(secret, body) },
    body,
  });
  console.log(`${kind} -> ${url}: HTTP ${response.status}`);
  if (kind === 'inbound') console.log(`wamid simulado: ${payload.entry[0].changes[0].value.messages[0].id}`);
  if (!response.ok) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(`Error: ${err.message}`); process.exit(1); });
}
