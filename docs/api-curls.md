# ms-gateway-llm — Curls de referencia (API)

Ejemplos listos para copiar y pegar de todos los endpoints públicos y admin.
Versión ejecutable en [`scripts/api-curls.sh`](../scripts/api-curls.sh).

**Requisitos:** exportá las variables antes de usar los ejemplos:

```bash
export BASE_URL="http://localhost:3000"
export API_KEY="sk-..."     # key pública (scopes chat.read / chat.write)
export ADMIN_KEY="sk-..."   # key con scope admin
export ALIAS_ID="coder"     # alias sobre el que probás el ruteo
export CLIENT_ID="tenant-acme"
```

> Para generar las keys con el CLI del gateway:
>
> ```bash
> export API_KEY_PEPPER=$(openssl rand -hex 32)   # misma pepper que el gateway
> pnpm admin:reset -- --create --id admin --scopes "admin,chat.read,chat.write,chat.completions" --rpm 1000
> pnpm admin:reset -- --create --id demo   --scopes "chat.read,chat.write" --rpm 60
> ```
>
> La `plaintextApiKey` se muestra **una sola vez** — guardala.

Referencia completa: [`docs/API.md`](API.md) · [`docs/API-KEYS.md`](API-KEYS.md) · [`docs/ARCHITECTURE.md`](ARCHITECTURE.md).

---

## 1. Health (sin auth)

```bash
# Liveness del proceso
curl -sS "$BASE_URL/v1/health"

# Circuit breaker por proveedor (closed / open / half-open)
curl -sS "$BASE_URL/v1/health/llm"
```

---

## 2. Catálogo de modelos (auth pública)

```bash
curl -sS "$BASE_URL/v1/models" \
  -H "Authorization: Bearer $API_KEY"
```

Solo devuelve **aliases** — la identidad real del upstream nunca se expone.

---

## 3. Chat completions (auth pública)

```bash
# JSON (buffered)
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
  }'

# Streaming (SSE) — usa -N para leer el stream en vivo
curl -sSN "$BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "'"$ALIAS_ID"'",
    "messages": [{"role": "user", "content": "Di hola en 5 palabras"}],
    "stream": true
  }'
```

---

## 4. Métricas (sin auth)

```bash
# Ventana: 1h | 24h | 7d (default 1h)
curl -sS "$BASE_URL/v1/metrics/summary?window=1h"

# Con timestamp explícito (unix seconds)
curl -sS "$BASE_URL/v1/metrics/summary?window=24h&now=1783353000"
```

---

## 5. Logs de requests (scope admin)

```bash
# Últimos 50 requests
curl -sS "$BASE_URL/admin/logs?limit=50" \
  -H "Authorization: Bearer $ADMIN_KEY"

# Filtros: cliente + status + rango de fechas (ISO-8601)
curl -sS "$BASE_URL/admin/logs?client_id=$CLIENT_ID&status=error&from=2026-08-01T00:00:00Z&to=2026-08-31T23:59:59Z&limit=50" \
  -H "Authorization: Bearer $ADMIN_KEY"

# Filtro por proveedor resuelto — solo admin ve la identidad real upstream
curl -sS "$BASE_URL/admin/logs?provider=nan&limit=50" \
  -H "Authorization: Bearer $ADMIN_KEY"
```

Filtros disponibles: `client_id`, `model` (alias), `provider`, `resolved_model`,
`status` (`ok` / `error` / `circuit_open`), `from`, `to`, `limit` (default 100, máx 500).

---

## 6. Aliases y estrategia de balanceo (scope admin)

```bash
# Ver la política de ruteo de todos los alias
curl -sS "$BASE_URL/admin/aliases" \
  -H "Authorization: Bearer $ADMIN_KEY"

# Ver un alias
curl -sS "$BASE_URL/admin/aliases/$ALIAS_ID" \
  -H "Authorization: Bearer $ADMIN_KEY"

# Cambiar estrategia (primary | round-robin | weighted | priority-grouped)
curl -sS -X PUT "$BASE_URL/admin/aliases/$ALIAS_ID/strategy" \
  -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"strategy":"weighted"}'

# Pesos por posición (length debe == length de la chain)
curl -sS -X PUT "$BASE_URL/admin/aliases/$ALIAS_ID/weights" \
  -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"weights":[1,3]}'

# Prioridades por posición (mapa sparse; posiciones omitidas conservan su valor)
curl -sS -X PUT "$BASE_URL/admin/aliases/$ALIAS_ID/priorities" \
  -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"priorities":{"0":5}}'

# Verificar el cambio aplicado
curl -sS "$BASE_URL/admin/aliases/$ALIAS_ID" \
  -H "Authorization: Bearer $ADMIN_KEY"
```

Los cambios se persisten en SQLite (`alias_policy` / `alias_entries`) — **no
requieren redeploy**.

---

## 7. Gestión de clientes / API keys (scope admin)

```bash
# Listar clientes (incluye revocados)
curl -sS "$BASE_URL/admin/clients" \
  -H "Authorization: Bearer $ADMIN_KEY"

# Un cliente
curl -sS "$BASE_URL/admin/clients/$CLIENT_ID" \
  -H "Authorization: Bearer $ADMIN_KEY"

# Crear cliente — devuelve plaintextApiKey UNA sola vez
# ⚠️ Si el id ya existe, la creación falla (esperado en una demo).
curl -sS -X POST "$BASE_URL/admin/clients" \
  -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"id":"'"$CLIENT_ID"'","name":"Acme Co.","scopes":["chat.read","chat.write"],"rateLimitRpm":300}'

# Actualizar límites / scopes
curl -sS -X PATCH "$BASE_URL/admin/clients/$CLIENT_ID" \
  -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"rateLimitRpm":500,"rateLimitTpm":100000}'

# Rotar key (devuelve la nueva plaintextApiKey)
curl -sS -X POST "$BASE_URL/admin/clients/$CLIENT_ID/rotate" \
  -H "Authorization: Bearer $ADMIN_KEY"

# Revocar — 204; la cache de auth tarda ≤5 min en propagarse
curl -sS -X POST "$BASE_URL/admin/clients/$CLIENT_ID/revoke" \
  -H "Authorization: Bearer $ADMIN_KEY"

# Borrar la fila — 204
curl -sS -X DELETE "$BASE_URL/admin/clients/$CLIENT_ID" \
  -H "Authorization: Bearer $ADMIN_KEY"
```

---

## 8. Errores comunes

```bash
# Sin API key → 401
curl -sS -o /dev/null -w "→ HTTP %{http_code}\n" "$BASE_URL/v1/models"

# Key sin scope admin en /admin/* → 403
curl -sS -o /dev/null -w "→ HTTP %{http_code}\n" "$BASE_URL/admin/logs?limit=10" \
  -H "Authorization: Bearer $API_KEY"

# Alias inexistente en chat/completions
curl -sS "$BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"no-existe","messages":[{"role":"user","content":"hola"}]}'
```

---

## Status codes

| Status | Cuándo |
|---|---|
| `200` | Respuesta exitosa |
| `201` | Cliente creado (`POST /admin/clients`) |
| `204` | Mutación sin body (strategy/weights/priorities, revoke, delete) |
| `400` | Body o query falló validación (zod) |
| `401` | API key faltante o inválida |
| `403` | Cliente autenticado pero sin scope requerido |
| `404` | Recurso inexistente |
| `429` | Rate limit excedido — `Retry-After: <segundos>` |
| `500` | Error de upstream o del gateway |
