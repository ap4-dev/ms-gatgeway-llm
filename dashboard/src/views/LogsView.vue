<script setup lang="ts">
import { onUnmounted, reactive, ref, watch } from 'vue';
import { ApiError, extractIssues, listLogs } from '../api/client';
import type { ListLogsParams, LogItem, LogStatus } from '../api/types';
import LogsTable from '../components/LogsTable.vue';

/**
 * Phase 4 Logs view: filter bar, request-log table with expandable rows,
 * "Load more" pagination and an opt-in 5s live poll.
 *
 * Pagination strategy: the endpoint has no cursor yet, so "Load more" lowers
 * `to` to (oldest requestedAt seen − 1s) and appends. Timestamps have
 * second granularity, so rows sharing that exact second after the window are
 * the only theoretical gap — acceptable until the API grows a real cursor.
 */

const LIVE_INTERVAL_MS = 5000;

const filters = reactive({
  model: '',
  client_id: '',
  provider: '',
  resolved_model: '',
  status: '' as '' | LogStatus,
  from: '',
  to: '',
  limit: '100',
});

const items = ref<LogItem[]>([]);
const loading = ref(false);
const loadingMore = ref(false);
const error = ref('');
const hasMore = ref(false);
const live = ref(false);

let liveTimer: number | null = null;

function formatError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const issues = extractIssues(err);
  if (issues.length === 0) return message;
  const details = issues
    .map((issue) => {
      const where = issue.path || issue.param || '';
      return where ? `${where}: ${issue.message}` : issue.message;
    })
    .join('; ');
  return `${message} (${details})`;
}

function buildParams(): ListLogsParams {
  const parsedLimit = Number(filters.limit);
  const params: ListLogsParams = {
    limit: Number.isInteger(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 500) : 100,
  };
  if (filters.model.trim()) params.model = filters.model.trim();
  if (filters.client_id.trim()) params.client_id = filters.client_id.trim();
  if (filters.provider.trim()) params.provider = filters.provider.trim();
  if (filters.resolved_model.trim()) params.resolved_model = filters.resolved_model.trim();
  if (filters.status) params.status = filters.status;
  if (filters.from) params.from = new Date(filters.from).toISOString();
  if (filters.to) params.to = new Date(filters.to).toISOString();
  return params;
}

function clearTimer(): void {
  if (liveTimer !== null) {
    window.clearInterval(liveTimer);
    liveTimer = null;
  }
}

function stopLive(): void {
  clearTimer();
  live.value = false;
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const page = await listLogs(buildParams());
    items.value = page.items;
    hasMore.value = page.hasMore;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) stopLive();
    items.value = [];
    hasMore.value = false;
    error.value = formatError(err);
  } finally {
    loading.value = false;
  }
}

async function loadMore(): Promise<void> {
  if (items.value.length === 0 || loadingMore.value) return;
  loadingMore.value = true;
  error.value = '';
  try {
    const oldest = items.value[items.value.length - 1].requestedAt;
    const params = buildParams();
    params.to = new Date((oldest - 1) * 1000).toISOString();
    const page = await listLogs(params);
    items.value = [...items.value, ...page.items];
    hasMore.value = page.hasMore;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) stopLive();
    error.value = formatError(err);
  } finally {
    loadingMore.value = false;
  }
}

function resetFilters(): void {
  filters.model = '';
  filters.client_id = '';
  filters.provider = '';
  filters.resolved_model = '';
  filters.status = '';
  filters.from = '';
  filters.to = '';
  filters.limit = '100';
  void load();
}

watch(live, (enabled) => {
  clearTimer();
  if (enabled) {
    liveTimer = window.setInterval(() => {
      if (!loading.value) void load();
    }, LIVE_INTERVAL_MS);
  }
});

onUnmounted(clearTimer);

void load();
</script>

<template>
  <div>
    <h1>Logs</h1>

    <form class="toolbar logs-toolbar" @submit.prevent="load">
      <div class="field">
        <label for="log-model">Model (alias)</label>
        <input id="log-model" v-model="filters.model" placeholder="code" />
      </div>
      <div class="field">
        <label for="log-client">Client id</label>
        <input id="log-client" v-model="filters.client_id" placeholder="tenant-acme" />
      </div>
      <div class="field">
        <label for="log-provider">Provider</label>
        <input id="log-provider" v-model="filters.provider" placeholder="nan" />
      </div>
      <div class="field">
        <label for="log-resolved">Resolved model</label>
        <input id="log-resolved" v-model="filters.resolved_model" placeholder="qwen" />
      </div>
      <div class="field">
        <label for="log-status">Status</label>
        <select id="log-status" v-model="filters.status">
          <option value="">any</option>
          <option value="ok">ok</option>
          <option value="error">error</option>
          <option value="circuit_open">circuit_open</option>
        </select>
      </div>
      <div class="field">
        <label for="log-from">From</label>
        <input id="log-from" v-model="filters.from" type="datetime-local" />
      </div>
      <div class="field">
        <label for="log-to">To</label>
        <input id="log-to" v-model="filters.to" type="datetime-local" />
      </div>
      <div class="field compact">
        <label for="log-limit">Limit</label>
        <input id="log-limit" v-model="filters.limit" type="number" min="1" max="500" />
      </div>
      <div class="field field-action">
        <button class="btn" type="submit" :disabled="loading">
          {{ loading ? 'Loading…' : 'Apply' }}
        </button>
        <button class="btn btn-ghost" type="button" @click="resetFilters">Reset</button>
      </div>
    </form>

    <label class="live-toggle">
      <input v-model="live" type="checkbox" />
      <span>Live (poll every 5s)</span>
    </label>

    <p v-if="error" class="error">{{ error }}</p>

    <LogsTable v-if="items.length > 0" :items="items" />
    <p v-else-if="!loading" class="muted">No data for this range.</p>

    <div v-if="items.length > 0" class="toolbar">
      <button
        class="btn btn-ghost"
        type="button"
        :disabled="!hasMore || loadingMore"
        @click="loadMore"
      >
        {{ loadingMore ? 'Loading…' : hasMore ? 'Load more' : 'No more rows' }}
      </button>
      <span class="muted">Showing {{ items.length }} rows</span>
    </div>
  </div>
</template>
