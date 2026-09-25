<script lang="ts">
/** Options accepted by the imperative {@link ConfirmDialog} `confirm` method. */
export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Render the confirm action with danger styling (destructive operations). */
  danger?: boolean;
}
</script>

<script setup lang="ts">
import { ref } from 'vue';

/**
 * Promise-based confirmation dialog, reused by every destructive action.
 *
 * The parent keeps a template ref and awaits a boolean:
 *
 * ```ts
 * const confirmRef = ref<{ confirm: (o: ConfirmOptions) => Promise<boolean> } | null>(null);
 * if (!(await confirmRef.value?.confirm({ message: 'Delete?' }))) return;
 * ```
 *
 * Only one confirmation can be pending at a time; opening a new one resolves the
 * previous promise with `false` so a caller can never hang.
 */

const open = ref(false);
const title = ref('');
const message = ref('');
const confirmLabel = ref('Confirm');
const cancelLabel = ref('Cancel');
const danger = ref(false);

let resolver: ((value: boolean) => void) | null = null;

function confirm(options: ConfirmOptions): Promise<boolean> {
  if (resolver) resolver(false);
  title.value = options.title ?? 'Are you sure?';
  message.value = options.message;
  confirmLabel.value = options.confirmLabel ?? 'Confirm';
  cancelLabel.value = options.cancelLabel ?? 'Cancel';
  danger.value = options.danger === true;
  open.value = true;
  return new Promise<boolean>((resolve) => {
    resolver = resolve;
  });
}

function finish(result: boolean): void {
  open.value = false;
  const resolve = resolver;
  resolver = null;
  resolve?.(result);
}

defineExpose({ confirm });
</script>

<template>
  <div v-if="open" class="modal-backdrop" @click.self="finish(false)">
    <div class="modal modal-narrow" role="dialog" aria-modal="true">
      <h2 class="section-title">{{ title }}</h2>
      <p class="confirm-message">{{ message }}</p>
      <div class="modal-actions">
        <button
          class="btn"
          :class="danger ? 'btn-danger' : ''"
          type="button"
          @click="finish(true)"
        >
          {{ confirmLabel }}
        </button>
        <button class="btn btn-ghost" type="button" @click="finish(false)">
          {{ cancelLabel }}
        </button>
      </div>
    </div>
  </div>
</template>
