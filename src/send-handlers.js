// Envío en nombre de una app: lo usan la API de las apps (/v1/messages/*, con su llave) y el
// backoffice (/v1/admin/console/clients/:id/messages/*, con la llave de administración).
// Mismas reglas en ambos casos: canal asignado a la app, límite diario, sandbox, idempotencia
// y ventana de 24 h para texto libre.
import { ApiError } from './errors.js';
import { normalizePhone } from './whatsapp.js';
import { sendMessage, toApiResult, SEND_PAUSE_MS, sleep } from './messages.js';
import { windowOpen } from './conversations.js';
import { resolveSendChannel } from './channels.js';
import { isRecipientAllowed } from './sandbox.js';
import { parseTemplateMessage, parseTextMessage } from './validate.js';

export const MAX_BATCH = 100;

// Traduce el resultado de sendMessage a la respuesta HTTP de un envío individual.
export function respondSend(res, result) {
  const message = toApiResult(result);
  switch (result.status) {
    case 'sent': return res.status(201).json({ message });
    case 'duplicate': return res.status(200).json({ message, duplicate: true });
    case 'skipped':
      if (result.reason === 'daily_limit') throw new ApiError(429, 'DAILY_LIMIT', 'Se alcanzó el límite diario de mensajes de esta app');
      if (result.reason === 'not_allowed') throw new ApiError(403, 'RECIPIENT_NOT_ALLOWED', 'El teléfono no está en SEND_ALLOWLIST (modo sandbox)');
      throw new ApiError(422, 'INVALID_PHONE', 'El teléfono no es válido para WhatsApp');
    default:
      return res.status(502).json({ error: { ...message.error, code: 'SEND_FAILED' }, message });
  }
}

// `decorate(input)` permite al backoffice marcar el origen en metadata sin cambiar las reglas.
export async function sendTemplateAs(client, body, res, decorate = (x) => x) {
  const input = decorate(parseTemplateMessage(body));
  const channel = await resolveSendChannel(client, input.channel);
  respondSend(res, await sendMessage(client, channel, input));
}

// Texto libre: solo dentro de las 24 h posteriores a que el destinatario escribió.
export async function sendTextAs(client, body, res, decorate = (x) => x) {
  const input = decorate(parseTextMessage(body));
  const channel = await resolveSendChannel(client, input.channel);
  const phone = normalizePhone(input.to);
  if (phone && !isRecipientAllowed(phone)) throw new ApiError(403, 'RECIPIENT_NOT_ALLOWED', 'El teléfono no está en SEND_ALLOWLIST (modo sandbox)');
  if (phone && !(await windowOpen(client.id, channel.id, phone))) {
    throw new ApiError(409, 'WINDOW_CLOSED', 'Pasaron más de 24 h desde el último mensaje del destinatario: solo se pueden enviar plantillas.');
  }
  respondSend(res, await sendMessage(client, channel, input));
}

// Hasta 100 plantillas; secuencial, y se detiene ante errores que harían fallar todo
// (token, plantilla, pago, límite diario).
export async function sendBatchAs(client, body, res, decorate = (x) => x) {
  const list = body?.messages;
  if (!Array.isArray(list) || !list.length || list.length > MAX_BATCH) {
    throw new ApiError(400, 'VALIDATION', `messages debe ser una lista de 1 a ${MAX_BATCH} mensajes`);
  }
  const inputs = list.map((item, i) => {
    try { return decorate(parseTemplateMessage(item)); } catch (err) { throw new ApiError(400, 'VALIDATION', `messages[${i}]: ${err.message}`); }
  });

  // Los canales se validan todos antes de enviar nada (403/503 rechaza el lote completo).
  const channels = new Map();
  for (const input of inputs) {
    if (!channels.has(input.channel ?? null)) channels.set(input.channel ?? null, await resolveSendChannel(client, input.channel));
  }

  const results = [];
  let aborted = null;
  for (let i = 0; i < inputs.length; i += 1) {
    if (aborted) { results.push({ index: i, status: 'not_attempted' }); continue; }
    const r = await sendMessage(client, channels.get(inputs[i].channel ?? null), inputs[i]);
    results.push({
      index: i,
      status: r.status,
      ...(r.reason ? { reason: r.reason } : {}),
      ...(r.message ? { message: toApiResult(r) } : {}),
      ...(r.status === 'failed' && r.message ? { error: toApiResult(r).error } : {}),
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
}
