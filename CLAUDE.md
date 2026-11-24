# sofiai-messenger-api

Servicio de mensajería WhatsApp (Cloud API de Meta) de SofIA, compartido por cualquier sistema (Eventopolis, CEINVET, IronCore, …). No sabe nada del negocio de cada app: recibe "manda esta plantilla/texto a este teléfono", guarda el estado y avisa por webhook firmado. Especificación: `docs/SPEC.md`. Diseño multisistema: `../docs/diseno-mensajero-multisistema.md`.

## Comandos
- `npm ci` instala dependencias (Node >= 20.6, ESM, Express, mysql2).
- `npm run migrate` crea/actualiza tablas (repetible). Requiere `.env`.
- `npm run dev` arranca con `--watch`; `npm start` en producción (pm2: `pm2 start server.js --name sofiai-messenger`, un solo proceso, nunca cluster ni `pm2 restart all`).
- `npm test` corre `node --test`. La prueba de integración solo corre con `TEST_DB_HOST/PORT/USER/PASSWORD/NAME`; **borra las tablas** de esa BD, usar una exclusiva de pruebas.

## Estructura
- `server.js`: escucha (http/https). `src/app.js`: crea y exporta `app` (lo importan las pruebas).
- `src/routes.js` (API `/v1`), `src/meta-webhook.js` (entrantes y estados de Meta), `src/outbound-webhooks.js` (avisos a las apps), `src/messages.js` (envío e idempotencia), `src/whatsapp.js` (cliente de Meta), `src/conversations.js`, `src/inbox.js`, `src/validate.js`, `src/auth.js`, `src/db.js`, `src/errors.js`.
- `scripts/migrate.js`: tablas. `docs/`: SPEC y colección Postman. `test/`: pruebas.
- Variables de entorno: ver `.env.example` (solo nombres).

## Reglas
- Ramas: `feature/*` desde `develop`, PR a `develop`. Sin commits directos a `develop` ni `main`.
- Nunca secretos en git (`.env*` está ignorado; `.env.example` va sin valores). Tokens por canal: variable de entorno cuyo nombre se guarda en `channel.tokenEnv`.
- BD propia y exclusiva; nunca compartirla con otra app.
- En pruebas y desarrollo no escribir a teléfonos reales: usar el número de prueba de Meta y `SEND_ALLOWLIST`; las pruebas automáticas simulan Meta parchando `fetch`.
- Cambios de API solo aditivos (las apps conectadas no deben romperse).
- Código y mensajes en español, estilo existente.
