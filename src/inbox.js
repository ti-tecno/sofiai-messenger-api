// Funciones puras: errores de entrega de Meta y mensajes entrantes (sin base de datos).
import { normalizePhone } from './whatsapp.js';

// Guests can be answered with free text only within 24 h of their last message
// (WhatsApp "customer service window"); after that, only approved templates.
export const SERVICE_WINDOW_HOURS = 24;

// Código de error de Meta → qué pasó y qué se puede hacer, en español simple.
const ERRORS = {
  131026: ['El número no tiene WhatsApp o no pudo recibir el mensaje', 'Confirma el número con el destinatario o avísale por otro medio.'],
  131030: ['El número no está autorizado (número de prueba de Meta)', 'Solo pasa con el número de prueba; con el número real no aplica.'],
  131042: ['Meta rechazó el envío por un problema con el método de pago', 'Revisa el método de pago en WhatsApp Manager y vuelve a enviar.'],
  131047: ['Pasaron más de 24 h desde el último mensaje del destinatario', 'Solo se pueden mandar plantillas (aprobadas por Meta) hasta que vuelva a escribir.'],
  131049: ['Meta no lo entregó para no saturar al destinatario', 'Intenta más tarde; no lo reenvíes de inmediato.'],
  131050: ['El destinatario pidió no recibir mensajes de este tipo', 'No lo reenvíes; avísale por otro medio.'],
  131051: ['Tipo de mensaje no admitido', 'Reenvía como texto.'],
  131056: ['Demasiados mensajes seguidos a este número', 'Espera unos minutos antes de reenviar.'],
  131021: ['El número es el mismo que envía', 'Corrige el teléfono del destinatario.'],
  131000: ['Error temporal de WhatsApp', 'Vuelve a intentar en unos minutos.'],
  130472: ['Meta está probando un cambio con este número y no lo entregó', 'Intenta más tarde o avísale por otro medio.'],
  132000: ['La plantilla no coincide con sus datos', 'Avísanos: hay que revisar la plantilla.'],
  132001: ['La plantilla no existe o no está aprobada', 'Revisa en WhatsApp Manager que la plantilla esté aprobada.'],
  100: ['El número no es válido', 'Corrige el teléfono del destinatario (10 dígitos).'],
};

export function describeWhatsAppError(code, message) {
  const known = ERRORS[Number(code)];
  if (known) return { reason: known[0], hint: known[1] };
  return { reason: message ? String(message).slice(0, 200) : 'Error de WhatsApp', hint: 'Vuelve a intentar; si se repite, avísanos.' };
}

// One message from a webhook `value.messages[]` → the row to store (null when unusable).
// `contacts` is `value.contacts` (carries the sender's WhatsApp profile name).
export function parseInboundMessage(message, contacts = []) {
  const phone = normalizePhone(message?.from);
  if (!phone || !message?.id) return null;
  const type = String(message.type || 'unknown');
  let body;
  switch (type) {
    case 'text': body = message.text?.body; break;
    case 'button': body = message.button?.text; break;                       // quick reply of a template
    case 'interactive': body = message.interactive?.button_reply?.title ?? message.interactive?.list_reply?.title; break;
    case 'reaction': body = message.reaction?.emoji ? `Reaccionó ${message.reaction.emoji}` : 'Quitó su reacción'; break;
    case 'location': {
      const l = message.location || {};
      body = `[Ubicación] ${l.name ? `${l.name} ` : ''}${l.latitude},${l.longitude}`;
      break;
    }
    case 'image': case 'video': case 'audio': case 'document': case 'sticker': {
      const label = { image: 'Imagen', video: 'Video', audio: 'Audio', document: 'Documento', sticker: 'Sticker' }[type];
      const caption = message[type]?.caption || message[type]?.filename;
      body = `[${label}]${caption ? ` ${caption}` : ''}`;
      break;
    }
    default: body = `[Mensaje de tipo ${type}]`;
  }
  const profile = contacts.find(c => normalizePhone(c?.wa_id) === phone);
  const ts = Number(message.timestamp);
  return {
    phone,
    waMessageId: String(message.id),
    contextWaId: message.context?.id ?? (type === 'reaction' ? message.reaction?.message_id ?? null : null),
    msgType: type.slice(0, 20),
    body: body == null ? null : String(body).slice(0, 4096),
    profileName: profile?.profile?.name ? String(profile.profile.name).slice(0, 255) : null,
    at: Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000) : new Date(),
  };
}

// Until when free text can be sent, given the guest's last incoming message (or null).
export function serviceWindowUntil(lastInboundAt) {
  if (!lastInboundAt) return null;
  return new Date(new Date(lastInboundAt).getTime() + SERVICE_WINDOW_HOURS * 3600000);
}
