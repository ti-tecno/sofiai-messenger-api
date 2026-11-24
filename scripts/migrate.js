import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../src/db.js';

// Crea las tablas de esta API (CREATE TABLE IF NOT EXISTS: se puede repetir sin riesgo).
const TABLES = [
  `CREATE TABLE IF NOT EXISTS client (
    id            INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name          VARCHAR(100) NOT NULL,
    apiKeyHash    CHAR(64)     NOT NULL,
    webhookUrl    VARCHAR(500) NULL,
    webhookSecret VARCHAR(80)  NULL,
    dailyLimit    INT          NULL,
    active        TINYINT(1)   NOT NULL DEFAULT 1,
    createdAt     DATETIME(3)  NOT NULL,
    updatedAt     DATETIME(3)  NOT NULL,
    UNIQUE KEY uq_client_key (apiKeyHash)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // Un renglón por mensaje, enviado (out) o recibido (in), de plantilla o de texto libre.
  `CREATE TABLE IF NOT EXISTS message (
    id             CHAR(36)     NOT NULL PRIMARY KEY,
    clientId       INT          NULL,
    direction      VARCHAR(3)   NOT NULL,
    kind           VARCHAR(10)  NOT NULL,
    phone          VARCHAR(20)  NOT NULL,
    template       VARCHAR(100) NULL,
    params         JSON         NULL,
    body           TEXT         NULL,
    ref            VARCHAR(100) NULL,
    metadata       JSON         NULL,
    idempotencyKey VARCHAR(100) NULL,
    status         VARCHAR(20)  NOT NULL,
    errorCode      INT          NULL,
    errorMessage   VARCHAR(500) NULL,
    waMessageId    VARCHAR(128) NULL,
    contextWaId    VARCHAR(128) NULL,
    msgType        VARCHAR(20)  NULL,
    profileName    VARCHAR(255) NULL,
    readAt         DATETIME(3)  NULL,
    createdAt      DATETIME(3)  NOT NULL,
    updatedAt      DATETIME(3)  NOT NULL,
    UNIQUE KEY uq_message_wamid (waMessageId),
    UNIQUE KEY uq_message_idem (clientId, idempotencyKey),
    KEY idx_message_client_ref (clientId, ref, createdAt),
    KEY idx_message_client_phone (clientId, phone, createdAt),
    KEY idx_message_phone (phone, createdAt),
    FOREIGN KEY (clientId) REFERENCES client(id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // Un número de WhatsApp (o, a futuro, otro tipo de canal) desde el que se envía y en el que se recibe.
  // El token NO va en la BD: tokenEnv es el nombre de la variable de entorno que lo contiene.
  `CREATE TABLE IF NOT EXISTS channel (
    id              INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
    slug            VARCHAR(50)  NOT NULL,
    type            VARCHAR(20)  NOT NULL DEFAULT 'whatsapp',
    name            VARCHAR(100) NOT NULL,
    phoneNumberId   VARCHAR(40)  NULL,
    wabaId          VARCHAR(40)  NULL,
    displayPhone    VARCHAR(20)  NULL,
    tokenEnv        VARCHAR(64)  NULL,
    defaultClientId INT          NULL,
    dailyLimit      INT          NULL,
    config          JSON         NULL,
    active          TINYINT(1)   NOT NULL DEFAULT 1,
    createdAt       DATETIME(3)  NOT NULL,
    updatedAt       DATETIME(3)  NOT NULL,
    UNIQUE KEY uq_channel_slug (slug),
    UNIQUE KEY uq_channel_phone (phoneNumberId),
    FOREIGN KEY (defaultClientId) REFERENCES client(id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // Qué apps pueden usar qué canal (uno es el canal por defecto de la app).
  `CREATE TABLE IF NOT EXISTS client_channel (
    clientId  INT        NOT NULL,
    channelId INT        NOT NULL,
    isDefault TINYINT(1) NOT NULL DEFAULT 0,
    PRIMARY KEY (clientId, channelId),
    FOREIGN KEY (clientId)  REFERENCES client(id)  ON DELETE CASCADE,
    FOREIGN KEY (channelId) REFERENCES channel(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

const one = async (sql, params) => (await pool.query(sql, params))[0][0];

// ALTER repetibles sin depender de ADD COLUMN IF NOT EXISTS (MariaDB sí, MySQL 8 no).
async function columnExists(table, column) {
  return Boolean(await one('SELECT 1 AS x FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [table, column]));
}
async function indexExists(table, index) {
  return Boolean(await one('SELECT 1 AS x FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1', [table, index]));
}
async function constraintExists(table, name) {
  return Boolean(await one('SELECT 1 AS x FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?', [table, name]));
}

async function addMessageChannel() {
  if (!(await columnExists('message', 'channelId'))) await pool.query('ALTER TABLE message ADD COLUMN channelId INT NULL AFTER clientId');
  if (!(await indexExists('message', 'idx_message_channel_phone'))) await pool.query('ALTER TABLE message ADD KEY idx_message_channel_phone (channelId, phone, createdAt)');
  if (!(await constraintExists('message', 'fk_message_channel'))) {
    await pool.query('ALTER TABLE message ADD CONSTRAINT fk_message_channel FOREIGN KEY (channelId) REFERENCES channel(id) ON DELETE SET NULL');
  }
}

// Instalaciones previas (un solo número en el .env): crea el canal "default", lo asigna como canal
// por defecto de todas las apps y marca los mensajes viejos con él. Solo si no hay canales.
async function seedDefaultChannel() {
  const { WHATSAPP_PHONE_NUMBER_ID: phoneNumberId, WHATSAPP_BUSINESS_ACCOUNT_ID: wabaId } = process.env;
  if (!phoneNumberId) return false;
  if (await one('SELECT 1 AS x FROM channel LIMIT 1')) return false;
  const now = new Date();
  const [result] = await pool.query(
    "INSERT INTO channel (slug, type, name, phoneNumberId, wabaId, tokenEnv, active, createdAt, updatedAt) VALUES ('default', 'whatsapp', 'Default', ?, ?, NULL, 1, ?, ?)",
    [phoneNumberId, wabaId || null, now, now],
  );
  await pool.query('INSERT INTO client_channel (clientId, channelId, isDefault) SELECT id, ?, 1 FROM client', [result.insertId]);
  await pool.query('UPDATE message SET channelId = ? WHERE channelId IS NULL', [result.insertId]);
  return true;
}

export async function migrate() {
  for (const sql of TABLES) await pool.query(sql);
  await addMessageChannel();
  return { seeded: await seedDefaultChannel() };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { seeded } = await migrate();
  if (seeded) console.log('Se creó el canal "default" con WHATSAPP_PHONE_NUMBER_ID y se asignó a las apps existentes.');
  console.log('Listo: tablas client, message, channel y client_channel al día.');
  await pool.end();
}
