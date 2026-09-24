<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { getSummary, type SummaryResponse } from '../api/client';
import StatsCards from '../components/StatsCards.vue';

/** `datetime-local` wants `YYYY-MM-DDTHH:mm` in the operator's local time. */
function toLocalInput(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

const now = new Date();
const from = ref(toLocalInput(new Date(now.getTime() - 24 * 60 * 60 * 1000)));
const to = ref(toLocalInput(now));

const loading = ref(false);
const error = ref('');
const summary = ref<SummaryResponse | null>(null);

const fmt = (n: number): string => n.toLocaleString('en-US');

/** Errors / requests as a one-decimal percentage (0 when there is no traffic). */
function errorRate(requests: number, errors: number): string {
  if (requests <= 0) return '0.0%';
  return `${((errors / requests) * 100).toFixed(1)}%`;
}

/** Column height shared by every day bar, relative to the busiest day. */
const maxDayRequests = computed(() => {
  const days = summary.value?.byDay ?? [];
  return days.reduce((max, d) => Math.max(max, d.requests), 0);
});

function barHeight(requests: number): string {
  const max = maxDayRequests.value;
  if (max <= 0) return '0%';
  return `${Math.max(2, Math.round((requests / max) * 100))}%`;
}

/** `2026-09-21` -> `09-21` to keep the axis compact. */
function shortDay(day: string): string {
  return day.length >= 10 ? day.slice(5) : day;
}

const rangeLabel = computed(() => {
  const current = summary.value;
  if (!current) return '';
  const format = (unixSeconds: number): string =>
    new Date(unixSeconds * 1000).toLocaleString();
  return `${format(current.from)} → ${format(current.to)}`;
});

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    summary.value = await getSummary({
      from: new Date(from.value).toISOString(),
      to: new Date(to.value).toISOString(),
    });
  } catch (err) {
    summary.value = null;
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div>
    <h1>Overview</h1>

    <div class="toolbar">
      <div class="field">
        <label for="from">From</label>
        <input id="from" v-model="from" type="datetime-local" />
      </div>
      <div class="field">
        <label for="to">To</label>
        <input id="to" v-model="to" type="datetime-local" />
      </div>
      <button class="btn" type="button" :disabled="loading" @click="load">
        {{ loading ? 'Loading…' : 'Load' }}
      </button>
    </div>

    <p v-if="error" class="error">{{ error }}</p>

    <template v-if="summary">
      <p class="muted">{{ rangeLabel }}</p>

      <StatsCards :totals="summary.totals" />

      <h2>Requests by day</h2>
      <div v-if="summary.byDay.length > 0" class="chart">
        <div
          v-for="row in summary.byDay"
          :key="row.day"
          class="chart-col"
          :title="`${row.day}: ${fmt(row.requests)} requests`"
        >
          <div class="chart-bar" :style="{ height: barHeight(row.requests) }"></div>
          <span class="chart-label">{{ shortDay(row.day) }}</span>
        </div>
      </div>
      <p v-else class="muted">No data for this range.</p>

      <h2>By model</h2>
      <table>
        <thead>
          <tr>
            <th>Model</th>
            <th>Requests</th>
            <th>OK</th>
            <th>Errors</th>
            <th>Error rate</th>
            <th>Circuit open</th>
            <th>Total tokens</th>
            <th>Avg latency</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in summary.byModel" :key="row.model">
            <td>{{ row.model }}</td>
            <td>{{ fmt(row.requests) }}</td>
            <td>{{ fmt(row.ok) }}</td>
            <td>{{ fmt(row.errors) }}</td>
            <td>{{ errorRate(row.requests, row.errors) }}</td>
            <td>{{ fmt(row.circuitOpen) }}</td>
            <td>{{ fmt(row.totalTokens) }}</td>
            <td>{{ fmt(row.avgLatencyMs) }} ms</td>
          </tr>
          <tr v-if="summary.byModel.length === 0">
            <td colspan="8" class="muted">No data for this range.</td>
          </tr>
        </tbody>
      </table>

      <h2>By client</h2>
      <table>
        <thead>
          <tr>
            <th>Client</th>
            <th>Requests</th>
            <th>OK</th>
            <th>Errors</th>
            <th>Error rate</th>
            <th>Circuit open</th>
            <th>Total tokens</th>
            <th>Avg latency</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, index) in summary.byClient" :key="`${row.client ?? 'none'}-${index}`">
            <td>{{ row.client ?? '—' }}</td>
            <td>{{ fmt(row.requests) }}</td>
            <td>{{ fmt(row.ok) }}</td>
            <td>{{ fmt(row.errors) }}</td>
            <td>{{ errorRate(row.requests, row.errors) }}</td>
            <td>{{ fmt(row.circuitOpen) }}</td>
            <td>{{ fmt(row.totalTokens) }}</td>
            <td>{{ fmt(row.avgLatencyMs) }} ms</td>
          </tr>
          <tr v-if="summary.byClient.length === 0">
            <td colspan="8" class="muted">No data for this range.</td>
          </tr>
        </tbody>
      </table>

      <h2>By day</h2>
      <table>
        <thead>
          <tr>
            <th>Day</th>
            <th>Requests</th>
            <th>OK</th>
            <th>Errors</th>
            <th>Error rate</th>
            <th>Circuit open</th>
            <th>Total tokens</th>
            <th>Avg latency</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in summary.byDay" :key="row.day">
            <td>{{ row.day }}</td>
            <td>{{ fmt(row.requests) }}</td>
            <td>{{ fmt(row.ok) }}</td>
            <td>{{ fmt(row.errors) }}</td>
            <td>{{ errorRate(row.requests, row.errors) }}</td>
            <td>{{ fmt(row.circuitOpen) }}</td>
            <td>{{ fmt(row.totalTokens) }}</td>
            <td>{{ fmt(row.avgLatencyMs) }} ms</td>
          </tr>
          <tr v-if="summary.byDay.length === 0">
            <td colspan="8" class="muted">No data for this range.</td>
          </tr>
        </tbody>
      </table>
    </template>
  </div>
</template>
