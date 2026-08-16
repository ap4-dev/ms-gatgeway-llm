# ms-gateway-llm — Arquitectura

> **Estado:** este documento describe la implementación **actual** del código
> (feb 2026, POC con funcionalidad en producción). Si algo no coincide con lo
> que ves en `src/`, es que el doc quedó viejo — actualizalo.

---

## 1. Resumen

Gateway LLM **OpenAI-compatible** en **NestJS 11 sobre Fastify** (`@nestjs/platform-fastify`).
Recibe `/v1/chat/completions`, resuelve el modelo pedido (alias → proveedor
real), rutea la llamada upstream bajo un **circuit breaker por proveedor** con
**estrategias de balanceo** configurables, y registra cada request en **SQLite**.

```
Cliente (Kilo / OpenCode / Claude Code / …)
   │  Authorization: Bearer sk-…
   ▼
POST /v1/chat/completions  ──▶  ChatController
                                   │  guards: ApiKeyAuth → RequireScopes → RateLimit
                                   ▼
                              ChatService
                                   │  normalize (merge system) + prompt hash
                                   │  tee del stream (para tokens)
                                   ▼
                              RoutingService
                                   │  alias → chain ordenada (pickOrder por estrategia)
                                   │  walk bajo CircuitBreaker
                                   ▼
                              ProviderService  ──▶  OpenAI SDK (cliente cacheado por provider)
                                   │  apiKey env · baseURL · timeoutMs · overrides
                                   ▼
                              Upstream (nan / openai / …)
```

**Stack:** NestJS 11 · Fastify · TypeScript · zod · `better-sqlite3` · OpenAI SDK ·
ioredis (cache de auth + rate limit) · Doppler (secretos) · NewRelic + Sentry ·
Swagger (`@nestjs/swagger`).

---

## 2. Módulos

`src/app.module.ts` cablea:

| Módulo | Responsabilidad |
|---|---|
| `ConfigModule` + `CoreModule` | Env schema zod, CORS, tokens DI (`ENV_CONFIG`) |
| `RedisModule` / `RedisService` | Cliente ioredis (cache de auth, rate limit) |
| `ChatModule` | `chat.controller` (completions) + `models.controller` (catálogo) + `chat.service` |
| `HealthModule` | `GET /v1/health` (AppController), `/v1/health/llm`, `/v1/metrics/summary` |
| `AdminModule` | `admin/clients`, `admin/aliases`, `admin/logs`, `admin-reset-cli` |
| `AuthModule` | `ApiKeyAuthGuard`, `RequireScopesGuard`, repositorio/servicio de clientes, cache de auth |
| `DatabaseModule` (global) | Conexión SQLite, migraciones, seed, repositorios |
| `RatelimitModule` | `RateLimitGuard` + limiter Redis (fail-open) |
| Sentry | `APP_FILTER` global + `sentry.instrument.ts` |

### Bootstrap (`src/main.ts`)

1. Carga `newrelic`, `dotenv`, `sentry.instrument` (efectos al import).
2. `inyectEnv()` → Doppler escribe secretos en `process.env` (ganan sobre `.env`).
3. `getEnv()` → valida el schema zod; **fail-fast** si falta algo
   (p. ej. `API_KEY_PEPPER` < 32 chars).
4. `NestFactory.create` con `FastifyAdapter` (`trustProxy: true`, logger).
5. Registra websocket, static (assets de Swagger), multipart (10 MB), CORS.
6. Prefijo global `/v1` (excluye `docs` y `docs-json`).
7. `setupSwagger()` → UI en `/docs`, spec en `/docs-json` (solo AdminModule).
8. Escucha en `PORT` (default 3000) y manda `process.send('ready')` (pm2 `wait_ready`).
9. `SIGINT`/`SIGTERM` → `app.close()` graceful.

---

## 3. Flujo de una request (`POST /v1/chat/completions`)

1. **Guards** (pre-hooks): `ApiKeyAuthGuard` valida la key y adjunta el
   `clientId`; `RateLimitGuard` aplica RPM/TPM del cliente. Scope `chat.write`
   requerido si el guard de scopes está activo en esa ruta.
2. **`ChatService.completions`**:
   - Calcula `promptHash` (hash de messages + model).
   - Delega en `RoutingService.route(model, body, executor)`.
   - `executor` → `callUpstream`: normaliza body (`mergeSystemMessages`),
     aplica overrides (`maxTokens`, `stream_options.include_usage`), y llama al
     **OpenAI SDK** con un `AbortSignal` cuyo timeout es el `timeoutMs` efectivo.
3. **Respuesta:**
   - `stream: false` → `ChatCompletion` completa; se extrae `usage` y se
     registra success (DB + log estructurado).
   - `stream: true` → se **tee** el iterable del SDK: el cliente recibe los
     chunks en vivo (TTFT intacto) mientras una copia se acumula para capturar
     tokens al final (uso real si llega, si no, estimador local 1 token ≈ 4 chars).
4. **Errores:** `RoutingFailedError` (todas las posiciones fallaron) o
   `CircuitOpenError` → se registra failure y se responde el error estructurado.

---

## 4. Registro de proveedores y resolución de modelos

Fuente de verdad: `config/providers.json` (validado con zod en
`provider.model.ts`). Se siembra en SQLite al primer boot y se cachea en
`ProviderRegistryService`.

```jsonc
{
  "providers": {
    "nan": {
      "apiKeyEnv": "NAN_API_KEY",          // env var de la key
      "baseURL": "https://api.nan.builders/v1",
      "timeoutMs": 120000,                  // override del timeout global
      "models": { "qwen3-coder": { "real": "qwen3-coder", "maxTokens": 32768 } }
    }
  },
  "aliases": {
    "coder": ["nan/qwen3-coder", "nan/mimo-v2.5", "nan/deepseek-v4-flash"]
  },
  "routing": { /* knobs globales del breaker, ver §6 */ }
}
```

`ProviderService.resolveChain(model)` devuelve la **chain ordenada** de
`ResolvedModel[]`. Orden de resolución del string recibido:

1. **Alias** (`coder`) → su chain.
2. **`provider/model`** (`nan/qwen3-coder`) → chain de un elemento.
3. **model key** → scan entre todos los proveedores.
4. **`default`** → chain del alias `default` si existe.
5. → error con la lista de aliases/modelos conocidos.

El `baseURL` default es `LLM_PROVIDER_BASE_URL` (o `api.openai.com/v1`). El
`apiKey` se lee de `process.env[apiKeyEnv]` al resolver; si falta → error al
primer uso. `clientFor()` cachea **un cliente OpenAI por provider** (un pool de
conexiones por upstream).

---

## 5. Ruteo y estrategias de balanceo

`RoutingService.route` combina tres piezas:

- **`ProviderService.resolveChain`** → chain (fallbacks ordenados).
- **`pickOrder(strategy, chain, cursorNext, weights)`** (`src/routing/strategy.ts`)
  → secuencia de índices a intentar.
- **`CircuitBreakerService`** → decide qué posiciones se intentan (skip si el
  circuito del provider está abierto).

La estrategia es **por alias** (`PUT /admin/aliases/:id/strategy` la cambia en
caliente; se persiste en `alias_policy`). Valores:

| Estrategia | `pickOrder` produce | Estado compartido |
|---|---|---|
| `primary` (y alias `fallback`) | chain en orden (`[0,1,2,…]`) — posición 0 primero | ninguno |
| `round-robin` | arranca en el cursor (avanza por request) y camina hacia adelante | cursor por modelo (`RoundRobinCursor`) |
| `weighted` | muestra un índice de arranque ponderado por `weights[i]` y camina adelante | ninguno (aleatorio por call) |
| `priority-grouped` | ordena por (prioridad asc, posición asc) | prioridades en `alias_entries` |

Durante el walk, por cada posición: si el breaker rechaza al provider →
`attempts.push({circuitOpen:true})` y sigue; si no, ejecuta con
`AbortSignal.timeout(timeoutMs)` bajo `breaker.execute`. Éxito → retorna.
Fallo → intenta la siguiente. Si se agotan todas → `RoutingFailedError` con el
detalle de `attempts`.

> Los pesos (`weights`) y prioridades (`priorities`) se cambian con
> `PUT /admin/aliases/:id/weights` y `/priorities`; ver `docs/API.md`.

---

## 6. Circuit breaker (`src/resilience/circuit-breaker.service.ts`)

Uno por **provider** (estado keyed por `providerId`), tres estados:

```
closed ──(failureThreshold fallos consecutivos)──▶ open
open   ──(cooldownMs transcurrido)────────────────▶ half-open
half-open ──(probe OK)────────────────────────────▶ closed
half-open ──(probe falla)─────────────────────────▶ open
```

Knobs (defaults en `provider.model.ts`):

| Knob | Default | Significado |
|---|---|---|
| `failureThreshold` | 5 | Fallos consecutivos en `closed` que abren el circuito |
| `cooldownMs` | 30 000 | Tiempo en `open` antes de permitir un probe |
| `halfOpenProbes` | 1 | Probes concurrentes máximos en `half-open` |
| `requestTimeoutMs` | 120 000 | Timeout efectivo por intento upstream |
| `fallbackEnabled` | true | Habilita el walk de fallbacks |

`GET /v1/health/llm` expone el snapshot por provider (`state`, `failures`,
`canServe`) sin auth.

---

## 7. Autenticación, autorización y rate limiting

### API keys (`src/auth/`)

- Formato `sk-` + 64 hex. En DB solo vive el hash
  `HMAC-SHA256(API_KEY_PEPPER, plaintext)` (ver `docs/API-KEYS.md`).
- `ApiKeyAuthGuard`: lee `Authorization: Bearer` (o `X-API-Key`), extrae el
  prefix (8 chars) → lookup en **Redis** (`ak:v1:<prefix>:<sha256>`, TTL 5 min)
  o fallback a SQLite (`clients`). Verifica con timing-safe. Adjunta `clientId`.
- `RequireScopesGuard` + `@RequireScopes('admin')`: las rutas admin exigen el
  scope `admin`.
- `ClientService`: create / rotate / revoke; `seed-default-client` crea el
  cliente `admin` en el primer boot si la tabla está vacía.

### Rate limiting (`src/ratelimit/`)

- `RateLimitGuard` aplica `rate_limit_rpm` (requests/min) y `rate_limit_tpm`
  (tokens/min) del cliente autenticado.
- `RedisRateLimiterService` (ventana deslizante en Redis); ante fallo de Redis
  **fail-open** (nunca bloquea tráfico legítimo). Los tests usan un fake en
  memoria con la misma interfaz.

---

## 8. Persistencia (SQLite)

Conexión singleton vía `DatabaseService` (`better-sqlite3`, síncrono). Path:
`DATABASE_PATH` (default `./data/ms-gateway.db`). Al primer boot: corre
migraciones (`migrations/`) y siembra el registro de proveedores
(`migrations/seeds/0001_initial_providers.json`).

Tablas (migraciones `0001`–`0011`):

| Tabla | Contenido |
|---|---|
| `providers` | `id`, `api_key_env`, `base_url`, `timeout_ms` |
| `model_configs` | `real`, `max_tokens`, `supports_stream`, `disable_thinking` por modelo (0011) |
| `alias_policy` | estrategia por alias (`primary`/`round-robin`/`weighted`/`priority-grouped`/`fallback`) |
| `alias_entries` | posiciones de la chain + `weight` y `priority` por posición |
| `alias_weights` | pesos por posición (estrategia `weighted`) |
| `routing_policy` | knobs globales del breaker/fallback |
| `clients` | `id`, `name`, `api_key_hash`, `api_key_prefix`, `scopes`, `rate_limit_rpm`, `rate_limit_tpm`, `revoked_at`, `last_used_at` |
| `request_logs` | `requested_at`, `client_key`, `model_requested`, `resolved_provider`, `resolved_model`, `attempts`, `latency_ms`, `status`, `error`, `prompt_hash`, `prompt_tokens`, `completion_tokens`, `total_tokens`, `attempt_details` (+ índices en `0009`) |

> Migraciones `0010` (attempt_details) y `0011` (disable_thinking) — ver
> `migrations/0010_request_logs_attempts.sql` y `migrations/0011_model_disable_thinking.sql`.
> Desde `0010`, cada intento fallido de una chain de fallback se loggea como
> su propia fila `status='error'` con el mensaje de error del provider;
> `attempt_details` (JSON) guarda el detalle por intento (provider, model,
> duración, error, circuit open). `disable_thinking` inyecta
> `thinking: {type: 'disabled'}` en requests a modelos DeepSeek V4 que exigen
> el echo de `reasoning_content` en threads multi-turno.

> El gateway registra en la tabla **después** de responder: `request_logs`
> documenta lo que pasó; no bloquea la respuesta. Con la réplica única actual
> alcanza SQLite; si escala, la tabla pasa a Postgres sin cambiar la forma de
> la respuesta (`GET /admin/logs`).

---

## 9. Observabilidad

| Capa | Mecanismo |
|---|---|
| Logs de proceso | Nest logger / Pino vía Fastify (`bufferLogs`), formato JSON (`AppJsonLogger`) |
| Logs estructurados de LLM | `LlmLoggingService` — evento `chat.request` a stdout: model, resolvedProvider, promptHash, latency, tokens, status, clientKey |
| Request logs persistidos | `request_logs` (SQLite) — consultables por `GET /admin/logs` |
| Métricas agregadas | `GET /v1/metrics/summary` (ventana 1h/24h/7d, por alias) — `MetricsService` |
| Health | `GET /v1/health` (memoria), `GET /v1/health/llm` (circuit breakers) |
| APM / errores | NewRelic (import en `main.ts`) + Sentry (`sentry.instrument.ts`, `APP_FILTER`) |

**Privilegios de visibilidad:** la superficie pública (`/v1/models`,
`/v1/metrics/summary`) solo expone **aliases**. `GET /admin/logs` expone
`resolvedProvider` / `resolvedModel` (identidad real upstream) — gated por el
scope `admin`.

---

## 10. Superficie admin y Swagger

- **Rutas:** `GET/POST/PATCH/DELETE /admin/clients…`, `GET/PUT
  /admin/aliases…`, `GET /admin/logs`. Auth: key válida + scope `admin` +
  rate limit.
- **Swagger:** `/docs` (UI) y `/docs-json` (spec) — solo documenta el
  AdminModule, fuera del prefijo `/v1`.

---

## 11. Estado actual y roadmap pendiente

**Hecho:** multi-proveedor, aliases, 4 estrategias de balanceo, circuit
breaker, auth por cliente (HMAC+pepper), rotación/revocación, rate limiting
RPM/TPM, request logs + tokens, log de intentos fallidos individuales,
`disable_thinking` por modelo (DeepSeek V4), métricas por ventana, health LLM,
admin API + Swagger, Doppler, NewRelic/Sentry.

**Pendiente / deuda técnica:**

- El controlador de aliases escribe prioridades tocando la DB directamente
  (comentario en `admin-aliases.controller.ts`) — falta un método
  `replacePriorities` en el repositorio.
- `GET /admin/logs` con `?model=` / `?provider=` son scans por `requested_at`;
  ok hasta ~5M filas.
- Streaming: los tokens se estiman si el upstream no manda chunk de `usage`
  (el `stream_options.include_usage` se fuerza salvo que el cliente lo desactive).
- `API_KEY_PEPPER` y otras secrets viven en `process.env` — redacción en logs
  y rotación de pepper a revisar para hardening.
- No hay caché de respuestas idénticas ni paginación con cursor en `/admin/logs`.
