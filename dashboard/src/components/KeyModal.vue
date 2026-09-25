<script lang="ts">
import type { ClientWithKey } from '../api/types';

/** State rendered by {@link KeyModal} after a create/rotate. */
export interface KeyModalState extends ClientWithKey {
  kind: 'created' | 'rotated';
}
</script>

<script setup lang="ts">
import { ref, watch } from 'vue';

/**
 * One-time plaintext API key modal. Extracted from the inline modal that used to
 * live in `ClientsView.vue` so other flows can reuse it. The plaintext key is
 * shown exactly once by the API and never persisted client-side.
 */
const props = defineProps<{ state: KeyModalState | null }>();
const emit = defineEmits<{ close: [] }>();

const copied = ref(false);

// Re-arm the "Copied!" feedback whenever a new key is presented.
watch(
  () => props.state,
  () => {
    copied.value = false;
  },
);

async function copyKey(): Promise<void> {
  const state = props.state;
  if (!state) return;
  try {
    await navigator.clipboard.writeText(state.plaintextApiKey);
    copied.value = true;
    window.setTimeout(() => {
      copied.value = false;
    }, 2000);
  } catch {
    copied.value = false;
  }
}

function close(): void {
  emit('close');
}
</script>

<template>
  <div v-if="state" class="modal-backdrop" @click.self="close">
    <div class="modal">
      <h2 class="section-title">
        {{ state.kind === 'created' ? 'Client created' : 'Key rotated' }}
      </h2>
      <p class="warning">{{ state.warning }}</p>
      <p class="muted">
        Client: <strong>{{ state.name }}</strong> (<span class="mono">{{ state.id }}</span>)
      </p>
      <div class="key-box">
        <code class="key-value">{{ state.plaintextApiKey }}</code>
      </div>
      <div class="modal-actions">
        <button class="btn" type="button" @click="copyKey">
          {{ copied ? 'Copied!' : 'Copy key' }}
        </button>
        <button class="btn btn-ghost" type="button" @click="close">Done</button>
      </div>
    </div>
  </div>
</template>
