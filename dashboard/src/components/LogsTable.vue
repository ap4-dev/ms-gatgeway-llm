<script setup lang="ts">
import { ref } from 'vue';
import { parseJsonField } from '../api/client';
import type { LogItem } from '../api/types';

/**
 * Request-log table with click-to-expand detail rows.
 *
 * `attemptDetails` / `requestParams` arrive as JSON *strings* (SQLite TEXT
 * columns); both are parsed defensively so a malformed payload degrades to the
 * raw string instead of breaking the render.
 *
 * Rows are index-keyed because `GET /admin/logs` does not expose a stable row
 * id. That is safe here: the list is replaced wholesale on refresh and rows are
 * never reordered without a reload.
 */
defineProps<{ items: LogItem[] }>();

const expanded = ref<number | null>(null);

function toggle(index: number): void {
  expanded.value = expanded.value === index ? null : index;
}

interface AttemptDetail {
  providerId?: string;
  upstreamModel?: string;
  ok?: boolean;
  circuitOpen?: boolean;
  durationMs?: number;
  error?: string;
}

function attemptDetails(item: LogItem): AttemptDetail[] {
  const parsed = parseJsonField(item.attemptDetails);
  return Array.isArray(parsed) ? (parsed as AttemptDetail[]) : [];
}

function prettyJson(value: string | null | undefined): string {
  const parsed = parseJsonField(value);
  if (parsed === null) return '';
  if (typeof parsed === 'string') return parsed;
  return JSON.stringify(parsed, null, 2);
}

function formatTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString();
}

function statusClass(status: LogItem['status']): string {
  if (status === 'ok') return 'badge badge-ok';
  if (status === 'error') return 'badge badge-error';
  return 'badge badge-warn';
}
</script>

<template>
  <table class="logs-table">
    <thead>
      <tr>
        <th>Time</th>
        <th>Status</th>
        <th>Model</th>
        <th>Provider</th>
        <th>Attempts</th>
        <th>Latency</th>
        <th>Tokens</th>
        <th>Client</th>
        <th>Prompt hash</th>
      </tr>
    </thead>
    <tbody>
      <template v-for="(item, index) in items" :key="index">
        <tr class="clickable" @click="toggle(index)">
          <td>{{ formatTime(item.requestedAt) }}</td>
          <td>
            <span :class="statusClass(item.status)">{{ item.status }}</span>
          </td>
          <td>
            {{ item.modelRequested }}
            <template v-if="item.resolvedModel">
              <span class="muted"> → {{ item.resolvedModel }}</span>
            </template>
          </td>
          <td>{{ item.resolvedProvider ?? '—' }}</td>
          <td>{{ item.attempts }}</td>
          <td>{{ item.latencyMs.toLocaleString('en-US') }} ms</td>
          <td>{{ item.totalTokens === null ? '—' : item.totalTokens.toLocaleString('en-US') }}</td>
          <td>{{ item.clientKey ?? '—' }}</td>
          <td class="mono">{{ item.promptHash ?? '—' }}</td>
        </tr>
        <tr v-if="expanded === index" class="detail-row">
          <td colspan="9">
            <p v-if="item.error" class="error">{{ item.error }}</p>

            <template v-if="attemptDetails(item).length > 0">
              <h3>Attempts</h3>
              <table class="detail-table">
                <thead>
                  <tr>
                    <th>Provider</th>
                    <th>Upstream model</th>
                    <th>OK</th>
                    <th>Circuit open</th>
                    <th>Duration</th>
                    <th>Error</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(attempt, attemptIndex) in attemptDetails(item)" :key="attemptIndex">
                    <td>{{ attempt.providerId ?? '—' }}</td>
                    <td>{{ attempt.upstreamModel ?? '—' }}</td>
                    <td>{{ attempt.ok === undefined ? '—' : attempt.ok ? 'yes' : 'no' }}</td>
                    <td>{{ attempt.circuitOpen === undefined ? '—' : attempt.circuitOpen ? 'yes' : 'no' }}</td>
                    <td>{{ attempt.durationMs === undefined ? '—' : `${attempt.durationMs} ms` }}</td>
                    <td>{{ attempt.error ?? '—' }}</td>
                  </tr>
                </tbody>
              </table>
            </template>

            <template v-if="prettyJson(item.requestParams).length > 0">
              <h3>Request params</h3>
              <pre class="pre">{{ prettyJson(item.requestParams) }}</pre>
            </template>

            <p
              v-if="!item.error && attemptDetails(item).length === 0 && prettyJson(item.requestParams).length === 0"
              class="muted"
            >
              No extra detail for this row.
            </p>
          </td>
        </tr>
      </template>
    </tbody>
  </table>
</template>
