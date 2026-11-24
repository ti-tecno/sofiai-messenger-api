# eventopolis-messaging-api

API de mensajería WhatsApp (Cloud API de Meta) compartida por todo el software de Eventopolis, con base de datos propia.
Especificación completa: **[docs/SPEC.md](docs/SPEC.md)**.

```bash
cp .env.example .env      # completar BD, ADMIN_API_KEY y WHATSAPP_*
npm ci
npm run migrate           # crea las tablas client y message (repetible)
npm start                 # o: pm2 start server.js --name messaging-api

# crear una app cliente (la llave se muestra una sola vez)
curl -X POST https://HOST/v1/admin/clients -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Eventopolis","webhookUrl":"https://HOST_DE_LA_APP/ruta","dailyLimit":2000}'
```

Pruebas: `npm test` (unitarias). La de integración corre con una BD vacía:
`TEST_DB_HOST=127.0.0.1 TEST_DB_PORT=3306 TEST_DB_USER=… TEST_DB_PASSWORD=… TEST_DB_NAME=msgtest npm test`
— **borra** las tablas `client` y `message` de esa BD, usa una de pruebas.

# Eventopolis Messaging API — Especificación v1

API REST para enviar y recibir mensajes de **WhatsApp** (Cloud API de Meta). Está pensada para que **cualquier software de Eventopolis** (backend de eventos, CRM, apps nuevas…) envíe mensajes sin hablar directamente con Meta y sin tener tablas de mensajes propias.

Esta API **no sabe nada de eventos, invitaciones ni usuarios de Eventopolis**. Solo conoce: *a qué teléfono mando qué plantilla o texto*, *en qué estado quedó* y *qué contestó la persona*. Todo lo demás lo decide la app que la usa (cuándo enviar, a quién, qué texto) y lo ata con dos campos libres: `ref` y `metadata`.

```
 ┌────────────────┐   POST /v1/messages/...    ┌──────────────────────┐   Cloud API   ┌────────┐
 │ App cliente    │ ─────────────────────────▶ │ Messaging API        │ ────────────▶ │  Meta  │
 │ (eventopolis-  │                            │  · BD propia         │ ◀──────────── │        │
 │  api, CRM, …)  │ ◀───────────────────────── │  · 1 número WhatsApp │   webhook     └────────┘
 └────────────────┘   webhooks firmados        └──────────────────────┘
                      message.status / message.received
```

## 1. Conceptos

| Concepto | Qué es |
|---|---|
| **App cliente** | Cada software que usa la API. Tiene su propia llave, su propio historial (no ve el de otras), su `webhookUrl` y un `dailyLimit` opcional. |
| **Mensaje** | Un renglón por mensaje, enviado (`direction: out`) o recibido (`in`). Dos tipos: `template` (plantilla aprobada por Meta) o `text` (texto libre). |
| **`ref`** | Texto libre (≤100) para agrupar mensajes, p. ej. `event:14`. Se puede filtrar por él en consultas y conversaciones. Los mensajes entrantes heredan el `ref` del último envío a ese teléfono. |
| **`metadata`** | Objeto JSON libre (≤4 KB) que la API guarda y devuelve tal cual, p. ej. `{ "invitationId": 7 }`. Es la forma de saber a qué cosa de tu sistema se refiere un mensaje. |
| **`idempotencyKey`** | Texto único por app (≤100). Repetir una petición con la misma llave **no** manda el mensaje otra vez (§4). |
| **Ventana de 24 h** | WhatsApp solo permite **texto libre** a quien te escribió en las últimas 24 h. Fuera de ella, solo plantillas. |

## 2. Convenciones

- Base: `https://<host>/v1`. JSON en peticiones y respuestas (`Content-Type: application/json`).
- **Autenticación** (todas las rutas salvo `/health` y `/webhooks/whatsapp`): `Authorization: Bearer msk_…` (también se acepta `X-API-Key`). Las rutas `/v1/admin/*` usan la llave de administración.
- Fechas en ISO 8601 UTC. Teléfonos: se aceptan en cualquier formato (`+52 (55) 1234-5678`, `5512345678`, `044…`); se guardan y devuelven normalizados como `525512345678` (lada + 10 dígitos, sin `+`).
- **Errores**: HTTP 4xx/5xx con

```json
{ "error": { "code": "VALIDATION", "message": "template es requerido" } }
```

| HTTP | `code` | Cuándo |
|---|---|---|
| 400 | `VALIDATION`, `INVALID_JSON` | Cuerpo o parámetros inválidos |
| 401 | `UNAUTHORIZED` | Falta la llave o es inválida |
| 403 | `CLIENT_DISABLED` | La app está desactivada |
| 404 | `NOT_FOUND` | No existe (o es de otra app) |
| 409 | `WINDOW_CLOSED` | Texto libre fuera de la ventana de 24 h |
| 413 | `PAYLOAD_TOO_LARGE` | Cuerpo > 1 MB |
| 422 | `INVALID_PHONE` | El teléfono no puede ser de WhatsApp |
| 429 | `DAILY_LIMIT` | La app alcanzó su límite de mensajes en 24 h |
| 502 | `SEND_FAILED` | Meta rechazó el envío (el mensaje queda guardado como `failed`) |
| 503 | `NOT_CONFIGURED`, `ADMIN_DISABLED` | Falta configuración en el servidor |

## 3. El objeto Mensaje

```json
{
  "id": "6f1c2c3e-0d6e-4c3a-9b52-1f0d1f7a9a11",
  "direction": "out",
  "kind": "template",
  "phone": "525512345678",
  "template": "recordatorio_evento",
  "parameters": { "language": "es_MX", "body": { "nombre": "Ana" }, "buttonUrlSuffix": "abc/def" },
  "text": null,
  "ref": "event:14",
  "metadata": { "invitationId": 7 },
  "idempotencyKey": "event_reminder:7:d7",
  "status": "delivered",
  "error": null,
  "msgType": null,
  "profileName": null,
  "readAt": null,
  "createdAt": "2026-11-23T18:00:00.000Z",
  "updatedAt": "2026-11-23T18:00:03.120Z"
}
```

**`status`**: `sending` → `sent` → `delivered` → `read`, o `failed`; los entrantes son `received`. Solo avanza (un aviso tardío nunca lo retrocede). Cuando es `failed`:

```json
"error": { "code": 131026, "message": "…de Meta…", "reason": "El número no tiene WhatsApp o no pudo recibir el mensaje", "hint": "Confirma el número con el destinatario o avísale por otro medio." }
```

`reason` y `hint` están en español, pensados para mostrarse a una persona. En mensajes entrantes `text` es el contenido (los adjuntos llegan como `[Imagen]`, `[Audio]`, `[Ubicación] lat,lng`…), `msgType` es el tipo de WhatsApp y `profileName` el nombre de perfil de quien escribió.

## 4. Envío

### `POST /v1/messages/template`
Envía una plantilla **ya aprobada** en Meta.

```json
{
  "to": "55 1234 5678",
  "template": "recordatorio_evento",
  "language": "es_MX",
  "parameters": {
    "body": { "nombre": "Ana", "evento": "Boda I&F", "fecha": "sábado 5 de diciembre" },
    "buttonUrlSuffix": "eventoHex/contactoHex",
    "headerImageUrl": "https://…/foto.jpg"
  },
  "ref": "event:14",
  "metadata": { "invitationId": 7 },
  "idempotencyKey": "event_reminder:7:d7"
}
```

Requeridos: `to`, `template`. `language` por defecto `es_MX`. `parameters.body` es `{ nombreDeVariable: valor }` (las plantillas usan variables con nombre); los valores se limpian (sin saltos de línea, tabs ni 4+ espacios, nunca vacíos) porque Meta los rechaza. `buttonUrlSuffix` es lo que se agrega a la URL del botón de la plantilla. `headerImageUrl` debe ser `https`.

Respuestas: **201** `{ "message": {…} }` · **200** `{ "message": {…}, "duplicate": true }` (misma `idempotencyKey`) · **422** `INVALID_PHONE` · **429** `DAILY_LIMIT` · **502** `SEND_FAILED` (con `error` y `message`).

**Idempotencia.** El mensaje se guarda *antes* de llamar a Meta y la llave `(app, idempotencyKey)` es única. Reintentar tras un timeout, o desde otro proceso, devuelve el mismo mensaje sin volver a enviar ni volver a cobrar (también cuando ya se agotó el límite diario). Si el envío falla por algo **reintentable** (límite de Meta, caída temporal, error de configuración), la llave se libera y la misma petición puede volver a intentarse. Si falla por algo del destinatario (número sin WhatsApp), la llave se conserva: no se reintenta sola.

### `POST /v1/messages/template/batch`
Hasta **100** plantillas en una petición: `{ "messages": [ {…igual que arriba…}, … ] }`. Se envían en orden, ~20 por segundo. Se detiene (y marca el resto `not_attempted`) ante errores que harían fallar a todos: token inválido, plantilla inexistente, problema de pago o límite diario.

```json
{
  "summary": { "sent": 1, "duplicate": 1, "skipped": 1, "failed": 0, "notAttempted": 0 },
  "aborted": false,
  "results": [
    { "index": 0, "status": "sent", "message": {…} },
    { "index": 1, "status": "duplicate", "message": {…} },
    { "index": 2, "status": "skipped", "reason": "invalid_phone" }
  ]
}
```

HTTP 200, o **502** si `aborted` es true (con `abortReason`). Un `messages[i]` mal formado rechaza todo el lote con 400 antes de enviar nada.

### `POST /v1/messages/text`
Texto libre: `{ "to", "text" (≤4096), "ref"?, "metadata"?, "idempotencyKey"? }`. Solo si ese teléfono le escribió **a tu app** en las últimas 24 h; si no, **409 `WINDOW_CLOSED`**. Mismas respuestas que la plantilla.

## 5. Consulta

### `GET /v1/messages`
Mensajes de tu app, el más reciente primero. Filtros (todos opcionales, se combinan):

`ref` (varios: `ref=a&ref=b` o `ref=a,b`) · `phone` · `direction` (`in`/`out`) · `kind` (`template`/`text`) · `template` · `status` (lista) · `excludeStatus` (lista, p. ej. `failed`) · `since` / `until` (ISO) · `limit` (1–1000, por defecto 50) · `offset`.

→ `{ "data": [Mensaje…], "limit": 50, "offset": 0 }`

Sirve para el historial por evento, para saber "¿a quién ya le mandé esto?" (`ref=event:14&template=recordatorio_evento&excludeStatus=failed`) y para reconciliar si perdiste un webhook (`since=<última fecha vista>`).

### `GET /v1/messages/:id` → `{ "message": {…} }` (404 si es de otra app)

## 6. Conversaciones (lo que contestan)

Una *conversación* es un teléfono que alguna vez escribió a tu app.

- `GET /v1/conversations?ref=` → `{ "data": [ { phone, ref, profileName, unread, lastInboundAt, windowUntil, last: { direction, kind, text, status, at } } ] }`, la más reciente primero. `windowUntil` es hasta cuándo puedes mandar texto libre.
- `GET /v1/conversations/unread?ref=` → `{ "unread": 3 }` (sin `ref`: todos los de la app).
- `GET /v1/conversations/:phone?ref=` → `{ phone, profileName, windowUntil, messages: [Mensaje…] }`, el hilo completo (plantillas y texto, entrantes y salientes), el más viejo primero.
- `POST /v1/conversations/:phone/read` con `{ "ref"?: … }` → `{ "updated": 2 }`. Marca como leídos los entrantes.

**¿A qué app llega lo que contesta una persona?** Como todas las apps comparten un solo número de WhatsApp, se asigna así: (1) si la persona *respondió a un mensaje concreto*, a la app que lo envió; (2) si no, a la app que le envió el último mensaje. Si nunca se le mandó nada, el mensaje queda sin dueño y no se entrega a nadie. El mensaje entrante hereda `ref` y `metadata` del mensaje al que se atribuyó.

## 7. Webhooks hacia tu app

Si tu app tiene `webhookUrl`, la API le hace `POST` (JSON) cuando:

| `event` | Cuándo | `data` |
|---|---|---|
| `message.status` | Meta cambió el estado de un mensaje tuyo (`delivered`, `read`, `failed`) | el Mensaje actualizado |
| `message.received` | Alguien te contestó | el Mensaje entrante |

```json
{ "event": "message.received", "createdAt": "2026-11-23T18:05:00.000Z", "data": { …Mensaje… } }
```

Cabecera **`X-Signature-256: sha256=<hex>`** = HMAC-SHA256 del **cuerpo crudo** con tu `webhookSecret`. Verifícala siempre:

```js
import crypto from 'node:crypto';
const expected = 'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
const ok = header.length === expected.length && crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
```

Responde **2xx** rápido. Se reintenta 3 veces (de inmediato, a 1 s y a 5 s) ante red caída, 5xx o 429; un 4xx no se reintenta. Los reintentos viven en memoria: si algo se pierde, reconcilia con `GET /v1/messages?since=`. Puede llegar el mismo evento más de una vez: usa `data.id` y `data.status` para que tu manejo sea idempotente.

## 8. Administración (llave `ADMIN_API_KEY`)

- `POST /v1/admin/clients` `{ name, webhookUrl?, dailyLimit?, active? }` → **201** `{ client, apiKey, webhookSecret }`. La `apiKey` y el `webhookSecret` **se muestran una sola vez**; en la BD de la API solo queda el hash de la llave.
- `GET /v1/admin/clients` → apps registradas (sin secretos).
- `PATCH /v1/admin/clients/:id` `{ name?, webhookUrl?, dailyLimit?, active?, rotateKey?: true, rotateWebhookSecret?: true }`. Rotar devuelve la llave o secreto nuevos y los anteriores dejan de funcionar al instante. `active: false` bloquea la app.
- `POST /v1/admin/templates` con la definición de plantilla de Meta (`{ name, language, category, components }`) → la crea en la cuenta de WhatsApp Business (Meta la revisa; tarda de minutos a horas). Requiere `WHATSAPP_BUSINESS_ACCOUNT_ID`.

`dailyLimit` cuenta los mensajes salientes **no fallidos** de las últimas 24 h: es un tope de gasto si una app se descontrola o se filtra su llave. `null` = sin límite.

## 9. Otras rutas

- `GET /health` → `{ "status": "ok" }` (503 `db_error` si la BD no responde). Sin autenticación.
- `GET /v1/me` → tu app y si WhatsApp está configurado; útil para probar una llave.
- `GET|POST /webhooks/whatsapp` — **solo para Meta** (verificación y eventos, con firma `X-Hub-Signature-256` y `WHATSAPP_APP_SECRET`). Es la URL que se pone en la configuración del webhook de la app de Meta: `https://<host>/webhooks/whatsapp`.

## 10. Datos y costos

Base de datos **propia** de esta API (MySQL/MariaDB), dos tablas: `client` y `message` (`npm run migrate` las crea y se puede repetir sin riesgo). No comparte BD con ningún otro sistema.

Meta cobra **cada plantilla entregada** (también las de utilidad) y los números nuevos arrancan con límites de envío bajos. Esta API no decide a quién mandar: usa `dailyLimit` e `idempotencyKey` para que ninguna app gaste de más ni repita.

## 11. Configuración del servidor

Variables (ver `.env.example`): `PORT`, `DB_HOST/PORT/NAME/USER/PASSWORD`, `ADMIN_API_KEY` (≥24 caracteres), `WHATSAPP_TOKEN` (token permanente de un usuario del sistema), `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_ACCOUNT_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_API_VERSION` (por defecto `v27.0`), `WHATSAPP_DEFAULT_COUNTRY` (por defecto `52`), y opcionalmente `SSL_KEY_PATH`/`SSL_CERT_PATH`.

Puesta en marcha: `npm ci` → crear la BD y su usuario → `npm run migrate` → `npm start` (o pm2) → en Meta (WhatsApp → Configuración → Webhook) apuntar a `https://<host>/webhooks/whatsapp` con el mismo `WHATSAPP_VERIFY_TOKEN` y suscribirse al campo `messages` → crear una app cliente con `POST /v1/admin/clients`.

## 12. Cómo se conecta eventopolis-api

| Hoy en eventopolis-api | Con la Messaging API |
|---|---|
| `sendTemplate` / `sendText` directo a Meta | `POST /v1/messages/template`, `/batch` y `/text` |
| `WhatsappMessage.dedupeKey` (`event_reminder:<inv>:d7`) | `idempotencyKey` con el mismo formato |
| `eventId`, `invitationId` en `whatsapp_message` | `ref: "event:<id>"`, `metadata: { invitationId }` |
| `eventSendHistory(eventId)` (¿ya se le mandó?) | `GET /v1/messages?ref=event:<id>&excludeStatus=failed` |
| Reporte "no entregados" | `GET /v1/messages?ref=…&status=failed` (el `error` ya trae `reason` y `hint`) |
| Bandeja de conversaciones y respuestas | `GET /v1/conversations…` y `POST /v1/messages/text` |
| `POST /webhooks/whatsapp` de Meta | Lo recibe la Messaging API; eventopolis-api recibe `message.status` y `message.received` firmados |
| Plantillas, catálogo de tipos de mensaje, automatización por evento, scheduler, permisos de WhatsApp | **Se quedan en eventopolis-api** (es lógica de eventos) |
