#!/usr/bin/env bash
# =============================================================================
# ms-gateway-llm — Ejemplos de curl para la API
# -----------------------------------------------------------------------------
# Referencia rápida de todos los endpoints públicos y admin. Ajustá las 3
# variables de la sección "CONFIG" y corré el script (o copiá los bloques).
#
#   · Endpoints públicos →  cualquier API key válida
#   · Endpoints /admin/… →  API key cuyo cliente tenga scope `admin`
#
# Para generar las keys (CLI del gateway):
#   export API_KEY_PEPPER=$(openssl rand -hex 32)          # misma pepper que el gateway
#   pnpm admin:reset -- --create --id admin --scopes "admin,chat.read,chat.write,chat.completions" --rpm 1000
#   pnpm admin:reset -- --create --id demo   --scopes "chat.read,chat.write" --rpm 60
# Guardá las PLAIN API KEY que imprime (se muestran UNA sola vez).
#
# Referencia completa: docs/API.md · docs/API-KEYS.md · docs/ARCHITECTURE.md
# =============================================================================

set -u   # falla si una variable quedó sin valor; sin -e para que cada curl corra igual

# --- CONFIG ----------------------------------------------------------------
BASE_URL="${BASE_URL:-http://localhost:3000}"
API_KEY="${API_KEY:-sk-REEMPLAZAR_CON_KEY_PUBLICA}"
ADMIN_KEY="${ADMIN_KEY:-sk-REEMPLAZAR_CON_KEY_ADMIN}"
ALIAS_ID="${ALIAS_ID:-coder}"          # alias sobre el que probás el ruteo
CLIENT_ID="${CLIENT_ID:-tenant-acme}"  # id de cliente para el CRUD
# ---------------------------------------------------------------------------

# jq formatea el JSON si está disponible; si no, imprime crudo.
pp() { if command -v jq >/dev/null 2>&1; then jq . 2>/dev/null || cat; else cat; fi; }
hdr() { printf '\n\033[1;36m▶ %s\033[0m\n' "$1"; }

echo "Gateway: $BASE_URL"

# =============================================================================
# 1. HEALTH
# =============================================================================
hdr "1. GET /v1/health — liveness del proceso (sin auth)"
curl -sS "$BASE_URL/v1/health" | pp

hdr "2. GET /v1/health/llm — circuit breaker por proveedor (sin auth)"
curl -sS "$BASE_URL/v1/health/llm" | pp

# =============================================================================
# 2. CATÁLOGO DE MODELOS
# =============================================================================
hdr "3. GET /v1/models — aliases de modelos (auth pública)"
curl -sS "$BASE_URL/v1/models" -H "Authorization: Bearer $API_KEY" | pp

# =============================================================================
# 3. CHAT COMPLETIONS
# =============================================================================
hdr "4. POST /v1/chat/completions — JSON (buffered)"
curl -sS "$BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "'"$ALIAS_ID"'",
    "messages": [
      {"role": "system", "content": "Eres un asistente."},
      {"role": "user",   "content": "Escribe un quicksort en Python."}
    ],
    "stream": false,
    "temperature": 0.2
  }' | pp

hdr "5. POST /v1/chat/completions — streaming SSE"
curl -sSN "$BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "'"$ALIAS_ID"'",
    "messages": [{"role": "user", "content": "Di hola en 5 palabras"}],
    "stream": true
  }'

# =============================================================================
# 4. MÉTRICAS
# =============================================================================
hdr "6. GET /v1/metrics/summary — métricas agregadas (sin auth)"
curl -sS "$BASE_URL/v1/metrics/summary?window=1h" | pp

# =============================================================================
# 5. ADMIN — LOGS
# =============================================================================
hdr "7. GET /admin/logs — últimos 50 requests (scope admin)"
curl -sS "$BASE_URL/admin/logs?limit=50" -H "Authorization: Bearer $ADMIN_KEY" | pp

hdr "8. GET /admin/logs — filtros: cliente + error + rango de fechas"
curl -sS "$BASE_URL/admin/logs?client_id=$CLIENT_ID&status=error&from=2026-08-01T00:00:00Z&to=2026-08-31T23:59:59Z&limit=50" \
  -H "Authorization: Bearer $ADMIN_KEY" | pp

hdr "9. GET /admin/logs — filtro por proveedor resuelto (solo admin ve la identidad real)"
curl -sS "$BASE_URL/admin/logs?provider=nan&limit=50" -H "Authorization: Bearer $ADMIN_KEY" | pp

# =============================================================================
# 6. ADMIN — ALIASES / BALANCEO
# =============================================================================
hdr "10. GET /admin/aliases — política de ruteo de todos los alias"
curl -sS "$BASE_URL/admin/aliases" -H "Authorization: Bearer $ADMIN_KEY" | pp

hdr "11. GET /admin/aliases/:id — política de un alias"
curl -sS "$BASE_URL/admin/aliases/$ALIAS_ID" -H "Authorization: Bearer $ADMIN_KEY" | pp

hdr "12. PUT /admin/aliases/:id/strategy — cambiar estrategia (204)"
curl -sS -o /dev/null -w "→ HTTP %{http_code}\n" -X PUT "$BASE_URL/admin/aliases/$ALIAS_ID/strategy" \
  -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"strategy":"weighted"}'

hdr "13. PUT /admin/aliases/:id/weights — pesos por posición (204)"
curl -sS -o /dev/null -w "→ HTTP %{http_code}\n" -X PUT "$BASE_URL/admin/aliases/$ALIAS_ID/weights" \
  -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"weights":[1,3]}'

hdr "14. PUT /admin/aliases/:id/priorities — prioridades sparse (204)"
curl -sS -o /dev/null -w "→ HTTP %{http_code}\n" -X PUT "$BASE_URL/admin/aliases/$ALIAS_ID/priorities" \
  -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"priorities":{"0":5}}'

hdr "15. GET /admin/aliases/:id — ver la política aplicada"
curl -sS "$BASE_URL/admin/aliases/$ALIAS_ID" -H "Authorization: Bearer $ADMIN_KEY" | pp

# =============================================================================
# 7. ADMIN — CLIENTES (API keys por tenant)
# =============================================================================
hdr "16. GET /admin/clients — listar clientes"
curl -sS "$BASE_URL/admin/clients" -H "Authorization: Bearer $ADMIN_KEY" | pp

hdr "17. GET /admin/clients/:id — un cliente"
curl -sS "$BASE_URL/admin/clients/$CLIENT_ID" -H "Authorization: Bearer $ADMIN_KEY" | pp

hdr "18. POST /admin/clients — crear cliente (devuelve plaintextApiKey UNA vez)"
# ⚠️ Si el id ya existe, la creación devuelve un error (esperado en una demo).
curl -sS -X POST "$BASE_URL/admin/clients" \
  -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"id":"'"$CLIENT_ID"'","name":"Acme Co.","scopes":["chat.read","chat.write"],"rateLimitRpm":300}' | pp

hdr "19. PATCH /admin/clients/:id — actualizar límites/scopes"
curl -sS -X PATCH "$BASE_URL/admin/clients/$CLIENT_ID" \
  -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"rateLimitRpm":500,"rateLimitTpm":100000}' | pp

hdr "20. POST /admin/clients/:id/rotate — rotar key (nueva plaintextApiKey)"
curl -sS -X POST "$BASE_URL/admin/clients/$CLIENT_ID/rotate" \
  -H "Authorization: Bearer $ADMIN_KEY" | pp

hdr "21. POST /admin/clients/:id/revoke — revocar (204; la cache tarda ≤5 min)"
curl -sS -o /dev/null -w "→ HTTP %{http_code}\n" -X POST "$BASE_URL/admin/clients/$CLIENT_ID/revoke" \
  -H "Authorization: Bearer $ADMIN_KEY"

hdr "22. DELETE /admin/clients/:id — borrar la fila (204)"
curl -sS -o /dev/null -w "→ HTTP %{http_code}\n" -X DELETE "$BASE_URL/admin/clients/$CLIENT_ID" \
  -H "Authorization: Bearer $ADMIN_KEY"

# =============================================================================
# 8. ERRORES COMUNES (demostrativo)
# =============================================================================
hdr "23. Sin API key → 401"
curl -sS -o /dev/null -w "→ HTTP %{http_code}\n" "$BASE_URL/v1/models"

hdr "24. Key sin scope admin en /admin/logs → 403"
curl -sS -o /dev/null -w "→ HTTP %{http_code}\n" "$BASE_URL/admin/logs?limit=10" \
  -H "Authorization: Bearer $API_KEY"

hdr "25. Alias inexistente en chat/completions"
curl -sS "$BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"no-existe","messages":[{"role":"user","content":"hola"}]}' | pp

echo
echo "Hecho."
