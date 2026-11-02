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
| Web search | `POST /v1/search` (REST) + `POST /v1/mcp` (MCP JSON-RPC) + `GET /v1/tools` (discovery) — ver [`docs/search.md`](docs/search.md) |
| Aliases de modelos | El cliente pide `coder`; el gateway resuelve a `nan/qwen3.6`, etc. Nunca expone ids reales upstream |
| Multi-proveedor | Registro de proveedores en SQLite (`providers`), clave por proveedor en env (`NAN_API_KEY`, …) |
| Estrategias de balanceo | `primary`, `round-robin`, `weighted`, `priority-grouped` — configurable por alias vía API admin |
| Circuit breaker | Por proveedor: `closed` / `open` / `half-open`; fallback a la siguiente posición de la chain |
| API keys por cliente | Formato `sk-` + 64 hex. Hash `HMAC-SHA256(pepper, plaintext)` en DB. Scopes, rotación, revocación |
| Rate limiting | Por cliente: `rate_limit_rpm` (requests/min) y `rate_limit_tpm` (tokens/min) |
| Request logs | SQLite `request_logs`: prompt hash, tokens, latencia, proveedor resuelto, alias servido |
| Cuotas mensuales | Límite de tokens por **(cliente × alias)** con degradación silenciosa a un alias de respaldo (`divert_alias_key`) |
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

## Cuotas mensuales de tokens por alias

Un cliente puede tener un **límite mensual de tokens por alias**. La unidad es
`(cliente × alias)`: sin fila en `client_alias_quotas` el alias es **ilimitado**
(no se lee ni se escribe uso).

```bash
KEY="sk-<key-con-scope-admin>"

# Ver las cuotas de un cliente con el uso del mes UTC en curso
curl -s http://localhost:3000/admin/clients/tenant-acme/quotas \
  -H "Authorization: Bearer $KEY"

# Asignar (o cambiar) el límite: 20M tokens/mes en `codex` y, al agotarse,
# rutear en silencio a `slave`
curl -s -X PUT http://localhost:3000/admin/clients/tenant-acme/quotas \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"quotas":[{"aliasKey":"codex","monthlyTokenLimit":20000000,"divertAliasKey":"slave"}]}'

# Quitar la cuota: el alias vuelve a ser ilimitado
curl -s -X DELETE http://localhost:3000/admin/clients/tenant-acme/quotas/codex \
  -H "Authorization: Bearer $KEY"
```

`aliasKey` y `divertAliasKey` deben existir ya en el registry de aliases (no se
crean acá), y el límite tiene que ser un entero `> 0`. El `PUT` aplica **toda la
lista** que manda; no es un reemplazo total del conjunto.

**Qué observa el cliente cuando se agota:**

- **Con `divertAliasKey`** (el caso normal): **nada**. El gateway rutea al alias
de respaldo, responde `200` con el body de siempre y sin headers extra. El
alias de respaldo tiene su propia chain principal+fallback.
- **Sin `divertAliasKey`**: `429` con `code: "quota_exhausted"` y header
  `Retry-After` hasta el 1º del mes UTC siguiente. En streaming el error llega
  como frame SSE.
- El consumo se imputa al alias **servido**, así que el tráfico degradado no
  sigue gastando la cuota del alias agotado: su contador se congela.

**Subir el límite a mitad de mes** (el caso típico de fin de mes) aplica en la
**request siguiente**, sin cache ni invalidación: apenas `tokens < límite` otra
vez, el cliente vuelve a recibir el alias que pidió.

El cliente puede consultar su propio saldo con `GET /v1/quota` (sólo su API key,
sin scope).

**Si un contador perdió escrituras**, se reconstruye desde `request_logs` (que
es el registro durable de lo servido):

```bash
# Primero en seco: reporta el drift sin escribir nada (dryRun=true por defecto)
curl -s -X POST "http://localhost:3000/admin/quotas/reconcile?periodKey=2026-11" \
  -H "Authorization: Bearer $KEY"

# Reparar de verdad
curl -s -X POST "http://localhost:3000/admin/quotas/reconcile?periodKey=2026-11&dryRun=false" \
  -H "Authorization: Bearer $KEY"
```

La reconciliación imputa cada request al alias servido, sólo toca pares que
tienen fila de cuota y escribe valores absolutos: correrla dos veces no cambia
nada. Detalle de endpoints: [`docs/API.md`](docs/API.md) → `POST /admin/quotas/reconcile`.

---

## Allowlist de aliases por cliente

Además de la cuota, un cliente puede tener una **allowlist**: qué aliases puede
usar y ver. La unidad es `(cliente × alias)`; **sin filas el cliente es
ilimitado** (ve y usa todos los aliases, como antes de que existiera la feature).

Se administra desde el dashboard, en la vista **Client access**
(`/dashboard/quotas`): elegí el cliente, agregá o quitá aliases y guardá. Es la
misma vista donde se cargan las cuotas mensuales, a propósito: con la allowlist y
las cuotas del mismo cliente en pantalla, una **config contradictoria** se ve —
una cuota sobre un alias que el cliente no tiene permitido es config muerta,
porque la request se rechaza con `403` antes de que corra el gate de cuotas. El
dashboard marca esas filas, pero no bloquea nada: el servidor es la autoridad.

Para uso scripteado, los mismos endpoints:

```bash
KEY="sk-<key-con-scope-admin>"

# Ver la allowlist de un cliente
curl -s http://localhost:3000/admin/clients/tenant-acme/aliases \
  -H "Authorization: Bearer $KEY"

# Reemplazar la allowlist (el body ES el conjunto: lo que no está, se revoca)
curl -s -X PUT http://localhost:3000/admin/clients/tenant-acme/aliases \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"aliases":["codex","slave"]}'

# Borrar la allowlist: el cliente vuelve a ser ilimitado
curl -s -X DELETE http://localhost:3000/admin/clients/tenant-acme/aliases \
  -H "Authorization: Bearer $KEY"
```

**`unrestricted` viene con `aliases: []`, y esa lista vacía no significa "no
puede usar nada"**: significa lo contrario, que puede usar **todos** los aliases
del registry. Es el estado de todo cliente que nunca se configuró, y por eso un
`PUT` con la lista vacía se rechaza (`400`): como *sin filas = ilimitado*,
aceptar `[]` daría acceso total justo cuando el operador quería lo contrario. Para
limpiar, `DELETE` (o **Return to unrestricted** en el dashboard).

**Al activar la allowlist, el cliente tiene que pedir un alias.** El gate compara
`body.model` tal cual contra la lista. Un request con un path `provider/model`
(`nan/qwen3.6`) o con una model key suelta (`qwen3.6`) — que sin allowlist
funcionan, porque el gateway los resuelve fuera del registry de aliases — pasa a
responder `403` para un cliente restringido: ese string no es un alias permitido.
Es deliberado: la allowlist habla de aliases, y cualquier otra forma de nombrar un
modelo es ambigua para el operador que la configuró. Cargá el alias que el cliente
debe usar y hacé que el cliente lo pida por ese nombre.

**Qué observa el cliente cuando pide un alias que no está en su lista:**

- En `/v1/chat/completions` (y `/v1/messages`): `403` con
  `error.type: "permission_error"` y `code: "alias_not_permitted"`, **sin**
  `Retry-After` (esperar no otorga el permiso; lo otorga el operador). En
  streaming llega como frame SSE de error.
- En `/v1/models`: el alias **no aparece**. Un alias prohibido es
  indistinguible de uno que no existe — el listado no filtra información sobre
  lo que el cliente no puede usar.

**El chequeo usa el alias pedido, nunca el alias servido**, y corre antes del gate
de cuotas. Consecuencia deliberada: si una request se **degrada por cuota** hacia
un alias que no está en la allowlist, **sigue funcionando** — el desvío lo decide
el gateway, no el cliente, y no se lo castiga con un `403`. El caso queda
auditable en `request_logs` (`model_requested` vs `served_alias`).

Detalle de endpoints: [`docs/API.md`](docs/API.md) → `/admin/clients/:id/aliases`.

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

## Migraciones de base de datos (`pnpm db:migrate`)

Aplica las migraciones SQL pendientes de `migrations/` a la base del gateway y
reporta qué hizo. Usa el **mismo** `MigrationRunner` que el arranque del
servidor, así que deja el mismo registro en `_migrations`: lo aplicado acá se
saltea en el próximo boot y viceversa. No hay otra forma de aplicar DDL — si se
aplicara por fuera, el servidor reintentaría el archivo y fallaría con
`table already exists`.

Corre el **`dist/` compilado**, así que primero hay que compilar (la migración
que se aplica es la que el servidor compilado espera encontrar):

```bash
pnpm build

# Aplicar lo pendiente (imprime la lista aplicada, la salteada y los ms totales)
pnpm db:migrate

# Ver qué está aplicado y qué falta, sin escribir nada
pnpm db:migrate -- --status

# Igual que --status pero redactado como "would apply"
pnpm db:migrate -- --dry-run

# Copia consistente de la DB antes de aplicar (VACUUM INTO)
pnpm db:migrate -- --backup

# Apuntar a otra base (omite Doppler: es la vía offline)
pnpm db:migrate -- --db ./data/otra.db
```

**Resuelve la base igual que el servidor.** `src/main.ts` llama `inyectEnv()`
(Doppler) **antes** de `getEnv()`, así que en un entorno real el
`DATABASE_PATH` que el gateway abre viene de Doppler. Este comando hace lo
mismo:

- **Con `START_TOKEN` definido:** carga los mismos secretos desde Doppler
  (proyecto `MS`, config según `NODE_ENV`, p. ej. `ms-proxy-llm/prd`) y recién
  entonces resuelve `DATABASE_PATH` — el mismo archivo que leerá el gateway.
- **Si esa consulta falla:** aborta con exit 1. Nunca cae al default del schema
  (`./data/ms-gateway.db`): un fallback silencioso es exactamente cómo se
  termina migrando la base equivocada. El mensaje pide arreglar
  `START_TOKEN`/`MS`/`NODE_ENV` o pasar `--db`.
- **`--db <path>`:** overrides todo y no contacta Doppler — es la vía
  deliberada y offline (sin red).
- **Sin `START_TOKEN`:** comportamiento local de siempre — `.env`, luego el
  shell, luego el default; no hay red.

Cada corrida imprime la **ruta absoluta de la base, el directorio de
migraciones y el origen de esa ruta** al empezar:

```text
db-migrate · status
  database:   /srv/app/data/gateway.db  (from Doppler ms-proxy-llm/prd)
  migrations: /srv/app/migrations
```

El origen puede ser `Doppler <proyecto>/<config>`, `.env`, `shell`, `default`
o `--db`. Este comando puede tocar un entorno real, así que no deja lugar a
dudas sobre qué base se modificó ni por qué se eligió.

> ⚠️ **Sin `--db`, en un entorno con Doppler configurado, el comando apunta a
> lo que Doppler diga.** Antes de confirmar, lee la línea `database:` impresa.

- `--backup` escribe `<db-sin-extensión>.backup-<timestamp-UTC>.db` con
  `VACUUM INTO` (síncrono, copia consistente y compactada; requiere SQLite
  3.27+, la versión se reporta en la salida). Nunca sobrescribe: si el nombre ya
  existe agrega `-2`, `-3`, …
- **Pará el gateway antes.** Las migraciones toman el lock de escritura de
  SQLite; si la base está bloqueada el comando falla con `SQLITE_BUSY` (no
  reintenta: solo espera el timeout por defecto de `better-sqlite3`, ~5 s) en
  vez de quedarse colgado.
- Si falla una migración, cada archivo corre en su propia transacción: se
  revierte y la base queda como estaba. El error se imprime tal cual.
- El servidor correría estas mismas migraciones al arrancar; el comando existe
  para hacerlo **a propósito**, ver el estado y medir cuánto tarda.

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
- **DB:** `data/ms-gateway.db` (SQLite). Migraciones en `migrations/` (raíz, `0001`–`0014`); seed de proveedores al primer boot. Aplicación deliberada y medible: `pnpm db:migrate` (ver arriba).
- **Redis:** solo para cache de auth (TTL 5 min). Caída → fallback a SQLite.
