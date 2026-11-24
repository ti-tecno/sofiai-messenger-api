import { rows } from './db.js';
import { ApiError } from './errors.js';
import { T } from './tables.js';

// Canales (números de WhatsApp). Pocos y casi estáticos: se guardan en memoria y se recargan
// cuando se editan desde admin (un solo proceso; ver CLAUDE.md).
let cache = null; // { list, bySlug, byId, byPhoneNumberId }

export function invalidateChannels() { cache = null; }

export async function ensureChannels() {
  if (cache) return cache;
  const list = await rows(`SELECT * FROM ${T.channel} ORDER BY id`);
  cache = {
    list,
    bySlug: new Map(list.map((c) => [c.slug, c])),
    byId: new Map(list.map((c) => [c.id, c])),
    byPhoneNumberId: new Map(list.filter((c) => c.phoneNumberId).map((c) => [c.phoneNumberId, c])),
  };
  return cache;
}

// Síncrona: requiere que ensureChannels() ya se haya esperado (lo hacen el router y los webhooks).
export const channelSlug = (id) => (id == null ? null : cache?.byId.get(id)?.slug ?? null);
export const channelBySlug = async (slug) => (await ensureChannels()).bySlug.get(slug) ?? null;
export const channelByPhoneNumberId = async (phoneNumberId) => (await ensureChannels()).byPhoneNumberId.get(String(phoneNumberId)) ?? null;

// El token no está en la BD: `tokenEnv` es el NOMBRE de la variable de entorno (NULL = WHATSAPP_TOKEN).
export const tokenFor = (channel) => process.env[channel.tokenEnv || 'WHATSAPP_TOKEN'] || null;

export const isChannelConfigured = (channel) => Boolean(channel && channel.active && channel.phoneNumberId && tokenFor(channel));

// Canales que una app puede usar: [{ ...channel, isDefault }]
export async function clientChannels(clientId) {
  const { byId } = await ensureChannels();
  const links = await rows(`SELECT channelId, isDefault FROM ${T.client_channel} WHERE clientId = ?`, [clientId]);
  return links.filter((l) => byId.has(l.channelId)).map((l) => ({ ...byId.get(l.channelId), isDefault: Boolean(l.isDefault) }));
}

// Canal con el que envía una app: el pedido (debe estar asignado a la app) o su canal por defecto.
export async function resolveSendChannel(client, slug) {
  const allowed = await clientChannels(client.id);
  let channel;
  if (slug) {
    channel = allowed.find((c) => c.slug === slug);
    if (!channel) throw new ApiError(403, 'CHANNEL_NOT_ALLOWED', `Esta app no puede usar el canal "${slug}"`);
  } else {
    channel = allowed.find((c) => c.isDefault);
    if (!channel) throw new ApiError(503, 'NOT_CONFIGURED', 'Esta app no tiene un canal de WhatsApp por defecto');
  }
  if (!isChannelConfigured(channel)) {
    throw new ApiError(503, 'NOT_CONFIGURED', `El canal "${channel.slug}" está inactivo o le falta configuración (número o token)`);
  }
  return channel;
}
