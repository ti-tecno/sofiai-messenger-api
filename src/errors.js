export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// código + mensaje sin sql/sqlMessage ni valores (mysql2 incluye el SQL en `message` y `sqlMessage`).
export function safeErrorSummary(err) {
  const code = err?.code || err?.name || 'Error';
  let msg = String(err?.message ?? '');
  for (const v of [err?.sql, err?.sqlMessage]) if (v) msg = msg.split(String(v)).join('[sql]');
  msg = msg.replace(/\b(?:insert|update|delete|select)\b[\s\S]*$/i, '[sql]').replace(/'[^']*'/g, "'?'").slice(0, 300);
  return `[${code}] ${msg}`;
}

export function errorHandler(err, _req, res, _next) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, ...err.extra } });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'El cuerpo no es un JSON válido' } });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'El cuerpo es demasiado grande' } });
  }
  // No se registra el objeto completo: los errores de mysql2 traen el SQL con valores (secretos, teléfonos).
  console.error(`Error no controlado: ${_req?.method ?? ''} ${_req?.originalUrl?.split('?')[0] ?? ''} ${safeErrorSummary(err)}`.replace(/\s+/g, ' ').trim());
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Error interno del servidor' } });
}
