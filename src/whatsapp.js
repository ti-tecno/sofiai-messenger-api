// Cliente delgado de la WhatsApp Business Cloud API de Meta (sin SDK).
// Docs: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages

const DEFAULT_API_VERSION = 'v27.0';

export class WhatsAppError extends Error {
  constructor(message, { status, code, subcode, details, retryable } = {}) {
    super(message);
    this.name = 'WhatsAppError';
    this.status = status ?? null;
    this.code = code ?? null;
    this.subcode = subcode ?? null;
    this.details = details ?? null;
    this.retryable = Boolean(retryable);
  }
}

// Códigos de Meta que vale la pena reintentar (límite de velocidad / fallas temporales).
const RETRYABLE_CODES = new Set([1, 2, 4, 80007, 130429, 131000, 131016, 131048, 131056, 133004]);

export function isWhatsAppConfigured() {
  return Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
}

// "+52 (55) 1234-5678", "5512345678", "044 55 1234 5678", "521..." → "525512345678" (E.164 sin "+").
// null si no puede ser un destinatario válido.
export function normalizePhone(raw, defaultCountry = process.env.WHATSAPP_DEFAULT_COUNTRY || '52') {
  if (raw === null || raw === undefined) return null;
  let digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;

  if (digits.startsWith('00')) digits = digits.slice(2);
  if (defaultCountry === '52' && digits.length === 13 && (digits.startsWith('044') || digits.startsWith('045'))) {
    digits = digits.slice(3);
  }
  if (digits.length === 10) digits = defaultCountry + digits;
  // México quitó el "1" de móvil tras la lada: los ids de WhatsApp son 52 + 10 dígitos.
  if (digits.startsWith('521') && digits.length === 13) digits = '52' + digits.slice(3);

  if (digits.length < 11 || digits.length > 15) return null;
  return digits;
}

async function graphRequest(path, body) {
  if (!isWhatsAppConfigured()) {
    throw new WhatsAppError('WhatsApp no está configurado en el servidor', { status: 503 });
  }
  const version = process.env.WHATSAPP_API_VERSION || DEFAULT_API_VERSION;

  let response;
  try {
    response = await fetch(`https://graph.facebook.com/${version}/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw new WhatsAppError(`No se pudo contactar a WhatsApp: ${err.message}`, { retryable: true });
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    const e = data.error || {};
    throw new WhatsAppError(e.error_data?.details || e.message || `Error HTTP ${response.status}`, {
      status: response.status,
      code: e.code,
      subcode: e.error_subcode,
      details: e,
      retryable: response.status >= 500 || RETRYABLE_CODES.has(e.code),
    });
  }
  return data;
}

// Plantilla aprobada. `parameters` = { body: {nombre: valor}, buttonUrlSuffix?, headerImageUrl? }.
export async function sendTemplate({ to, template, language = 'es_MX', parameters = {} }) {
  const components = [];

  if (parameters.headerImageUrl) {
    components.push({ type: 'header', parameters: [{ type: 'image', image: { link: parameters.headerImageUrl } }] });
  }

  const bodyEntries = Object.entries(parameters.body || {});
  if (bodyEntries.length) {
    components.push({
      type: 'body',
      parameters: bodyEntries.map(([name, value]) => ({
        type: 'text',
        parameter_name: name,
        // WhatsApp rechaza vacíos y saltos de línea, tabs o 4+ espacios en las variables.
        text: String(value ?? '').replace(/[\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim() || '-',
      })),
    });
  }

  if (parameters.buttonUrlSuffix) {
    components.push({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: parameters.buttonUrlSuffix }] });
  }

  const data = await graphRequest(`${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: { name: template, language: { code: language }, components },
  });
  return { messageId: data.messages?.[0]?.id ?? null };
}

// Texto libre: solo llega si el destinatario escribió en las últimas 24 h (error 131047 si no).
export async function sendText({ to, text, previewUrl = true }) {
  const data = await graphRequest(`${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { body: text, preview_url: previewUrl },
  });
  return { messageId: data.messages?.[0]?.id ?? null };
}

export async function createTemplate(wabaId, definition) {
  return graphRequest(`${wabaId}/message_templates`, definition);
}
