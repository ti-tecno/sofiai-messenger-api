// A qué app (y ref/metadata) pertenece un mensaje entrante. Función pura: recibe lo que ya se
// consultó en la BD, siempre dentro del MISMO canal.
//   1. `replied`: el saliente al que contestó (context.id);
//   2. `latestOut`: el último saliente a ese teléfono;
//   3. la app por defecto del canal (sin ref ni metadata);
//   4. nadie (clientId null): se guarda y no se notifica.
export function pickInboundOwner({ replied, latestOut, channel }) {
  if (replied?.clientId) return { clientId: replied.clientId, ref: replied.ref ?? null, metadata: replied.metadata ?? null };
  if (latestOut?.clientId) return { clientId: latestOut.clientId, ref: latestOut.ref ?? null, metadata: latestOut.metadata ?? null };
  if (channel?.defaultClientId) return { clientId: channel.defaultClientId, ref: null, metadata: null };
  return { clientId: null, ref: null, metadata: null };
}
