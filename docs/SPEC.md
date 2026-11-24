# SofIA Messenger API — Especificación v1

API REST para enviar y recibir mensajes de **WhatsApp** (Cloud API de Meta). Está pensada para que **cualquier sistema** (backend de eventos, CRM, apps nuevas…) envíe mensajes sin hablar directamente con Meta y sin tener tablas de mensajes propias.

Esta API **no sabe nada de eventos, invitaciones ni usuarios de ningún sistema**. Solo conoce: *a qué teléfono mando qué plantilla o texto*, *en qué estado quedó* y *qué contestó la persona*. Todo lo demás lo decide la app que la usa (cuándo enviar, a quién, qué texto) y lo ata con dos campos libres: `ref` y `metadata`.

```
 ┌────────────────┐   POST /v1/messages/...    ┌──────────────────────┐   Cloud API   ┌────────┐
 │ App cliente    │ ─────────────────────────▶ │ SofIA Messenger API  │ ────────────▶ │  Meta  │
 │ (cualquier     │                            │  · BD propia         │ ◀──────────── │        │
 │  sistema)      │ ◀───────────────────────── │  · N canales (núm.)  │   webhook     └────────┘
 └────────────────┘   webhooks firmados        └──────────────────────┘
                      message.status / message.received
```

## 1. Conceptos

| Concepto | Qué es |
|---|---|
| **Canal** | Un número de WhatsApp (con su WABA, token y marca) desde el que se envía y en el que se recibe. Cada app tiene uno o más canales asignados, uno **por defecto**. Cada marca de cara al cliente debe tener el suyo. |
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
| 403 | `CHANNEL_NOT_ALLOWED` | El `channel` pedido no está asignado a la app |
| 403 | `RECIPIENT_NOT_ALLOWED` | Modo sandbox: el teléfono no está en `SEND_ALLOWLIST` (no se guardó ni se llamó a Meta) |
| 404 | `NOT_FOUND` | No existe (o es de otra app) |
| 404/409 | `NOT_FOUND` / `CONFLICT` | Canal inexistente (admin) / slug o `phoneNumberId` repetido |
| 409 | `WINDOW_CLOSED` | Texto libre fuera de la ventana de 24 h |
| 413 | `PAYLOAD_TOO_LARGE` | Cuerpo > 1 MB |
| 422 | `INVALID_PHONE` | El teléfono no puede ser de WhatsApp |
| 429 | `DAILY_LIMIT` | La app alcanzó su límite de mensajes en 24 h |
| 502 | `SEND_FAILED` | Meta rechazó el envío (el mensaje queda guardado como `failed`) |
| 503 | `NOT_CONFIGURED`, `ADMIN_DISABLED` | La app no tiene canal por defecto, o el canal está inactivo o sin token; falta la llave de admin |

## 3. El objeto Mensaje

```json
{
  "id": "6f1c2c3e-0d6e-4c3a-9b52-1f0d1f7a9a11",
  "direction": "out",
  "kind": "template",
  "channel": "eventopolis",
  "phone": "525512345678",
  "template": "recordatorio_evento",
  "parameters": { "language": "es_MX", "body": { "nombre": "Ana" }, "buttonUrlSuffix": "abc/def" },
  "text": null,
  "ref": "event:14",
  "metadata": { "invitationId": 7 },
  "idempotencyKey": "event_reminder:7:d7",
  "status": "delivered",
  "waMessageId": "wamid.HBg…",
  "contextWaId": null,
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

`reason` y `hint` están en español, pensados para mostrarse a una persona. `channel` es el slug del canal; `waMessageId` es el id de Meta (sirve para ligar estados y respuestas) y `contextWaId`, en un entrante, el `waMessageId` del mensaje al que contestó. Un `502 SEND_FAILED` trae `error.code: "SEND_FAILED"` y el mensaje guardado en `message` (con `status: failed` y `message.error.code` numérico de Meta). Además trae `error.retryable` (bool: `true` si la llave de idempotencia quedó liberada y el cliente puede reintentar con la misma `idempotencyKey`; `false` si el fallo es definitivo) y `error.httpStatus` (status HTTP de Meta, o `null` si no hubo respuesta). Los mismos campos van en `message.error` de ese 502 y en `error` de cada resultado `failed` del lote; no se guardan, así que los listados de mensajes no los traen.

En mensajes entrantes `text` es el contenido (los adjuntos llegan como `[Imagen]`, `[Audio]`, `[Ubicación] lat,lng`…), `msgType` es el tipo de WhatsApp y `profileName` el nombre de perfil de quien escribió.

## 4. Envío

### `POST /v1/messages/template`
Envía una plantilla **ya aprobada** en Meta.

```json
{
  "to": "55 1234 5678",
  "channel": "eventopolis",
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

Requeridos: `to`, `template`. `channel` (slug) es opcional: si no viene se usa el canal por defecto de la app; si viene debe estar asignado a la app (`403 CHANNEL_NOT_ALLOWED`). `language` por defecto `es_MX`. `parameters.body` es `{ nombreDeVariable: valor }` (las plantillas usan variables con nombre); los valores se limpian (sin saltos de línea, tabs ni 4+ espacios, nunca vacíos) porque Meta los rechaza. `buttonUrlSuffix` es lo que se agrega a la URL del botón de la plantilla. `headerImageUrl` debe ser `https`.

Respuestas: **201** `{ "message": {…} }` · **200** `{ "message": {…}, "duplicate": true }` (misma `idempotencyKey`) · **403** `RECIPIENT_NOT_ALLOWED` (sandbox) · **422** `INVALID_PHONE` · **429** `DAILY_LIMIT` · **502** `SEND_FAILED` (con `error` y `message`).

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

HTTP 200, o **502** si `aborted` es true (con `abortReason`). Cada mensaje puede traer su `channel`. Un `messages[i]` mal formado o un canal no permitido rechazan todo el lote (400/403/503) antes de enviar nada. En sandbox, un destino fuera de `SEND_ALLOWLIST` queda `skipped` con `reason: "not_allowed"` y no corta el lote.

### `POST /v1/messages/text`
Texto libre: `{ "to", "text" (≤4096), "channel"?, "ref"?, "metadata"?, "idempotencyKey"? }`. Solo si ese teléfono le escribió **a tu app, en ese canal,** en las últimas 24 h; si no, **409 `WINDOW_CLOSED`**. Mismas respuestas que la plantilla.

## 5. Consulta

### `GET /v1/messages`
Mensajes de tu app, el más reciente primero. Filtros (todos opcionales, se combinan):

`channel` (slug) · `ref` (varios: `ref=a&ref=b` o `ref=a,b`) · `phone` · `direction` (`in`/`out`) · `kind` (`template`/`text`) · `template` · `status` (lista) · `excludeStatus` (lista, p. ej. `failed`) · `since` / `until` (ISO) · `limit` (1–1000, por defecto 50) · `offset`.

→ `{ "data": [Mensaje…], "limit": 50, "offset": 0 }`

Sirve para consultar sin webhook (una app sin `webhookUrl` igual guarda sus mensajes y los consulta aquí o en `/v1/conversations`), para el historial por evento, para saber "¿a quién ya le mandé esto?" (`ref=event:14&template=recordatorio_evento&excludeStatus=failed`) y para reconciliar si perdiste un webhook (`since=<última fecha vista>`).

### `GET /v1/messages/:id` → `{ "message": {…} }` (404 si es de otra app)

## 6. Conversaciones (lo que contestan)

Una *conversación* es un teléfono que alguna vez escribió a tu app en un canal. Todas las rutas aceptan `channel` (slug) opcional para limitarse a un canal; cada conversación trae su `channel`.

- `GET /v1/conversations?ref=&channel=` → `{ "data": [ { phone, channel, ref, profileName, unread, lastInboundAt, windowUntil, last: { direction, kind, text, status, at } } ] }`, la más reciente primero. `windowUntil` es hasta cuándo puedes mandar texto libre.
- `GET /v1/conversations/unread?ref=` → `{ "unread": 3 }` (sin `ref`: todos los de la app).
- `GET /v1/conversations/:phone?ref=` → `{ phone, profileName, windowUntil, messages: [Mensaje…] }`, el hilo completo (plantillas y texto, entrantes y salientes), el más viejo primero.
- `POST /v1/conversations/:phone/read` con `{ "ref"?: … }` → `{ "updated": 2 }`. Marca como leídos los entrantes.

**¿A qué app llega lo que contesta una persona?** Primero se identifica el **canal** por el número que recibió el mensaje (`metadata.phone_number_id` del evento de Meta; si no es de ningún canal, se ignora y no se guarda). Dentro de ese canal: (1) si la persona *respondió a un mensaje concreto* (`context.id`) enviado por ese mismo canal, a la app que lo envió; (2) si no, a la app que envió el último mensaje a ese teléfono por ese canal; (3) si nunca se le mandó nada, a la app por defecto del canal (`defaultClientId`), sin `ref` ni `metadata` (la app decide a qué corresponde); (4) si el canal no tiene app por defecto, queda sin dueño y no se avisa a nadie. En los casos 1 y 2 el entrante hereda `ref` y `metadata` del saliente.

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

Responde **2xx** rápido. Se reintenta 3 veces (de inmediato, a 1 s y a 5 s) ante red caída, 5xx o 429; un 4xx no se reintenta. Los reintentos viven en memoria: si algo se pierde, reconcilia con `GET /v1/messages?since=` (ojo: `since` filtra por fecha de creación y no ve cambios de estado de mensajes viejos). Un `duplicate` puede ser un mensaje ya fallido: revisa `message.status`. Puede llegar el mismo evento más de una vez: usa `data.id` y `data.status` para que tu manejo sea idempotente.

## 8. Administración (llave `ADMIN_API_KEY`)

- `POST /v1/admin/clients` `{ name, webhookUrl?, dailyLimit?, active? }` → **201** `{ client, apiKey, webhookSecret }`. La `apiKey` y el `webhookSecret` **se muestran una sola vez**; en la BD de la API solo queda el hash de la llave.
- `GET /v1/admin/clients` → apps registradas (sin secretos).
- `PATCH /v1/admin/clients/:id` `{ name?, webhookUrl?, dailyLimit?, active?, rotateKey?: true, rotateWebhookSecret?: true }`. Rotar devuelve la llave o secreto nuevos y los anteriores dejan de funcionar al instante. `active: false` bloquea la app.
- `POST /v1/admin/channels` `{ slug, name, phoneNumberId?, wabaId?, displayPhone?, tokenEnv?, defaultClientId?, active? }` → **201** `{ channel }`. `tokenEnv` es el **nombre** de la variable de entorno que contiene el token (p. ej. `WA_TOKEN_CEINVET`; vacío = `WHATSAPP_TOKEN`): el token nunca se guarda en la BD ni se devuelve (solo `tokenConfigured`). Agregar un número implica agregar esa variable y reiniciar el proceso.
- `GET /v1/admin/channels` · `PATCH /v1/admin/channels/:slug` (mismos campos; `defaultClientId` es la app que recibe los entrantes no atribuibles).
- `PUT /v1/admin/clients/:id/channels` `{ channels: [{ slug, isDefault }] }` reemplaza los canales de la app (uno `isDefault`; con un solo canal es el defecto).
- `POST /v1/admin/templates` con la definición de plantilla de Meta más `channel` (`{ channel, name, language, category, components }`) → la crea en la cuenta (WABA) y con el token de ese canal (Meta la revisa; tarda de minutos a horas). El canal necesita `wabaId`.

`dailyLimit` cuenta los mensajes salientes **no fallidos** de las últimas 24 h: es un tope de gasto si una app se descontrola o se filtra su llave. `null` = sin límite.

## 9. Otras rutas

- `GET /health` → `{ "status": "ok" }` (503 `db_error` si la BD no responde). Sin autenticación.
- `GET /v1/me` → tu app, sus `channels: [{ slug, name, displayPhone, isDefault }]`, si hay WhatsApp configurado y `sandbox: true|false`; útil para probar una llave.
- `GET|POST /webhooks/whatsapp` — **solo para Meta** (verificación y eventos, con firma `X-Hub-Signature-256` y `WHATSAPP_APP_SECRET`). Es la URL que se pone en la configuración del webhook de la app de Meta: `https://<host>/webhooks/whatsapp`.

## 10. Datos y costos

Base de datos **propia** de esta API (MySQL/MariaDB), cuatro tablas: `client`, `message`, `channel` y `client_channel` (`npm run migrate` las crea y se puede repetir sin riesgo, en MySQL y MariaDB). Si la tabla `channel` está vacía y existe `WHATSAPP_PHONE_NUMBER_ID`, la migración crea el canal `default` con ese número, lo asigna como canal por defecto de todas las apps existentes y marca los mensajes viejos con él. No comparte BD con ningún otro sistema.

**Prefijo de tablas (`DB_TABLE_PREFIX`).** Para vivir en una BD compartida (p. ej. hosting cPanel con MariaDB) con tablas de otros sistemas, todas las tablas, índices y llaves foráneas del mensajero llevan este prefijo (p. ej. `msg_` → `msg_client`, `msg_message`, `msg_channel`, `msg_client_channel`; las FK son únicas por BD, por eso también se prefijan). Solo `[a-z0-9_]`, máximo 20 caracteres; si es inválido el servidor y la migración no arrancan y lo dicen. Vacío = sin prefijo (nombres originales, compatible con instalaciones previas). Si el prefijo cambia, las tablas con el prefijo anterior quedan huérfanas (no se renombran solas). Antes de crear nada, `npm run migrate` revisa las tablas que ya existan con los nombres esperados: si alguna no tiene las columnas del mensajero (es de otro sistema), aborta con un mensaje claro sin modificar la BD. Los nombres se centralizan en `src/tables.js` y vienen solo de la configuración, nunca de la petición.

Meta cobra **cada plantilla entregada** (también las de utilidad) y los números nuevos arrancan con límites de envío bajos. Esta API no decide a quién mandar: usa `dailyLimit` e `idempotencyKey` para que ninguna app gaste de más ni repita.

## 11. Configuración del servidor

Variables (ver `.env.example`): `PORT`, `DB_HOST/PORT/NAME/USER/PASSWORD`, `ADMIN_API_KEY` (≥24 caracteres), `WHATSAPP_TOKEN` (token permanente de un usuario del sistema), `WHATSAPP_PHONE_NUMBER_ID` y `WHATSAPP_BUSINESS_ACCOUNT_ID` (solo siembran el canal `default`), `WA_TOKEN_<CANAL>` (una por canal que no use `WHATSAPP_TOKEN`), `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_API_VERSION` (por defecto `v27.0`), `WHATSAPP_DEFAULT_COUNTRY` (por defecto `52`), y opcionalmente `DB_TABLE_PREFIX` (ver sección 10), `SSL_KEY_PATH`/`SSL_CERT_PATH` y `SEND_ALLOWLIST`.

**Sandbox (`SEND_ALLOWLIST`).** Lista de teléfonos separados por comas. Si está definida, cualquier destino fuera de ella se rechaza **antes** de guardar o llamar a Meta (`403 RECIPIENT_NOT_ALLOWED`; en el lote, `skipped` con `reason: "not_allowed"`). `/v1/me` devuelve `sandbox: true` y el arranque lo avisa en el log. Úsala siempre en desarrollo.

**Pruebas locales sin túnel.** `npm run simulate -- status <wamid> delivered|read|failed [codigo] [--channel slug]` y `npm run simulate -- inbound <telefono> "<texto>" [--context <wamid>] [--channel slug]` firman con `WHATSAPP_APP_SECRET` y mandan a `/webhooks/whatsapp` del mensajero local un evento con el `phone_number_id` del canal elegido.

Puesta en marcha: `npm ci` → crear la BD y su usuario → `npm run migrate` → `npm start` (o pm2, **un solo proceso**) → en Meta (WhatsApp → Configuración → Webhook) apuntar a `https://<host>/webhooks/whatsapp` con el mismo `WHATSAPP_VERIFY_TOKEN` y suscribirse al campo `messages` → crear una app cliente con `POST /v1/admin/clients`.

## 12. Ejemplo: cómo se conecta un sistema (eventopolis-api)

El sistema **conserva sus propias tablas** (su registro de "ya se le envió", su bandeja) y solo cambia el **transporte**: envía por esta API y recibe estados y entrantes por el webhook firmado.

| Hoy en eventopolis-api | Con SofIA Messenger API |
|---|---|
| `sendTemplate` / `sendText` directo a Meta | `POST /v1/messages/template` y `/text` (con `channel` opcional) |
| `WhatsappMessage.dedupeKey` (`event_reminder:<inv>:d7`) | `idempotencyKey` con el mismo valor |
| `eventId`, `invitationId` | `ref: "event:<id>"`, `metadata: { localId, invitationId }` |
| Estado de cada mensaje | `message.status` por webhook, ligado por `waMessageId` (o por `metadata.localId`) |
| Respuestas de invitados | `message.received` por webhook, con `waMessageId` y `contextWaId` |
| `POST /webhooks/whatsapp` de Meta | Lo recibe esta API; el sistema recibe webhooks firmados |
| Plantillas, tipos de mensaje, automatización, scheduler, permisos | **Se quedan en el sistema** (es lógica de negocio) |
