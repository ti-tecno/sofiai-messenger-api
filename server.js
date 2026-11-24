import fs from 'fs';
import http from 'http';
import https from 'https';
import { app } from './src/app.js';
import { sendAllowlist } from './src/sandbox.js';

const { SSL_KEY_PATH, SSL_CERT_PATH, PORT } = process.env;
const secure = SSL_KEY_PATH && SSL_CERT_PATH && fs.existsSync(SSL_KEY_PATH) && fs.existsSync(SSL_CERT_PATH);
const server = secure
  ? https.createServer({ key: fs.readFileSync(SSL_KEY_PATH), cert: fs.readFileSync(SSL_CERT_PATH) }, app)
  : http.createServer(app);
server.listen(PORT, () => {
  console.log(`SofIA Messenger API en puerto ${PORT} (${secure ? 'https' : 'http'})`);
  const allow = sendAllowlist();
  if (allow) console.log(`SANDBOX activo: solo se envía a ${allow.size} teléfono(s) de SEND_ALLOWLIST`);
});
