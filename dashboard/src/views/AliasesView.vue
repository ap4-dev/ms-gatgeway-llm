<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import {
  ALIAS_STRATEGIES,
  ApiError,
  appendAliasEntry,
  createAlias,
  deleteAlias,
  extractIssues,
  listAliases,
  removeAliasEntry,
  setAliasPriorities,
  setAliasStrategy,
  setAliasWeights,
} from '../api/client';
import type { Alias, AliasStrategy } from '../api/types';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import type { ConfirmOptions } from '../components/ConfirmDialog.vue';

/**
 * Phase 5 Aliases view: full chain builder on top of the routing policy editor.
 *
 * Kept from Phase 4: per-alias strategy select (with confirm), weights editor and
 * sparse priorities editor, each with local dirty state cleared on `200`/`204`.
 * Added: create an alias with an ordered chain, append a `provider/model` entry,
 * remove one position (backend refuses to empty the chain with `400`) and delete
 * a whole alias. Every successful mutation re-reads `GET /admin/aliases`.
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

interface ChainRow {
  provider: string;
  model: string;
}

const aliases = ref<Alias[]>([]);
const loading = ref(false);
const loadError = ref('');
/** Edit buffers keyed by alias id (deep-reactive `ref` object). */
const edits = reactive<Record<string, EditState>>({});
/** Per-alias mutation errors for append/remove/delete, keyed by alias id. */
const aliasErrors = reactive<Record<string, string>>({});
/** Append-entry input buffers, keyed by alias id. */
const entryDrafts = reactive<Record<string, string>>({});
const busyAlias = ref<string | null>(null);

const newAlias = reactive({
  id: '',
  strategy: 'primary' as AliasStrategy,
  rows: [{ provider: '', model: '' }] as ChainRow[],
});
const creating = ref(false);
const createError = ref('');

const confirmRef = ref<{ confirm: (o: ConfirmOptions) => Promise<boolean> } | null>(null);

function askConfirm(options: ConfirmOptions): Promise<boolean> {
  return confirmRef.value?.confirm(options) ?? Promise.resolve(false);
}

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
      if (entryDrafts[alias.id] === undefined) entryDrafts[alias.id] = '';
    }
  } catch (err) {
    aliases.value = [];
    loadError.value = formatError(err);
  } finally {
    loading.value = false;
  }
}

// ── New alias chain builder ─────────────────────────────────────────────────

function addChainRow(): void {
  newAlias.rows.push({ provider: '', model: '' });
}

function removeChainRow(index: number): void {
  if (newAlias.rows.length <= 1) return;
  newAlias.rows.splice(index, 1);
}

function resetNewAlias(): void {
  newAlias.id = '';
  newAlias.strategy = 'primary';
  newAlias.rows = [{ provider: '', model: '' }];
}

async function submitCreateAlias(): Promise<void> {
  createError.value = '';
  const id = newAlias.id.trim();
  if (id.length === 0) {
    createError.value = 'Alias id is required.';
    return;
  }
  const chain = newAlias.rows
    .map((row) => ({ provider: row.provider.trim(), model: row.model.trim() }))
    .filter((row) => row.provider.length > 0 || row.model.length > 0);
  if (chain.length === 0) {
    createError.value = 'Add at least one provider/model entry to the chain.';
    return;
  }
  const incomplete = chain.find((row) => row.provider.length === 0 || row.model.length === 0);
  if (incomplete) {
    createError.value = 'Every chain entry needs both a provider and a model.';
    return;
  }

  creating.value = true;
  try {
    await createAlias({
      id,
      chain: chain.map((row) => `${row.provider}/${row.model}`),
      strategy: newAlias.strategy,
    });
    resetNewAlias();
    await load();
  } catch (err) {
    createError.value = formatError(err);
  } finally {
    creating.value = false;
  }
}

// ── Per-alias chain mutations ───────────────────────────────────────────────

async function onAppendEntry(alias: Alias): Promise<void> {
  const entry = (entryDrafts[alias.id] ?? '').trim();
  aliasErrors[alias.id] = '';
  if (entry.length === 0) {
    aliasErrors[alias.id] = 'Enter a provider/model entry to append.';
    return;
  }
  busyAlias.value = alias.id;
  try {
    await appendAliasEntry(alias.id, entry);
    entryDrafts[alias.id] = '';
    await load();
  } catch (err) {
    aliasErrors[alias.id] = formatError(err);
  } finally {
    busyAlias.value = null;
  }
}

async function onRemoveEntry(alias: Alias, position: number): Promise<void> {
  const ok = await askConfirm({
    title: 'Remove chain entry',
    message: `Remove entry ${position} ("${alias.chain[position]}") from alias "${alias.id}"?`,
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!ok) return;
  aliasErrors[alias.id] = '';
  busyAlias.value = alias.id;
  try {
    await removeAliasEntry(alias.id, position);
    await load();
  } catch (err) {
    // A 400 here means the chain would be emptied (last entry).
    const prefix = err instanceof ApiError && err.status === 400 ? 'cannot remove: ' : '';
    aliasErrors[alias.id] = `${prefix}${formatError(err)}`;
  } finally {
    busyAlias.value = null;
  }
}

async function onDeleteAlias(alias: Alias): Promise<void> {
  const ok = await askConfirm({
    title: 'Delete alias',
    message: `Delete alias "${alias.id}"? Its chain, strategy and weights are removed. This cannot be undone.`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  aliasErrors[alias.id] = '';
  busyAlias.value = alias.id;
  try {
    await deleteAlias(alias.id);
    await load();
  } catch (err) {
    aliasErrors[alias.id] = formatError(err);
  } finally {
    busyAlias.value = null;
  }
}

// ── Policy editors ──────────────────────────────────────────────────────────

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

    <section class="panel">
      <h2 class="section-title">New alias</h2>
      <form class="form-grid" @submit.prevent="submitCreateAlias">
        <div class="field">
          <label for="new-alias-id">Id</label>
          <input id="new-alias-id" v-model="newAlias.id" placeholder="coder" />
        </div>
        <div class="field">
          <label for="new-alias-strategy">Strategy</label>
          <select id="new-alias-strategy" v-model="newAlias.strategy">
            <option v-for="strategy in ALIAS_STRATEGIES" :key="strategy" :value="strategy">
              {{ strategy }}
            </option>
          </select>
        </div>
        <div class="field field-action">
          <button class="btn" type="submit" :disabled="creating">
            {{ creating ? 'Creating…' : 'Create alias' }}
          </button>
        </div>
      </form>

      <div class="chain-builder">
        <span class="chain-builder-label">Chain (in routing order)</span>
        <div v-for="(row, index) in newAlias.rows" :key="index" class="chain-builder-row">
          <span class="step-index">{{ index }}</span>
          <input
            v-model="row.provider"
            class="chain-input"
            :aria-label="`Provider for entry ${index}`"
            placeholder="provider"
          />
          <span class="chain-sep">/</span>
          <input
            v-model="row.model"
            class="chain-input"
            :aria-label="`Model for entry ${index}`"
            placeholder="model"
          />
          <button
            class="btn btn-sm btn-ghost"
            type="button"
            :disabled="newAlias.rows.length <= 1"
            @click="removeChainRow(index)"
          >
            Remove
          </button>
        </div>
        <button class="btn btn-sm btn-ghost" type="button" @click="addChainRow">
          Add entry
        </button>
      </div>
      <p v-if="createError" class="error">{{ createError }}</p>
    </section>

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
        <span class="spacer"></span>
        <button
          class="btn btn-sm btn-danger"
          type="button"
          :disabled="busyAlias === alias.id"
          @click="onDeleteAlias(alias)"
        >
          Delete alias
        </button>
      </div>

      <ol class="chain">
        <li v-for="(entry, position) in alias.chain" :key="position" class="chain-step">
          <span class="step-index" :title="`Position ${position}`">{{ position }}</span>
          <span class="priority-badge" :title="`Priority ${stateFor(alias).priorities[position]}`">
            P{{ stateFor(alias).priorities[position] }}
          </span>
          <span class="chain-provider">{{ entryParts(entry).provider }}</span>
          <span class="chain-sep">/</span>
          <span class="mono">{{ entryParts(entry).model }}</span>
          <input
            class="weight-inline"
            type="number"
            min="1"
            :value="stateFor(alias).weights[position]"
            :aria-label="`Weight for position ${position}`"
            @input="
              (event) => {
                stateFor(alias).weights[position] = Number(
                  (event.target as HTMLInputElement).value,
                );
                markWeightsDirty(alias);
              }
            "
          />
          <button
            class="btn btn-sm btn-danger"
            type="button"
            :disabled="busyAlias === alias.id"
            @click="onRemoveEntry(alias, position)"
          >
            Remove
          </button>
        </li>
      </ol>

      <div class="chain-actions">
        <button
          class="btn btn-sm"
          type="button"
          :disabled="stateFor(alias).status === 'saving' || !stateFor(alias).weightsDirty"
          @click="saveWeights(alias)"
        >
          Save weights
        </button>
        <form class="inline-form" @submit.prevent="onAppendEntry(alias)">
          <input
            v-model="entryDrafts[alias.id]"
            class="chain-input"
            :aria-label="`Append provider/model entry to ${alias.id}`"
            placeholder="provider/model"
          />
          <button
            class="btn btn-sm"
            type="submit"
            :disabled="busyAlias === alias.id"
          >
            {{ busyAlias === alias.id ? 'Working…' : 'Add model to chain' }}
          </button>
        </form>
      </div>

      <p v-if="aliasErrors[alias.id]" class="error">{{ aliasErrors[alias.id] }}</p>

      <div class="alias-grid">
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

    <ConfirmDialog ref="confirmRef" />
  </div>
</template>
