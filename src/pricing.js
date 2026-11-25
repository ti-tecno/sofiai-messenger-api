// Costo estimado de WhatsApp. Meta cobra por plantilla entregada según su categoría y el país del
// destinatario; los mensajes de servicio (texto libre dentro de las 24 h) no se cobran. Son tarifas de
// referencia para México en USD: sirven para estimar, no sustituyen la factura de Meta (que además no
// cobra las plantillas de utilidad enviadas dentro de una conversación abierta).
import { listTemplates, WhatsAppError } from './whatsapp.js';
import { tokenFor } from './channels.js';

export const PRICE_MX_USD = { MARKETING: 0.0436, UTILITY: 0.0085, AUTHENTICATION: 0.0085 };
export const priceFor = (category) => PRICE_MX_USD[category] ?? PRICE_MX_USD.UTILITY;

// Categoría de cada plantilla por canal (se pregunta a Meta y se guarda 10 minutos).
const TTL_MS = 10 * 60000;
const cache = new Map(); // channelId -> { at, categories: Map(nombre -> categoría) }

export async function templateCategories(channel) {
  const hit = cache.get(channel.id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.categories;
  if (!channel.wabaId) return hit?.categories ?? new Map();
  try {
    const list = await listTemplates(channel.wabaId, tokenFor(channel));
    const categories = new Map(list.map((t) => [t.name, t.category]));
    cache.set(channel.id, { at: Date.now(), categories });
    return categories;
  } catch (err) {
    if (!(err instanceof WhatsAppError)) throw err;
    return hit?.categories ?? new Map(); // sin Meta se estima como utilidad
  }
}

export const clearPricingCache = () => cache.clear();

// rows: [{ channelId, template, n, ...llaves de agrupación }] → mismas filas con category y cost
export async function priceRows(rows, channelsById) {
  const byChannel = new Map();
  for (const r of rows) {
    if (!byChannel.has(r.channelId)) {
      const channel = channelsById.get(r.channelId);
      byChannel.set(r.channelId, channel ? await templateCategories(channel) : new Map());
    }
  }
  return rows.map((r) => {
    const category = byChannel.get(r.channelId).get(r.template) ?? 'UTILITY';
    return { ...r, category, cost: Number(r.n) * priceFor(category) };
  });
}

// Plantillas cobrables: las salientes que no fallaron (las que se quedaron en "enviado" casi siempre
// llegaron y Meta no avisó; contarlas da un estimado conservador).
export const BILLABLE_SQL = "direction = 'out' AND kind = 'template' AND status IN ('sent','delivered','read')";

export const emptyCost = () => ({ billable: 0, costUsd: 0, byCategory: {} });
export function addCost(target, r) {
  target.billable += Number(r.n);
  target.costUsd = Math.round((target.costUsd + r.cost) * 10000) / 10000;
  target.byCategory[r.category] = (target.byCategory[r.category] ?? 0) + Number(r.n);
}
