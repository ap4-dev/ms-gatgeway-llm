# ms-gateway-llm

Gateway LLM **OpenAI-compatible** construido con **NestJS 11 + Fastify**.
Proxy con aliases de modelos, ruteo multi-proveedor, circuit breaker,
autenticación por cliente (API keys) y logging de requests — todo persistido en
**SQLite** (`better-sqlite3`).

> ⚠️ **Estado:** POC con funcionalidad real en producción. La documentación
> completa de API está en [`docs/API.md`](docs/API.md); gestión de API keys en
> [`docs/API-KEYS.md`](docs/API-KEYS.md); arquitectura/roadmap en
> [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Qué hace

| Capacidad | Detalle |
|---|---|
| Chat completions | `POST /v1/chat/completions` — OpenAI-compatible, buffered y SSE streaming |
| Aliases de modelos | El cliente pide `coder`; el gateway resuelve a `nan/qwen3.6`, etc. Nunca expone ids reales upstream |
| Multi-proveedor | Registro de proveedores en SQLite (`providers`), clave por proveedor en env (`NAN_API_KEY`, …) |
| Estrategias de balanceo | `primary`, `round-robin`, `weighted`, `priority-grouped` — configurable por alias vía API admin |
| Circuit breaker | Por proveedor: `closed` / `open` / `half-open`; fallback a la siguiente posición de la chain |
| API keys por cliente | Formato `sk-` + 64 hex. Hash `HMAC-SHA256(pepper, plaintext)` en DB. Scopes, rotación, revocación |
| Rate limiting | Por cliente: `rate_limit_rpm` (requests/min) y `rate_limit_tpm` (tokens/min) |
| Request logs | SQLite `request_logs`: prompt hash, tokens, latencia, proveedor resuelto |
| Métricas | `GET /v1/metrics/summary` — ventana `1h/24h/7d` por alias |
| Health | `GET /v1/health` (proceso) y `GET /v1/health/llm` (por proveedor) |
| Admin | CRUD de clientes, política de aliases, consulta de logs — scope `admin` |
| Swagger | UI interactiva en `/docs` (solo superficie admin), spec OpenAPI en `/docs-json` |

**Auth:** cada request requiere `Authorization: Bearer sk-…` (o `X-API-Key`).
El cache de autenticación vive en **Redis** (TTL 5 min); si Redis cae, se cae a
SQLite (fail-open).

---

## Arranque rápido

```bash
pnpm install
cp .env.example .env            # completar las claves
pnpm build
pnpm start:prod                 # o pnpm start:dev para watch
```

El servicio escucha en `PORT` (default **3000**), bind `0.0.0.0`, prefijo global
`/v1`.

### Variables de entorno clave

| Variable | Requerida | Default | Descripción |
|---|---|---|---|
| `API_KEY_PEPPER` | **sí** | — | Pepper server-side (≥32 chars) para hashear API keys. `openssl rand -hex 32`. Idéntica en gateway y CLI admin. |
| `DATABASE_PATH` | no | `./data/ms-gateway.db` | Ruta del SQLite. El primer boot crea schema y siembra el registro de proveedores. |
| `NAN_API_KEY` | sí* | — | API key del proveedor `nan`. Cada proveedor del registro usa su propia env var. |
| `CORS_ORIGINS` | no | `*` | Allowlist de orígenes separados por coma. |
| `NODE_ENV` | no | `development` | Alias Doppler: `dev`/`stg`/`prd`. |
| `MS` / `START_TOKEN` | no | — | Proyecto + PAT de Doppler para secretos (ganan sobre `.env`). |
| `SENTRY_DSN` | no | — | Tracking de errores (opcional). |

---

## Probar que funciona

```bash
# Health del proceso (sin auth)
curl -s http://localhost:3000/v1/health

# Listar aliases de modelos (requiere API key)
curl -s http://localhost:3000/v1/models -H "Authorization: Bearer sk-…"

# Chat completions (requiere API key)
curl -s http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-…" -H "Content-Type: application/json" \
  -d '{"model":"coder","messages":[{"role":"user","content":"Hola"}],"stream":false}'

# Métricas agregadas (sin auth)
curl -s "http://localhost:3000/v1/metrics/summary?window=1h"

# Swagger (admin)
# navegador → http://localhost:3000/docs
```

---

## Ver los logs (requests)

**`GET /admin/logs`** — admin scope requerido. Lee la tabla `request_logs` de
SQLite (nuevos primero).

```bash
curl -s "http://localhost:3000/admin/logs?limit=50" \
  -H "Authorization: Bearer sk-<key-con-scope-admin>"

# Con filtros (AND combinados)
curl -s "http://localhost:3000/admin/logs?client_id=tenant-acme&status=error&from=2026-07-01T00:00:00Z" \
  -H "Authorization: Bearer sk-…"
```

Filtros: `client_id`, `model` (alias), `provider`, `resolved_model`, `status`
(`ok`/`error`/`circuit_open`), `from`/`to` (ISO-8601), `limit` (default 100,
máx 500). Respuesta con `hasMore` para paginar. **Solo los admin ven
`resolvedProvider` / `resolvedModel`** — la superficie pública siempre oculta
la identidad real del upstream.

> Referencia completa: [`docs/API.md`](docs/API.md) → sección `GET /admin/logs`.

---

## Modificar la estrategia de balanceo

La política de ruteo es **por alias** y se cambia en caliente vía API admin
(se persiste en SQLite; sin redeploy).

```bash
# Ver la política actual de todos los aliases
curl -s http://localhost:3000/admin/aliases -H "Authorization: Bearer sk-…"

# Cambiar la estrategia de un alias
curl -s -X PUT http://localhost:3000/admin/aliases/coder/strategy \
  -H "Authorization: Bearer sk-…" -H "Content-Type: application/json" \
  -d '{"strategy":"weighted"}'

# Poner pesos por posición (length debe == length de la chain)
curl -s -X PUT http://localhost:3000/admin/aliases/coder/weights \
  -H "Authorization: Bearer sk-…" -H "Content-Type: application/json" \
  -d '{"weights":[1,3]}'

# Prioridades por posición (mapa sparse; posiciones omitidas conservan su valor)
curl -s -X PUT http://localhost:3000/admin/aliases/coder/priorities \
  -H "Authorization: Bearer sk-…" -H "Content-Type: application/json" \
  -d '{"priorities":{"0":5}}'
```

### Estrategias soportadas (`PUT /admin/aliases/:id/strategy`)

| Valor | Comportamiento |
|---|---|
| `primary` | Siempre la chain en orden: posición 0 primero, las demás solo si falla (fallback) |
| `round-robin` | Un cursor avanza una posición por request; se reparte de forma pareja |
| `weighted` | Muestra un índice de arranque ponderado por `weights[i]` y recorre la chain desde ahí |
| `priority-grouped` | Ordena por (prioridad asc, posición asc): los grupos de menor prioridad solo se intentan si fallan los de mayor |

La decisión efectiva la toma `src/routing/strategy.ts` (`pickOrder`), con estado
de cursor en `src/routing/round-robin-cursor.ts`. La caída de un proveedor se
detecta con circuit breaker (ver `GET /v1/health/llm` → campo `state`).

---

## Gestión de API keys de cliente

Las keys tienen formato `sk-` + 64 hex. Se crean con el CLI `admin:reset`, que
**imprime el SQL a aplicar** en la DB (nunca abre la DB):

```bash
export API_KEY_PEPPER=$(openssl rand -hex 32)

# Crear cliente (genera key nueva)
pnpm admin:reset -- --create --id tenant-acme --name "Acme Co." --rpm 300

# Rotar key de un cliente existente
pnpm admin:reset -- --reset admin

# Hash de una key existente (migración POC)
pnpm admin:reset -- --reset admin --plain "sk-mi-key-existente"
```

La key plana se muestra **una sola vez**. Alternativamente, todo esto está
expuesto en la API admin (`POST /admin/clients`, `PATCH`, `/:id/rotate`,
`/:id/revoke`, `DELETE`). Guía completa: [`docs/API-KEYS.md`](docs/API-KEYS.md).

---

## Documentación

| Documento | Contenido |
|---|---|
| [`docs/API.md`](docs/API.md) | Referencia completa de endpoints (públicos + admin), auth, status codes |
| [`docs/API-KEYS.md`](docs/API-KEYS.md) | Gestión de API keys: formato, CLI, rotación, migración |
| [`docs/api-curls.md`](docs/api-curls.md) | Curls listos para copiar y pegar (públicos + admin). Versión ejecutable: `scripts/api-curls.sh` |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Arquitectura, decisiones de diseño y roadmap |

---

## Operación

- **Logs de proceso:** stdout (pino/Nest logger) + NewRelic/Sentry según config.
- **Shutdown:** señal `SIGTERM` → cierre graceful de Fastify.
- **DB:** `data/ms-gateway.db` (SQLite). Migraciones en `migrations/` (raíz, `0001`–`0011`); seed de proveedores al primer boot.
- **Redis:** solo para cache de auth (TTL 5 min). Caída → fallback a SQLite.
