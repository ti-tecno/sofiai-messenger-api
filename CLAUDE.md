# sofiai-messenger-api

Servicio de mensajería WhatsApp (Cloud API de Meta) de SofIA, compartido por cualquier sistema (Eventopolis, CEINVET, IronCore, …). No sabe nada del negocio de cada app: recibe "manda esta plantilla/texto a este teléfono", guarda el estado y avisa por webhook firmado. Especificación: `docs/SPEC.md`. Diseño multisistema: `../docs/diseno-mensajero-multisistema.md`.

## Comandos
- `npm ci` instala dependencias (Node >= 20.6, ESM, Express, mysql2).
- `npm run migrate` crea/actualiza tablas (repetible). Requiere `.env`.
- `npm run dev` arranca con `--watch`; `npm start` en producción (pm2: `pm2 start server.js --name sofiai-messenger`, un solo proceso, nunca cluster ni `pm2 restart all`).
- Desplegar (VPS, pm2 `sofiai-messenger`, código desde GitHub, secretos en `/root/secrets/sofiai-messenger-api/.env`): `tr -d '\r' < deploy/deploy.sh | ssh root@<servidor> 'BRANCH=develop bash -s'`. La primera vez clona y crea el `.env` desde `.env.example` para llenarlo.
- `npm test` corre `node --test`. La prueba de integración solo corre con `TEST_DB_HOST/PORT/USER/PASSWORD/NAME`; **borra las tablas** de esa BD, usar una exclusiva de pruebas. Con `TEST_DB_TABLE_PREFIX=msg_` corre la misma prueba con prefijo; correr ambas (sin y con prefijo) al tocar SQL.

## Estructura
- `server.js`: escucha (http/https). `src/app.js`: crea y exporta `app` (lo importan las pruebas).
- `src/routes.js` (API `/v1`), `src/meta-webhook.js` (entrantes y estados de Meta), `src/outbound-webhooks.js` (avisos a las apps), `src/messages.js` (envío e idempotencia), `src/whatsapp.js` (cliente de Meta), `src/channels.js` (canales: caché, token por `tokenEnv`, `resolveSendChannel`), `src/inbound-owner.js` (a qué app va un entrante, función pura), `src/sandbox.js` (`SEND_ALLOWLIST`), `src/conversations.js`, `src/inbox.js`, `src/validate.js`, `src/auth.js`, `src/db.js`, `src/errors.js`.
- `scripts/migrate.js`: tablas (los ALTER consultan `information_schema`: sirve en MySQL y MariaDB). `scripts/simulate-meta-webhook.js`: simula estados y entrantes de Meta (`npm run simulate -- …`). `docs/`: SPEC y colección Postman. `test/`: pruebas.
- `src/tables.js`: nombres de tablas con el prefijo `DB_TABLE_PREFIX` (`T.client`, `T.message`, `T.channel`, `T.client_channel`, ya entre backticks). Toda consulta SQL usa `${T.x}` en plantillas de texto, nunca el nombre fijo. Índices y FK de `scripts/migrate.js` también llevan el prefijo; la migración aborta si ya existe una tabla con ese nombre sin las columnas del mensajero.
- Variables de entorno: ver `.env.example` (solo nombres).

## Reglas
- Ramas: `feature/*` desde `develop`, PR a `develop`. Sin commits directos a `develop` ni `main`.
- Nunca secretos en git (`.env*` está ignorado; `.env.example` va sin valores). Tokens por canal: variable de entorno cuyo nombre se guarda en `channel.tokenEnv`.
- Un número (canal) por marca: se rutea por `phone_number_id`. El token de cada canal vive en la variable cuyo nombre está en `channel.tokenEnv`. Un solo proceso (la caché de canales es en memoria).
- BD propia y exclusiva; nunca compartirla con otra app. Excepción: en hosting compartido (cPanel) usar `DB_TABLE_PREFIX` (p. ej. `msg_`) para no chocar con tablas de otros sistemas.
- En pruebas y desarrollo no escribir a teléfonos reales: usar el número de prueba de Meta y `SEND_ALLOWLIST`; las pruebas automáticas simulan Meta parchando `fetch`.
- Cambios de API solo aditivos (las apps conectadas no deben romperse).
- Código y mensajes en español, estilo existente.
