# ms-gateway-llm — Architecture & Roadmap

## 1. Current State (POC v0.1)

The service is a NestJS 11 + Fastify proxy that forwards **OpenAI-compatible** `/chat/completions` requests to upstream LLM providers.

```
Client (Kilo / OpenCode / etc.)
  │
  ▼
POST /v1/chat/completions
  │
  ▼
┌─────────────────────────────────────┐
│  ProxyController                   │
│  ├── validates body                │
│  ├── if stream → SSE passthrough   │
│  └── else → JSON response          │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│  ProxyService                      │
│  ├── normalizeBody()               │
│  │   └── mergeSystemMessages()     │
│  └── OpenAI SDK → upstream         │
└─────────────────────────────────────┘
               │
               ▼
  Provider (nan.builders / OpenAI / etc.)
```

### Files

| File | Purpose |
|---|---|
| `src/main.ts` | Bootstrap, Fastify adapter, CORS, global prefix `v1` |
| `src/app.module.ts` | Root module, wires controllers + providers |
| `src/proxy.controller.ts` | `POST /chat/completions` — streaming & non-streaming |
| `src/openia/proxy.service.ts` | Normalization + OpenAI SDK client |
| `config/providers.json` | Provider/model registry (not yet consumed) |

---

## 2. Methodology: TDD

**Why TDD for this POC:**
- Proxy correctness is binary — it either passes the right payload upstream or it doesn't.
- Streaming SSE has subtle contract issues (newline framing, `[DONE]`, chunk shape) that unit tests catch cheaply.
- Normalization logic (system message merging, role coercion) is pure-function territory — perfect for TDD.
- Tests double as documentation for the team on how the proxy behaves.

### Test Layers

| Layer | Tool | What it covers |
|---|---|---|
| Unit | Jest | `normalizeBody`, `mergeSystemMessages`, provider routing |
| Integration | Jest + NestJS `TestingModule` | Controller ↔ Service wiring, mock upstream |
| E2E | Jest + supertest | Full HTTP round-trip against a mock OpenAI server |

---

## 3. Target Architecture (v1.0)

```
src/
  chat/
    chat.controller.ts          # POST /chat/completions
    chat.module.ts              # Feature module
  normalization/
    normalize.service.ts        # system merge, role fix
    normalize.service.spec.ts   # TDD tests
  providers/
    provider.service.ts         # resolve model → provider, API key, baseURL
    provider.service.spec.ts    # TDD tests
    provider.model.ts           # types/interfaces
  routing/
    routing.service.ts          # fallback, round-robin, health-check
    routing.service.spec.ts     # TDD tests
  resilience/
    circuit-breaker.service.ts  # per-provider circuit breaker
    rate-limiter.service.ts     # rate limiting per API key
  observability/
    llm-logging.service.ts      # structured logs (prompt hash, latency, tokens)
    llm-logging.service.spec.ts
  config/
    providers.json              # provider registry
    providers.schema.ts         # Zod validation of providers.json
  health/
    llm-health.controller.ts    # GET /health/llm — per-provider status
```

---

## 4. Key Design Decisions

### 4.1 Provider Abstraction

```ts
// provider.model.ts
interface ProviderConfig {
  apiKey: string;
  baseURL: string;
  models: Record<string, {
    real: string;          // model name upstream
    maxTokens?: number;    // override
    supportsStream?: boolean;
  }>;
}

interface ResolvedModel {
  provider: string;        // "nan" | "openai" | ...
  config: ProviderConfig;
  modelName: string;       // real model name
}
```

**Routing flow:** `client model → alias lookup → provider resolution → OpenAI SDK call`

All providers must be OpenAI-compatible (the SDK enforces the protocol).

### 4.2 Normalization Pipeline

```
Incoming body
  → validate (Zod schema)
  → normalize messages (merge system, coerce roles)
  → apply model overrides (maxTokens, etc.)
  → forward to upstream
```

**Why normalize upstream instead of rejecting:**
- Clients (Kilo, OpenCode, Claude Code) all send slightly different formats.
- The proxy should be forgiving — absorb differences, return clean results.

### 4.3 Streaming Contract

```
Content-Type: text/event-stream

data: {"id":"...","object":"chat.completion.chunk","choices":[{"delta":{"content":"Hello"}}]}
data: {"id":"...","object":"chat.completion.chunk","choices":[{"delta":{"content":" world"}}]}
data: [DONE]
```

**Critical:** The proxy MUST forward raw OpenAI chunk objects (not a custom format). Clients parse these directly.

### 4.4 Error Handling

| Scenario | Behavior |
|---|---|
| Upstream 4xx | Forward status + body to client |
| Upstream timeout | 504 + structured error |
| Upstream 5xx + fallback enabled | Retry on next provider |
| All providers down | 503 + circuit state |
| Invalid client request | 400 + Zod validation errors |

---

## 5. Implementation Roadmap

### Phase 1 — POC Hardening (this sprint)

- [ ] Move hardcoded env vars to Doppler/Dotenv
- [ ] Add Zod validation for incoming body
- [ ] Add unit tests for `normalizeMessages`
- [ ] Add unit tests for `completions` (stream + non-stream) with mock OpenAI client
- [ ] Register `ProxyService` in `ChatModule` (feature module extraction)

### Phase 2 — Multi-Provider

- [ ] Implement `ProviderService` consuming `config/providers.json`
- [ ] Model alias resolution (`fast` → `openai/gpt-4o-mini`)
- [ ] `ProviderConfig` schema validation (Zod)
- [ ] Unit tests for routing logic

### Phase 3 — Resilience

- [ ] Per-provider circuit breaker (closed/open/half-open)
- [ ] Fallback routing: primary fails → try next provider
- [ ] Configurable timeouts per provider
- [ ] Health check endpoint per provider

### Phase 4 — Observability

- [ ] Structured logging: prompt hash, model, latency, token counts
- [ ] Metrics: request count, error rate, latency p50/p95/p99 per model
- [ ] Dashboard-ready OpenTelemetry traces

### Phase 5 — Production

- [ ] API key management (per-client, rotation)
- [ ] Rate limiting (per API key, per model)
- [ ] Request/response caching (for identical non-streaming calls)
- [ ] Load testing with k6/artillery

---

## 6. Open Questions

| # | Question | Options | Decision |
|---|---|---|---|
| 1 | Feature module naming? | `chat` vs `llm` vs `openai` | **TBD** |
| 2 | Where to store provider config? | `config/providers.json` vs DB vs Doppler | **TBD** |
| 3 | Auth strategy? | Bearer token passthrough vs proxy API keys vs mTLS | **TBD** |
| 4 | Caching? | Redis (already in deps) vs in-memory LRU | **TBD** |
| 5 | Tool/function calling support? | Passthrough as-is vs structured response | **TBD** |
| 6 | Models endpoint? | `GET /v1/models` (OpenAI compat) vs custom | **TBD** |

---

## 7. Quick Start

```bash
# Env vars
export LLM_PROVIDER_API_KEY="sk-..."
export LLM_PROVIDER_BASE_URL="https://api.nan.builders/v1"

# Run
pnpm run start:dev

# Test (non-streaming)
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3.6",
    "messages": [{"role":"user","content":"Hola mundo"}],
    "stream": false
  }'

# Test (streaming)
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3.6",
    "messages": [{"role":"user","content":"Hola mundo"}],
    "stream": true
  }'
```

---

## 8. Client Compatibility

| Client | Protocol | Status |
|---|---|---|
| Kilo (OpenCode) | OpenAI-compatible streaming | ✅ Working |
| Claude Code | OpenAI-compatible streaming | 🔍 Needs testing |
| Continue.dev | OpenAI-compatible streaming | 🔍 Needs testing |
| Cursor | OpenAI-compatible streaming | 🔍 Needs testing |
| Aider | OpenAI-compatible streaming | 🔍 Needs testing |
| Cline | OpenAI-compatible streaming | 🔍 Needs testing |
