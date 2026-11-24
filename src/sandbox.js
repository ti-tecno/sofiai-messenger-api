import { normalizePhone } from './whatsapp.js';

// SEND_ALLOWLIST: teléfonos separados por comas. Si está definida, solo se envía a ellos
// (entorno de pruebas). Se lee en cada llamada para poder cambiarla sin reiniciar pruebas.
export function sendAllowlist(env = process.env) {
  const raw = env.SEND_ALLOWLIST;
  if (!raw || !raw.trim()) return null;
  return new Set(raw.split(',').map((p) => normalizePhone(p.trim())).filter(Boolean));
}

export const isSandbox = () => sendAllowlist() !== null;

// `phone` ya normalizado.
export function isRecipientAllowed(phone, env = process.env) {
  const list = sendAllowlist(env);
  return list === null || list.has(phone);
}
