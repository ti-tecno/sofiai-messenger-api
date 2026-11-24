// Nombres de las tablas del mensajero, con el prefijo configurable DB_TABLE_PREFIX.
// Permite compartir una BD (p. ej. hosting cPanel) con tablas de otros sistemas.
// Los nombres salen solo de la configuración (nunca de la petición) y ya vienen entre backticks:
// usar `${T.message}` dentro de las consultas SQL.

export const BASE_TABLES = ['client', 'message', 'channel', 'client_channel'];
const MAX_PREFIX = 20;

// Devuelve el prefijo validado ('' = sin prefijo). Lanza un Error claro si no es válido.
export function validateTablePrefix(prefix) {
  const p = prefix ?? '';
  if (typeof p !== 'string' || p.length > MAX_PREFIX || !/^[a-z0-9_]*$/.test(p)) {
    throw new Error(`DB_TABLE_PREFIX inválido: solo se permiten letras minúsculas, dígitos y guion bajo ([a-z0-9_]), máximo ${MAX_PREFIX} caracteres.`);
  }
  return p;
}

// { client: '`msg_client`', ... } para un prefijo dado.
export function buildTables(prefix) {
  const p = validateTablePrefix(prefix);
  return Object.freeze(Object.fromEntries(BASE_TABLES.map((n) => [n, `\`${p}${n}\``])));
}

// Nombre sin backticks (para information_schema y para nombrar índices/llaves foráneas).
export const rawName = (prefix, base) => `${validateTablePrefix(prefix)}${base}`;

// Al importar este módulo se valida la configuración: si es inválida, no arranca (servidor ni migración).
function configuredPrefix() {
  try { return validateTablePrefix(process.env.DB_TABLE_PREFIX?.trim()); } catch (err) {
    console.error(`Error de configuración: ${err.message}`);
    process.exit(1);
  }
}
export const TABLE_PREFIX = configuredPrefix();
export const T = buildTables(TABLE_PREFIX);
export const tn = (base) => rawName(TABLE_PREFIX, base);
