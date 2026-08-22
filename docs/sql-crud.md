# SQL CRUD — Tablas del Gateway

Referencia rápida de sentencias SQL para ejecutar desde `/admin/db`.



SELECT * FROM "request_logs" ORDER BY id DESC LIMIT 200;

---

## alias_entries

Posiciones de modelos dentro de cada alias (fallback chain).

```sql
-- Listar todas las entradas de un alias
SELECT * FROM alias_entries WHERE alias_name = 'coder' ORDER BY position;

-- Listar todos los aliases con sus entradas
SELECT a.alias_name, a.position, a.provider_id, a.model_key, a.priority
FROM alias_entries a
ORDER BY a.alias_name, a.position;

-- Insertar una nueva entrada al final de un alias
INSERT INTO alias_entries (alias_name, position, provider_id, model_key, priority)
VALUES ('nuevo-alias', 0, 'nan', 'qwen', 0);

-- Agregar un modelo como fallback (posición siguiente)
INSERT INTO alias_entries (alias_name, position, provider_id, model_key, priority)
VALUES ('coder', (SELECT COALESCE(MAX(position), -1) + 1 FROM alias_entries WHERE alias_name = 'coder'), 'nan', 'deepseek1', 0);

-- Actualizar el modelo de una posición específica
UPDATE alias_entries
SET provider_id = 'nan', model_key = 'deepseek2'
WHERE alias_name = 'coder' AND position = 1;

-- Cambiar la prioridad de una entrada
UPDATE alias_entries
SET priority = 1
WHERE alias_name = 'coder' AND position = 2;

-- Eliminar una entrada específica
DELETE FROM alias_entries WHERE alias_name = 'coder' AND position = 3;

-- Eliminar todas las entradas de un alias
DELETE FROM alias_entries WHERE alias_name = 'nuevo-alias';

-- Reordenar posiciones después de un DELETE (compactar)
UPDATE alias_entries
SET position = (
    SELECT COUNT(*) - 1
    FROM alias_entries e2
    WHERE e2.alias_name = alias_entries.alias_name
      AND e2.rowid <= alias_entries.rowid
)
WHERE alias_name = 'coder';
```

---

## alias_policy

Estrategia de routing por alias (primary, round-robin, fallback, weighted, priority-grouped).

```sql
-- Ver todas las políticas
SELECT * FROM alias_policy ORDER BY alias_key;

-- Ver la política de un alias específico
SELECT * FROM alias_policy WHERE alias_key = 'coder';

-- Crear política para un alias
INSERT INTO alias_policy (alias_key, strategy) VALUES ('nuevo-alias', 'primary');

-- Cambiar estrategia de un alias
UPDATE alias_policy SET strategy = 'weighted' WHERE alias_key = 'coder';
UPDATE alias_policy SET strategy = 'round-robin' WHERE alias_key = 'coder';
UPDATE alias_policy SET strategy = 'priority-grouped' WHERE alias_key = 'coder';

-- Eliminar política
DELETE FROM alias_policy WHERE alias_key = 'nuevo-alias';

-- Ver aliases sin política configurada
SELECT DISTINCT e.alias_name
FROM alias_entries e
LEFT JOIN alias_policy p ON e.alias_name = p.alias_key
WHERE p.alias_key IS NULL;
```

---

## alias_weights

Pesos por entrada para estrategia `weighted`.

```sql
-- Ver pesos de un alias
SELECT * FROM alias_weights WHERE alias_key = 'coder' ORDER BY position;

-- Ver todos los pesos
SELECT w.alias_key, w.position, w.weight, e.provider_id, e.model_key
FROM alias_weights w
JOIN alias_entries e ON w.alias_key = e.alias_name AND w.position = e.position
ORDER BY w.alias_key, w.position;

-- Insertar peso para una entrada
INSERT INTO alias_weights (alias_key, position, weight) VALUES ('coder', 0, 5);

-- Actualizar peso
UPDATE alias_weights SET weight = 3 WHERE alias_key = 'coder' AND position = 0;

-- Eliminar peso de una entrada
DELETE FROM alias_weights WHERE alias_key = 'coder' AND position = 1;

-- Eliminar todos los pesos de un alias
DELETE FROM alias_weights WHERE alias_key = 'coder';

-- Ver aliases que usan weighted pero no tienen pesos configurados
SELECT p.alias_key
FROM alias_policy p
WHERE p.strategy = 'weighted'
  AND NOT EXISTS (SELECT 1 FROM alias_weights w WHERE w.alias_key = p.alias_key);
```

---

## clients

Clientes (API keys) registrados en el gateway.

```sql
-- Listar todos los clientes
SELECT id, name, api_key_prefix, scopes, rate_limit_rpm, rate_limit_tpm,
       created_at, last_used_at, revoked_at
FROM clients ORDER BY created_at;

-- Buscar cliente por ID
SELECT * FROM clients WHERE id = 'mi-cliente';

-- Buscar cliente por prefijo de API key
SELECT * FROM clients WHERE api_key_prefix = 'sk-1c25bc';

-- Ver clientes activos (no revocados)
SELECT id, name, scopes, rate_limit_rpm
FROM clients
WHERE revoked_at IS NULL
ORDER BY name;

-- Ver clientes revocados
SELECT id, name, revoked_at FROM clients WHERE revoked_at IS NOT NULL;

-- Actualizar scopes de un cliente
UPDATE clients SET scopes = 'admin,chat.read,chat.write' WHERE id = 'mi-cliente';

-- Actualizar rate limit
UPDATE clients SET rate_limit_rpm = 120 WHERE id = 'mi-cliente';

-- Revocar un cliente (soft delete)
UPDATE clients SET revoked_at = unixepoch() WHERE id = 'mi-cliente';

-- Reactivar un cliente revocado
UPDATE clients SET revoked_at = NULL WHERE id = 'mi-cliente';

-- Eliminar un cliente permanentemente
DELETE FROM clients WHERE id = 'mi-cliente';

-- Contar clientes activos
SELECT COUNT(*) AS total_activos FROM clients WHERE revoked_at IS NULL;

-- Crear un nuevo cliente (requiere generar api_key_hash por separado)
-- El hash se genera con scrypt en Node.js, no se puede hacer desde SQL puro.
-- Usar el endpoint POST /admin/clients desde la API o el script seed.
```

> **Nota:** Para crear clients con API key hasheada, usa el endpoint
> `POST /admin/clients` de la API admin — el hash scrypt se genera
> en Node.js. Desde SQL solo puedes modificar los campos existentes.

---

## model_configs

Configuración de modelos por provider.

```sql
-- Listar todos los modelos de un provider
SELECT * FROM model_configs WHERE provider_id = 'nan' ORDER BY model_key;

-- Listar todos los modelos con su provider
SELECT m.provider_id, m.model_key, m.real_name, m.max_tokens, m.supports_stream, m.disable_thinking
FROM model_configs m
ORDER BY m.provider_id, m.model_key;

-- Ver un modelo específico
SELECT * FROM model_configs WHERE provider_id = 'nan' AND model_key = 'qwen';

-- Insertar un nuevo modelo
INSERT INTO model_configs (provider_id, model_key, real_name, max_tokens, supports_stream, disable_thinking)
VALUES ('nan', 'nuevo-modelo', 'qwen3.7-coder', 32000, 1, 0);

-- Actualizar el nombre real de un modelo
UPDATE model_configs SET real_name = 'qwen3.7' WHERE provider_id = 'nan' AND model_key = 'qwen';

-- Actualizar max_tokens
UPDATE model_configs SET max_tokens = 64000 WHERE provider_id = 'nan' AND model_key = 'qwen';

-- Desactivar streaming para un modelo
UPDATE model_configs SET supports_stream = 0 WHERE provider_id = 'nan' AND model_key = 'deepseek1';

-- Activar disable_thinking (para modelos como DeepSeek V4)
UPDATE model_configs SET disable_thinking = 1 WHERE provider_id = 'nan' AND model_key = 'deepseek1';

-- Eliminar un modelo
DELETE FROM model_configs WHERE provider_id = 'nan' AND model_key = 'nuevo-modelo';

-- Eliminar todos los modelos de un provider (cuidado: cascading deletes en alias_entries)
DELETE FROM model_configs WHERE provider_id = 'nan';

-- Ver modelos que no están referenciados en ningún alias
SELECT m.provider_id, m.model_key, m.real_name
FROM model_configs m
WHERE NOT EXISTS (
    SELECT 1 FROM alias_entries e
    WHERE e.provider_id = m.provider_id AND e.model_key = m.model_key
);
```

---

## utilidades

```sql
-- Ver el estado completo del registry (provider + modelos + aliases + policy)
SELECT
    p.id AS provider,
    m.model_key,
    m.real_name,
    e.alias_name,
    e.position,
    e.priority,
    ap.strategy,
    COALESCE(w.weight, 1) AS weight
FROM providers p
JOIN model_configs m ON m.provider_id = p.id
LEFT JOIN alias_entries e ON e.provider_id = m.provider_id AND e.model_key = m.model_key
LEFT JOIN alias_policy ap ON ap.alias_key = e.alias_name
LEFT JOIN alias_weights w ON w.alias_key = e.alias_name AND w.position = e.position
ORDER BY p.id, e.alias_name, e.position;

-- Ver la política de routing global
SELECT * FROM routing_policy;

-- Contar requests por status en las últimas 24h
SELECT status, COUNT(*) AS total
FROM request_logs
WHERE requested_at >= unixepoch() - 86400
GROUP BY status;
```

