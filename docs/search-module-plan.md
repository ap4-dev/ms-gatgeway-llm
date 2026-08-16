# Search Module — implementation plan

## Objective

Expose NaN web search as a provider-agnostic surface on the gateway. Clients
use the gateway's own endpoints, not NaN's directly. If the search provider
changes, only gateway internals change — clients stay unaffected.

## Design

```
CLIENT (Pi, Kilo, OpenCode, curl)
  │
  ├── POST /v1/search  (REST)
  ├── POST /v1/mcp     (JSON-RPC — MCP protocol)
  ├── GET  /v1/tools   (discovery)
  └── chat tool web_search (future, Option 2)
  │
  ▼
GATEWAY
  └── SearchProvider interface
       └── HttpSearchProvider (wire-format adapter, POST /v1/search)
       └── ??? (future provider)
  │
  ▼
PROVIDER (NaN today, another tomorrow)
```

## Files to create

| File | Purpose |
|------|---------|
| `src/search/search-provider.interface.ts` | `SearchProvider` interface + `SearchResult`, `SearchOptions` types |
| `src/search/http-search.provider.ts` | Wire-format adapter: JSON `POST /v1/search` (`NAN_API_KEY`) |
| `src/search/search.controller.ts` | `POST /v1/search` REST endpoint |
| `src/search/mcp.controller.ts` | `POST /v1/mcp` JSON-RPC (initialize, tools/list, tools/call, ping) |
| `src/search/tools.controller.ts` | `GET /v1/tools` discovery endpoint |
| `src/search/search.module.ts` | Nest module |
| `src/search/search.service.ts` | Orchestrator: rate limit, logging, provider dispatch |
| `docs/search.md` | Usage docs |
| `migrations/0012_search_logs.sql` | Optional: search-specific log table or use request_logs |

## Implementation steps

### 1. Types and interface (`search-provider.interface.ts`)

```typescript
interface SearchOptions {
  query: string;
  count?: number;        // 1-20, default 5
  freshness?: string;    // 'pd'|'pw'|'pm'|'py'|'YYYY-MM-DDtoYYYY-MM-DD'
  fetchContent?: boolean;
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  content?: string;
  source?: string;
}

interface SearchProvider {
  search(opts: SearchOptions): Promise<{ results: SearchResult[]; cached: boolean }>;
}
```

### 2. HttpSearchProvider (`http-search.provider.ts`)

- Reads NAN_API_KEY from env
- Calls `POST https://api.nan.builders/v1/search` with Bearer auth
- Wraps errors in standard gateway format
- Rate-limit awareness: NaN gives 20 RPM / 3 concurrent / 500 day

### 3. SearchService (`search.service.ts`)

- Injectable into controllers
- Validates input (zod)
- Calls provider
- Logs to request_logs (model_requested = `$search`)
- Applies gateway per-client rate limit

### 4. REST controller (`search.controller.ts`)

- `POST /v1/search`
- Auth: ApiKeyAuthGuard + RequireScopes('chat.write')
- Rate limit: RateLimitGuard
- Request/response same shape as NaN but without `source` (internal detail)

### 5. MCP controller (`mcp.controller.ts`)

- `POST /v1/mcp`
- Auth: ApiKeyAuthGuard + RequireScopes('chat.write')
- JSON-RPC 2.0 methods:
  - `initialize` → protocol version + capabilities
  - `tools/list` → [{ name: 'web_search', description, inputSchema }]
  - `tools/call` → call SearchService.search with args, return results
  - `ping` → pong
- Stateless (like NaN's MCP)

### 6. Tools controller (`tools.controller.ts`)

- `GET /v1/tools` → list available tools with full schemas
- Auth: optional, same as GET /v1/models
- Useful for OpenCode/Kilo to auto-discover without needing the full chat completions schema

### 7. MCP config for Pi (post-deployment)

```json
{
  "mcpServers": {
    "gateway-search": {
      "url": "https://gateway/v1/mcp",
      "headers": { "Authorization": "Bearer sk-..." }
    }
  }
}
```

Then Pi discovers `web_search` tool and can use it.

## Edge cases

- NaN rate limit (20 RPM): gateway should handle 429 from NaN, queue or return error
- NaN downtime → error envelope `search_unavailable`
- fetch_content timeout → gateway timeout per provider setting
- Query too short/long → zod validation
- MCP JSON-RPC error responses must use HTTP 200 with `error` field (MCP standard)

## DB changes

- Search logs -> `request_logs` with `model_requested = '$search'`
- Or new table `search_logs` if fields diverge (separate migration)
- Decision: use request_logs with marker, no new table needed at first