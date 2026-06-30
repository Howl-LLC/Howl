#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if [ -f .env ]; then
  echo ".env already exists; refusing to overwrite. Remove it first to regenerate." >&2
  exit 1
fi

read -rp "Public domain (e.g. chat.example.com): " DOMAIN
if [ -z "$DOMAIN" ]; then
  echo "A domain is required (use 'localhost' for a local test). Aborting." >&2
  exit 1
fi
read -rp "Instance name [Howl]: " INSTANCE_NAME
INSTANCE_NAME="${INSTANCE_NAME:-Howl}"

gen() { openssl rand -hex "$1"; }

# Capture the one-time first-admin setup token so we can both write it to .env
# and print it for the operator after setup.
BOOTSTRAP_TOKEN="$(gen 24)"

cat > .env <<EOF
SELF_HOST=true
SELF_HOST_ALL_PRO=true
REGISTRATION_MODE=closed
INSTANCE_NAME=${INSTANCE_NAME}
DOMAIN=${DOMAIN}

POSTGRES_PASSWORD=$(gen 24)
REDIS_PASSWORD=$(gen 24)

JWT_SECRET=$(gen 48)
ADMIN_JWT_SECRET=$(gen 48)
EMAIL_HMAC_KEY=$(gen 32)
MFA_ENCRYPTION_KEY=$(gen 32)
DM_ENCRYPTION_KEY=$(gen 32)
SERVER_E2E_MASTER_KEY=$(gen 32)

# One-time token required to create the first admin account (printed below).
BOOTSTRAP_TOKEN=${BOOTSTRAP_TOKEN}

CF_ACCESS_ENFORCE=false

# Voice: bring-your-own LiveKit (uncomment to enable)
# LIVEKIT_WS_URL=wss://your-livekit-host
# LIVEKIT_API_KEY=
# LIVEKIT_API_SECRET=

# Email (optional)
# RESEND_API_KEY=
EOF

chmod 600 .env
echo
echo "Wrote deploy/selfhost/.env. Review it, then run:"
echo "  cd deploy/selfhost && docker compose up -d --build"
echo
echo "Then open https://${DOMAIN} and register the first (admin) account. You will be"
echo "asked for this one-time setup token:"
echo
echo "    ${BOOTSTRAP_TOKEN}"
echo
echo "It is also saved as BOOTSTRAP_TOKEN in deploy/selfhost/.env. Without it nobody can"
echo "claim admin, so an internet-reachable instance is safe to bring up before you register."
