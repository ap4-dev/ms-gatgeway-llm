# PII / Secrets — Diseño de Protección

## Problema

El cliente (tenant) tiene credenciales y datos PII.
El modelo LLM NUNCA debe verlos, pero debe poder aludirlos en respuestas (ej: `curl -H "Auth: Bearer sk-..."`).
El servidor tampoco persiste ni ve las credenciales.

## Solución: Sanitización + Tokenización Reversible

```
Cliente (tiene secrets)          Gateway (no ve secrets)           Modelo LLM
       │                                 │                             │
       │ "curl -H 'Auth: Bearer          │                             │
       │  sk-abc123def...'"              │                             │
       │────────────────────────────────>│                             │
       │                                 │                             │
       │                          ┌──────┴──────┐                     │
       │                          │ PII Detector  │                     │
       │                          │  (regex scan) │                     │
       │                          └──────┬──────┘                     │
       │                          │ Extrae → Map()                     │
       │                          │ Reemplaza sk-... → {{SEC_0}}      │
       │                          └──────┬──────┘                     │
       │                                 │                             │
       │                                 │ "curl -H 'Auth:              │
       │                                 │  Bearer {{SEC_0}}'..."      │
       │                                 │────────────────────────────>│
       │                                 │                             │
       │                                 │                  (no ve credencial)
       │                                 │                             │
       │                                 │<────────────────────────────│
       │                                 │ "curl -H 'Auth:              │
       │                                 │  Bearer {{SEC_0}}'..."      │
       │                                 │                             │
       │                          ┌──────┴──────┐                     │
       │                          │ Restore       │                     │
       │                          │ {{SEC_0}}→sk-abc... │               │
       │                          └──────┬──────┘                     │
       │                                 │                             │
       │<────────────────────────────────│                             │
       │ Resultado sin leak               │                             │
```

## Arquitectura

### 1. PiiDetector Service

Detección por regex. Cada request crea su propio `Map<placeholder, valor>` volátil. Se destruye al finalizar la request.

```typescript
const PATTERNS = [
  /sk-[a-zA-Z0-9]{20,}/g,                // OpenAI / API keys
  /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY/g, // SSH/RSA keys
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, // emails
  /\b(?:\d[ -]*?){13,16}\b/g,             // credit cards
  /password["']?\s*[:=]\s*["']?[^"';\s]{6,}/gi, // password patterns
  /(?:AKIA|ASIA)[A-Z0-9]{16}/g,            // AWS Access Keys
  /ghp_[A-Za-z0-9]{36,}/g,                // GitHub PATs
  /-----BEGIN.*PRIVATE KEY-----/,         // Any private key
  /token["']?\s*[:=]\s*["']?[^"';\s]{8,}/gi, // generic tokens
  /bearer\s+[a-zA-Z0-9\-._~+/]+=*$/gim,   // bearer tokens at end of line
  // Patterns for internal PII (configurable per tenant)
  /(?:dni|cedula|rut|ssn)\s*[:=]\s*["']?[^"';\s]{6,}/gi,
];
```

### 2. Integración en ChatService

```typescript
// chat.service.ts — en completions()

async completions(body: ChatCompletionCreateParams, clientId?: string) {
    // 1. Crear tokenizador (request-scoped, se destruye al finalizar)
    const tokenizer = new PiiDetector();

    // 2. Sanitizar mensajes ANTES de enviar al modelo
    const sanitizedMessages = (body.messages ?? []).map(m => ({
        ...m,
        content: typeof m.content === 'string'
            ? tokenizer.sanitize(m.content)
            : m.content,
    }));

    // 3. Enviar al modelo con texto sanitizado
    const result = await this.callUpstream(resolved, {
        ...body,
        messages: sanitizedMessages,
    });

    // 4. Restaurar placeholders en la respuesta
    if (isAsyncIterable(result)) {
        return this.restoreStream(result, tokenizer);
    }
    return this.restoreBody(result, tokenizer);
}

private restoreBody(body: ChatCompletion, tokenizer: PiiDetector): ChatCompletion {
    if (body.choices?.[0]?.message?.content) {
        body.choices[0].message.content =
            tokenizer.restore(body.choices[0].message.content);
    }
    return body;
}

private async restoreStream(
    stream: AsyncIterable<ChatCompletionChunk>,
    tokenizer: PiiDetector
): Promise<AsyncIterable<ChatCompletionChunk>> {
    return (async function* () {
        for await (const chunk of stream) {
            if (chunk.choices?.[0]?.delta?.content) {
                chunk.choices[0].delta.content =
                    tokenizer.restore(chunk.choices[0].delta.content);
            }
            if (chunk.choices?.[0]?.text) {
                chunk.choices[0].text =
                    tokenizer.restore(chunk.choices[0].text);
            }
            yield chunk;
        }
    })();
}
```

### 3. Integración en Tools / Shell Executors

Si el cliente usa tools (`execute_curl`, `bash`, `file_write`), el gateway intercepta antes de la ejecución:

```typescript
// Si el modelo genera un curl con placeholder:
// "curl -H 'Authorization: Bearer {{SEC_0}}' https://..."

async executeTool(toolCall, clientId: string) {
    // 1. Buscar la credencial real (solo el gateway la conoce)
    const realValue = await this.getCredential(clientId, toolCall.toolName);
    if (!realValue) throw new Error('Credential not found for tenant');

    // 2. Crear tokenizer temporal
    const tokenizer = new PiiDetector();
    // Invertir: mapa placeholder→valor para restore en salida

    // 3. Ejecutar tool (sin que el modelo vea el valor real)
    const output = await this.runTool(toolCall, realValue);

    // 4. Sanitizar output (puede contener el valor también)
    const sanitizedOutput = tokenizer.sanitize(output);

    // 5. Restore para el cliente final
    // (si el cliente quiere ver el resultado real)
    const restored = tokenizer.restore(sanitizedOutput);
    return restored;
}
```

## Reglas de Protección

| Regla | Implementación |
|-------|---------------|
| **No persistencia de secrets** | Map en memoria, destruido al finalizar request |
| **No logs de secrets** | Interceptar logs → `sanitize()` antes de write |
| **No Sentry de secrets** | Interceptar errores → `sanitize()` antes de reportar |
| **Credenciales por tenant** | `Map<clientId, Map<secretId, value>>` |
| **No redeploy para nuevos patterns** | Configurable vía `alias_config` o file |
| **Read-only by default** | Regex detecta pero no modify output |
| **Streaming-safe** | Restore se aplica chunk por chunk |

## Costo

| Operación | Latencia | Memoria |
|-----------|---------|---------|
| Regex scan (10+ patterns) | ~2-5ms | 0 |
| Placeholder replacement | ~1-2ms | ~500 bytes (placeholder) |
| Restore en respuesta | ~1ms | 0 |
| **Total por request** | **4-8ms** | **~500 bytes** |
| **Costo monetario** | **$0** | |

## Integración por Alias

Cada modelo/alias puede tener una política de sanitización:

| Alias | PII Policy | Efecto |
|-------|-----------|--------|
| `safe` | strict | Bloquea cualquier request que contenga PII detectado |
| `audit` | sanitize | Reemplaza PII por placeholders, no interrumpe |
| `open` | none | Bypass (alias de confianza) |
| `strict` | sanitize + block response | Si el modelo responde con PII, se limpia |

Configurable en `alias_config` tabla o file de config:

```sql
CREATE TABLE alias_policy (
  alias_key TEXT PRIMARY KEY,
  pii_policy TEXT NOT NULL DEFAULT 'sanitize'
              CHECK (pii_policy IN ('none', 'sanitize', 'strict', 'block')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT INTO alias_policy VALUES ('safe', 'block', ...);
INSERT INTO alias_policy VALUES ('audit', 'sanitize', ...);
INSERT INTO alias_policy VALUES ('open', 'none', ...);
INSERT INTO alias_policy VALUES ('strict', 'strict', ...);
```

## Ejemplos

### Input del cliente
```
"use el token sk-abc123def456ghi789jkl para consultar mi API"
```

### Lo que ve el modelo
```
"use el token {{SEC_0}} para consultar mi API"
```

### Response del modelo (puede contener el placeholder)
```
"la respuesta del endpoint es: data con auth bearer {{SEC_0}}"
```

### Lo que recibe el cliente (después de restore)
```
"la respuesta del endpoint es: data con auth bearer sk-abc123def456ghi789jkl"
```

## Archivos a crear

```
src/secrets/
├── pii-detector.service.ts      ← Sanitizer + Restore (regex-based)
├── pii-middleware.ts            ← Hooks: sanitize request, restore response
├── pii-config.ts                ← Patterns list, alias policies
├── pii.module.ts                ← Request-scoped module
└── pii.spec.ts                  ← Tests
```

## Integración con ChatService (改动 mínimos)

```typescript
// En src/chat/chat.service.ts — completions()

async completions(body, clientId?) {
    const tokenizer = new PiiDetector();

    // Sanitize antes de router
    body.messages = body.messages.map(m => ({
        ...m,
        content: typeof m.content === 'string' ? tokenizer.sanitize(m.content) : m.content,
    }));

    const result = await this.router.route(body.model, body, executor);

    // Restore después de upstream
    if (isAsyncIterable(result)) {
        return this.restoreStream(result, tokenizer);
    }
    return this.restoreChatCompletion(result, tokenizer);
}
```

## Notas de Seguridad Críticas

1. **Map destruido explícitamente**: `tokenizer.clear()` cuando termina la request
2. **No usar console.log()** en el módulo PII — usa logger de Nest con sanitización
3. **No exponer error messages** que contengan raw values
4. **Rate limiting del sanitizer** no es necesario (solo regex CPU-bound)
5. **No guardar el map en Redis/DB/session** — memory only
6. **No serializar el map** para debugging