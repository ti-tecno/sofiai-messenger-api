import { ApiError } from './errors.js';

const bad = (message) => new ApiError(400, 'VALIDATION', message);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function optString(body, key, max) {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw bad(`${key} debe ser un texto de 1 a ${max} caracteres`);
  return v;
}

// Campos comunes a cualquier mensaje: to, channel (slug, opcional), ref, metadata, idempotencyKey.
function common(body) {
  if (!isObject(body)) throw bad('El cuerpo debe ser un objeto JSON');
  if (typeof body.to !== 'string' && typeof body.to !== 'number') throw bad('to (teléfono) es requerido');
  const out = { to: String(body.to), channel: optString(body, 'channel', 50), ref: optString(body, 'ref', 100), idempotencyKey: optString(body, 'idempotencyKey', 100) };
  if (body.metadata !== undefined && body.metadata !== null) {
    if (!isObject(body.metadata) || JSON.stringify(body.metadata).length > 4096) throw bad('metadata debe ser un objeto JSON de máximo 4 KB');
    out.metadata = body.metadata;
  }
  return out;
}

export function parseTemplateMessage(body) {
  const out = { kind: 'template', ...common(body) };
  out.template = optString(body, 'template', 100);
  if (!out.template) throw bad('template es requerido');
  out.language = optString(body, 'language', 10) ?? 'es_MX';

  const p = body.parameters ?? {};
  if (!isObject(p)) throw bad('parameters debe ser un objeto');
  const parameters = {};
  if (p.body !== undefined) {
    if (!isObject(p.body) || Object.values(p.body).some((v) => v !== null && typeof v === 'object')) {
      throw bad('parameters.body debe ser un objeto { nombre: valor } con valores de texto o número');
    }
    parameters.body = p.body;
  }
  if (p.buttonUrlSuffix !== undefined) {
    if (typeof p.buttonUrlSuffix !== 'string' || !p.buttonUrlSuffix || p.buttonUrlSuffix.length > 500) throw bad('parameters.buttonUrlSuffix debe ser un texto');
    parameters.buttonUrlSuffix = p.buttonUrlSuffix;
  }
  if (p.headerImageUrl !== undefined) {
    if (typeof p.headerImageUrl !== 'string' || !/^https:\/\//.test(p.headerImageUrl)) throw bad('parameters.headerImageUrl debe ser una URL https');
    parameters.headerImageUrl = p.headerImageUrl;
  }
  out.parameters = parameters;
  return out;
}

export function parseTextMessage(body) {
  const out = { kind: 'text', ...common(body) };
  if (typeof body.text !== 'string' || !body.text.trim()) throw bad('text es requerido');
  if (body.text.length > 4096) throw bad('text no puede pasar de 4096 caracteres');
  out.text = body.text.trim();
  return out;
}

// ?ref=a&ref=b o ?ref=a,b → ['a','b'] (o undefined)
export function listParam(value) {
  if (value === undefined) return undefined;
  const list = (Array.isArray(value) ? value : [value]).flatMap((v) => String(v).split(',')).map((v) => v.trim()).filter(Boolean);
  return list.length ? list : undefined;
}

export function dateParam(value, name) {
  if (value === undefined) return undefined;
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) throw bad(`${name} debe ser una fecha ISO 8601`);
  return d;
}

export function intParam(value, { name, min = 0, max, fallback }) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${name} debe ser un entero entre ${min} y ${max}`);
  return n;
}
