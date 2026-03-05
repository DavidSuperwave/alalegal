#!/usr/bin/env bash
# ============================================================
# Superwave — ManyChat Setup Script
# Creates custom fields and tags via ManyChat API
#
# Usage:
#   chmod +x setup-manychat.sh
#   MANYCHAT_API_KEY="Bearer 416263294908731:..." ./setup-manychat.sh
#
# Or set the variable in .env and source it first:
#   source .env && ./setup-manychat.sh
# ============================================================

set -euo pipefail

# ── Config ──────────────────────────────────────────────────────
API_KEY="${MANYCHAT_API_KEY:-}"
BASE_URL="https://api.manychat.com"

if [[ -z "$API_KEY" ]]; then
  echo "ERROR: MANYCHAT_API_KEY is not set."
  echo "Export it before running: export MANYCHAT_API_KEY='Bearer 416263294908731:xxxxx'"
  exit 1
fi

# ── Helpers ───────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

ok()   { echo -e "${GREEN}  ✓ $1${NC}"; }
warn() { echo -e "${YELLOW}  ⚠ $1${NC}"; }
fail() { echo -e "${RED}  ✗ $1${NC}"; }

# POST wrapper — prints result code
mc_post() {
  local endpoint="$1"
  local body="$2"
  local label="$3"

  local response
  response=$(curl -s -w "\n%{http_code}" \
    -X POST "${BASE_URL}${endpoint}" \
    -H "Authorization: ${API_KEY}" \
    -H "Content-Type: application/json" \
    -d "$body")

  local body_part code_part
  body_part=$(echo "$response" | head -n -1)
  code_part=$(echo "$response" | tail -n 1)

  if [[ "$code_part" == "200" || "$code_part" == "201" ]]; then
    ok "${label} — HTTP ${code_part}"
  else
    warn "${label} — HTTP ${code_part}: ${body_part}"
  fi
}

# ── Banner ───────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║   Superwave — ManyChat Field & Tag Setup    ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# ── 1. Custom Fields ──────────────────────────────────────────────
echo "── Creando Custom Fields ───────────────────────────────────────"

declare -A FIELDS=(
  ["CURP"]="text"
  ["NSS"]="text"
  ["telefono"]="text"
  ["estado"]="text"
  ["ultima_clasificacion"]="text"
  ["pilar_servicio"]="text"
  ["agente_asignado"]="text"
  ["fit_caso"]="text"
  ["lead_stage"]="text"
  ["review_id"]="text"
  ["ultimo_contacto"]="text"
  ["canal"]="text"
  ["monto_preaprobado"]="text"
  ["tipo_caso"]="text"
)

for field_name in "${!FIELDS[@]}"; do
  field_type="${FIELDS[$field_name]}"
  mc_post "/fb/page/createCustomField" \
    "{\"caption\": \"${field_name}\", \"type\": \"${field_type}\"}" \
    "Custom field: ${field_name} (${field_type})"
  sleep 0.3  # respect rate limits
done

echo ""

# ── 2. Tags ────────────────────────────────────────────────────────────
echo "── Creando Tags ───────────────────────────────────────────────"

TAGS=(
  "nuevo"
  "fallecimientos"
  "lesiones"
  "aseguradoras"
  "litigios"
  "potencial_alto"
  "potencial_medio"
  "potencial_bajo"
  "consulta_legal"
  "estado_caso"
  "precalificacion"
  "cita"
  "precio"
  "info_general"
  "calificado"
  "no_califica"
  "seguimiento"
  "cita_agendada"
  "caso_activo"
  "spam"
)

for tag in "${TAGS[@]}"; do
  mc_post "/fb/page/createTag" \
    "{\"name\": \"${tag}\"}" \
    "Tag: ${tag}"
  sleep 0.3  # respect rate limits
done

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║   Configuración completada.                 ║"
echo "║   Verifica en ManyChat → Settings →        ║"
echo "║     Custom Fields y Tags.                   ║"
echo "╚══════════════════════════════════════════════╝"
echo ""
echo "Próximo paso: configura el External Request en ManyChat."
echo "Ver MANYCHAT-FLOW.md para instrucciones detalladas."
echo ""
