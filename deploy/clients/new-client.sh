#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Scaffold a new client env + Caddy file.

Usage:
  bash deploy/clients/new-client.sh \
    --client <slug> \
    --domain <fqdn> \
    --bridge-port <host-port> \
    --web-port <host-port> \
    --gateway-port <host-port>

Example:
  bash deploy/clients/new-client.sh \
    --client alalegal \
    --domain alalegal.proyectoprisma.com \
    --bridge-port 4011 \
    --web-port 3111 \
    --gateway-port 3011
USAGE
}

CLIENT=""
DOMAIN=""
BRIDGE_PORT=""
WEB_PORT=""
GATEWAY_PORT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --client) CLIENT="${2:-}"; shift 2 ;;
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --bridge-port) BRIDGE_PORT="${2:-}"; shift 2 ;;
    --web-port) WEB_PORT="${2:-}"; shift 2 ;;
    --gateway-port) GATEWAY_PORT="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; usage; exit 1 ;;
  esac
done

if [[ -z "$CLIENT" || -z "$DOMAIN" || -z "$BRIDGE_PORT" || -z "$WEB_PORT" || -z "$GATEWAY_PORT" ]]; then
  echo "Missing required args." >&2
  usage
  exit 1
fi

if [[ ! "$CLIENT" =~ ^[a-z0-9-]+$ ]]; then
  echo "Client slug must match ^[a-z0-9-]+$" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEMPLATE_ENV="${ROOT_DIR}/deploy/clients/alalegal.env.template"
OUT_ENV="${ROOT_DIR}/deploy/clients/${CLIENT}.env"
OUT_CADDY="${ROOT_DIR}/deploy/caddy/${DOMAIN}.Caddyfile"

if [[ -f "$OUT_ENV" ]]; then
  echo "Refusing to overwrite existing file: $OUT_ENV" >&2
  exit 1
fi

if [[ -f "$OUT_CADDY" ]]; then
  echo "Refusing to overwrite existing file: $OUT_CADDY" >&2
  exit 1
fi

cp "$TEMPLATE_ENV" "$OUT_ENV"

sed -i \
  -e "s/^CLIENT_SLUG=.*/CLIENT_SLUG=${CLIENT}/" \
  -e "s/^AGENT_GATEWAY_PORT=.*/AGENT_GATEWAY_PORT=${GATEWAY_PORT}/" \
  -e "s/^BRIDGE_PUBLIC_PORT=.*/BRIDGE_PUBLIC_PORT=${BRIDGE_PORT}/" \
  -e "s/^WEB_PUBLIC_PORT=.*/WEB_PUBLIC_PORT=${WEB_PORT}/" \
  -e "s/^POSTGRES_DB=.*/POSTGRES_DB=superwave_${CLIENT}/" \
  -e "s|^DASHBOARD_ADMIN_EMAIL=.*|DASHBOARD_ADMIN_EMAIL=admin@${DOMAIN}|" \
  "$OUT_ENV"

mkdir -p "$(dirname "$OUT_CADDY")"
cat > "$OUT_CADDY" <<EOF
${DOMAIN} {
  handle /manychat/* {
    reverse_proxy localhost:${BRIDGE_PORT}
  }

  handle /telegram/* {
    reverse_proxy localhost:${BRIDGE_PORT}
  }

  handle /admin/* {
    reverse_proxy localhost:${BRIDGE_PORT}
  }

  handle /health {
    reverse_proxy localhost:${BRIDGE_PORT}
  }

  handle {
    reverse_proxy localhost:${WEB_PORT}
  }
}
EOF

cat <<EOF
Generated:
  - ${OUT_ENV}
  - ${OUT_CADDY}

Next:
  1) Fill CHANGE_ME values in ${OUT_ENV}
  2) Deploy:
     docker compose -p ${CLIENT} --env-file deploy/clients/${CLIENT}.env up -d --build
  3) Append ${OUT_CADDY} block into /etc/caddy/Caddyfile and reload caddy
EOF
