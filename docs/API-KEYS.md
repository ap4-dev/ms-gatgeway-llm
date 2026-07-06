# Gestión de API Keys

## Formato

Las API keys usan el formato `sk-` seguido de 64 caracteres hex (32 bytes aleatorios):

```
sk-a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2
```

- **Prefix** (8 chars públicos): `sk-a1b2c3` — usado para lookup rápido en DB
- **Hash almacenado**: `hmac$<hex64>` — solo esto persiste en SQLite (HMAC-SHA256 con pepper server-side)
- **Key plana**: se muestra UNA SOLA VEZ al crear el cliente

> **Importante (Phase 6+)**: el gateway ahora usa `hmac$<hex>` con `HMAC-SHA256(pepper, plaintext)`.
> Filas viejas con formato `scrypt$...` **son rechazadas** (401). Todos los clientes
> deben rehashear su key via este CLI.

---

## Variable de entorno requerida

El gateway requiere una pepper server-side (mínimo 32 chars). Generar con:

```bash
openssl rand -hex 32
# output: a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2
```

- **Producción**: guardar en Doppler como `API_KEY_PEPPER`. El gateway la levanta al boot vía `main.ts`.
- **CLI local**: exportarla antes de invocar el script (ver ejemplos más abajo). El CLI también intenta cargar `.env` si existe.

> ⚠️ La pepper debe ser **idéntica** en el gateway y en el CLI. Si difieren, las filas recién hasheadas devolverán 401 aunque el SQL se aplique correctamente.

---

## Crear una nueva API Key

### Opción A: Generar key nueva + hash (recomendado)

```bash
export API_KEY_PEPPER=$(openssl rand -hex 32)
pnpm admin:reset -- --create --id tenant-acme --name "Acme Co." --rpm 300
```

Flags disponibles:
| Flag | Requerido | Descripción |
|------|-----------|-------------|
| `--id` | Sí | Identificador único del cliente |
| `--name` | No | Nombre legible (default: valor de `--id`) |
| `--rpm` | No | Rate limit en requests/minuto (default: 60) |
| `--scopes` | No | Scopes separados por coma (default: `chat.read,chat.write`) |

Salida:

```
────────────────────────────────────────────────────────────────
admin-reset · CREATE · client 'tenant-acme'
────────────────────────────────────────────────────────────────

PLAIN API KEY (save NOW — never shown again):
  sk-a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2

SQL to apply (paste into sqlite3 against the gateway DB):

  INSERT INTO clients (id, name, api_key_hash, api_key_prefix, scopes, rate_limit_rpm) VALUES ('tenant-acme', 'Acme Co.', 'hmac$ab12cd34...', 'sk-a1b2c3', 'chat.read,chat.write', 300);

────────────────────────────────────────────────────────────────
```

**IMPORTANTE**: Guarda la key plana inmediatamente. Nunca se volverá a mostrar.

### Opción B: Usar una API key existente (solo generar hash)

Si ya tienes una key (porque la generaste con otra herramienta, o porque un developer
ya tiene una key asignada para esta POC), usa `--plain` para hashearla y obtener el SQL
listo para pegar en la DB:

```bash
export API_KEY_PEPPER=<la misma pepper que el gateway>
pnpm admin:reset -- --reset admin --plain "sk-mi-key-existente"
```

> El flag `--plain` evita generar una key nueva. El script toma la key que le das, la
> hashea con HMAC + pepper y produce el SQL listo para aplicar. Ideal para migrar
> claves existentes.

---

## Aplicar el SQL en la DB

```bash
sqlite3 data/ms-gateway.db
```

Pega el SQL generado por el script y presiona Enter. Para verificar:

```sql
SELECT id, api_key_prefix, scopes FROM clients;
```

---

## Rotar una API Key existente

```bash
pnpm admin:reset -- --reset admin
```

Esto genera una **nueva** key (aleatoria) y produce un `UPDATE` SQL.

Si quieres rotar a una key específica:

```bash
pnpm admin:reset -- --reset admin --plain "sk-nueva-key"
```

> Las rotaciones y revocaciones tardan **hasta 5 minutos** en propagarse a través del
> cache de auth en Redis (TTL del cache). Un revoke inmediato + cache TTL puede dejar
> pasar tráfico durante ese intervalo.

---

## Probar que la key funciona

```bash
curl -H "Authorization: Bearer sk-tu-key" http://localhost:3000/v1/models
```

Debe responder con la lista de modelos disponibles. Si obtienes `401 Unauthorized`:

1. Verifica que `API_KEY_PEPPER` sea **idéntica** en gateway y al hashear.
2. Verifica que la fila en la DB empiece con `hmac$`.
3. Si la fila empieza con `scrypt$`, necesitas rehashear via `--plain`.

---

## Seguridad

- El script **NUNCA abre la DB** — solo imprime SQL que tú ejecutas manualmente.
- Las keys se almacenan como `HMAC-SHA256(pepper, plaintext)`. El pepper es server-side
  (no vive en la DB) y debe estar en Doppler o en env vars.
- El `api_key_prefix` (8 chars) se usa solo para lookup rápido; el hash completo se
  verifica con timing-safe comparison.
- Si pierdes la key plana de un cliente, debes rotarla (la key plana se muestra una sola
  vez al crearla).
- El cache de auth en Redis (TTL 5 min) reduce latencia ~50x en tráfico caliente.
  Si Redis cae, el gateway cae al path SQLite (fail-open, log warning).

---

## Comandos rápidos

```bash
# Generar una pepper (guardar de forma segura)
PEPPER=$(openssl rand -hex 32) && echo "$PEPPER"

# Crear cliente admin con todos los scopes
API_KEY_PEPPER=$PEPPER pnpm admin:reset -- --create --id admin \
  --scopes "admin,chat.read,chat.write,chat.completions" --rpm 1000

# Crear cliente de lectura
API_KEY_PEPPER=$PEPPER pnpm admin:reset -- --create --id tenant-lectura \
  --scopes "chat.read" --rpm 100

# Rotar key del admin (genera una nueva random)
API_KEY_PEPPER=$PEPPER pnpm admin:reset -- --reset admin

# Hash de una key existente para el admin (caso POC: developers que ya tienen key)
API_KEY_PEPPER=$PEPPER pnpm admin:reset -- --reset admin --plain "sk-mi-key-existente"
```

---

## Migración desde filas legacy `scrypt$…`

Como Phase 6 no es retrocompatible, los pasos para migrar son:

1. Generar `API_KEY_PEPPER`, setearla en Doppler (gateway) y exportarla en tu shell (CLI).
2. Para cada tenant con fila `scrypt$...`, pedirles su key plana (o emitir una nueva) y correr:
   ```bash
   API_KEY_PEPPER=$PEPPER pnpm admin:reset -- --reset <id> --plain "<key>"
   ```
3. Aplicar el SQL en la DB del proxy.
4. Verificar con `curl` que cada key siga funcionando.

Para la POC donde solo cambia el puerto del proxy, los usuarios siguen usando sus keys
existentes — solo el proxy ahora hashea bajo el nuevo formato.
