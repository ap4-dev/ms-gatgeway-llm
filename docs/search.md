# Search Module

Web search expuesto por el gateway como superficie provider-agnóstica. Los
clientes (Pi, Kilo, OpenCode, curl) usan **solo los endpoints del gateway** —
nunca NaN directamente. Si el proveedor de search cambia, solo cambian los
internals del gateway.

```
CLIENT (Pi, Kilo, OpenCode, curl)
  │
  ├── POST /v1/search  (REST)
  ├── POST /v1/mcp     (JSON-RPC — MCP protocol)
  └── GET  /v1/tools   (discovery)
  │
  ▼
GATEWAY
  └── SearchProvider interface  ← src/search/search-provider.interface.ts
       └── HttpSearchProvider  ← src/search/http-search.provider.ts (POST /v1/search)
  │
  ▼
PROVIDER (NaN hoy, otro mañana)
```

**Auth:** todos los endpoints requieren `Authorization: Bearer sk-…` (o
`X-API-Key`). `POST /v1/search` y `POST /v1/mcp` exigen además scope
`chat.write`. Rate limit por cliente aplica igual que en chat.

---

## 1. REST — `POST /v1/search`

Request/response espejan el wire format de NaN (sin el campo interno
`source` de cada resultado).

```bash
curl -s http://localhost:3000/v1/search \
  -H "Authorization: Bearer sk-…" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "mejores prácticas observability LLM",
    "count": 5,
    "freshness": "pm",
    "fetch_content": true
  }'
```

| Campo | Tipo | Default | Descripción |
|---|---|---|---|
| `query` | string | **requerido** | Consulta (1–500 chars) |
| `count` | int | `5` | Resultados a devolver (1–20) |
| `freshness` | string | — | `pd` \| `pw` \| `pm` \| `py` o rango `YYYY-MM-DDtoYYYY-MM-DD` |
| `fetch_content` | bool | `false` | Trae texto completo de cada página (más lento) |

Respuesta:

```json
{
  "results": [
    {
      "title": "…",
      "url": "…",
      "snippet": "…",
      "content": "…"
    }
  ],
  "cached": true
}
```

Errores de proveedor (envelope estándar del gateway):

| `code` | HTTP | Significado |
|---|---|---|
| `search_unavailable` | 502 | NaN caído / error upstream |
| `search_rate_limited` | 429 | Rate limit de NaN (20 RPM / 3 concurrentes / 500 día) — incluye `Retry-After` |
| `search_timeout` | 504 | Timeout de fetch (30s snippets / 120s con `fetch_content`) |

```json
{
  "error": {
    "message": "Search provider rate limit exceeded. Retry after the indicated time.",
    "type": "search_rate_limited",
    "code": "search_rate_limited",
    "retryAfterMs": 30000
  }
}
```

## 2. MCP — `POST /v1/mcp`

Servidor MCP stateless sobre JSON-RPC 2.0. Cada POST es un round-trip; sin
sesiones ni SSE. Métodos soportados:

| Método | Respuesta |
|---|---|
| `initialize` | `protocolVersion` negociado + `capabilities.tools` + `serverInfo` |
| `notifications/initialized` (sin `id`) | HTTP 202, body vacío |
| `tools/list` | `[{ name: 'web_search', description, inputSchema }]` |
| `tools/call` | ejecuta búsqueda → `content` + `structuredContent` |
| `ping` | `{}` |

Convenciones MCP: errores JSON-RPC van con **HTTP 200** y campo `error`
(códigos `-32700`/`-32600`/`-32601`/`-32602`). Fallos de búsqueda dentro de
`tools/call` devuelven `isError: true` con el mensaje, no un throw.

```bash
curl -s http://localhost:3000/v1/mcp \
  -H "Authorization: Bearer sk-…" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"web_search","arguments":{"query":"llm gateway","count":3}}}'
```

### Config para Pi

```json
{
  "mcpServers": {
    "gateway-search": {
      "url": "https://gateway/v1/mcp",
      "headers": { "Authorization": "Bearer sk-…" }
    }
  }
}
```

Pi descubre el tool `web_search` y puede usarlo en conversaciones.

## 3. Discovery — `GET /v1/tools`

Para clientes que no hablan MCP (Kilo, OpenCode). Forma OpenAI-compatible
(`type: 'function'`) para insertar directo en el tooling de
chat-completions. Auth igual que `GET /v1/models` (key + rate limit, sin
scope extra).

```bash
curl -s http://localhost:3000/v1/tools -H "Authorization: Bearer sk-…"
```

```json
{
  "object": "list",
  "data": [
    {
      "type": "function",
      "function": {
        "name": "web_search",
        "description": "…",
        "parameters": { "type": "object", "properties": { … }, "required": ["query"] }
      }
    }
  ]
}
```

---

## Observabilidad

Cada búsqueda registra una fila en `request_logs` con
`model_requested = '$search'` (mismo schema que chat — sin tabla nueva) y un
evento estructurado `search.request` en stdout. Consultable vía
`GET /admin/logs?model=$search`.

## Edge cases v1

- **429 de NaN:** se devuelve `search_rate_limited` con `Retry-After`. No hay
  cola ni reintento automático en v1 — el cliente decide.
- **NaN caído:** `search_unavailable`.
- **Timeout fetch_content:** 120s; snippets: 30s.
- **Query inválida:** zod → 400 con envelope OpenAI-style.
- **Resultados sin `url`:** se descartan en normalización.

## Archivos

| Archivo | Rol |
|---|---|
| `src/search/search-provider.interface.ts` | `SearchProvider` + tipos + errores |
| `src/search/http-search.provider.ts` | Adapter de wire format HTTP (`POST <base_url>/search`) — sin identidad de proveedor |
| `src/search/search.service.ts` | Orquestador: validación, logging, dispatch |
| `src/search/search.controller.ts` | `POST /v1/search` |
| `src/search/search.module.ts` | Módulo Nest — selecciona proveedor por capacidad (`supports_search`) |
| `src/mcp/mcp.controller.ts` | `POST /v1/mcp` JSON-RPC (protocolo MCP) |
| `src/mcp/mcp.module.ts` | Módulo protocolo MCP |
| `src/tools/tools.controller.ts` | `GET /v1/tools` (registry de herramientas) |
| `src/tools/web-search.tool.ts` | Definición única del tool `web_search` |
| `src/tools/tools.module.ts` | Módulo tools |

**Selección de proveedor:** el módulo de search no nombra ningún proveedor.
`SearchModule` pregunta al registry cuál fila tiene `supports_search = 1`
(migración 0012) y le pasa `id`, `base_url` (+ `/search`) y `api_key_env`
al adapter. Cambiar de proveedor de search = UPDATE en `providers`, cero
código. (Chat no tiene flag: su capacidad se deriva de tener filas en
`model_configs`.)
