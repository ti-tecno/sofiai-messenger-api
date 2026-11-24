#!/usr/bin/env bash
# Despliega SofIA Messenger API en el VPS. Corre EN el servidor; desde Windows (Git Bash):
#
#   tr -d '\r' < deploy/deploy.sh | ssh root@<servidor> 'bash -s'
#   tr -d '\r' < deploy/deploy.sh | ssh root@<servidor> 'BRANCH=feature/canales bash -s'
#
# Primera vez: clona el repo desde GitHub, instala dependencias, corre la migración
# y crea el proceso pm2. Siguientes veces: trae la rama, migra (es repetible) y
# reinicia SOLO este proceso.
#
# Los secretos nunca vienen de git: el .env real vive en $SECRETS_DIR (solo root)
# y se copia a la app en cada despliegue. Si no existe, el script crea uno a partir
# de .env.example y se detiene para que lo llenes.
set -euo pipefail

REPO_URL=${REPO_URL:-https://github.com/ti-tecno/sofiai-messenger-api.git}
APP_DIR=${APP_DIR:-/root/sofiai-messenger-api}
SECRETS_DIR=${SECRETS_DIR:-/root/secrets/sofiai-messenger-api}
PM2_NAME=${PM2_NAME:-sofiai-messenger}   # nunca `pm2 restart all`: en este servidor corren otros proyectos
BRANCH=${BRANCH:-develop}

if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>20||(a===20&&b>=6)?0:1)'; then
  echo "ERROR: se requiere Node >= 20.6 (hay $(node -v))" >&2
  exit 1
fi

# 1. Código desde GitHub
if [ ! -d "$APP_DIR/.git" ]; then
  echo "Clonando $REPO_URL ($BRANCH) en $APP_DIR"
  git clone --quiet --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
  before=none
  cd "$APP_DIR"
else
  cd "$APP_DIR"
  if ! git diff --quiet HEAD; then
    echo "ERROR: hay cambios sin commit en el servidor:" >&2
    git status --short >&2
    exit 1
  fi
  before=$(git rev-parse HEAD)
  git fetch --quiet origin "$BRANCH"
  git checkout --quiet -B "$BRANCH" "origin/$BRANCH"
fi
after=$(git rev-parse HEAD)

# 2. Secretos
mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"
if [ ! -f "$SECRETS_DIR/.env" ]; then
  install -m 600 "$APP_DIR/.env.example" "$SECRETS_DIR/.env"
  echo
  echo "Creé $SECRETS_DIR/.env desde .env.example. Llénalo (PORT, DB_*, ADMIN_API_KEY,"
  echo "WHATSAPP_*, SSL_*, SEND_ALLOWLIST) y vuelve a correr este script."
  exit 2
fi
chmod 600 "$SECRETS_DIR"/.env*

# Sin SEND_ALLOWLIST el mensajero puede escribir a cualquier teléfono. Mientras no se
# decida pasar a producción de verdad, se exige; para quitarlo: ALLOW_ANY_RECIPIENT=1.
env_value() { grep -E "^$1=" "$SECRETS_DIR/.env" | tail -1 | cut -d= -f2- | sed -E 's/[[:space:]]+#.*$//; s/^["'\'']//; s/["'\'']$//' | tr -d '\r'; }
if [ -z "$(env_value SEND_ALLOWLIST)" ] && [ "${ALLOW_ANY_RECIPIENT:-0}" != 1 ]; then
  echo "ERROR: SEND_ALLOWLIST está vacía en $SECRETS_DIR/.env (el envío no estaría limitado)." >&2
  echo "Llénala, o despliega con ALLOW_ANY_RECIPIENT=1 si ya es producción abierta." >&2
  exit 1
fi
install -m 600 "$SECRETS_DIR/.env" "$APP_DIR/.env"

# 3. Dependencias y migración (repetible)
if [ "$before" = none ] || git diff --name-only "$before" "$after" | grep -qx 'package-lock.json' || [ ! -d node_modules ]; then
  npm ci --omit=dev --no-audit --no-fund
fi
node --env-file=.env scripts/migrate.js

# 4. Proceso pm2 (solo este)
if pm2 describe "$PM2_NAME" >/dev/null 2>&1; then
  pm2 restart "$PM2_NAME" --update-env >/dev/null
else
  pm2 start server.js --name "$PM2_NAME" --cwd "$APP_DIR" --node-args="--env-file=.env" >/dev/null
  pm2 save >/dev/null
fi

[ "$before" != none ] && [ "$before" != "$after" ] && git log --oneline "$before..$after"

# 5. Salud
port=$(env_value PORT)
host=$(env_value HOST); host=${host:-127.0.0.1}; [ "$host" = 0.0.0.0 ] && host=127.0.0.1
for _ in $(seq 1 15); do
  if curl -fsk --max-time 3 "https://${host}:${port}/health" >/dev/null \
     || curl -fs --max-time 3 "http://${host}:${port}/health" >/dev/null; then
    echo "OK: $PM2_NAME en $BRANCH $(git rev-parse --short HEAD), /health responde en el puerto $port."
    exit 0
  fi
  sleep 1
done
echo "ERROR: /health no responde. Revisa: pm2 logs $PM2_NAME --lines 50" >&2
exit 1
