<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import {
  ALIAS_STRATEGIES,
  extractIssues,
  listAliases,
  setAliasPriorities,
  setAliasStrategy,
  setAliasWeights,
} from '../api/client';
import type { Alias, AliasStrategy } from '../api/types';

/**
 * Phase 4 Aliases view: per-alias routing policy editing.
 *
 * Each alias keeps local edit state (weights / priorities) so the operator can
 * stage changes and submit them explicitly. A `204` from the gateway clears the
 * dirty flag; a `400` surfaces the zod issues returned by the controller.
 */

type ActionStatus = 'idle' | 'saving' | 'saved' | 'error';

interface EditState {
  weights: number[];
  priorities: number[];
  weightsDirty: boolean;
  prioritiesDirty: boolean;
  status: ActionStatus;
  message: string;
}

const aliases = ref<Alias[]>([]);
const loading = ref(false);
const loadError = ref('');
/** Edit buffers keyed by alias id (deep-reactive `ref` object). */
const edits = reactive<Record<string, EditState>>({});

function buildState(alias: Alias): EditState {
  return {
    weights: [...alias.weights],
    priorities: [...alias.priorities],
    weightsDirty: false,
    prioritiesDirty: false,
    status: 'idle',
    message: '',
  };
}

function stateFor(alias: Alias): EditState {
  const existing = edits[alias.id];
  if (existing) return existing;
  const created = buildState(alias);
  edits[alias.id] = created;
  return created;
}

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

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = '';
  try {
    const response = await listAliases();
    aliases.value = response.aliases;
    for (const alias of response.aliases) {
      edits[alias.id] = buildState(alias);
    }
  } catch (err) {
    aliases.value = [];
    loadError.value = formatError(err);
  } finally {
    loading.value = false;
  }
}

async function onStrategyChange(alias: Alias, event: Event): Promise<void> {
  const select = event.target as HTMLSelectElement;
  const next = select.value as AliasStrategy;
  const state = stateFor(alias);
  const previous = alias.strategy;
  if (next === previous) return;
  if (
    !window.confirm(
      `Change strategy for "${alias.id}" from "${previous}" to "${next}"?`,
    )
  ) {
    select.value = previous;
    return;
  }
  state.status = 'saving';
  state.message = '';
  try {
    await setAliasStrategy(alias.id, next);
    alias.strategy = next;
    state.status = 'saved';
    state.message = `Strategy set to "${next}".`;
  } catch (err) {
    select.value = previous;
    state.status = 'error';
    state.message = formatError(err);
  }
}

function markWeightsDirty(alias: Alias): void {
  const state = stateFor(alias);
  state.weightsDirty = true;
  state.status = 'idle';
  state.message = '';
}

function markPrioritiesDirty(alias: Alias): void {
  const state = stateFor(alias);
  state.prioritiesDirty = true;
  state.status = 'idle';
  state.message = '';
}

async function saveWeights(alias: Alias): Promise<void> {
  const state = stateFor(alias);
  if (state.weights.length !== alias.chain.length) {
    state.status = 'error';
    state.message = `Weights must have ${alias.chain.length} values (got ${state.weights.length}).`;
    return;
  }
  if (state.weights.some((weight) => !Number.isInteger(weight) || weight <= 0)) {
    state.status = 'error';
    state.message = 'Every weight must be a positive integer.';
    return;
  }
  state.status = 'saving';
  state.message = '';
  try {
    await setAliasWeights(alias.id, [...state.weights]);
    alias.weights = [...state.weights];
    state.weightsDirty = false;
    state.status = 'saved';
    state.message = 'Weights saved.';
  } catch (err) {
    state.status = 'error';
    state.message = formatError(err);
  }
}

async function savePriorities(alias: Alias): Promise<void> {
  const state = stateFor(alias);
  const sparse: Record<number, number> = {};
  state.priorities.forEach((priority, position) => {
    if (priority !== alias.priorities[position]) sparse[position] = priority;
  });
  if (Object.keys(sparse).length === 0) {
    state.prioritiesDirty = false;
    state.status = 'idle';
    state.message = 'No priority changes to save.';
    return;
  }
  if (state.priorities.some((priority) => !Number.isInteger(priority) || priority < 0)) {
    state.status = 'error';
    state.message = 'Every priority must be a non-negative integer.';
    return;
  }
  state.status = 'saving';
  state.message = '';
  try {
    await setAliasPriorities(alias.id, sparse);
    alias.priorities = [...state.priorities];
    state.prioritiesDirty = false;
    state.status = 'saved';
    state.message = 'Priorities saved.';
  } catch (err) {
    state.status = 'error';
    state.message = formatError(err);
  }
}

function entryParts(entry: string): { provider: string; model: string } {
  const slash = entry.indexOf('/');
  if (slash === -1) return { provider: entry, model: '' };
  return { provider: entry.slice(0, slash), model: entry.slice(slash + 1) };
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div>
    <h1>Aliases</h1>

    <div class="toolbar">
      <button class="btn btn-ghost" type="button" :disabled="loading" @click="load">
        {{ loading ? 'Loading…' : 'Reload' }}
      </button>
    </div>

    <p v-if="loadError" class="error">{{ loadError }}</p>
    <p v-else-if="loading" class="muted">Loading…</p>
    <p v-else-if="aliases.length === 0" class="muted">No aliases configured.</p>

    <section v-for="alias in aliases" :key="alias.id" class="panel alias-panel">
      <div class="alias-head">
        <h2 class="section-title mono">{{ alias.id }}</h2>
        <div class="field">
          <label :for="`strategy-${alias.id}`">Strategy</label>
          <select
            :id="`strategy-${alias.id}`"
            :value="alias.strategy"
            @change="onStrategyChange(alias, $event)"
          >
            <option v-for="strategy in ALIAS_STRATEGIES" :key="strategy" :value="strategy">
              {{ strategy }}
            </option>
          </select>
        </div>
      </div>

      <ol class="chain">
        <li v-for="(entry, position) in alias.chain" :key="position" class="chain-step">
          <span class="priority-badge" :title="`Priority ${stateFor(alias).priorities[position]}`">
            #{{ stateFor(alias).priorities[position] }}
          </span>
          <span class="chain-provider">{{ entryParts(entry).provider }}</span>
          <span class="chain-sep">/</span>
          <span class="mono">{{ entryParts(entry).model }}</span>
        </li>
      </ol>

      <div class="alias-grid">
        <div class="alias-block">
          <h3>Weights</h3>
          <div class="inline-inputs">
            <div v-for="(_, position) in alias.chain" :key="`w-${position}`" class="field compact">
              <label :for="`weight-${alias.id}-${position}`">#{{ position }}</label>
              <input
                :id="`weight-${alias.id}-${position}`"
                v-model.number="stateFor(alias).weights[position]"
                type="number"
                min="1"
                @input="markWeightsDirty(alias)"
              />
            </div>
          </div>
          <button
            class="btn btn-sm"
            type="button"
            :disabled="stateFor(alias).status === 'saving' || !stateFor(alias).weightsDirty"
            @click="saveWeights(alias)"
          >
            Save weights
          </button>
        </div>

        <div class="alias-block">
          <h3>Priorities</h3>
          <div class="inline-inputs">
            <div v-for="(_, position) in alias.chain" :key="`p-${position}`" class="field compact">
              <label :for="`priority-${alias.id}-${position}`">#{{ position }}</label>
              <input
                :id="`priority-${alias.id}-${position}`"
                v-model.number="stateFor(alias).priorities[position]"
                type="number"
                min="0"
                @input="markPrioritiesDirty(alias)"
              />
            </div>
          </div>
          <button
            class="btn btn-sm"
            type="button"
            :disabled="stateFor(alias).status === 'saving' || !stateFor(alias).prioritiesDirty"
            @click="savePriorities(alias)"
          >
            Save priorities
          </button>
        </div>
      </div>

      <p v-if="stateFor(alias).message" :class="stateFor(alias).status === 'error' ? 'error' : 'success'">
        {{ stateFor(alias).message }}
      </p>
    </section>
  </div>
</template>
