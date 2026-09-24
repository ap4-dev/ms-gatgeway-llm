<script setup lang="ts">
import type { SummaryTotals } from '../api/types';

/**
 * Totals cards for `GET /admin/stats/summary`. Kept dumb + reusable: it only
 * formats numbers, never fetches.
 */
defineProps<{ totals: SummaryTotals }>();

const fmt = (n: number): string => n.toLocaleString('en-US');

const cards = (totals: SummaryTotals): { label: string; value: string }[] => [
  { label: 'Requests', value: fmt(totals.requests) },
  { label: 'OK', value: fmt(totals.ok) },
  { label: 'Errors', value: fmt(totals.errors) },
  { label: 'Circuit open', value: fmt(totals.circuitOpen) },
  { label: 'Prompt tokens', value: fmt(totals.promptTokens) },
  { label: 'Completion tokens', value: fmt(totals.completionTokens) },
  { label: 'Total tokens', value: fmt(totals.totalTokens) },
  { label: 'Avg latency', value: `${fmt(totals.avgLatencyMs)} ms` },
];
</script>

<template>
  <div class="cards">
    <div v-for="card in cards(totals)" :key="card.label" class="card">
      <div class="label">{{ card.label }}</div>
      <div class="value">{{ card.value }}</div>
    </div>
  </div>
</template>
