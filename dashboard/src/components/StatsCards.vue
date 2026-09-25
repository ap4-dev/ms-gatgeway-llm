<script setup lang="ts">
import type { SummaryTotals } from '../api/types';

/**
 * Totals cards for `GET /admin/stats/summary`. Kept dumb + reusable: it only
 * formats numbers, never fetches.
 */
defineProps<{ totals: SummaryTotals }>();

const fmt = (n: number): string => n.toLocaleString('en-US');

const formatCompact = (n: number | null | undefined): string => {
  if (n == null || Number.isNaN(n)) return '-';
  if (n >= 1_000_000) return `${+(n / 1e6).toFixed(1)}M`;
  if (n >= 1_000) return `${+(n / 1e3).toFixed(1)}K`;
  return String(n);
};

const cards = (totals: SummaryTotals): { label: string; value: string; title: string }[] => [
  { label: 'Requests', value: formatCompact(totals.requests), title: fmt(totals.requests) },
  { label: 'OK', value: formatCompact(totals.ok), title: fmt(totals.ok) },
  { label: 'Errors', value: formatCompact(totals.errors), title: fmt(totals.errors) },
  { label: 'Circuit open', value: formatCompact(totals.circuitOpen), title: fmt(totals.circuitOpen) },
  { label: 'Prompt tokens', value: formatCompact(totals.promptTokens), title: fmt(totals.promptTokens) },
  { label: 'Completion tokens', value: formatCompact(totals.completionTokens), title: fmt(totals.completionTokens) },
  { label: 'Total tokens', value: formatCompact(totals.totalTokens), title: fmt(totals.totalTokens) },
  { label: 'Avg latency', value: `${formatCompact(totals.avgLatencyMs)} ms`, title: `${fmt(totals.avgLatencyMs)} ms` },
];
</script>

<template>
  <div class="cards">
    <div v-for="card in cards(totals)" :key="card.label" class="card">
      <div class="label">{{ card.label }}</div>
      <div class="value" :title="card.title">{{ card.value }}</div>
    </div>
  </div>
</template>
