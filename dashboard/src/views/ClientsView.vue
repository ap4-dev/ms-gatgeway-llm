<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import {
  createClient,
  deleteClient,
  extractIssues,
  listClients,
  patchClient,
  revokeClient,
  rotateClient,
} from '../api/client';
import type { Client, ClientWithKey, CreateClientPayload, PatchClientPayload } from '../api/types';

/**
 * Phase 4 Clients view: list, create (one-time key), inline edit, rotate,
 * revoke and delete. Every mutation re-reads `GET /admin/clients` so the table
 * always reflects server state.
 */

const clients = ref<Client[]>([]);
const loading = ref(false);
const loadError = ref('');

const newClient = reactive({ id: '', name: '', scopes: '', rpm: '', tpm: '' });
const creating = ref(false);
const createError = ref('');

const editingId = ref<string | null>(null);
const savingId = ref<string | null>(null);
const editError = ref('');
const editForm = reactive({ name: '', scopes: '', rpm: '', tpm: '' });

const rowBusy = ref<string | null>(null);
const rowError = ref('');

interface KeyModalState extends ClientWithKey {
  kind: 'created' | 'rotated';
}

const keyModal = ref<KeyModalState | null>(null);
const copied = ref(false);

/** Comma-separated input -> trimmed, non-empty scope list. */
function parseScopes(raw: string): string[] {
  return raw
    .split(',')
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
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

function humanizeUnix(unixSeconds: number | null): string {
  if (unixSeconds === null) return 'Never';
  return new Date(unixSeconds * 1000).toLocaleString();
}

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

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = '';
  try {
    clients.value = (await listClients()).clients;
  } catch (err) {
    clients.value = [];
    loadError.value = formatError(err);
  } finally {
    loading.value = false;
  }
}

function resetCreate(): void {
  newClient.id = '';
  newClient.name = '';
  newClient.scopes = '';
  newClient.rpm = '';
  newClient.tpm = '';
}

async function submitCreate(): Promise<void> {
  createError.value = '';
  const name = newClient.name.trim();
  if (name.length === 0) {
    createError.value = 'Name is required.';
    return;
  }
  const payload: CreateClientPayload = { name };
  const id = newClient.id.trim();
  if (id.length > 0) payload.id = id;
  const scopes = parseScopes(newClient.scopes);
  if (scopes.length > 0) payload.scopes = scopes;
  const rpm = parseOptionalPositiveInt(newClient.rpm);
  if (rpm.invalid) {
    createError.value = 'RPM must be a positive integer.';
    return;
  }
  if (rpm.value !== undefined) payload.rateLimitRpm = rpm.value;
  const tpm = parseOptionalPositiveInt(newClient.tpm);
  if (tpm.invalid) {
    createError.value = 'TPM must be a positive integer.';
    return;
  }
  if (tpm.value !== undefined) payload.rateLimitTpm = tpm.value;

  creating.value = true;
  try {
    const created = await createClient(payload);
    keyModal.value = { ...created, kind: 'created' };
    resetCreate();
    await load();
  } catch (err) {
    // A 409 (duplicate id) lands here with the server message.
    createError.value = formatError(err);
  } finally {
    creating.value = false;
  }
}

function startEdit(client: Client): void {
  editingId.value = client.id;
  editError.value = '';
  editForm.name = client.name;
  editForm.scopes = client.scopes.join(', ');
  editForm.rpm = String(client.rateLimitRpm);
  editForm.tpm = client.rateLimitTpm === null ? '' : String(client.rateLimitTpm);
}

function cancelEdit(): void {
  editingId.value = null;
  editError.value = '';
}

async function saveEdit(client: Client): Promise<void> {
  editError.value = '';
  const patch: PatchClientPayload = {};
  const name = editForm.name.trim();
  if (name.length === 0) {
    editError.value = 'Name is required.';
    return;
  }
  patch.name = name;
  const scopes = parseScopes(editForm.scopes);
  if (scopes.length > 0) patch.scopes = scopes;
  const rpm = parseOptionalPositiveInt(editForm.rpm);
  if (rpm.invalid) {
    editError.value = 'RPM must be a positive integer.';
    return;
  }
  if (rpm.value !== undefined) patch.rateLimitRpm = rpm.value;
  const tpm = parseOptionalPositiveInt(editForm.tpm);
  if (tpm.invalid) {
    editError.value = 'TPM must be a positive integer or empty.';
    return;
  }
  // Empty TPM clears the limit server-side.
  patch.rateLimitTpm = tpm.value ?? null;

  savingId.value = client.id;
  try {
    await patchClient(client.id, patch);
    editingId.value = null;
    await load();
  } catch (err) {
    editError.value = formatError(err);
  } finally {
    savingId.value = null;
  }
}

async function onRotate(client: Client): Promise<void> {
  if (
    !window.confirm(
      `Rotate the API key for "${client.name}"? The current key stops working immediately.`,
    )
  ) {
    return;
  }
  rowBusy.value = client.id;
  rowError.value = '';
  try {
    const rotated = await rotateClient(client.id);
    keyModal.value = { ...rotated, kind: 'rotated' };
    await load();
  } catch (err) {
    rowError.value = formatError(err);
  } finally {
    rowBusy.value = null;
  }
}

async function onRevoke(client: Client): Promise<void> {
  if (!window.confirm(`Revoke "${client.name}"? Its key stops working.`)) return;
  rowBusy.value = client.id;
  rowError.value = '';
  try {
    await revokeClient(client.id);
    await load();
  } catch (err) {
    rowError.value = formatError(err);
  } finally {
    rowBusy.value = null;
  }
}

async function onDelete(client: Client): Promise<void> {
  if (
    !window.confirm(
      `Permanently delete "${client.name}" (${client.id})? This cannot be undone.`,
    )
  ) {
    return;
  }
  rowBusy.value = client.id;
  rowError.value = '';
  try {
    await deleteClient(client.id);
    await load();
  } catch (err) {
    rowError.value = formatError(err);
  } finally {
    rowBusy.value = null;
  }
}

async function copyKey(): Promise<void> {
  const modal = keyModal.value;
  if (!modal) return;
  try {
    await navigator.clipboard.writeText(modal.plaintextApiKey);
    copied.value = true;
    window.setTimeout(() => {
      copied.value = false;
    }, 2000);
  } catch {
    copied.value = false;
  }
}

function closeModal(): void {
  keyModal.value = null;
  copied.value = false;
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div>
    <h1>Clients</h1>

    <section class="panel">
      <h2 class="section-title">New client</h2>
      <form class="form-grid" @submit.prevent="submitCreate">
        <div class="field">
          <label for="new-id">Id (optional)</label>
          <input id="new-id" v-model="newClient.id" placeholder="tenant-acme" />
        </div>
        <div class="field">
          <label for="new-name">Name</label>
          <input id="new-name" v-model="newClient.name" placeholder="Acme Co." />
        </div>
        <div class="field">
          <label for="new-scopes">Scopes (comma separated)</label>
          <input
            id="new-scopes"
            v-model="newClient.scopes"
            placeholder="chat.read, chat.write"
          />
        </div>
        <div class="field">
          <label for="new-rpm">Rate limit RPM (optional)</label>
          <input id="new-rpm" v-model="newClient.rpm" inputmode="numeric" placeholder="60" />
        </div>
        <div class="field">
          <label for="new-tpm">Rate limit TPM (optional)</label>
          <input id="new-tpm" v-model="newClient.tpm" inputmode="numeric" placeholder="100000" />
        </div>
        <div class="field field-action">
          <button class="btn" type="submit" :disabled="creating">
            {{ creating ? 'Creating…' : 'Create client' }}
          </button>
        </div>
      </form>
      <p v-if="createError" class="error">{{ createError }}</p>
    </section>

    <p v-if="loadError" class="error">{{ loadError }}</p>
    <p v-if="rowError" class="error">{{ rowError }}</p>
    <p v-if="loading" class="muted">Loading…</p>

    <table v-else>
      <thead>
        <tr>
          <th>Name</th>
          <th>Id</th>
          <th>Prefix</th>
          <th>Scopes</th>
          <th>RPM</th>
          <th>TPM</th>
          <th>Status</th>
          <th>Last used</th>
          <th>Created</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="client in clients" :key="client.id">
          <tr>
            <td>{{ client.name }}</td>
            <td class="mono">{{ client.id }}</td>
            <td class="mono">{{ client.apiKeyPrefix }}…</td>
            <td class="scopes">
              <span v-for="scope in client.scopes" :key="scope" class="tag">{{ scope }}</span>
            </td>
            <td>{{ client.rateLimitRpm.toLocaleString('en-US') }}</td>
            <td>{{ client.rateLimitTpm === null ? '—' : client.rateLimitTpm.toLocaleString('en-US') }}</td>
            <td>
              <span :class="['badge', client.revoked ? 'badge-error' : 'badge-ok']">
                {{ client.revoked ? 'revoked' : 'active' }}
              </span>
            </td>
            <td>{{ humanizeUnix(client.lastUsedAt) }}</td>
            <td>{{ humanizeUnix(client.createdAt) }}</td>
            <td class="actions">
              <button class="btn btn-sm btn-ghost" type="button" @click="startEdit(client)">
                Edit
              </button>
              <button
                class="btn btn-sm btn-ghost"
                type="button"
                :disabled="rowBusy === client.id"
                @click="onRotate(client)"
              >
                Rotate
              </button>
              <button
                class="btn btn-sm btn-ghost"
                type="button"
                :disabled="rowBusy === client.id || client.revoked"
                @click="onRevoke(client)"
              >
                Revoke
              </button>
              <button
                class="btn btn-sm btn-danger"
                type="button"
                :disabled="rowBusy === client.id"
                @click="onDelete(client)"
              >
                Delete
              </button>
            </td>
          </tr>
          <tr v-if="editingId === client.id" class="edit-row">
            <td colspan="10">
              <form class="form-grid" @submit.prevent="saveEdit(client)">
                <div class="field">
                  <label :for="`edit-name-${client.id}`">Name</label>
                  <input :id="`edit-name-${client.id}`" v-model="editForm.name" />
                </div>
                <div class="field">
                  <label :for="`edit-scopes-${client.id}`">Scopes</label>
                  <input :id="`edit-scopes-${client.id}`" v-model="editForm.scopes" />
                </div>
                <div class="field">
                  <label :for="`edit-rpm-${client.id}`">RPM</label>
                  <input :id="`edit-rpm-${client.id}`" v-model="editForm.rpm" inputmode="numeric" />
                </div>
                <div class="field">
                  <label :for="`edit-tpm-${client.id}`">TPM (empty clears)</label>
                  <input :id="`edit-tpm-${client.id}`" v-model="editForm.tpm" inputmode="numeric" />
                </div>
                <div class="field field-action">
                  <button class="btn btn-sm" type="submit" :disabled="savingId === client.id">
                    {{ savingId === client.id ? 'Saving…' : 'Save' }}
                  </button>
                  <button class="btn btn-sm btn-ghost" type="button" @click="cancelEdit">
                    Cancel
                  </button>
                </div>
              </form>
              <p v-if="editError" class="error">{{ editError }}</p>
            </td>
          </tr>
        </template>
        <tr v-if="clients.length === 0">
          <td colspan="10" class="muted">No clients yet. Create one above.</td>
        </tr>
      </tbody>
    </table>

    <div v-if="keyModal" class="modal-backdrop" @click.self="closeModal">
      <div class="modal">
        <h2 class="section-title">
          {{ keyModal.kind === 'created' ? 'Client created' : 'Key rotated' }}
        </h2>
        <p class="warning">{{ keyModal.warning }}</p>
        <p class="muted">
          Client: <strong>{{ keyModal.name }}</strong> (<span class="mono">{{ keyModal.id }}</span>)
        </p>
        <div class="key-box">
          <code class="key-value">{{ keyModal.plaintextApiKey }}</code>
        </div>
        <div class="modal-actions">
          <button class="btn" type="button" @click="copyKey">
            {{ copied ? 'Copied!' : 'Copy key' }}
          </button>
          <button class="btn btn-ghost" type="button" @click="closeModal">Done</button>
        </div>
      </div>
    </div>
  </div>
</template>
