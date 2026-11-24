import fs from 'fs';
import http from 'http';
import https from 'https';
import { app } from './src/app.js';
import { sendAllowlist } from './src/sandbox.js';

// HOST: interfaz donde escuchar (p. ej. 127.0.0.1 para que solo se llegue por túnel SSH
// o proxy local). Sin HOST escucha en todas las interfaces.
const { SSL_KEY_PATH, SSL_CERT_PATH, PORT, HOST } = process.env;
const secure = SSL_KEY_PATH && SSL_CERT_PATH && fs.existsSync(SSL_KEY_PATH) && fs.existsSync(SSL_CERT_PATH);
const server = secure
  ? https.createServer({ key: fs.readFileSync(SSL_KEY_PATH), cert: fs.readFileSync(SSL_CERT_PATH) }, app)
  : http.createServer(app);
server.listen(PORT, HOST || undefined, () => {
  console.log(`SofIA Messenger API en ${HOST || '*'}:${PORT} (${secure ? 'https' : 'http'})`);
  const allow = sendAllowlist();
  if (allow) console.log(`SANDBOX activo: solo se envía a ${allow.size} teléfono(s) de SEND_ALLOWLIST`);
});
