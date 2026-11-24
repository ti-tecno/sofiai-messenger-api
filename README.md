# sofiai-messenger-api

SofIA Messenger API: servicio de mensajería WhatsApp (Cloud API de Meta) compartido por cualquier sistema, con base de datos propia.
Especificación completa: **[docs/SPEC.md](docs/SPEC.md)**. Guía para trabajar en el repo: [CLAUDE.md](CLAUDE.md).

```bash
cp .env.example .env      # completar BD, ADMIN_API_KEY y WHATSAPP_*
npm ci
npm run migrate           # crea las tablas (repetible)
npm start                 # o: pm2 start server.js --name sofiai-messenger

# crear una app cliente (la llave se muestra una sola vez)
curl -X POST https://HOST/v1/admin/clients -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Mi app","webhookUrl":"https://HOST_DE_LA_APP/ruta","dailyLimit":2000}'
```

Pruebas: `npm test` (unitarias). La de integración corre con una BD vacía:
`TEST_DB_HOST=127.0.0.1 TEST_DB_PORT=3306 TEST_DB_USER=… TEST_DB_PASSWORD=… TEST_DB_NAME=msgtest npm test`
— **borra** las tablas de esa BD: usa una de pruebas. Repite con `TEST_DB_TABLE_PREFIX=msg_` para probar con prefijo de tablas.
