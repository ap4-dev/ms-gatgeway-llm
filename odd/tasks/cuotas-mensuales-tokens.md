# Feature: Cuotas mensuales de tokens por cliente con degradación silenciosa

> Estado: **planificado** (ninguna línea de código escrita todavía).
> Rama: `feature/cuotas-mensuales-tokens`.

## 0. Problema de negocio

El gateway corre sobre **proveedores con capacidad mensual finita de modelos
frontera**. Hoy un cliente puede consumir toda la cuota del proveedor y dejar sin
acceso a los demás. Al mismo tiempo existen **modelos ilimitados** que nunca deben
contarse ni frenarse.

Objetivo: asignar a cada cliente una **capacidad mensual** sobre los aliases
frontera, y cuando la agote, **degradarlo silenciosamente** a un alias de respaldo
sin romper la sesión agéntica del cliente.

## 1. Decisiones cerradas

| ID | Decisión | Valor | Consecuencia |
|----|----------|-------|--------------|
| D1 | Aviso de desvío | **C — silencioso** (solo log interno) | Sin headers ni mutación del body. |
| D2 | Sin desvío disponible | **A — `429 quota_exhausted` + `Retry-After`** | Último recurso: sólo cuando no hay ningún alias de respaldo sano. |
| D3 | Anti-bypass | **A — allowlist de aliases por cliente** | Tabla `client_alias_access`. Sin filas = sin restricción. |
| D4 | Corte de período | **A — mes calendario UTC** (`'YYYY-MM'`) | `period_key` calculado, sin cron de reset. |
| D5 | Agrupación del presupuesto | **Ver §3 — resuelto por `quota_scopes`** | Soporta presupuesto por alias y presupuesto único compartido sin código distinto. |

### 1.1 Reglas de negocio confirmadas

1. **Alias ilimitado ⇒ cero I/O de cuota.** Un alias sin `quota_scopes` no se lee,
   no se escribe, no se evalúa. No es "límite infinito": es **ausencia de
   participación**. Cero costo por request.
2. Los aliases ilimitados **pueden tener fallback** y siguen usando el walk normal
   del router (circuit breaker incluido).
3. La degradación es **silenciosa** para cualquier modelo que tenga cuota.
4. La cuota se asigna al **cliente** sobre **aliases frontera**, y el cliente está
   preparado para llegar a fin de mes con ella (formato agéntico, sin reintentos
   infinitos).

### Tradeoff aceptado (R1)

Silencioso (D1) + 429 duro (D2) es asimétrico: el cliente no percibe la degradación
hasta que se queda sin respaldo. Mitigación: `quotaDiverted: true` + `servedModel`
en el evento estructurado `chat.request` (`LlmLoggingService`), y una tabla de
"degrada­ciones por cliente" en `/admin/logs`.

## 2. Alcance

**Dentro:** cuotas mensuales de tokens por `(cliente × budget)`; budgets agrupando
uno o varios aliases/modelos; degradación en dos niveles (pre-walk + por posición);
desvío a alias alternativo sin recursión; contabilidad exacta buffered/streaming/abort;
allowlist de aliases por cliente; admin API y consulta de saldo.

**Fuera:** unidades normalizadas de costo (`unit` queda reservada); reserva
pre-flight anti-overshoot; cuotas distribuidas en Redis; push/PR/merge.

## 3. Modelo de datos

La pieza que resuelve D5: se separa **el presupuesto** (`quota_budgets`) de **qué
lo consume** (`quota_scopes`).

- Budget con **un** scope → cuota por alias.
- Budget con **N** scopes → presupuesto único compartido entre todos los aliases
  frontera del cliente ("tenés 500k tokens/mes de modelos frontera").

Mismo código, distinta configuración. No hay que elegir ahora.

```sql
-- migrations/0014_quota_budgets.sql

CREATE TABLE quota_budgets (
  id               TEXT PRIMARY KEY,              -- 'frontera-mensual'
  token_limit      INTEGER NOT NULL CHECK (token_limit > 0),  -- capacidad default
  period           TEXT NOT NULL DEFAULT 'monthly' CHECK (period IN ('monthly')),
  unit             TEXT NOT NULL DEFAULT 'tokens'  CHECK (unit IN ('tokens')),
  divert_alias_key TEXT,                          -- alias de respaldo (NULL = 429)
  enabled          INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at       INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Qué aliases/modelos consumen este presupuesto. AUSENCIA = ILIMITADO.
CREATE TABLE quota_scopes (
  budget_id  TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('alias','model')),
  scope_key  TEXT NOT NULL,                       -- 'coder' | 'nan/qwen3-premium'
  PRIMARY KEY (budget_id, scope_kind, scope_key),
  FOREIGN KEY (budget_id) REFERENCES quota_budgets(id) ON DELETE CASCADE
);

-- Quién tiene presupuesto. Sin fila = ILIMITADO.
CREATE TABLE quota_bindings (
  client_id   TEXT NOT NULL,
  budget_id   TEXT NOT NULL,
  token_limit INTEGER CHECK (token_limit IS NULL OR token_limit > 0), -- override
  PRIMARY KEY (client_id, budget_id),
  FOREIGN KEY (budget_id) REFERENCES quota_budgets(id) ON DELETE CASCADE
);

-- Contadores. Una fila por (cliente, budget, mes UTC).
CREATE TABLE quota_usage (
  client_id  TEXT    NOT NULL,
  budget_id  TEXT    NOT NULL,
  period_key TEXT    NOT NULL,                    -- '2026-02'
  tokens     INTEGER NOT NULL DEFAULT 0 CHECK (tokens >= 0),
  requests   INTEGER NOT NULL DEFAULT 0 CHECK (requests >= 0),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (client_id, budget_id, period_key),
  FOREIGN KEY (budget_id) REFERENCES quota_budgets(id) ON DELETE CASCADE
);

CREATE INDEX idx_quota_usage_client_period ON quota_usage (client_id, period_key);
CREATE INDEX idx_quota_scopes_key ON quota_scopes (scope_kind, scope_key);
```

```sql
-- migrations/0015_client_alias_access.sql  (T8)

CREATE TABLE client_alias_access (
  client_id TEXT NOT NULL,
  alias_key TEXT NOT NULL,
  PRIMARY KEY (client_id, alias_key)
);
CREATE INDEX idx_client_alias_access_client ON client_alias_access (client_id);
```

### Invariantes

1. **Ilimitado = no está en `quota_scopes` y no tiene binding.** Jamás `token_limit = 0`.
2. Cliente sin filas en `quota_bindings` → ningún budget se le aplica.
3. Cliente sin filas en `client_alias_access` → sin restricción de aliases (retrocompat).
4. `quota_usage` sin FK a `clients` (mismo criterio que `request_logs.client_key`,
   `migrations/0004_clients.sql`): el histórico sobrevive al borrado del cliente.
5. `period_key` = `YYYY-MM` **UTC** derivado de `requestedAt`.
6. Límite efectivo = `COALESCE(binding.token_limit, budget.token_limit)`.

## 4. Semántica de enforcement

### 4.1 Nivel A — gate pre-walk (alias)

Antes de `resolveChain(model)`:

```
budgets = quota.budgetsFor(clientId, 'alias', model)   // [] si el alias es ilimitado
if budgets has any exhausted budget:
    if budget.divert_alias_key → route(divert, ctx{diverted:true})   // 1 nivel
    else                       → QuotaExhaustedError → 429
```

Costo para un alias ilimitado: **una lectura de `quota_scopes`** (cacheada), cero
escrituras. Nada más.

### 4.2 Nivel B — gate por posición (modelo)

Dentro del walk (`src/routing/routing.service.ts:90-130`), antes de
`breaker.canRequest`:

```
if (quota.isExhaustedFor(clientId, 'model', `${providerId}/${upstreamModel}`)) {
    attempts.push({ providerId, upstreamModel, ok: false, quotaExhausted: true });
    continue;   // ← el fallback a la siguiente posición es gratis
}
```

Esto habilita limitar un modelo caro puntual dentro de un alias sin limitar el alias.

### 4.3 Anidamiento del desvío

- El desvío se aplica **una sola vez** (`ctx.diverted = true`). Sin recursión.
- En la cadena de desvío, el nivel B sigue activo: si el respaldo también tiene
  cuota agotada → 429.
- Un desvío **no** requiere que el alias esté en la allowlist del cliente (D3):
  es decisión del gateway, no del cliente.

### 4.4 Regla de error

| Situación | Resultado |
|-----------|-----------|
| Todas las posiciones salteadas por cuota, sin fallas técnicas | `QuotaExhaustedError` → **429** |
| Al menos una posición falló técnicamente | `RoutingFailedError` (comportamiento actual) |
| Desvío aplicado y servido | 200 silencioso (D1) |

## 5. Contabilidad

Se ejecuta **sólo si el request tocó al menos un budget**. Se incrementa cada
budget aplicable (alias pedido + modelo servido), con una sentencia atómica por budget:

```sql
INSERT INTO quota_usage (client_id, budget_id, period_key, tokens, requests)
VALUES (?, ?, ?, ?, 1)
ON CONFLICT (client_id, budget_id, period_key)
DO UPDATE SET tokens     = tokens + excluded.tokens,
              requests   = requests + 1,
              updated_at = unixepoch();
```

Puntos de enganche en `src/chat/chat.service.ts`:
- buffered: junto a `recordSuccess` (~línea 74) con `extractTokens`;
- streaming: junto a `recordSuccess` async (~línea 89) con `extractStreamTokens`;
- **abort**: `finally` sobre el iterable → si no hubo `usage`, `estimateTokens`.
  Nunca perder el gasto.

## 6. Tareas

Cada tarea cierra con un commit work-unit en la rama. Tests y docs en el mismo commit.

### T1 — Schema de cuotas
- **Superficies:** `migrations/0014_quota_budgets.sql`, `src/database/migrations/quota-schema.spec.ts`
- **Hacer:** las 4 tablas + índices.
- **Test:** migraciones sobre SQLite `:memory:` (patrón `migration-runner.spec.ts`);
  CHECKs (`token_limit > 0`, `scope_kind`, `tokens >= 0`), PK compuesta de
  `quota_usage`, `ON DELETE CASCADE`.
- **Commit:** `feat(quota): add monthly token quota schema`

### T2 — QuotaRepository
- **Superficies:** `src/database/repositories/quota.repository.ts` (+spec),
  `src/database/database.module.ts`
- **Hacer:** CRUD budgets/scopes/bindings; `budgetsForScope(kind, key)`,
  `bindingsForClient(clientId)`, `getUsage`, `addUsage` (UPSERT atómico),
  `effectiveLimit(binding, budget)`.
- **Test:** `:memory:`; override de binding; UPSERT idempotente; cascade delete.
- **Commit:** `feat(quota): add quota repository`

### T3 — QuotaService
- **Superficies:** `src/quota/quota.service.ts`, `src/quota/quota.module.ts`,
  `src/quota/quota.service.spec.ts`, `src/app.module.ts`
- **Hacer:** `periodKey(nowMs)` (UTC), `budgetsFor(clientId, kind, key)`,
  `isExhausted(...)`, `consume(clientId, budgetIds[], tokens)`,
  `divertFor(clientId, budgetId)`, `retryAfterSeconds(nowMs)`.
  Cache en memoria TTL ≤5 s con invalidación en `consume`. **Fast path:** si
  `budgetsFor` devuelve `[]`, `consume` no toca la DB.
- **Test:** rollover de mes; `tokens == limit` cuenta como agotado; cliente sin
  binding = nunca agotado; alias ilimitado = cero llamadas a `addUsage`; TTL.
- **Commit:** `feat(quota): add quota service with utc period keys`

### T4 — Skip por cuota en el walk (nivel B)
- **Superficies:** `src/routing/routing.service.ts`, `src/routing/routing.service.spec.ts`
- **Hacer:** `RouteContext { clientId?: string|null; diverted?: boolean }` como 4º
  parámetro opcional de `route()`; `quotaExhausted?: boolean` en `RouteAttemptFailed`;
  gate antes de `breaker.canRequest`; regla de error §4.4.
- **Test:** posición 0 agotada → intenta 1; todas agotadas → `QuotaExhaustedError`;
  falla técnica + cuota → `RoutingFailedError`; sin clientId → sin chequeo.
- **Commit:** `feat(routing): skip quota-exhausted chain entries`

### T5 — Contabilidad en ChatService
- **Superficies:** `src/chat/chat.service.ts`, `src/chat/chat.service.spec.ts`,
  `src/chat/chat.module.ts`
- **Hacer:** pasar `clientId` al router; contabilizar según §5; emitir
  `quotaDiverted`/`servedModel` en el log estructurado (mitigación R1).
- **Test:** buffered con `usage`; streaming con `usage`; streaming sin `usage`;
  stream abortado; alias ilimitado no escribe en `quota_usage`; doble budget
  (alias + modelo) incrementa ambos.
- **Commit:** `feat(chat): account token usage against quotas`

### T6 — Desvío a alias de respaldo (nivel A)
- **Superficies:** `src/routing/routing.service.ts`,
  `src/routing/routing.service.spec.ts`,
  `src/database/repositories/provider-registry.repository.ts`
- **Hacer:** gate pre-walk; si agotado y hay `divert_alias_key`, resolver la chain
  del respaldo y recorrerla con `ctx.diverted = true`.
- **Test:** agotado con respaldo → sirve el respaldo; sin respaldo → 429; respaldo
  agotado → 429; un solo nivel de desvío.
- **Commit:** `feat(routing): divert to fallback alias when quota is exhausted`

### T7 — 429 `quota_exhausted`
- **Superficies:** `src/routing/routing.service.ts` (export del error),
  `src/chat/chat.controller.ts`, `src/chat/chat.service.ts`,
  `src/anthropic/anthropic.service.ts`
- **Hacer:** `429` + `Retry-After` (segundos hasta el 1° del mes UTC) + body
  `{ code: 'quota_exhausted', budget, resets_at }`. Replicar en `/v1/messages`.
- **Test:** controller spec → 429, header y shape; sin `Retry-After` negativo.
- **Commit:** `feat(chat): return 429 when monthly quota is exhausted`

### T8 — Allowlist de aliases (D3)
- **Superficies:** `migrations/0015_client_alias_access.sql`,
  `src/database/repositories/client-alias-access.repository.ts` (+spec),
  `src/auth/client-alias-access.service.ts` (+spec),
  `src/routing/routing.service.ts`, `src/chat/models.controller.ts` (+spec)
- **Hacer:** cache por `clientId` con invalidación en mutación; sin filas = permitido;
  con filas = sólo las listadas y `provider/model` directo rechazado; desvío exento.
- **Test:** sin filas (retrocompat); permitido/denegado; `provider/model` denegado;
  desvío exento; `/v1/models` filtrado.
- **Commit:** `feat(auth): scope client access to allowlisted aliases`

### T9 — Superficie admin y saldo propio
- **Superficies:** `src/admin/admin-quota.controller.ts` (+spec),
  `src/admin/admin-clients.controller.ts`, `src/admin/admin.module.ts`,
  `src/quota/quota.controller.ts` (+spec)
- **Hacer:** `GET/POST/PATCH/DELETE /admin/quota/budgets[/:id]`,
  `PUT /admin/quota/budgets/:id/scopes`, `GET /admin/clients/:id/quota`,
  `PUT /admin/clients/:id/quota` (bindings),
  `PUT /admin/clients/:id/aliases` (allowlist), `GET /v1/quota` (scope `chat.read`).
- **Test:** specs de controller; shape y status; validación zod.
- **Commit:** `feat(admin): expose quota and alias access management`

### T10 — Reconciliación y documentación
- **Superficies:** `src/quota/quota-reconcile.service.ts` (+spec),
  `src/quota/quota.module.ts`, `docs/API.md`, `docs/ARCHITECTURE.md`, `README.md`
- **Hacer:** recálculo desde `request_logs` (`client_key`, `model_requested`,
  `requested_at` en período) por budget de scope alias; `--dry-run`; log de drift.
  Documentar schema, semántica, endpoints, R1 y actualizar la tabla de migraciones
  en `docs/ARCHITECTURE.md` §8.
- **Test:** drift cero; drift detectado y corregido.
- **Commit:** `feat(quota): reconcile usage from request logs`

### T11 — Guardia de sobresuscripción del pool (opcional)
- **Superficies:** `migrations/0016_provider_capacity.sql`,
  `src/admin/admin-quota.controller.ts`, `src/providers/provider.registry.ts`
- **Hacer:** `providers.monthly_token_capacity INTEGER`; al crear/actualizar un
  binding, sumar los límites de todos los clientes que consumen budgets apuntando
  a ese provider y **advertir** (no bloquear) si se supera la capacidad.
  Endpoint `GET /admin/quota/capacity` con el balance.
- **Por qué:** es la contracara del problema de negocio ("me deja a otros clientes
  sin acceso"). Sin esto, `50 clientes × 500k` sobre un pool de `5M` sigue
  agotando el proveedor aunque cada cliente respete su cuota.
- **Commit:** `feat(quota): warn on provider capacity oversubscription`

**Total: 11 work units** (T1–T10 core, T11 opcional).

## 7. Riesgos y deuda

| ID | Riesgo | Mitigación |
|----|--------|-----------|
| R1 | Degradación silenciosa + 429 es indistinguible de un bug | `quotaDiverted`/`servedModel` en logs; documentar en `docs/API.md` |
| R2 | Overshoot por concurrencia | Aceptado en fase 1; reserva pre-flight en fase 2 |
| R3 | Stream abortado pierde el gasto | `finally` + estimador (T5) |
| R4 | Cache de cuota con staleness ≤5 s | Aceptado; invalidación en `consume` |
| R5 | Reconciliación autoritativa sólo para scope alias (`model_requested` guarda el alias) | Scope model queda best-effort documentado |
| R6 | Tokens ≠ costo por modelo | Columna `unit` reservada |
| R7 | Sobresuscripción del pool: cuotas individuales correctas, proveedor igual agotado | T11 |

## 8. Orden y dependencias

```
T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9 → T10 → (T11)
                        └──── T8 reusa el punto de intercepción de T4
T9 depende de T2/T3 (+T8 para allowlist). T11 depende de T2/T9.
```
