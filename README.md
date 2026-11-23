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
