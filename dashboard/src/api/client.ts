/**
 * Thin HTTP client for the gateway admin API.
 *
 * Auth model: the SPA holds a plaintext API key in `localStorage` under
 * {@link API_KEY_STORAGE_KEY} and sends it as `Authorization: Bearer <key>` on
 * every request. There are no cookies or sessions. Any `401` means the stored
 * key is missing/revoked/rotated, so the key is cleared and the app is routed
 * back to the login screen via the injected {@link setUnauthorizedHandler}.
 */

import type {
  Alias,
  AliasStrategy,
  AliasesResponse,
  Client,
  ClientsResponse,
  ClientWithKey,
  CreateClientPayload,
  DbQueryResponse,
  DbTablesResponse,
  ListLogsParams,
  LogsResponse,
  ModelsListResponse,
  PatchClientPayload,
  SummaryResponse,
} from './types';

// The response types live in `./types` (single source of truth). Re-export the
// whole surface so callers can keep importing either module.
export type {
  Alias,
  AliasStrategy,
  AliasesResponse,
  Client,
  ClientsResponse,
  ClientWithKey,
  CreateClientPayload,
  DbQueryResponse,
  DbTable,
  DbTablesResponse,
  ListLogsParams,
  LogItem,
  LogStatus,
  LogsResponse,
  ModelConfigRow,
  ModelListItem,
  ModelsListResponse,
  PatchClientPayload,
  SummaryClientBucket,
  SummaryCountFields,
  SummaryDayBucket,
  SummaryFilters,
  SummaryModelBucket,
  SummaryResponse,
  SummaryTotals,
} from './types';
export { ALIAS_STRATEGIES } from './types';

export const API_KEY_STORAGE_KEY = 'gw_admin_key';

/** Injected by the router layer to avoid a client <-> router import cycle. */
let unauthorizedHandler: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

/** Read the stored API key, or `null` when the operator has not logged in. */
export function getApiKey(): string | null {
  try {
    return window.localStorage.getItem(API_KEY_STORAGE_KEY);
  } catch {
    // localStorage can throw in privacy modes; treat it as "not logged in".
    return null;
  }
}

export function setApiKey(key: string): void {
  window.localStorage.setItem(API_KEY_STORAGE_KEY, key);
}

export function clearApiKey(): void {
  window.localStorage.removeItem(API_KEY_STORAGE_KEY);
}

export function hasApiKey(): boolean {
  return (getApiKey() ?? '').length > 0;
}

/** Error thrown for any non-2xx response, carrying the parsed body when present. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Best-effort message extraction across the gateway's error body shapes. */
function extractMessage(parsed: unknown, status: number): string {
  if (parsed && typeof parsed === 'object') {
    const body = parsed as Record<string, unknown>;
    if (typeof body.message === 'string' && body.message.length > 0) {
      return body.message;
    }
    const nested = body.error;
    if (nested && typeof nested === 'object') {
      const nestedMessage = (nested as Record<string, unknown>).message;
      if (typeof nestedMessage === 'string' && nestedMessage.length > 0) {
        return nestedMessage;
      }
    }
    if (typeof body.error === 'string' && body.error.length > 0) {
      return body.error;
    }
  }
  return `Request failed with status ${status}`;
}

/**
 * `fetch` wrapper: attaches the bearer key, parses JSON, and propagates the
 * gateway error body as an {@link ApiError}. `401` additionally clears the
 * stored key and triggers the unauthorized handler (route to login).
 */
export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  const key = getApiKey();
  if (key) headers.set('Authorization', `Bearer ${key}`);
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(path, { ...init, headers });

  if (response.status === 401) {
    clearApiKey();
    unauthorizedHandler?.();
    throw new ApiError(
      401,
      'The stored API key was rejected. Sign in again with a key that has the `admin` scope.',
    );
  }

  const text = await response.text();
  let parsed: unknown = undefined;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!response.ok) {
    throw new ApiError(response.status, extractMessage(parsed, response.status), parsed);
  }

  return parsed as T;
}

/** One validation issue from a `400` response body. */
export interface ApiIssue {
  /** Admin stats/logs style: dotted path of the offending field. */
  path?: string;
  /** Client controller style (`ZodValidationPipe`): field name or `null`. */
  param?: string | null;
  message: string;
}

/**
 * Best-effort extraction of zod issues from a `400` {@link ApiError}. The
 * gateway emits two shapes: `{error:{issues:[{path,message}]}}` (stats/logs)
 * and `{error:{issues:[{param,message}]}}` (validation pipe). Both are handled.
 */
export function extractIssues(error: unknown): ApiIssue[] {
  if (!(error instanceof ApiError)) return [];
  const body = error.body;
  if (!body || typeof body !== 'object') return [];
  const nested = (body as Record<string, unknown>).error;
  if (!nested || typeof nested !== 'object') return [];
  const issues = (nested as Record<string, unknown>).issues;
  if (!Array.isArray(issues)) return [];
  return issues.map((raw): ApiIssue => {
    const rec = (raw ?? {}) as Record<string, unknown>;
    return {
      path: typeof rec.path === 'string' ? rec.path : undefined,
      param: typeof rec.param === 'string' ? rec.param : null,
      message:
        typeof rec.message === 'string' ? rec.message : String(rec.message ?? 'invalid'),
    };
  });
}

/**
 * Tolerant JSON parse for the `TEXT` columns the admin API exposes as strings
 * (`attemptDetails`, `requestParams`). Returns `null` for empty input and the
 * original string when the payload is malformed, so the UI can always render
 * *something* instead of throwing.
 */
export function parseJsonField(value: string | null | undefined): unknown {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

// ── GET /admin/stats/summary ────────────────────────────────────────────────

/**
 * `GET /admin/stats/summary`. Both bounds are required by the API and must be
 * ISO-8601 datetimes with an offset (callers convert `datetime-local` values
 * with `Date#toISOString`).
 */
export function getSummary(params: {
  from: string;
  to: string;
  model?: string;
  client?: string;
  provider?: string;
}): Promise<SummaryResponse> {
  const query = new URLSearchParams({ from: params.from, to: params.to });
  if (params.model) query.set('model', params.model);
  if (params.client) query.set('client', params.client);
  if (params.provider) query.set('provider', params.provider);
  return apiFetch<SummaryResponse>(`/admin/stats/summary?${query.toString()}`);
}

// ── GET/PUT /admin/aliases ──────────────────────────────────────────────────

export function listAliases(): Promise<AliasesResponse> {
  return apiFetch<AliasesResponse>('/admin/aliases');
}

export function getAlias(id: string): Promise<Alias> {
  return apiFetch<Alias>(`/admin/aliases/${encodeURIComponent(id)}`);
}

export function setAliasStrategy(id: string, strategy: AliasStrategy): Promise<void> {
  return apiFetch<void>(`/admin/aliases/${encodeURIComponent(id)}/strategy`, {
    method: 'PUT',
    body: JSON.stringify({ strategy }),
  });
}

export function setAliasWeights(id: string, weights: number[]): Promise<void> {
  return apiFetch<void>(`/admin/aliases/${encodeURIComponent(id)}/weights`, {
    method: 'PUT',
    body: JSON.stringify({ weights }),
  });
}

export function setAliasPriorities(
  id: string,
  priorities: Record<number, number>,
): Promise<void> {
  return apiFetch<void>(`/admin/aliases/${encodeURIComponent(id)}/priorities`, {
    method: 'PUT',
    body: JSON.stringify({ priorities }),
  });
}

// ── /admin/clients ──────────────────────────────────────────────────────────

export function listClients(): Promise<ClientsResponse> {
  return apiFetch<ClientsResponse>('/admin/clients');
}

export function getClient(id: string): Promise<Client> {
  return apiFetch<Client>(`/admin/clients/${encodeURIComponent(id)}`);
}

export function createClient(payload: CreateClientPayload): Promise<ClientWithKey> {
  return apiFetch<ClientWithKey>('/admin/clients', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function patchClient(id: string, payload: PatchClientPayload): Promise<Client> {
  return apiFetch<Client>(`/admin/clients/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export function rotateClient(id: string): Promise<ClientWithKey> {
  return apiFetch<ClientWithKey>(`/admin/clients/${encodeURIComponent(id)}/rotate`, {
    method: 'POST',
  });
}

export function revokeClient(id: string): Promise<void> {
  return apiFetch<void>(`/admin/clients/${encodeURIComponent(id)}/revoke`, {
    method: 'POST',
  });
}

export function deleteClient(id: string): Promise<void> {
  return apiFetch<void>(`/admin/clients/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

// ── GET /admin/logs ─────────────────────────────────────────────────────────

export function listLogs(params: ListLogsParams = {}): Promise<LogsResponse> {
  const query = new URLSearchParams();
  if (params.client_id) query.set('client_id', params.client_id);
  if (params.model) query.set('model', params.model);
  if (params.provider) query.set('provider', params.provider);
  if (params.resolved_model) query.set('resolved_model', params.resolved_model);
  if (params.status) query.set('status', params.status);
  if (params.from) query.set('from', params.from);
  if (params.to) query.set('to', params.to);
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  const qs = query.toString();
  return apiFetch<LogsResponse>(`/admin/logs${qs ? `?${qs}` : ''}`);
}

// ── GET /v1/models ──────────────────────────────────────────────────────────

export function listModels(): Promise<ModelsListResponse> {
  return apiFetch<ModelsListResponse>('/v1/models');
}

// ── /admin/db (SQLite admin) ────────────────────────────────────────────────

export function listTables(): Promise<DbTablesResponse> {
  return apiFetch<DbTablesResponse>('/admin/db/tables');
}

export function runQuery(sql: string): Promise<DbQueryResponse> {
  return apiFetch<DbQueryResponse>('/admin/db/query', {
    method: 'POST',
    body: JSON.stringify({ sql }),
  });
}
