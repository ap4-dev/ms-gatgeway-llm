# Feature: Cuota mensual de tokens por (cliente × alias) con degradación silenciosa

> Estado: **planificado** (ninguna línea de código escrita todavía).
> Rama: `feature/cuotas-mensuales-tokens`.

## 0. Alcance real (acotado el 2026-11-01)

Un cliente tiene un **límite mensual de tokens por alias**. Si lo supera, el
gateway lo **rutea en silencio** a un alias de respaldo que tiene su propio
comportamiento principal+fallback.

```
Alias codex  → principal: deepseek-v4-flash   fallback: qwen-3.6   (frontera)
Alias slave  → principal: qwen                fallback: gemma      (ilimitado)

Cliente 1 → codex: 20M/mes
Cliente 2 → codex: 30M/mes
Cliente 3 → codex: 50M/mes

Cliente 1 pide codex, uso < 20M  → deepseek. Si deepseek falla → qwen.   (comportamiento actual)
Cliente 1 pide codex, uso ≥ 20M  → se rutea a slave → qwen. Si falla → gemma.
Cliente 2 pide slave cuando quiera → sin cuota, sin control, como hoy.
```

### Lo que queda explícitamente FUERA

| Descartado | Por qué |
|---|---|
| Control de la capacidad del proveedor (100M) | El usuario compra más o recibe promociones. **No se gestiona acá.** |
| Allowlist de aliases por cliente | `slave` es **abierto a propósito**: "el cliente puede pegarle a slave sin problemas si así lo desea siempre". No hay bypass que evitar. |
| Cuota por modelo dentro de una chain | La unidad de cuota es el **alias**, no la posición. |
| Cache de cuota en memoria | Ver §5 — subir el límite debe tener efecto inmediato. |
| Unidades normalizadas de costo | Todos los tokens se asumen equivalentes por ahora. |

## 1. Decisiones

| ID | Decisión | Valor |
|----|----------|-------|
| D1 | Aviso al cliente al degradar | **Silencioso.** Sin headers, sin mutación del body. |
| D2 | Cuota agotada y sin alias de respaldo | `429 quota_exhausted` + `Retry-After` hasta el 1° del mes UTC |
| D3 | ~~Allowlist~~ | **Descartada** (ver §0) |
| D4 | Corte de período | Mes calendario **UTC** (`'YYYY-MM'`) |
| D5 | Unidad de cuota | **(cliente × alias)**, fila explícita; sin fila = ilimitado |
| D6 | Asignación | Admin API: alias + límite por cliente, editable en cualquier momento |

## 2. Por qué el cambio es chico

Tres hechos verificados en el código actual:

1. **`RoutingService.route()` ignora `body`** (`_body`, `routing.service.ts:70`). La
   decisión de qué alias rutear es sólo el primer argumento.
2. **`applyResolved()` siempre sobreescribe `model` con `resolved.upstreamModel`**
   (`chat.service.ts:333-338`). Rutear `slave` no contamina el request upstream:
   el proveedor recibe el modelo real de `slave`.
3. El fallback **dentro** de `slave` (qwen → gemma) ya funciona: es el walk que
   existe. No hay que tocarlo.

Conclusión: el gate es **una sustitución del primer argumento de `route()`**.
`RoutingService` no se modifica. El walk no se modifica. El circuit breaker no se
toca.

```ts
// src/chat/chat.service.ts — antes de route()
const target = this.quota.resolveTarget(clientId, body.model);
const r = await this.router.route(target, body, (resolved, signal) =>
    this.callUpstream(resolved, body, signal),
);

// después de la respuesta
this.quota.recordUsage(clientId, target, tokens.totalTokens);
```

## 3. Modelo de datos

Dos tablas nuevas + una columna.

```sql
-- migrations/0014_client_alias_quotas.sql

CREATE TABLE client_alias_quotas (
  client_id        TEXT    NOT NULL,
  alias_key        TEXT    NOT NULL,              -- 'codex'
  monthly_token_limit INTEGER NOT NULL CHECK (monthly_token_limit > 0),
  divert_alias_key TEXT    CHECK (divert_alias_key IS NULL OR divert_alias_key <> alias_key),
  created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at       INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (client_id, alias_key)
);

CREATE TABLE client_alias_usage (
  client_id  TEXT    NOT NULL,
  alias_key  TEXT    NOT NULL,                    -- alias EFECTIVAMENTE servido
  period_key TEXT    NOT NULL,                    -- 'YYYY-MM' (UTC)
  tokens     INTEGER NOT NULL DEFAULT 0 CHECK (tokens >= 0),
  requests   INTEGER NOT NULL DEFAULT 0 CHECK (requests >= 0),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (client_id, alias_key, period_key)
);

CREATE INDEX idx_client_alias_usage_period ON client_alias_usage (period_key);

-- Observabilidad: qué pidió el cliente vs qué se le sirvió.
-- Sin esta columna no se puede reconciliar ni medir degradaciones (ver §6).
ALTER TABLE request_logs ADD COLUMN served_alias TEXT;
CREATE INDEX idx_request_logs_served_alias ON request_logs (served_alias);
```

### Invariantes

1. **Sin fila en `client_alias_quotas` = ilimitado.** No se lee uso, no se escribe
   uso. Cero costo por request. Aplica a `slave`.
2. `service` cuenta contra el alias **servido**, no el pedido. Si se degradó a
   `slave`, no se suma a `codex` (ver §5).
3. `period_key` = `YYYY-MM` UTC derivado de `requestedAt`. Sin cron de reset.
4. Cambiar `monthly_token_limit` aplica en la request siguiente, en ambas
   direcciones (subir y bajar).

## 4. Semántica del gate

```ts
resolveTarget(clientId, requestedAlias):
    if requestedAlias no es alias            → requestedAlias        // paths y modelos: sin cuota
    row = quota(clientId, requestedAlias)
    if !row                                  → requestedAlias        // ILIMITADO, cero I/O de uso
    used = usage(clientId, requestedAlias, periodKey(now))
    if used < row.monthly_token_limit        → requestedAlias
    if row.divert_alias_key                  → row.divert_alias_key  // degradación silenciosa
    else                                     → QuotaExhaustedError → 429
```

Detalles que importan:

- **`used === limit` cuenta como agotado.** Un cliente exactamente en 20M ya no
  entra a `codex`.
- **No hay cache.** Dos lookups por PK de SQLite (microsegundos). Ver §5.
- **Un `divert_alias_key` inexistente o roto** se valida al escribir la fila
  (admin API) y, si igual falla en runtime, se loguea y se degrada a
  `QuotaExhaustedError`. Nunca se sirve el alias agotado.
- **Anidamiento:** no hay recursión. `slave` no tiene fila de cuota → su walk es
  el de siempre (`qwen` → `gemma`).

## 5. Contabilidad y el requisito de subir la cuota

El caso que manda el diseño: *"si vemos que se acerca cierre de mes, subirle de
20M a 30M y que lo dejen pasar sin fallback"*.

Si los tokens servidos por `slave` se siguieran contando contra `codex`, un
cliente con 25M acumulados seguiría degradado aunque subas el límite a 30M. Por
eso:

**Se cuenta contra el alias servido. El tráfico degradado no consume la cuota del
alias agotado.** El contador de `codex` se congela cuando entra en degradación;
subir el límite restaura el acceso en la request siguiente.

```
uso codex = 25M, límite = 20M  → target = slave   (codex: 25M, congelado)
subís el límite a 30M
uso codex = 25M, límite = 30M  → target = codex   (vuelve, sin tocar nada más)
```

SQL de la contabilidad, una sentencia atómica por request:

```sql
INSERT INTO client_alias_usage (client_id, alias_key, period_key, tokens, requests)
VALUES (?, ?, ?, ?, 1)
ON CONFLICT (client_id, alias_key, period_key)
DO UPDATE SET tokens     = tokens + excluded.tokens,
              requests   = requests + 1,
              updated_at = unixepoch();
```

Puntos de enganche en `src/chat/chat.service.ts`:
- buffered: junto a `recordSuccess` (~línea 74), con `extractTokens`;
- streaming: junto a `recordSuccess` async (~línea 89), con `extractStreamTokens`;
- **stream abortado por el cliente**: `finally` sobre el iterable; si no llegó
  `usage`, `estimateTokens`. Nunca perder el gasto.

### Por qué NO hay cache

Subir el límite tiene que verse **en la request siguiente**. Un cache con TTL
introduce una ventana donde el cliente ya tiene 30M asignados y sigue degradado
— exactamente el bug que el requisito pide evitar. Dos `SELECT` por PK en SQLite
sincrónico son microsegundos; el cache no compra nada y sí introduce un modo de
falla. **Sin cache, sin invalidación, sin staleness.**

### Overshoot aceptado (R2)

El gate es pre-flight y la contabilidad post-hoc: un cliente con 19.9M que pide
una request de 3M la recibe y queda en 22.9M. La siguiente ya se degrada. Es el
comportamiento estándar de cuota post-paga y evita reservar tokens que el modelo
puede no usar.

## 6. Observabilidad (mitigación de D1 silencioso)

- `request_logs.served_alias` guarda el alias ruteado. `model_requested` conserva
  lo que pidió el cliente. `WHERE served_alias <> model_requested` = degradaciones.
- Evento estructurado `chat.request` gana `servedAlias` y `quotaDivertedFrom`.
- `GET /admin/logs?diverted=true` para auditarlas.
- El dashboard ya existente puede mostrar "tokens por alias servido" sin cambios
  de esquema.

## 7. Tareas (6 work units)

Cada tarea cierra con un commit en la rama. Tests y docs en el mismo commit.

### T1 — Schema
- **Superficies:** `migrations/0014_client_alias_quotas.sql`,
  `src/database/migrations/quota-schema.spec.ts`
- **Hacer:** las 2 tablas + `request_logs.served_alias` + índices.
- **Test:** migraciones sobre SQLite `:memory:` (patrón `migration-runner.spec.ts`);
  CHECKs (`monthly_token_limit > 0`, `divert_alias_key <> alias_key`,
  `tokens >= 0`), PK compuestas, ALTER de `served_alias` idempotente.
- **Commit:** `feat(quota): add per-client alias quota schema`

### T2 — QuotaRepository
- **Superficies:** `src/database/repositories/quota.repository.ts` (+spec),
  `src/database/database.module.ts`
- **Hacer:** `upsertQuota`, `deleteQuota`, `listQuotasByClient`, `getQuota`,
  `getUsage`, `addUsage` (UPSERT atómico), `listUsageByPeriod`.
- **Test:** `:memory:`; UPSERT idempotente; cambio de límite reflejado en lectura.
- **Commit:** `feat(quota): add client alias quota repository`

### T3 — QuotaService
- **Superficies:** `src/quota/quota.service.ts`, `src/quota/quota.module.ts`,
  `src/quota/quota.service.spec.ts`, `src/app.module.ts`
- **Hacer:** `periodKey(nowMs)` (UTC), `resolveTarget(clientId, alias)`,
  `recordUsage(clientId, alias, tokens)`, `retryAfterSeconds(nowMs)`.
  **Sin cache deliberadamente (§5).** Fast path: sin fila de cuota ⇒ retorna el
  alias sin leer `client_alias_usage`, y `recordUsage` retorna sin escribir.
- **Test:** bajo el límite; exactamente en el límite (agotado); sobre el límite;
  subir el límite restaura el acceso; bajarlo lo vuelve a degradar; alias sin fila
  ⇒ cero queries de uso; rollover de mes; `divert_alias_key` nulo ⇒ error 429.
- **Commit:** `feat(quota): resolve serving alias from monthly token quotas`

### T4 — Wiring en ChatService
- **Superficies:** `src/chat/chat.service.ts`, `src/chat/chat.service.spec.ts`,
  `src/chat/chat.module.ts`, `src/observability/request-log.service.ts`
- **Hacer:** `target = quota.resolveTarget(...)` antes de `route(target, ...)`;
  `recordUsage(clientId, target, tokens)` en los tres caminos (buffered, streaming,
  abort); persistir `served_alias` (`target`) manteniendo `model_requested`
  (`body.model`); `servedAlias`/`quotaDivertedFrom` en el log estructurado.
- **Test:** buffered dentro de cuota → `codex`, `served_alias` null; sobre cuota →
  rutea `slave`, `served_alias='slave'`, `model_requested='codex'`, y **no**
  incrementa `codex`; streaming sin `usage` (estimador); stream abortado; alias
  sin cuota ⇒ no escribe `client_alias_usage`.
- **Commit:** `feat(chat): divert to fallback alias when quota is exceeded`

### T5 — Admin API y saldo propio
- **Superficies:** `src/admin/admin-quota.controller.ts` (+spec),
  `src/admin/admin.module.ts`, `src/quota/quota.controller.ts` (+spec)
- **Hacer:**
  `GET /admin/clients/:id/quotas` (lista con uso del mes en curso),
  `PUT /admin/clients/:id/quotas` (`[{alias_key, monthly_token_limit, divert_alias_key}]`),
  `DELETE /admin/clients/:id/quotas/:aliasKey`,
  `GET /v1/quota` (scope `chat.read`, saldo propio del cliente).
  Validación zod: alias existente en el registry, `divert_alias_key` existente y
  distinto del alias, límite > 0.
- **Test:** specs de controller; subir el límite vía API se refleja en
  `resolveTarget` (integración con SQLite `:memory:`); 404 en alias inexistente.
- **Commit:** `feat(admin): manage per-client alias quotas`

### T7 — Observabilidad de la degradación
- **Superficies:** `request-log.repository.ts`, `request-log.service.ts`,
  `llm-logging.service.ts`, `chat.service.ts` (+ specs),
  `admin-quota.controller.ts` (+spec), `admin-stats.controller.spec.ts`,
  `admin-logs.controller.spec.ts`
- **Hacer:** persistir `served_alias` en las filas de éxito, fallo e intento;
  `servedAlias` + `quotaDivertedFrom` en el evento `chat.request` (el segundo sólo
  cuando hubo desvío, para no alterar la forma del evento normal); hilar el target
  resuelto por `recordSuccess` y `recordFailure`.
- **Por qué T7 antes de T6:** la reconciliación lee `request_logs`. Sin
  `served_alias` poblado, todo el tráfico desviado se imputaría a `codex` y el
  recálculo consolidaría el error en vez de repararlo.
- **Hallazgos cerrados:** R3-001 (si `recordSuccess` lanzaba dentro del handler del
  stream, el tail sólo logueaba: no había fila ni incremento, y ese gasto quedaba
  irrecuperable — ahora el tail acredita una estimación de prompt con un flag
  explícito que impide el doble conteo) y R3-002 (la validación de alias por
  truthiness dejaba pasar `constructor`, `toString`, `__proto__`).
- **Deuda saldada de paso:** los dos specs de admin armaban el schema de
  `request_logs` a mano; una columna nueva rompía 39 tests ajenos. Ahora usan la
  cadena real de migraciones.
- **Test:** desviado → `served_alias='slave'` con `model_requested='codex'` y
  `quotaDivertedFrom` en el evento; no desviado → `served_alias='codex'` y la clave
  `quotaDivertedFrom` **ausente** (no nula); desviado que falla al rutear → también
  registra el alias servido; `recordSuccess` que lanza → acredita exactamente una
  vez por el tail.
- **Commit:** `023eeac` — `feat(quota): make silent degradation observable end to end`
  (12 archivos, +648/−28; 656/656 tests, `tsc` exit 0; review `review-9b100c91fec0e368`
  aprobado, 0 bloqueantes, 6 hallazgos informativos)

### T6 — Reconciliación y documentación
- **Superficies:** `src/quota/quota-reconcile.service.ts` (+spec),
  `docs/API.md`, `docs/ARCHITECTURE.md`, `README.md`
- **Hacer:** recálculo de `client_alias_usage` desde `request_logs`
  (`COALESCE(served_alias, model_requested)`, `client_key`, `requested_at` en
  período), modo `--dry-run`, log de drift. Documentar schema, semántica,
  endpoints, y actualizar la tabla de migraciones en `docs/ARCHITECTURE.md` §8.
- **Test:** drift cero con datos consistentes; drift detectado y corregido;
  las requests degradadas no contaminan el contador de `codex`.
- **Implementado:** `QuotaReconcileService.reconcile({periodKey, dryRun})` +
  `POST /admin/quotas/reconcile` (`dryRun` default `true`). Tres sentencias nuevas
  en `QuotaRepository`: `setUsage` (upsert por valor absoluto, idempotente),
  `listAllQuotas`, `aggregateRequestLogUsage`.
- **Regla de correctitud (parece omisión a propósito):** se itera sobre los pares
  con fila en `client_alias_quotas`, no sobre los agregados. `recordUsage` retorna
  temprano cuando el alias servido no tiene cuota, así que atribuir todo alias
  visible en `request_logs` fabricaría contadores que el camino vivo nunca crea y
  reportaría drift fantasma en cada pasada. Misma razón por la que se valida
  `periodKey` también en el servicio: `2026-13` barrería una ventana vacía y
  "repararía" al cliente a cero.
- **Commit:** `c38ff5b` — `feat(quota): reconcile alias usage from request logs`
  (9 archivos + 2 nuevos, +1173/−14; 711/711 tests, `tsc` exit 0)

### T8 — Superficie de operador en el dashboard
- **Estado:** pendiente (descubierto al cerrar T6)
- **Superficies:** `dashboard/src/api/client.ts`, `dashboard/src/router.ts`,
  `dashboard/src/App.vue`, `dashboard/src/views/QuotasView.vue` (nueva),
  `dashboard/src/components/LogsTable.vue`, `dashboard/src/views/ClientsView.vue`,
  `src/admin/admin-logs.controller.ts` (+spec)
- **Problema:** la feature está completa en backend pero **no es operable desde la
  UI**. `dashboard/` (SPA Vue 3, 7 vistas, 2791 líneas) no menciona "quota" ni una
  vez, y peor: `toView()` en `admin-logs.controller.ts` no mapea `served_alias`, así
  que la degradación que T7 hizo auditable **no se puede ver en la vista de Logs**.
  La decisión D1 (diversión silenciosa) se justificó diciendo que el operador puede
  auditarla; hoy eso exige abrir sqlite a mano.
- **Hacer:**
  1. `servedAlias` en `LogItemView` y columna "Served" en `LogsTable.vue`, con
     marca visual cuando `servedAlias !== modelRequested`.  ← **mínimo indispensable**
  2. `QuotasView` + item de nav: alta/baja de cuota por cliente × alias, límite
     mensual, alias de desvío, y uso del mes en curso contra el límite.
  3. Panel de cuotas dentro de `ClientsView` (donde el operador ya está parado).
  4. Botón de reconcile con dry-run y vista previa del drift antes de escribir.
- **Test:** el front no tiene runner configurado; verificación manual vía
  `pnpm dashboard:dev` contra el gateway, más specs del `admin-logs.controller`
  para el nuevo campo.
- **Nota:** `dist-dashboard` no existe en el repo; la SPA sólo se sirve tras
  `pnpm dashboard:build`. El `build` ya encadena `nest build && pnpm dashboard:build`.

## 8. Riesgos

| ID | Riesgo | Mitigación |
|----|--------|-----------|
| R1 | Degradación silenciosa indistinguible de un bug | `served_alias` + `quotaDivertedFrom` en logs; `?diverted=true` en `/admin/logs` |
| R2 | Overshoot de una request por contabilidad post-hoc | Aceptado (§5) |
| R3 | Stream abortado pierde el gasto | `finally` + `estimateTokens` (T4) |
| R4 | Cliente que pide `slave` directo evita la cuota | **Intencional** (D3 descartada) |
| R5 | `divert_alias_key` apuntando a un alias que también tiene cuota | Validado en admin API; en runtime se aplica el gate otra vez sólo si esa fila existe |

## 9. Orden

```
T1 → T2 → T3 → T4 → T5 → T7 → T6 → T8
```

T7 se adelantó a T6: la reconciliación depende de que `served_alias` esté poblado.
T8 salió de una pregunta del operador al cerrar T6: el backend quedó completo pero
sin superficie de UI, y `served_alias` ni siquiera llega a la vista de Logs.
Sin dependencias cruzadas con routing, circuit breaker ni el walk de fallback.

## 10. Fuera de alcance (cerrado)

- `pnpm-lock.yaml` multi-documento: artefacto del `pnpm i` local del operador; el
  flujo CI/CD no está operativo. No se toca.
