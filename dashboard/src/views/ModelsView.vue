<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { listAliases, listModels, listProviders } from '../api/client';
import type { Alias, ProviderModelView, ProviderView } from '../api/types';

/**
 * Read-only model catalog: how each alias resolves to a concrete
 * `provider/model`, and which aliases the gateway advertises publicly.
 *
 * Provider/model CRUD lives in the Providers view now; this page is the
 * cross-reference an operator uses to sanity-check routing before editing a
 * chain. It composes three read endpoints: `GET /v1/models` (advertised aliases),
 * `GET /admin/aliases` (chains + policy) and `GET /admin/providers` (real model
 * names / flags).
 */

const aliases = ref<Alias[]>([]);
const providers = ref<ProviderView[]>([]);
const advertisedIds = ref<Set<string>>(new Set());
const loading = ref(false);
const loadError = ref('');

interface ResolvedEntry {
  position: number;
  entry: string;
  provider: string;
  modelKey: string;
  model: ProviderModelView | null;
}

interface AliasRow {
  alias: Alias;
  advertised: boolean;
  entries: ResolvedEntry[];
}

/** Flat `${providerId}/${modelKey}` -> model lookup built from the provider list. */
const modelIndex = computed<Map<string, ProviderModelView>>(() => {
  const index = new Map<string, ProviderModelView>();
  for (const provider of providers.value) {
    for (const model of provider.models) {
      index.set(`${provider.id}/${model.modelKey}`, model);
    }
  }
  return index;
});

const rows = computed<AliasRow[]>(() => {
  const index = modelIndex.value;
  return aliases.value.map((alias) => ({
    alias,
    advertised: advertisedIds.value.has(alias.id),
    entries: alias.chain.map((entry, position) => {
      const slash = entry.indexOf('/');
      const provider = slash === -1 ? entry : entry.slice(0, slash);
      const modelKey = slash === -1 ? '' : entry.slice(slash + 1);
      return {
        position,
        entry,
        provider,
        modelKey,
        model: index.get(entry) ?? null,
      };
    }),
  }));
});

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = '';
  try {
    const [aliasesResponse, modelsResponse, providersResponse] = await Promise.all([
      listAliases(),
      listModels(),
      listProviders(),
    ]);
    aliases.value = aliasesResponse.aliases;
    advertisedIds.value = new Set(modelsResponse.data.map((model) => model.id));
    providers.value = providersResponse.providers;
  } catch (err) {
    aliases.value = [];
    providers.value = [];
    advertisedIds.value = new Set();
    loadError.value = err instanceof Error ? err.message : String(err);
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
    <h1>Model catalog</h1>

    <p class="notice">
      Read-only resolution of each alias chain to its configured
      <code>provider/model</code>. Provider and model editing lives in the
      Providers view.
    </p>

    <div class="toolbar">
      <button class="btn btn-ghost" type="button" :disabled="loading" @click="load">
        {{ loading ? 'Loading…' : 'Reload' }}
      </button>
      <span class="muted">{{ rows.length }} alias(es)</span>
    </div>

    <p v-if="loadError" class="error">{{ loadError }}</p>
    <p v-else-if="loading" class="muted">Loading…</p>
    <p v-else-if="rows.length === 0" class="muted">
      No aliases configured. A provider is missing its API key env var, or no alias
      resolves.
    </p>

    <section v-for="row in rows" :key="row.alias.id" class="panel alias-panel">
      <div class="alias-head">
        <h2 class="section-title mono">{{ row.alias.id }}</h2>
        <span class="badge">{{ row.alias.strategy }}</span>
        <span :class="['badge', row.advertised ? 'badge-ok' : 'badge-warn']">
          {{ row.advertised ? 'advertised' : 'not advertised' }}
        </span>
      </div>

      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Provider</th>
            <th>Model key</th>
            <th>Real name</th>
            <th>Max tokens</th>
            <th>Stream</th>
            <th>Thinking</th>
            <th>Priority</th>
            <th>Weight</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="entry in row.entries" :key="entry.position">
            <td>{{ entry.position }}</td>
            <td class="mono">{{ entry.provider }}</td>
            <td class="mono">{{ entry.modelKey }}</td>
            <td v-if="entry.model">{{ entry.model.realName }}</td>
            <td v-else class="muted">unresolved</td>
            <td>{{ entry.model?.maxTokens === null || entry.model?.maxTokens === undefined ? '—' : entry.model.maxTokens.toLocaleString('en-US') }}</td>
            <td>
              <span
                v-if="entry.model"
                :class="['badge', entry.model.supportsStream ? 'badge-ok' : 'badge-warn']"
              >
                {{ entry.model.supportsStream ? 'yes' : 'no' }}
              </span>
              <span v-else class="muted">—</span>
            </td>
            <td>
              <span
                v-if="entry.model"
                :class="['badge', entry.model.disableThinking ? 'badge-warn' : 'badge-ok']"
              >
                {{ entry.model.disableThinking ? 'disabled' : 'enabled' }}
              </span>
              <span v-else class="muted">—</span>
            </td>
            <td>{{ row.alias.priorities[entry.position] ?? 0 }}</td>
            <td>{{ row.alias.weights[entry.position] ?? 1 }}</td>
          </tr>
        </tbody>
      </table>
    </section>
  </div>
</template>
