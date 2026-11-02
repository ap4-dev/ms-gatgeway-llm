<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import {
  ApiError,
  deleteClientAliases,
  deleteClientQuota,
  extractIssues,
  getClientAliases,
  listAliases,
  listClientQuotas,
  listClients,
  putClientAliases,
  putClientQuotas,
} from '../api/client';
import type {
  Alias,
  AliasAccessDescription,
  Client,
  ClientQuota,
  ClientQuotaEntry,
  ClientQuotasResponse,
} from '../api/client';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import type { ConfirmOptions } from '../components/ConfirmDialog.vue';

/**
 * Operator surface for BOTH access controls of one client (feature: cuotas
 * mensuales + alias allowlist): **which aliases it may use** (allowlist) and
 * **how much of each** (monthly token quota). One `(client, alias)` allowance =
 * a quota row; **no quota row means unlimited**. The allowlist is
 * `unrestricted` when the client has no rows (every alias allowed) and
 * `restricted` to an EXHAUSTIVE set otherwise.
 *
 * The two are orthogonal and are edited here, for the same selected client, on
 * purpose: only side by side can the operator see a contradictory config — a
 * quota on an alias the client is not permitted to request is dead config,
 * because the request is refused with `403` before the quota gate runs. This
 * view warns about that and blocks nothing: the server is the authority.
 *
 * Every read goes through the admin API (`GET /admin/clients/:id/quotas`,
 * `GET /admin/clients/:id/aliases`), so this view never computes a counter or
 * an access mode itself. Every mutation re-reads instead of patching local
 * state: the server response is the truth, the payloads are small, and a stale
 * optimistic row here would hide exactly the drift an operator is looking at.
 * The same rule is why the allowlist editor stages edits in a local DRAFT —
 * `PUT` replaces the whole set — but commits them through the server and then
 * re-reads, never by writing the draft back as if it were saved state.
 *
 * The alias inputs are selects fed by `GET /admin/aliases`, because both APIs
 * refuse unknown aliases (`400`) and typing one by hand could only produce an
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

// ── Allowlist state ────────────────────────────────────────────────────────

/** `null` until the first successful read; `unrestricted` is a real value. */
const access = ref<AliasAccessDescription | null>(null);
const accessLoading = ref(false);
const accessError = ref('');
const accessMessage = ref('');

/**
 * Local DRAFT of the permitted set. `PUT /aliases` replaces the whole set, so
 * edits are staged here and committed with an explicit Save; the draft is
 * re-seeded from the server after every successful read/write. `access` holds
 * what the server currently says and is the ONLY source for the warnings and
 * the Save/Clear affordances — never the draft.
 */
const draftAliases = ref<string[]>([]);
const addAliasChoice = ref('');
const accessSaving = ref(false);

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

// ── Allowlist derived state ────────────────────────────────────────────────

const accessMode = computed(() => access.value?.mode ?? null);

/**
 * The set the SERVER says the client may use. Empty is correct when the mode is
 * `unrestricted` — it means "every alias", never "none" — so this set is only
 * consulted as an allowlist while the mode is `restricted`.
 */
const permittedAliases = computed(() => access.value?.aliases ?? []);

/** Aliases of the registry that the draft does not contain yet (no free text). */
const addableAliases = computed(() =>
  aliasIds.value.filter((aliasId) => !draftAliases.value.includes(aliasId)),
);

/**
 * Draft vs saved set, order-insensitive: the server returns a sorted list but
 * the operator's staging order is whatever they clicked, and neither is
 * meaningful to an API that stores a SET.
 */
const draftDirty = computed(() => {
  if (access.value === null) return false;
  const saved = [...permittedAliases.value].sort().join('\u0000');
  const staged = [...draftAliases.value].sort().join('\u0000');
  return saved !== staged;
});

/**
 * An empty draft is never sendable: `PUT` with `[]` is a `400` by design
 * (no rows means UNRESTRICTED, so accepting it would grant everything instead
 * of nothing). Disabling Save here mirrors the server rule instead of
 * discovering it as an error.
 */
const canSaveAliases = computed(
  () => access.value !== null && draftDirty.value && draftAliases.value.length > 0 && !accessSaving.value,
);

/**
 * A quota on an alias this client may not request is DEAD CONFIG: the 403 is
 * returned by the alias gate before the quota gate is ever consulted, so the
 * allowance never decrements and never diverts. Evaluated against the SAVED set
 * (never the draft) because the server is the authority and the operator may be
 * mid-edit. Nothing is blocked: this is a warning, not a validation.
 */
function isDeadQuota(aliasKey: string): boolean {
  return accessMode.value === 'restricted' && !permittedAliases.value.includes(aliasKey);
}

const hasDeadQuota = computed(
  () => accessMode.value === 'restricted' && (envelope.value?.quotas ?? []).some((quota) => isDeadQuota(quota.aliasKey)),
);

// ── Allowlist draft + mutations ────────────────────────────────────────────

/** Re-seed the draft from the server state (after every read and every write). */
function seedDraft(): void {
  draftAliases.value = [...permittedAliases.value];
  addAliasChoice.value = '';
}

/** Drop the draft: re-seeded from the server state ("Discard changes"). */
function discardDraft(): void {
  seedDraft();
  accessMessage.value = '';
}

/** Drop the draft AND the loaded state (leaving one client for another). */
function clearDraft(): void {
  access.value = null;
  draftAliases.value = [];
  addAliasChoice.value = '';
  accessMessage.value = '';
}

function addDraftAlias(): void {
  const aliasId = addAliasChoice.value;
  if (aliasId === '') return;
  // Guard against a stale choice (the registry can change between two reads).
  if (!aliasIds.value.includes(aliasId)) {
    addAliasChoice.value = '';
    return;
  }
  if (!draftAliases.value.includes(aliasId)) draftAliases.value.push(aliasId);
  addAliasChoice.value = '';
  accessMessage.value = '';
}

function removeDraftAlias(aliasKey: string): void {
  draftAliases.value = draftAliases.value.filter((id) => id !== aliasKey);
  accessMessage.value = '';
}

/** A 404 on `/admin/clients/:id/aliases` means the client itself is gone. */
function describeAccessError(err: unknown, action: string): string {
  if (err instanceof ApiError && err.status === 404) {
    return (
      `${action}: the client "${selectedClientId.value}" no longer exists (404). ` +
      'Its access rows are gone with it; reload the client list.'
    );
  }
  return formatError(err);
}

async function loadAccess(): Promise<void> {
  if (selectedClientId.value === '') {
    access.value = null;
    seedDraft();
    return;
  }
  accessLoading.value = true;
  accessError.value = '';
  try {
    access.value = await getClientAliases(selectedClientId.value);
    seedDraft();
  } catch (err) {
    access.value = null;
    draftAliases.value = [];
    addAliasChoice.value = '';
    accessError.value = describeAccessError(err, 'Could not load the alias allowlist');
  } finally {
    accessLoading.value = false;
  }
}

async function saveAliases(): Promise<void> {
  accessError.value = '';
  accessMessage.value = '';
  if (selectedClientId.value === '') {
    accessError.value = 'Select a client first.';
    return;
  }
  if (draftAliases.value.length === 0) {
    // Belt and braces: Save is disabled in this state, and the server would
    // answer 400 anyway. Never fall through to a PUT that cannot succeed.
    accessError.value =
      'An empty allowlist cannot be saved: the API rejects `[]` because no rows means ' +
      'UNRESTRICTED. Add at least one alias, or use "Return to unrestricted".';
    return;
  }

  accessSaving.value = true;
  try {
    // The PUT response is the new state, but it is still re-read below so this
    // view has exactly one way of learning the truth.
    await putClientAliases(selectedClientId.value, [...draftAliases.value]);
    await refresh();
    accessMessage.value =
      `Allowlist saved (${draftAliases.value.length} alias` +
      `${draftAliases.value.length === 1 ? '' : 'es'}). It applies from the next request.`;
  } catch (err) {
    accessError.value = describeAccessError(err, 'Could not save the alias allowlist');
  } finally {
    accessSaving.value = false;
  }
}

async function onReturnToUnrestricted(): Promise<void> {
  const clientLabel = selectedClient.value?.name ?? selectedClientId.value;
  const ok = await askConfirm({
    title: 'Return to unrestricted',
    message:
      `Clear the alias allowlist of "${clientLabel}"? ` +
      `The client regains access to EVERY alias in the registry: it may call and see all of ` +
      `them again, not just the ones listed now. ` +
      `Monthly quotas are left untouched — they are a separate control and keep applying.`,
    confirmLabel: 'Return to unrestricted',
    danger: true,
  });
  if (!ok) return;

  accessSaving.value = true;
  accessError.value = '';
  accessMessage.value = '';
  try {
    await deleteClientAliases(selectedClientId.value);
    await refresh();
    accessMessage.value =
      `Allowlist cleared: "${clientLabel}" is unrestricted and may use every alias in the registry.`;
  } catch (err) {
    accessError.value = describeAccessError(err, 'Could not clear the alias allowlist');
  } finally {
    accessSaving.value = false;
  }
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
    // A different client means a different allowlist: the draft is dropped
    // rather than carried over (see `onClientChange`).
    clearDraft();
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
  await Promise.all([loadQuotas(), loadAccess()]);
}

async function loadAll(): Promise<void> {
  loading.value = true;
  loadError.value = '';
  accessError.value = '';
  try {
    await Promise.all([loadClients(), loadAliases()]);
    await refresh();
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
  accessError.value = '';
  resetForm();
  // A draft belongs to ONE client: carrying it to another would offer to save
  // a set the operator never intended for that client.
  clearDraft();
  await refresh();
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
    <h1>Client access</h1>

    <p class="muted view-intro">
      Both access controls of one client in one place: <strong>which aliases it may use</strong>
      (the allowlist) and <strong>how much of each it may use</strong> (the monthly quotas). They
      are orthogonal, and they are shown together on purpose — a quota on an alias the client is
      not permitted to request is dead configuration, because the request is refused with
      <code>403</code> before the quota gate ever runs.
    </p>

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

    <section v-if="selectedClientId !== ''" class="panel">
      <h2 class="section-title">Alias allowlist</h2>

      <p v-if="accessLoading && access === null" class="muted">Loading…</p>

      <template v-else-if="access">
        <p class="access-mode">
          <span v-if="access.mode === 'unrestricted'" class="badge badge-warn">unrestricted</span>
          <span v-else class="badge badge-ok">restricted</span>
          <span v-if="access.mode === 'unrestricted'" class="muted">
            This client has no allowlist rows: it may call and see <strong>every</strong> alias in
            the registry.
          </span>
          <span v-else class="muted">
            This list is <strong>exhaustive</strong> — an alias missing from it is refused with
            <code>403</code> and is not advertised in <code>/v1/models</code>. Saved:
            {{ access.aliases.length }} permitted.
          </span>
          <span v-if="draftDirty" class="badge badge-warn">unsaved draft</span>
        </p>

        <div class="field">
          <label>Aliases the client may use</label>
          <div v-if="draftAliases.length > 0" class="chip-row">
            <span v-for="aliasKey in draftAliases" :key="aliasKey" class="tag chip">
              <span class="mono">{{ aliasKey }}</span>
              <button
                class="chip-remove"
                type="button"
                :aria-label="`Remove ${aliasKey} from the draft`"
                :title="`Remove ${aliasKey}`"
                @click="removeDraftAlias(aliasKey)"
              >
                ×
              </button>
            </span>
          </div>
          <p v-else-if="access.mode === 'unrestricted'" class="muted">
            Nothing staged. <em>Unrestricted</em> means every alias in the registry is permitted —
            add one or more below to start restricting this client.
          </p>
          <p v-else class="muted">
            Nothing staged — an empty allowlist cannot be saved (see below).
          </p>
        </div>

        <div class="form-grid access-add">
          <div class="field">
            <label for="access-add-alias">Add an alias from the registry</label>
            <select
              id="access-add-alias"
              v-model="addAliasChoice"
              :disabled="addableAliases.length === 0"
            >
              <option value="">— select an alias —</option>
              <option v-for="aliasId in addableAliases" :key="aliasId" :value="aliasId">
                {{ aliasId }}
              </option>
            </select>
          </div>
          <div class="field field-action">
            <button
              class="btn btn-ghost"
              type="button"
              :disabled="addAliasChoice === ''"
              @click="addDraftAlias"
            >
              Add
            </button>
            <button
              class="btn"
              type="button"
              :disabled="!canSaveAliases"
              @click="saveAliases"
            >
              {{ accessSaving ? 'Saving…' : 'Save allowlist' }}
            </button>
            <button
              class="btn btn-ghost"
              type="button"
              :disabled="!draftDirty || accessSaving"
              @click="discardDraft"
            >
              Discard changes
            </button>
            <button
              v-if="access.mode === 'restricted'"
              class="btn btn-danger"
              type="button"
              :disabled="accessSaving"
              @click="onReturnToUnrestricted"
            >
              Return to unrestricted
            </button>
          </div>
        </div>

        <small v-if="addableAliases.length === 0 && aliasIds.length === 0" class="muted access-hint">
          No aliases in the registry yet — create one in the Aliases view first. The API only
          accepts aliases that already exist.
        </small>
        <small v-else-if="addableAliases.length === 0" class="muted access-hint">
          Every alias in the registry is already in the draft.
        </small>

        <small
          v-if="access.mode === 'restricted' && draftAliases.length === 0"
          class="warning access-hint"
        >
          An empty allowlist cannot be saved: <code>PUT</code> with <code>[]</code> is rejected with
          <code>400</code> on purpose, because no rows means <em>unrestricted</em> — the opposite of
          "no access at all". That state is deliberately not expressible here. Use
          <strong>Return to unrestricted</strong> instead.
        </small>
        <small v-else-if="draftAliases.length === 0" class="muted access-hint">
          Add at least one alias to save a restricted allowlist. With nothing staged there is
          nothing to save and the client stays unrestricted.
        </small>

        <small class="muted access-hint">
          Saving replaces the <strong>entire</strong> set: an alias whose chip you remove is
          revoked for this client, and the change applies from the next request. No cache, no
          restart.
        </small>

        <p v-if="accessError" class="error">{{ accessError }}</p>
        <p v-if="accessMessage" class="success">{{ accessMessage }}</p>
      </template>

      <template v-else>
        <p class="error">
          {{ accessError || 'Could not load the alias allowlist for this client.' }}
        </p>
        <button class="btn btn-ghost" type="button" :disabled="accessLoading" @click="refresh">
          Retry
        </button>
      </template>
    </section>

    <p v-if="loading" class="muted">Loading…</p>

    <section v-else-if="envelope" class="panel">
      <h2 class="section-title">Allowances</h2>

      <p v-if="hasDeadQuota" class="notice dead-quota-notice">
        <span class="badge badge-warn">unreachable</span>
        The rows marked below are on aliases this client is <strong>not permitted</strong> to request.
        A request for one of them is refused with <code>403</code> by the alias allowlist
        <em>before</em> the quota gate runs, so the allowance is never consulted: no counter moves,
        no divert happens, and the limit has no effect. Allow the alias above, or remove the quota.
      </p>

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
            <td class="mono">
              {{ quota.aliasKey }}
              <span v-if="isDeadQuota(quota.aliasKey)" class="badge badge-warn">unreachable</span>
              <small v-if="isDeadQuota(quota.aliasKey)" class="warning dead-quota-line">
                never reached: <code>403</code> before the quota gate
              </small>
            </td>
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
        This client has no quotas: every permitted alias is unlimited and nothing is gated.
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
/* Only what the shared stylesheet does not provide: the usage bar and the
   removable chip. Everything else (panels, badges, warnings) is global. */
.view-intro {
  margin-top: -6px;
  max-width: 90ch;
}

.access-mode {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
}

.chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.chip-remove {
  padding: 0 2px;
  border: 0;
  background: transparent;
  color: var(--danger);
  font: inherit;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}

.chip-remove:hover {
  color: var(--text);
}

.access-add {
  margin-top: 16px;
}

.access-hint {
  display: block;
  margin-top: 10px;
}

.dead-quota-notice {
  margin-bottom: 16px;
}

.dead-quota-line {
  display: block;
  margin-top: 2px;
  font-weight: 500;
}

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
