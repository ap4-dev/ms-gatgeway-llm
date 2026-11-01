<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import {
  ApiError,
  deleteClientQuota,
  extractIssues,
  listAliases,
  listClientQuotas,
  listClients,
  putClientQuotas,
} from '../api/client';
import type {
  Alias,
  Client,
  ClientQuota,
  ClientQuotaEntry,
  ClientQuotasResponse,
} from '../api/client';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import type { ConfirmOptions } from '../components/ConfirmDialog.vue';

/**
 * Operator surface for the monthly token quotas (feature: cuotas mensuales,
 * T8). One `(client, alias)` allowance = a row; **no row means unlimited**.
 *
 * Every read goes through `GET /admin/clients/:id/quotas`, which joins the
 * stored allowance with the usage of the UTC month in progress, so this view
 * never computes a counter itself. Every mutation re-reads that endpoint
 * instead of patching local state: the server response is the truth, the
 * format is small, and a stale optimistic row here would hide exactly the
 * drift an operator is looking at.
 *
 * The alias inputs are selects fed by `GET /admin/aliases`, because the API
 * refuses unknown aliases (`400`) and typing one by hand could only produce an
 * error. Nothing is pre-validated beyond that: the server stays the authority.
 */

const clients = ref<Client[]>([]);
const aliases = ref<Alias[]>([]);
const selectedClientId = ref('');

const envelope = ref<ClientQuotasResponse | null>(null);
const loading = ref(false);
const loadError = ref('');

const form = reactive({ aliasKey: '', monthlyTokenLimit: '', divertAliasKey: '' });
const saving = ref(false);
const formError = ref('');
const formMessage = ref('');

const rowBusy = ref<string | null>(null);
const rowError = ref('');

const confirmRef = ref<{ confirm: (o: ConfirmOptions) => Promise<boolean> } | null>(null);

function askConfirm(options: ConfirmOptions): Promise<boolean> {
  return confirmRef.value?.confirm(options) ?? Promise.resolve(false);
}

const aliasIds = computed(() => aliases.value.map((alias) => alias.id).sort());

/** Divert targets exclude the gated alias itself: the DB CHECK forbids it. */
const divertChoices = computed(() =>
  aliasIds.value.filter((id) => id !== form.aliasKey),
);

const selectedClient = computed(
  () => clients.value.find((client) => client.id === selectedClientId.value) ?? null,
);

/**
 * Readable form of the numeric limit, rendered next to the input on purpose: a
 * missing or extra zero is invisible in `20000000` and obvious in `20.0M`.
 */
const limitPreview = computed(() => {
  const raw = form.monthlyTokenLimit.trim();
  if (raw === '') return '';
  const value = Number(raw);
  if (!Number.isFinite(value)) return '';
  return humanizeTokens(value);
});

/** Only a warning: the API accepts any positive integer, round millions are a convention. */
const limitNotRound = computed(() => {
  const raw = form.monthlyTokenLimit.trim();
  if (raw === '') return false;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) return false;
  return value % 1_000_000 !== 0;
});

/** Error message + any zod issues the gateway attached. */
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

function humanizeTokens(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return value.toLocaleString('en-US');
}

/** `resetsAt` is unix SECONDS, like every other instant the admin API returns. */
function formatInstant(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString();
}

function humanizeSeconds(totalSeconds: number): string {
  if (totalSeconds <= 0) return 'now';
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  if (days > 0) return `${days}d ${hours}h`;
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  return `${hours}h ${minutes}m`;
}

/** Percentage of the allowance already spent, capped so the bar cannot overflow. */
function usedPercent(quota: ClientQuota): number {
  if (quota.monthlyTokenLimit <= 0) return 0;
  return Math.min(100, (quota.tokens / quota.monthlyTokenLimit) * 100);
}

function percentLabel(quota: ClientQuota): string {
  const percent = usedPercent(quota);
  if (percent > 0 && percent < 0.1) return '<0.1%';
  return `${percent.toFixed(1)}%`;
}

function hasQuota(aliasKey: string): boolean {
  return (envelope.value?.quotas ?? []).some((quota) => quota.aliasKey === aliasKey);
}

// ── Loading ─────────────────────────────────────────────────────────────────

async function loadClients(): Promise<void> {
  const response = await listClients();
  clients.value = response.clients;
  const current = selectedClientId.value;
  const stillThere = response.clients.some((client) => client.id === current);
  if (!stillThere) {
    selectedClientId.value = response.clients[0]?.id ?? '';
    resetForm();
  }
}

async function loadAliases(): Promise<void> {
  aliases.value = (await listAliases()).aliases;
  // The selects must never hold an id the registry no longer has (an alias can
  // be deleted between two visits), so both are re-anchored to what exists.
  if (form.aliasKey === '' || !aliasIds.value.includes(form.aliasKey)) {
    form.aliasKey = aliasIds.value[0] ?? '';
  }
  if (form.divertAliasKey !== '' && !aliasIds.value.includes(form.divertAliasKey)) {
    form.divertAliasKey = '';
  }
}

async function loadQuotas(): Promise<void> {
  if (selectedClientId.value === '') {
    envelope.value = null;
    return;
  }
  loading.value = true;
  loadError.value = '';
  try {
    envelope.value = await listClientQuotas(selectedClientId.value);
  } catch (err) {
    envelope.value = null;
    loadError.value = formatError(err);
  } finally {
    loading.value = false;
  }
}

/** One reload after any mutation: the server response is the only truth here. */
async function refresh(): Promise<void> {
  await loadQuotas();
}

async function loadAll(): Promise<void> {
  loading.value = true;
  loadError.value = '';
  try {
    await Promise.all([loadClients(), loadAliases()]);
    await loadQuotas();
  } catch (err) {
    loadError.value = formatError(err);
  } finally {
    loading.value = false;
  }
}

async function onClientChange(): Promise<void> {
  rowError.value = '';
  formError.value = '';
  formMessage.value = '';
  resetForm();
  await loadQuotas();
}

function resetForm(): void {
  form.aliasKey = aliasIds.value[0] ?? '';
  form.monthlyTokenLimit = '';
  form.divertAliasKey = '';
  formError.value = '';
}

function editQuota(quota: ClientQuota): void {
  form.aliasKey = quota.aliasKey;
  form.monthlyTokenLimit = String(quota.monthlyTokenLimit);
  form.divertAliasKey = quota.divertAliasKey ?? '';
  formError.value = '';
  formMessage.value = '';
}

/** Keep the divert target valid when the gated alias changes. */
function onAliasChange(): void {
  if (form.divertAliasKey === form.aliasKey) form.divertAliasKey = '';
  const existing = envelope.value?.quotas.find((quota) => quota.aliasKey === form.aliasKey);
  if (existing) {
    form.monthlyTokenLimit = String(existing.monthlyTokenLimit);
    form.divertAliasKey = existing.divertAliasKey ?? '';
  }
}

// ── Mutations ───────────────────────────────────────────────────────────────

async function submitQuota(): Promise<void> {
  formError.value = '';
  formMessage.value = '';

  if (selectedClientId.value === '') {
    formError.value = 'Select a client first.';
    return;
  }
  if (form.aliasKey === '') {
    formError.value = 'Select an alias.';
    return;
  }
  const rawLimit = form.monthlyTokenLimit.trim();
  if (rawLimit === '') {
    formError.value = 'Monthly token limit is required.';
    return;
  }
  const limit = Number(rawLimit);
  if (!Number.isInteger(limit) || limit <= 0) {
    formError.value = 'Monthly token limit must be a positive integer (tokens, no separators).';
    return;
  }
  if (form.divertAliasKey !== '' && form.divertAliasKey === form.aliasKey) {
    formError.value = 'The divert target must differ from the gated alias.';
    return;
  }

  const entry: ClientQuotaEntry = {
    aliasKey: form.aliasKey,
    monthlyTokenLimit: limit,
    divertAliasKey: form.divertAliasKey === '' ? null : form.divertAliasKey,
  };

  const updating = hasQuota(entry.aliasKey);
  saving.value = true;
  try {
    await putClientQuotas(selectedClientId.value, [entry]);
    await refresh();
    formMessage.value = updating
      ? `Limit for "${entry.aliasKey}" updated. It applies from the next request.`
      : `Quota for "${entry.aliasKey}" added. It applies from the next request.`;
  } catch (err) {
    formError.value = formatError(err);
  } finally {
    saving.value = false;
  }
}

async function onDelete(quota: ClientQuota): Promise<void> {
  const clientLabel = selectedClient.value?.name ?? selectedClientId.value;
  const ok = await askConfirm({
    title: 'Remove quota',
    message:
      `Remove the monthly quota for alias "${quota.aliasKey}" on "${clientLabel}"? ` +
      `The alias becomes UNLIMITED for this client: no monthly limit and no diversion. ` +
      `Usage already recorded for this month is left untouched.`,
    confirmLabel: 'Remove quota',
    danger: true,
  });
  if (!ok) return;

  rowBusy.value = quota.aliasKey;
  rowError.value = '';
  try {
    await deleteClientQuota(selectedClientId.value, quota.aliasKey);
    await refresh();
    if (form.aliasKey === quota.aliasKey) resetForm();
  } catch (err) {
    // A 404 means the row was already gone (another operator, another tab):
    // report it plainly instead of a generic failure, then resync the table.
    if (err instanceof ApiError && err.status === 404) {
      rowError.value =
        `No quota for "${quota.aliasKey}" any more (404): it was already removed. ` +
        'The table was reloaded.';
      await refresh();
    } else {
      rowError.value = formatError(err);
    }
  } finally {
    rowBusy.value = null;
  }
}

onMounted(() => {
  void loadAll();
});
</script>

<template>
  <div>
    <h1>Quotas</h1>

    <section class="panel">
      <div class="toolbar">
        <div class="field">
          <label for="quota-client">Client</label>
          <select
            id="quota-client"
            v-model="selectedClientId"
            :disabled="clients.length === 0"
            @change="onClientChange"
          >
            <option v-for="client in clients" :key="client.id" :value="client.id">
              {{ client.name }} ({{ client.id }})
            </option>
          </select>
        </div>
        <div class="field field-action">
          <button class="btn btn-ghost" type="button" :disabled="loading" @click="loadAll">
            {{ loading ? 'Loading…' : 'Reload' }}
          </button>
        </div>
      </div>

      <p v-if="envelope" class="notice">
        Period <code>{{ envelope.periodKey }}</code> (UTC). Counters reset at
        {{ formatInstant(envelope.resetsAt) }} — in
        {{ humanizeSeconds(envelope.retryAfterSeconds) }}
        (unix {{ envelope.resetsAt }}). No row means <strong>unlimited</strong>.
      </p>
      <p v-else-if="!loading" class="muted">
        Select a client to see its aliases' monthly quotas.
      </p>
    </section>

    <p v-if="loadError" class="error">{{ loadError }}</p>
    <p v-if="rowError" class="error">{{ rowError }}</p>
    <p v-if="loading" class="muted">Loading…</p>

    <section v-else-if="envelope" class="panel">
      <h2 class="section-title">Allowances</h2>

      <table v-if="envelope.quotas.length > 0">
        <thead>
          <tr>
            <th>Alias</th>
            <th>Monthly limit</th>
            <th>Used this month</th>
            <th>Remaining</th>
            <th>Usage</th>
            <th>Divert to</th>
            <th>State</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="quota in envelope.quotas" :key="quota.aliasKey">
            <td class="mono">{{ quota.aliasKey }}</td>
            <td>
              {{ quota.monthlyTokenLimit.toLocaleString('en-US') }}
              <span class="muted">({{ humanizeTokens(quota.monthlyTokenLimit) }})</span>
            </td>
            <td>
              {{ quota.tokens.toLocaleString('en-US') }}
              <span class="muted">({{ humanizeTokens(quota.tokens) }})</span>
            </td>
            <td>{{ quota.remaining.toLocaleString('en-US') }}</td>
            <td class="usage-cell">
              <span class="usage-bar" :title="percentLabel(quota)">
                <span
                  class="usage-fill"
                  :class="{ 'usage-fill-full': quota.exhausted }"
                  :style="{ width: `${usedPercent(quota)}%` }"
                ></span>
              </span>
              <span class="muted">{{ percentLabel(quota) }}</span>
            </td>
            <td>
              <span v-if="quota.divertAliasKey" class="mono">{{ quota.divertAliasKey }}</span>
              <span v-else class="muted">—</span>
            </td>
            <td>
              <span v-if="quota.exhausted" class="badge badge-error">exhausted</span>
              <span v-else class="badge badge-ok">ok</span>
            </td>
            <td class="actions">
              <button
                class="btn btn-sm btn-ghost"
                type="button"
                @click="editQuota(quota)"
              >
                Edit
              </button>
              <button
                class="btn btn-sm btn-danger"
                type="button"
                :disabled="rowBusy === quota.aliasKey"
                @click="onDelete(quota)"
              >
                Delete
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="muted">
        This client has no quotas: every alias is unlimited and nothing is gated.
        Add one below.
      </p>
    </section>

    <section v-if="selectedClientId !== ''" class="panel">
      <h2 class="section-title">Add or update a quota</h2>

      <p v-if="aliasIds.length === 0" class="muted">
        No aliases in the registry yet — create one in the Aliases view first. The
        API only accepts aliases that already exist.
      </p>

      <form v-else class="form-grid" @submit.prevent="submitQuota">
        <div class="field">
          <label for="quota-alias">Alias</label>
          <select id="quota-alias" v-model="form.aliasKey" @change="onAliasChange">
            <option v-for="aliasId in aliasIds" :key="aliasId" :value="aliasId">
              {{ aliasId }}
            </option>
          </select>
        </div>
        <div class="field">
          <label for="quota-limit">
            Monthly token limit
            <span v-if="limitPreview" class="muted">→ {{ limitPreview }}</span>
          </label>
          <input
            id="quota-limit"
            v-model="form.monthlyTokenLimit"
            inputmode="numeric"
            placeholder="20000000"
          />
          <small v-if="limitNotRound" class="warning">
            Not a whole million — check the zeros.
          </small>
        </div>
        <div class="field">
          <label for="quota-divert">Divert to (optional)</label>
          <select id="quota-divert" v-model="form.divertAliasKey">
            <option value="">— none —</option>
            <option v-for="aliasId in divertChoices" :key="aliasId" :value="aliasId">
              {{ aliasId }}
            </option>
          </select>
        </div>
        <div class="field field-action">
          <button class="btn" type="submit" :disabled="saving">
            {{ saving ? 'Saving…' : 'Save quota' }}
          </button>
          <button class="btn btn-ghost" type="button" @click="resetForm">Clear</button>
        </div>
      </form>

      <small v-if="aliasIds.length > 0" class="quota-hint muted">
        Without a divert target an exhausted quota answers <code>429</code> with
        <code>Retry-After</code> until the 1st of the next UTC month — the client
        is refused, never silently downgraded.
      </small>

      <p v-if="formError" class="error">{{ formError }}</p>
      <p v-if="formMessage" class="success">{{ formMessage }}</p>
    </section>

    <ConfirmDialog ref="confirmRef" />
  </div>
</template>

<style scoped>
/* Only what the shared stylesheet does not provide: the usage bar. */
.usage-cell {
  min-width: 140px;
}

.usage-bar {
  display: inline-block;
  width: 90px;
  height: 8px;
  margin-right: 8px;
  border-radius: 999px;
  background: var(--bg-elev-2);
  vertical-align: middle;
  overflow: hidden;
}

.usage-fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--accent);
}

.usage-fill-full {
  background: var(--danger);
}

.quota-hint {
  display: block;
  margin-top: 10px;
}
</style>
