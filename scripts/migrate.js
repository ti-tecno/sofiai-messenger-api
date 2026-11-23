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
];

export async function migrate() {
  for (const sql of TABLES) await pool.query(sql);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  await migrate();
  console.log('Listo: tablas client y message creadas (o ya existían).');
  await pool.end();
}
