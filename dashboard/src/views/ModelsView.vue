<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { listModels, runQuery } from '../api/client';
import type { ModelConfigRow, ModelListItem } from '../api/types';

/**
 * Phase 4 Models view — READ ONLY.
 *
 * Two independent reads:
 *   1. `GET /v1/models` — the aliases the gateway advertises publicly.
 *   2. `POST /admin/db/query` — a read-only join of `model_configs` against
 *      `providers`, because there are no typed CRUD endpoints for provider /
 *      model configuration yet (deferred; see the note in the UI).
 */
const MODEL_CONFIG_SQL = [
  'SELECT mc.provider_id, mc.model_key, mc.real_name, mc.max_tokens,',
  '       mc.supports_stream, mc.disable_thinking, p.base_url, p.timeout_ms',
  'FROM model_configs mc',
  'JOIN providers p ON p.id = mc.provider_id',
  'ORDER BY mc.provider_id, mc.model_key',
].join(' ');

const models = ref<ModelListItem[]>([]);
const modelsLoading = ref(false);
const modelsError = ref('');

const configRows = ref<ModelConfigRow[]>([]);
const configLoading = ref(false);
const configError = ref('');

interface ProviderGroup {
  id: string;
  baseUrl: string | null;
  timeoutMs: number | null;
  models: ModelConfigRow[];
}

/** Rows grouped by provider, preserving the SQL ordering. */
const providerGroups = computed<ProviderGroup[]>(() => {
  const groups = new Map<string, ProviderGroup>();
  for (const row of configRows.value) {
    let group = groups.get(row.provider_id);
    if (!group) {
      group = {
        id: row.provider_id,
        baseUrl: row.base_url,
        timeoutMs: row.timeout_ms,
        models: [],
      };
      groups.set(row.provider_id, group);
    }
    group.models.push(row);
  }
  return Array.from(groups.values());
});

const yesNo = (value: number | null): string => {
  if (value === null) return '—';
  return value === 1 ? 'yes' : 'no';
};

async function loadAliases(): Promise<void> {
  modelsLoading.value = true;
  modelsError.value = '';
  try {
    const response = await listModels();
    models.value = response.data;
  } catch (err) {
    models.value = [];
    modelsError.value = err instanceof Error ? err.message : String(err);
  } finally {
    modelsLoading.value = false;
  }
}

async function loadConfig(): Promise<void> {
  configLoading.value = true;
  configError.value = '';
  try {
    const response = await runQuery(MODEL_CONFIG_SQL);
    if (response.error) {
      configRows.value = [];
      configError.value = response.error;
      return;
    }
    configRows.value = response.rows as unknown as ModelConfigRow[];
  } catch (err) {
    configRows.value = [];
    configError.value = err instanceof Error ? err.message : String(err);
  } finally {
    configLoading.value = false;
  }
}

function reload(): void {
  void loadAliases();
  void loadConfig();
}

onMounted(reload);
</script>

<template>
  <div>
    <h1>Models</h1>

    <p class="notice">
      Read-only in this phase. Model and provider editing will ship through typed
      admin endpoints later; this page reads the current configuration directly.
    </p>

    <div class="toolbar">
      <button class="btn btn-ghost" type="button" @click="reload">Reload</button>
    </div>

    <section class="panel">
      <h2 class="section-title">Advertised models</h2>
      <p class="muted">
        Aliases exposed by <code>GET /v1/models</code>. The gateway never
        advertises upstream model ids.
      </p>

      <p v-if="modelsError" class="error">{{ modelsError }}</p>
      <p v-else-if="modelsLoading" class="muted">Loading…</p>

      <table v-else>
        <thead>
          <tr>
            <th>Alias</th>
            <th>Owned by</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="model in models" :key="model.id">
            <td>{{ model.id }}</td>
            <td>{{ model.owned_by }}</td>
            <td>{{ new Date(model.created * 1000).toLocaleString() }}</td>
          </tr>
          <tr v-if="models.length === 0">
            <td colspan="3" class="muted">
              No advertised models. A provider is missing its API key env var, or
              no alias resolves.
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="panel">
      <h2 class="section-title">Configured providers &amp; models</h2>
      <p class="muted">
        Joined <code>model_configs</code> × <code>providers</code> from the
        gateway database.
      </p>

      <p v-if="configError" class="error">{{ configError }}</p>
      <p v-else-if="configLoading" class="muted">Loading…</p>

      <template v-else>
        <div
          v-for="group in providerGroups"
          :key="group.id"
          class="provider-block"
        >
          <div class="provider-head">
            <span class="provider-id">{{ group.id }}</span>
            <span class="muted">
              base_url: {{ group.baseUrl ?? '—' }} · timeout:
              {{ group.timeoutMs === null ? '—' : `${group.timeoutMs} ms` }}
            </span>
          </div>

          <table>
            <thead>
              <tr>
                <th>Model key</th>
                <th>Real name</th>
                <th>Max tokens</th>
                <th>Stream</th>
                <th>Thinking disabled</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="model in group.models" :key="`${group.id}/${model.model_key}`">
                <td>{{ model.model_key }}</td>
                <td>{{ model.real_name ?? '—' }}</td>
                <td>{{ model.max_tokens === null ? '—' : model.max_tokens.toLocaleString('en-US') }}</td>
                <td>{{ yesNo(model.supports_stream) }}</td>
                <td>{{ yesNo(model.disable_thinking) }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <p v-if="providerGroups.length === 0" class="muted">
          No provider or model configuration found.
        </p>
      </template>
    </section>
  </div>
</template>
