# ms-gateway-llm — Análisis de capacidad

> **Pregunta:** ¿soporta este gateway ~100 millones de tokens/día para 3
> desarrolladores + 2 agentes (Hermes)?
> **Fecha:** 2026-08-15
> **Base:** código real (`src/`, `ecosystem.config.js`), no suposiciones.

---

## Veredicto corto

**Sí, el gateway aguanta 100M tokens/día con muchísimo margen.** No es un
problema de capacidad del proxy — es un passthrough I/O-bound; los tokens los
genera y factura el **upstream** (nan.builders). El cuello de botella real para
ese escenario está en **tres cosas que hay que configurar**, no en el proceso:

1. Los **rate limits por cliente** (los agentes Hermes pueden chocar con 429).
2. **Redis arriba** (caído = sin protección de rate limit).
3. **RAM del VPS** (el streaming bufferéa cada respuesta en memoria).

Y asumir que es **single-node**: sin HA y sin escalado horizontal mientras viva
de SQLite de archivo único.

---

## 1. Qué significa 100M tokens/día en números de tráfico

| Métrica | Valor | Nota |
|---|---|---|
| Promedio sostenido (24 h) | **~1.160 tokens/s** | 100e6 / 86.400 s |
| Concentrado en 8 h laborales | **~3.500 tokens/s** | 100e6 / 28.800 s |
| Requests/día (avg 25k tokens/req) | **~4.000** | prompt 15k + completion 10k |
| Requests/día (avg 10k tokens/req) | **~10.000** | llamadas más chicas |
| Promedio de requests | ~0.05–0.12 req/s | picos de agentes: 5–10 req/s |
| Streams concurrentes | **5–20** | 3 devs + 2 agentes × 1–4 llamadas paralelas |
| Payload a través del proxy | ~0.4–1 GB/día | ≈ 4 bytes/token |

Los tokens/seg que el proxy debe **reenviar** no se generan acá: vienen del
upstream y se escriben al socket del cliente. Un solo proceso Node/Fastify
mueve cientos de req/s con streaming — 5–20 streams es liviano.

---

## 2. Respuesta de la arquitectura real a esa carga

| Componente | Estado real en el código | Carga a 100M/día | Veredicto |
|---|---|---|---|
| Proceso único (`ecosystem.config.js`: `instances: 1`, cluster) | 1 worker Node/Fastify | ~0.1 req/s avg, picos 5–10 req/s | ✅ sobra |
| SQLite (`better-sqlite3`, **WAL** sync) | una conexión, `journal_mode=WAL` | 4–10k INSERTs/día (logs) ≈ 0.1/s, picos ~10/s | ✅ sobra (WAL soporta miles de writes/s) |
| Writes síncronos en el event loop | `request_logs` se inserta **sync** tras responder | ~10/s × ~0.1 ms ≈ 1 ms/s bloqueado | ✅ despreciable |
| Redis (cache de auth `ak:v1:…` TTL 5 min + rate limit) | 1–2 ops async por request | bajo | ✅ si Redis está up |
| Auth fallback a SQLite (sin Redis) | SELECT sync por request | miles/s posibles | ✅ |
| Memoria — **tee de streams** | cada stream bufferéa **una copia completa** para capturar tokens | ~2 MB por cada 10k tokens; 20 streams ≈ 40 MB | ⚠️ vigilar picos |
| Ceiling pm2 | `max_memory_restart: 500M` | — | ⚠️ ajustar según VPS |

**Conclusión de tabla:** a este volumen el proxy no es el límite. El
bottleneck, si aparece, va a estar en el upstream o en la configuración, no en
el proceso.

---

## 3. Dónde está el cuello de botella REAL (no es el proxy)

### 3.1 El proveedor upstream (nan.builders)
100M tokens/día los **genera el upstream**, no el gateway. Ahí importa:
- Límites **RPM/TPM** que aplique el proveedor al proyecto.
- Throughput de su infraestructura (si se satura, se saturan todos).
- **Costo**: 100M/día × tarifa del modelo = gasto diario real (orden de
  decenas de USD/día según modelo y precio). El proxy no cachea respuestas
  idénticas → **cada request paga tokens** por diseño.

### 3.2 Los rate limits por cliente (configurables)
- Default de creación: `rate_limit_rpm = 60` (máx permitido: 100.000).
- `rate_limit_tpm` = `null` (sin tope de tokens) salvo que lo fijes.
- Con requests grandes (15–25k tokens): 60 RPM ≈ 900k–1.5M tokens/min por
  cliente — de sobra.
- **Pero los agentes Hermes disparan ráfagas de llamadas chicas en paralelo.**
  Si son de ~1–2k tokens: 60 RPM × 1.5k ≈ 90–120k tokens/min por cliente.
  × 5 clientes ≈ 7M tokens/hora ≈ **56M en una jornada de 8 h — justo por
  debajo de 100M**. Los agentes van a empezar a chocar con `429` y `Retry-After`.

### 3.3 Redis caído = sin protección
Auth cache y rate limiter son **fail-open**: si Redis cae, la auth cae a
SQLite (funciona) pero el rate limit **deja de frenar**. A 100M/día, un cliente
descontrolado puede disparar consumo upstream sin tope. No es capacidad, es
control de costos.

---

## 4. Riesgos concretos para TU escenario (robustez, no capacidad)

1. **Single-node, sin HA.** `instances: 1`. Si el proceso crashea (o el VPS se
   cae), los 5 clientes pierden los streams en vuelo y los agentes fallan a
   mitad de tarea. pm2 `autorestart` (10 intentos, `min_uptime` 10 s) lo
   levanta, pero el trabajo a medio request se pierde. Para agentes que corren
   tareas largas, un crash = tarea rota.

2. **El tee bufferéa cada stream completo en RAM.** Un output de 100k tokens ≈
   20 MB en memoria (la copia para capturar tokens). En un pico con varios
   streams de outputs grandes podés acercarte al ceiling de **500 MB** de pm2 y
   que reinicie en el peor momento. Dimensionar el VPS ≥ 2 GB y revisar el
   ceiling.

3. **Escalar horizontal NO es trivial con SQLite.** Un solo archivo + una sola
   conexión = **un solo nodo**. No se escala "agregando workers" mientras el
   registro y los logs vivan en SQLite (los comentarios del código ya lo
   anticipan: `request_logs` → Postgres cuando crezca). El gateway en sí escala
   a N workers (pm2 cluster), pero la DB no acompaña.

4. **`request_logs` crece ~4–10k filas/día (~1.5–3M/año).** El endpoint
   `GET /admin/logs` sigue rápido con los índices de la migración `0009` y
   `limit` está topado en 500. No es problema a este volumen.

5. **Un provider caído.** El circuit breaker + fallback por chain funciona —
   siempre que cada alias tenga 2+ providers en su chain. Validar eso para que
   un provider caído no tire abajo a todos.

---

## 5. Recomendaciones accionables (3 devs + 2 Hermes, ~100M/día)

1. **Subir el RPM de los clientes de los agentes Hermes** a 300–1000 (o
   limitarlos por TPM en vez de RPM). A los devs, 60–120 RPM está bien.
2. **Redis en el mismo VPS o manejado**, y monitorizarlo: caído = sin rate
   limit (fail-open) + auth cayendo a SQLite.
3. **VPS con ≥ 2 GB RAM** y revisar `max_memory_restart` (500 MB) si ves
   restarts por memoria en picos de streams grandes.
4. **Validar chains de 2+ providers por alias** para aprovechar el circuit
   breaker + fallback.
5. **Asumir el costo**: sin caché de respuestas idénticas, 100M/día = gasto
   upstream real. Si querés bajar factura, ese es el próximo feature.
6. **Planificar Postgres** para `request_logs` antes de crecer más allá de
   ~2–3 nodos o ~5M filas, para no quedar atados a SQLite single-file.

---

## 6. Verdicto final

- **Capacidad del proxy: ✅ sobra por un factor grande.** 100M tokens/día son
  ~0.1 req/s promedio y 5–20 streams concurrentes. Un proceso Fastify los mueve
  sin esfuerzo. El gateway **no** va a ser el cuello de botella a este volumen.
- **Lo que sí hay que preparar:** límites por cliente de los agentes, Redis up,
  RAM del VPS, y la expectativa de que es **single-node sin HA**.
- **Lo que importa de verdad a 100M/día:** la capacidad y el costo del
  **proveedor upstream** — el proxy es un caño transparente, no el motor.
