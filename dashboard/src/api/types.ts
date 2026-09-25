/**
 * Shared request/response types for the gateway admin API.
 *
 * These mirror the JSON shapes returned by the Nest controllers under
 * `src/admin`, `src/chat/models.controller.ts` and the SQLite admin surface.
 * The SPA has no runtime schema validation, so a backend shape drift shows up
 * as a render bug — keep these definitions in sync with the controllers.
 */

// ── GET /admin/stats/summary ────────────────────────────────────────────────

export interface SummaryFilters {
  model: string | null;
  client: string | null;
  provider: string | null;
}

/** Count/latency fields shared by the totals object and every bucket row. */
export interface SummaryCountFields {
  requests: number;
  ok: number;
  errors: number;
  circuitOpen: number;
  totalTokens: number;
  avgLatencyMs: number;
}

/** Grand totals for the requested range, plus token sums. */
export interface SummaryTotals extends SummaryCountFields {
  promptTokens: number;
  completionTokens: number;
}

export interface SummaryDayBucket extends SummaryCountFields {
  day: string;
}

export interface SummaryModelBucket extends SummaryCountFields {
  model: string;
}

export interface SummaryClientBucket extends SummaryCountFields {
  /** `null` for rows with no attributed client. */
  client: string | null;
}

export interface SummaryResponse {
  from: number;
  to: number;
  filters: SummaryFilters;
  totals: SummaryTotals;
  byDay: SummaryDayBucket[];
  byModel: SummaryModelBucket[];
  byClient: SummaryClientBucket[];
}

// ── GET /admin/aliases ──────────────────────────────────────────────────────

export type AliasStrategy =
  | 'primary'
  | 'round-robin'
  | 'fallback'
  | 'weighted'
  | 'priority-grouped';

export const ALIAS_STRATEGIES: readonly AliasStrategy[] = [
  'primary',
  'round-robin',
  'fallback',
  'weighted',
  'priority-grouped',
];

export interface Alias {
  id: string;
  /** Ordered routing chain, each entry is `providerId/modelKey`. */
  chain: string[];
  strategy: AliasStrategy;
  /** One weight per chain position (length === chain.length). */
  weights: number[];
  /** One priority per chain position (length === chain.length). */
  priorities: number[];
}

export interface AliasesResponse {
  aliases: Alias[];
}

/** `POST /admin/aliases` accepts an optional strategy (defaults to `primary`). */
export interface CreateAliasPayload {
  id: string;
  /** Ordered routing chain, each entry is `providerId/modelKey`. */
  chain: string[];
  strategy?: AliasStrategy;
}

// ── /admin/providers ────────────────────────────────────────────────────────

/**
 * One model configured on a provider. `usedInAliases` lists the alias ids whose
 * chain contains this exact `provider/model` entry — an empty array means the
 * model can be deleted without a `409`.
 */
export interface ProviderModelView {
  modelKey: string;
  realName: string;
  maxTokens: number | null;
  supportsStream: boolean;
  disableThinking: boolean;
  usedInAliases: string[];
}

/**
 * One provider. `apiKeyEnv` is the NAME of the environment variable holding the
 * key; actual key material is never sent to or returned by the API.
 */
export interface ProviderView {
  id: string;
  apiKeyEnv: string;
  baseUrl: string | null;
  timeoutMs: number | null;
  supportsSearch: boolean;
  models: ProviderModelView[];
}

export interface ProvidersResponse {
  providers: ProviderView[];
}

export interface CreateProviderPayload {
  id: string;
  apiKeyEnv: string;
  baseUrl?: string;
  timeoutMs?: number;
  supportsSearch?: boolean;
}

/** PATCH cannot clear nullable fields; omit a field to leave it unchanged. */
export interface PatchProviderPayload {
  apiKeyEnv?: string;
  baseUrl?: string;
  timeoutMs?: number;
  supportsSearch?: boolean;
}

export interface CreateProviderModelPayload {
  modelKey: string;
  realName: string;
  maxTokens?: number;
  supportsStream?: boolean;
  disableThinking?: boolean;
}

export interface PatchProviderModelPayload {
  realName?: string;
  maxTokens?: number;
  supportsStream?: boolean;
  disableThinking?: boolean;
}

// ── GET /admin/clients ──────────────────────────────────────────────────────

export interface Client {
  id: string;
  name: string;
  scopes: string[];
  rateLimitRpm: number;
  rateLimitTpm: number | null;
  apiKeyPrefix: string;
  /** Unix seconds. */
  createdAt: number;
  /** Unix seconds, or `null` when the key has never been used. */
  lastUsedAt: number | null;
  revoked: boolean;
}

export interface ClientsResponse {
  clients: Client[];
}

/**
 * `POST /admin/clients` and `POST /admin/clients/:id/rotate` responses.
 * `plaintextApiKey` is returned exactly once and never persisted server-side.
 */
export interface ClientWithKey extends Client {
  plaintextApiKey: string;
  warning: string;
}

export interface CreateClientPayload {
  id?: string;
  name: string;
  scopes?: string[];
  rateLimitRpm?: number;
  rateLimitTpm?: number;
}

export interface PatchClientPayload {
  name?: string;
  scopes?: string[];
  rateLimitRpm?: number;
  /** `null` clears the token limit. */
  rateLimitTpm?: number | null;
}

// ── GET /admin/logs ─────────────────────────────────────────────────────────

export type LogStatus = 'ok' | 'error' | 'circuit_open';

export interface LogItem {
  /** Unix seconds. */
  requestedAt: number;
  modelRequested: string;
  resolvedProvider: string | null;
  resolvedModel: string | null;
  attempts: number;
  latencyMs: number;
  status: LogStatus;
  error: string | null;
  clientKey: string | null;
  promptHash: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  /**
   * JSON string with per-attempt details. Parse defensively with
   * {@link parseJsonField} — it may be `null` or malformed.
   */
  attemptDetails: string | null;
  /**
   * JSON string with the outbound request snapshot (failure rows only).
   * Currently NOT included by `GET /admin/logs` (the controller drops it);
   * typed/rendered defensively so it lights up if the backend adds it.
   */
  requestParams?: string | null;
}

export interface LogsResponse {
  items: LogItem[];
  count: number;
  limit: number;
  hasMore: boolean;
}

export interface ListLogsParams {
  client_id?: string;
  model?: string;
  provider?: string;
  resolved_model?: string;
  status?: LogStatus;
  from?: string;
  to?: string;
  limit?: number;
}

// ── GET /v1/models ──────────────────────────────────────────────────────────

export interface ModelListItem {
  /** Alias id (the gateway never advertises upstream model ids). */
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
}

export interface ModelsListResponse {
  object: 'list';
  data: ModelListItem[];
}

// ── GET /admin/db/tables + POST /admin/db/query ─────────────────────────────

export interface DbTable {
  name: string;
  c: number;
}

export interface DbTablesResponse {
  tables: DbTable[];
}

export interface DbQueryResponse {
  rows: Record<string, unknown>[];
  columns: string[];
  duration?: number;
  error?: string;
}

/**
 * One row of the read-only Models view join:
 * `model_configs JOIN providers`. SQLite returns booleans as 0/1 integers and
 * nullable columns as `null`.
 */
export interface ModelConfigRow {
  provider_id: string;
  model_key: string;
  real_name: string | null;
  max_tokens: number | null;
  supports_stream: number | null;
  disable_thinking: number | null;
  base_url: string | null;
  timeout_ms: number | null;
}
