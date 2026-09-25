<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import {
  ApiError,
  createProvider,
  createProviderModel,
  deleteProvider,
  deleteProviderModel,
  extractIssues,
  listProviders,
  patchProvider,
  patchProviderModel,
} from '../api/client';
import type {
  CreateProviderModelPayload,
  CreateProviderPayload,
  PatchProviderModelPayload,
  PatchProviderPayload,
  ProviderModelView,
  ProviderView,
} from '../api/types';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import type { ConfirmOptions } from '../components/ConfirmDialog.vue';

/**
 * Phase 5 Providers view: full typed CRUD over `providers` and their models.
 *
 * Every mutation calls the matching `/admin/providers` endpoint and then re-reads
 * `GET /admin/providers`, so the table always reflects server state. Deletes are
 * guarded by a promise-based {@link ConfirmDialog} and surface the backend `409`
 * (provider/model still referenced by an alias chain) verbatim, prefixed with
 * `blocked:` so the operator sees exactly which aliases are in the way.
 */

const providers = ref<ProviderView[]>([]);
const loading = ref(false);
const loadError = ref('');

/** Provider id -> models visible. Defaults to expanded once a list arrives. */
const expanded = reactive<Record<string, boolean>>({});

const newProvider = reactive({
  id: '',
  apiKeyEnv: '',
  baseUrl: '',
  timeoutMs: '',
  supportsSearch: false,
});
const creating = ref(false);
const createError = ref('');

const editingProviderId = ref<string | null>(null);
const savingProviderId = ref<string | null>(null);
const providerForm = reactive({
  apiKeyEnv: '',
  baseUrl: '',
  timeoutMs: '',
  supportsSearch: false,
});
/** Per-provider error message, keyed by provider id. */
const providerErrors = reactive<Record<string, string>>({});

const addingModelFor = ref<string | null>(null);
const modelForm = reactive({
  modelKey: '',
  realName: '',
  maxTokens: '',
  supportsStream: true,
  disableThinking: false,
});
const savingNewModel = ref(false);
const modelAddError = ref('');

const editingModel = ref<{ providerId: string; modelKey: string } | null>(null);
const savingModelKey = ref<string | null>(null);
const modelEditForm = reactive({
  realName: '',
  maxTokens: '',
  supportsStream: true,
  disableThinking: false,
});
/** Per-model error message, keyed by `${providerId}/${modelKey}`. */
const modelErrors = reactive<Record<string, string>>({});

const confirmRef = ref<{ confirm: (o: ConfirmOptions) => Promise<boolean> } | null>(null);

function askConfirm(options: ConfirmOptions): Promise<boolean> {
  return confirmRef.value?.confirm(options) ?? Promise.resolve(false);
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

/** A `409` delete is expected when the entity still backs an alias chain. */
function conflictMessage(err: unknown): string | null {
  if (err instanceof ApiError && err.status === 409) {
    return `blocked: ${formatError(err)}`;
  }
  return null;
}

interface IntParse {
  value?: number;
  invalid: boolean;
}

function parseOptionalPositiveInt(raw: string): IntParse {
  const trimmed = raw.trim();
  if (trimmed === '') return { invalid: false };
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value <= 0) return { invalid: true };
  return { value, invalid: false };
}

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = '';
  try {
    const response = await listProviders();
    providers.value = response.providers;
    for (const provider of response.providers) {
      if (expanded[provider.id] === undefined) expanded[provider.id] = true;
    }
  } catch (err) {
    providers.value = [];
    loadError.value = formatError(err);
  } finally {
    loading.value = false;
  }
}

function toggleProvider(id: string): void {
  expanded[id] = !expanded[id];
}

function resetCreateForm(): void {
  newProvider.id = '';
  newProvider.apiKeyEnv = '';
  newProvider.baseUrl = '';
  newProvider.timeoutMs = '';
  newProvider.supportsSearch = false;
}

async function submitCreate(): Promise<void> {
  createError.value = '';
  const id = newProvider.id.trim();
  if (id.length === 0) {
    createError.value = 'Provider id is required.';
    return;
  }
  const apiKeyEnv = newProvider.apiKeyEnv.trim();
  if (apiKeyEnv.length === 0) {
    createError.value = 'apiKeyEnv is required (the env var NAME, not the key).';
    return;
  }
  const payload: CreateProviderPayload = { id, apiKeyEnv, supportsSearch: newProvider.supportsSearch };
  const baseUrl = newProvider.baseUrl.trim();
  if (baseUrl.length > 0) payload.baseUrl = baseUrl;
  const timeout = parseOptionalPositiveInt(newProvider.timeoutMs);
  if (timeout.invalid) {
    createError.value = 'Timeout must be a positive integer (ms).';
    return;
  }
  if (timeout.value !== undefined) payload.timeoutMs = timeout.value;

  creating.value = true;
  try {
    await createProvider(payload);
    resetCreateForm();
    expanded[id] = true;
    await load();
  } catch (err) {
    createError.value = formatError(err);
  } finally {
    creating.value = false;
  }
}

function startEditProvider(provider: ProviderView): void {
  editingProviderId.value = provider.id;
  providerErrors[provider.id] = '';
  providerForm.apiKeyEnv = provider.apiKeyEnv;
  providerForm.baseUrl = provider.baseUrl ?? '';
  providerForm.timeoutMs = provider.timeoutMs === null ? '' : String(provider.timeoutMs);
  providerForm.supportsSearch = provider.supportsSearch;
}

function cancelEditProvider(): void {
  editingProviderId.value = null;
}

async function saveProviderEdit(provider: ProviderView): Promise<void> {
  providerErrors[provider.id] = '';
  const apiKeyEnv = providerForm.apiKeyEnv.trim();
  if (apiKeyEnv.length === 0) {
    providerErrors[provider.id] = 'apiKeyEnv is required (the env var NAME, not the key).';
    return;
  }
  const patch: PatchProviderPayload = {
    apiKeyEnv,
    supportsSearch: providerForm.supportsSearch,
  };
  const baseUrl = providerForm.baseUrl.trim();
  if (baseUrl.length > 0) patch.baseUrl = baseUrl;
  const timeout = parseOptionalPositiveInt(providerForm.timeoutMs);
  if (timeout.invalid) {
    providerErrors[provider.id] = 'Timeout must be a positive integer (ms).';
    return;
  }
  if (timeout.value !== undefined) patch.timeoutMs = timeout.value;

  savingProviderId.value = provider.id;
  try {
    await patchProvider(provider.id, patch);
    editingProviderId.value = null;
    await load();
  } catch (err) {
    providerErrors[provider.id] = formatError(err);
  } finally {
    savingProviderId.value = null;
  }
}

async function onDeleteProvider(provider: ProviderView): Promise<void> {
  const ok = await askConfirm({
    title: 'Delete provider',
    message: `Delete provider \"${provider.id}\" and its ${provider.models.length} model(s)? This cannot be undone.`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  providerErrors[provider.id] = '';
  try {
    await deleteProvider(provider.id);
    delete expanded[provider.id];
    await load();
  } catch (err) {
    providerErrors[provider.id] = conflictMessage(err) ?? formatError(err);
  }
}

function startAddModel(providerId: string): void {
  addingModelFor.value = providerId;
  modelAddError.value = '';
  modelForm.modelKey = '';
  modelForm.realName = '';
  modelForm.maxTokens = '';
  modelForm.supportsStream = true;
  modelForm.disableThinking = false;
}

function cancelAddModel(): void {
  addingModelFor.value = null;
  modelAddError.value = '';
}

async function submitAddModel(providerId: string): Promise<void> {
  modelAddError.value = '';
  const modelKey = modelForm.modelKey.trim();
  if (modelKey.length === 0) {
    modelAddError.value = 'Model key is required.';
    return;
  }
  const realName = modelForm.realName.trim();
  if (realName.length === 0) {
    modelAddError.value = 'Real name is required.';
    return;
  }
  const payload: CreateProviderModelPayload = {
    modelKey,
    realName,
    supportsStream: modelForm.supportsStream,
    disableThinking: modelForm.disableThinking,
  };
  const maxTokens = parseOptionalPositiveInt(modelForm.maxTokens);
  if (maxTokens.invalid) {
    modelAddError.value = 'Max tokens must be a positive integer.';
    return;
  }
  if (maxTokens.value !== undefined) payload.maxTokens = maxTokens.value;

  savingNewModel.value = true;
  try {
    await createProviderModel(providerId, payload);
    cancelAddModel();
    await load();
  } catch (err) {
    modelAddError.value = formatError(err);
  } finally {
    savingNewModel.value = false;
  }
}

function modelKeyOf(providerId: string, modelKey: string): string {
  return `${providerId}/${modelKey}`;
}

function startEditModel(providerId: string, model: ProviderModelView): void {
  editingModel.value = { providerId, modelKey: model.modelKey };
  modelErrors[modelKeyOf(providerId, model.modelKey)] = '';
  modelEditForm.realName = model.realName;
  modelEditForm.maxTokens = model.maxTokens === null ? '' : String(model.maxTokens);
  modelEditForm.supportsStream = model.supportsStream;
  modelEditForm.disableThinking = model.disableThinking;
}

function cancelEditModel(): void {
  editingModel.value = null;
}

async function saveModelEdit(providerId: string, model: ProviderModelView): Promise<void> {
  const key = modelKeyOf(providerId, model.modelKey);
  modelErrors[key] = '';
  const realName = modelEditForm.realName.trim();
  if (realName.length === 0) {
    modelErrors[key] = 'Real name is required.';
    return;
  }
  const patch: PatchProviderModelPayload = {
    realName,
    supportsStream: modelEditForm.supportsStream,
    disableThinking: modelEditForm.disableThinking,
  };
  const maxTokens = parseOptionalPositiveInt(modelEditForm.maxTokens);
  if (maxTokens.invalid) {
    modelErrors[key] = 'Max tokens must be a positive integer.';
    return;
  }
  if (maxTokens.value !== undefined) patch.maxTokens = maxTokens.value;

  savingModelKey.value = key;
  try {
    await patchProviderModel(providerId, model.modelKey, patch);
    editingModel.value = null;
    await load();
  } catch (err) {
    modelErrors[key] = formatError(err);
  } finally {
    savingModelKey.value = null;
  }
}

async function onDeleteModel(providerId: string, model: ProviderModelView): Promise<void> {
  const key = modelKeyOf(providerId, model.modelKey);
  const ok = await askConfirm({
    title: 'Delete model',
    message: `Delete model \"${model.modelKey}\" from provider \"${providerId}\"? This cannot be undone.`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  modelErrors[key] = '';
  try {
    await deleteProviderModel(providerId, model.modelKey);
    await load();
  } catch (err) {
    modelErrors[key] = conflictMessage(err) ?? formatError(err);
  }
}

const totalModels = computed(() =>
  providers.value.reduce((sum, provider) => sum + provider.models.length, 0),
);

onMounted(() => {
  void load();
});
</script>

<template>
  <div>
    <h1>Providers</h1>

    <p class="notice">
      <code>apiKeyEnv</code> is the NAME of the environment variable holding the key —
      the gateway resolves it at runtime. A provider whose env var is absent is
      unreachable.
    </p>

    <section class="panel">
      <h2 class="section-title">New provider</h2>
      <form class="form-grid" @submit.prevent="submitCreate">
        <div class="field">
          <label for="new-provider-id">Id</label>
          <input id="new-provider-id" v-model="newProvider.id" placeholder="nan" />
        </div>
        <div class="field">
          <label for="new-provider-env">apiKeyEnv (env var NAME)</label>
          <input
            id="new-provider-env"
            v-model="newProvider.apiKeyEnv"
            placeholder="NAN_API_KEY"
          />
        </div>
        <div class="field">
          <label for="new-provider-base-url">Base URL (optional)</label>
          <input
            id="new-provider-base-url"
            v-model="newProvider.baseUrl"
            placeholder="https://api.example.com/v1"
          />
        </div>
        <div class="field">
          <label for="new-provider-timeout">Timeout ms (optional)</label>
          <input
            id="new-provider-timeout"
            v-model="newProvider.timeoutMs"
            inputmode="numeric"
            placeholder="180000"
          />
        </div>
        <div class="field checkbox-field">
          <label for="new-provider-search">
            <input id="new-provider-search" v-model="newProvider.supportsSearch" type="checkbox" />
            Supports search
          </label>
        </div>
        <div class="field field-action">
          <button class="btn" type="submit" :disabled="creating">
            {{ creating ? 'Creating…' : 'Add provider' }}
          </button>
        </div>
      </form>
      <p v-if="createError" class="error">{{ createError }}</p>
    </section>

    <div class="toolbar">
      <button class="btn btn-ghost" type="button" :disabled="loading" @click="load">
        {{ loading ? 'Loading…' : 'Reload' }}
      </button>
      <span class="muted">
        {{ providers.length }} provider(s) · {{ totalModels }} model(s)
      </span>
    </div>

    <p v-if="loadError" class="error">{{ loadError }}</p>
    <p v-else-if="loading" class="muted">Loading…</p>
    <p v-else-if="providers.length === 0" class="muted">No providers configured.</p>

    <template v-else>
      <section v-for="provider in providers" :key="provider.id" class="panel provider-card">
        <div class="provider-head">
          <span class="provider-id mono">{{ provider.id }}</span>
          <span class="muted">
            env: <span class="mono">{{ provider.apiKeyEnv }}</span>
          </span>
          <span class="muted">base_url: {{ provider.baseUrl ?? '—' }}</span>
          <span class="muted">
            timeout: {{ provider.timeoutMs === null ? '—' : `${provider.timeoutMs} ms` }}
          </span>
          <span :class="['badge', provider.supportsSearch ? 'badge-ok' : 'badge-warn']">
            {{ provider.supportsSearch ? 'search' : 'no search' }}
          </span>
          <span class="badge">{{ provider.models.length }} models</span>
          <span class="spacer"></span>
          <div class="actions">
            <button class="btn btn-sm btn-ghost" type="button" @click="toggleProvider(provider.id)">
              {{ expanded[provider.id] ? 'Hide models' : 'Show models' }}
            </button>
            <button
              class="btn btn-sm btn-ghost"
              type="button"
              @click="startEditProvider(provider)"
            >
              Edit
            </button>
            <button
              class="btn btn-sm btn-danger"
              type="button"
              @click="onDeleteProvider(provider)"
            >
              Delete
            </button>
          </div>
        </div>

        <p v-if="providerErrors[provider.id]" class="error">
          {{ providerErrors[provider.id] }}
        </p>

        <form
          v-if="editingProviderId === provider.id"
          class="form-grid inline-edit"
          @submit.prevent="saveProviderEdit(provider)"
        >
          <div class="field">
            <label :for="`edit-env-${provider.id}`">apiKeyEnv (env var NAME)</label>
            <input :id="`edit-env-${provider.id}`" v-model="providerForm.apiKeyEnv" />
          </div>
          <div class="field">
            <label :for="`edit-base-${provider.id}`">Base URL (blank keeps current)</label>
            <input :id="`edit-base-${provider.id}`" v-model="providerForm.baseUrl" />
          </div>
          <div class="field">
            <label :for="`edit-timeout-${provider.id}`">Timeout ms (blank keeps current)</label>
            <input
              :id="`edit-timeout-${provider.id}`"
              v-model="providerForm.timeoutMs"
              inputmode="numeric"
            />
          </div>
          <div class="field checkbox-field">
            <label :for="`edit-search-${provider.id}`">
              <input
                :id="`edit-search-${provider.id}`"
                v-model="providerForm.supportsSearch"
                type="checkbox"
              />
              Supports search
            </label>
          </div>
          <div class="field field-action">
            <button class="btn btn-sm" type="submit" :disabled="savingProviderId === provider.id">
              {{ savingProviderId === provider.id ? 'Saving…' : 'Save' }}
            </button>
            <button class="btn btn-sm btn-ghost" type="button" @click="cancelEditProvider">
              Cancel
            </button>
          </div>
        </form>

        <div v-if="expanded[provider.id]" class="provider-models">
          <table>
            <thead>
              <tr>
                <th>Model key</th>
                <th>Real name</th>
                <th>Max tokens</th>
                <th>Stream</th>
                <th>Thinking</th>
                <th>Used in aliases</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="model in provider.models" :key="model.modelKey">
                <tr>
                  <td class="mono">{{ model.modelKey }}</td>
                  <td>{{ model.realName }}</td>
                  <td>{{ model.maxTokens === null ? '—' : model.maxTokens.toLocaleString('en-US') }}</td>
                  <td>
                    <span :class="['badge', model.supportsStream ? 'badge-ok' : 'badge-warn']">
                      {{ model.supportsStream ? 'stream' : 'no stream' }}
                    </span>
                  </td>
                  <td>
                    <span :class="['badge', model.disableThinking ? 'badge-warn' : 'badge-ok']">
                      {{ model.disableThinking ? 'disabled' : 'enabled' }}
                    </span>
                  </td>
                  <td class="scopes">
                    <span v-if="model.usedInAliases.length === 0" class="muted">—</span>
                    <span v-for="alias in model.usedInAliases" :key="alias" class="tag">
                      {{ alias }}
                    </span>
                  </td>
                  <td class="actions">
                    <button
                      class="btn btn-sm btn-ghost"
                      type="button"
                      @click="startEditModel(provider.id, model)"
                    >
                      Edit
                    </button>
                    <button
                      class="btn btn-sm btn-danger"
                      type="button"
                      @click="onDeleteModel(provider.id, model)"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
                <tr
                  v-if="modelErrors[modelKeyOf(provider.id, model.modelKey)]"
                  class="edit-row"
                >
                  <td colspan="7">
                    <p class="error">
                      {{ modelErrors[modelKeyOf(provider.id, model.modelKey)] }}
                    </p>
                  </td>
                </tr>
                <tr
                  v-if="
                    editingModel &&
                    editingModel.providerId === provider.id &&
                    editingModel.modelKey === model.modelKey
                  "
                  class="edit-row"
                >
                  <td colspan="7">
                    <form class="form-grid" @submit.prevent="saveModelEdit(provider.id, model)">
                      <div class="field">
                        <label :for="`edit-realname-${provider.id}-${model.modelKey}`">Real name</label>
                        <input
                          :id="`edit-realname-${provider.id}-${model.modelKey}`"
                          v-model="modelEditForm.realName"
                        />
                      </div>
                      <div class="field">
                        <label :for="`edit-maxtokens-${provider.id}-${model.modelKey}`">
                          Max tokens (blank keeps current)
                        </label>
                        <input
                          :id="`edit-maxtokens-${provider.id}-${model.modelKey}`"
                          v-model="modelEditForm.maxTokens"
                          inputmode="numeric"
                        />
                      </div>
                      <div class="field checkbox-field">
                        <label :for="`edit-stream-${provider.id}-${model.modelKey}`">
                          <input
                            :id="`edit-stream-${provider.id}-${model.modelKey}`"
                            v-model="modelEditForm.supportsStream"
                            type="checkbox"
                          />
                          Supports stream
                        </label>
                      </div>
                      <div class="field checkbox-field">
                        <label :for="`edit-thinking-${provider.id}-${model.modelKey}`">
                          <input
                            :id="`edit-thinking-${provider.id}-${model.modelKey}`"
                            v-model="modelEditForm.disableThinking"
                            type="checkbox"
                          />
                          Disable thinking
                        </label>
                      </div>
                      <div class="field field-action">
                        <button
                          class="btn btn-sm"
                          type="submit"
                          :disabled="savingModelKey === modelKeyOf(provider.id, model.modelKey)"
                        >
                          {{ savingModelKey === modelKeyOf(provider.id, model.modelKey) ? 'Saving…' : 'Save' }}
                        </button>
                        <button class="btn btn-sm btn-ghost" type="button" @click="cancelEditModel">
                          Cancel
                        </button>
                      </div>
                    </form>
                  </td>
                </tr>
              </template>
              <tr v-if="provider.models.length === 0">
                <td colspan="7" class="muted">No models on this provider yet.</td>
              </tr>
            </tbody>
          </table>

          <div class="model-add">
            <button
              v-if="addingModelFor !== provider.id"
              class="btn btn-sm btn-ghost"
              type="button"
              @click="startAddModel(provider.id)"
            >
              Add model
            </button>
            <form
              v-else
              class="form-grid"
              @submit.prevent="submitAddModel(provider.id)"
            >
              <div class="field">
                <label :for="`new-model-key-${provider.id}`">Model key</label>
                <input :id="`new-model-key-${provider.id}`" v-model="modelForm.modelKey" />
              </div>
              <div class="field">
                <label :for="`new-model-realname-${provider.id}`">Real name</label>
                <input :id="`new-model-realname-${provider.id}`" v-model="modelForm.realName" />
              </div>
              <div class="field">
                <label :for="`new-model-maxtokens-${provider.id}`">Max tokens (optional)</label>
                <input
                  :id="`new-model-maxtokens-${provider.id}`"
                  v-model="modelForm.maxTokens"
                  inputmode="numeric"
                />
              </div>
              <div class="field checkbox-field">
                <label :for="`new-model-stream-${provider.id}`">
                  <input
                    :id="`new-model-stream-${provider.id}`"
                    v-model="modelForm.supportsStream"
                    type="checkbox"
                  />
                  Supports stream
                </label>
              </div>
              <div class="field checkbox-field">
                <label :for="`new-model-thinking-${provider.id}`">
                  <input
                    :id="`new-model-thinking-${provider.id}`"
                    v-model="modelForm.disableThinking"
                    type="checkbox"
                  />
                  Disable thinking
                </label>
              </div>
              <div class="field field-action">
                <button class="btn btn-sm" type="submit" :disabled="savingNewModel">
                  {{ savingNewModel ? 'Adding…' : 'Add' }}
                </button>
                <button class="btn btn-sm btn-ghost" type="button" @click="cancelAddModel">
                  Cancel
                </button>
              </div>
            </form>
            <p v-if="modelAddError" class="error">{{ modelAddError }}</p>
          </div>
        </div>
      </section>
    </template>

    <ConfirmDialog ref="confirmRef" />
  </div>
</template>
