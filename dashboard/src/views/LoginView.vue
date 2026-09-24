<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { setApiKey } from '../api/client';

const router = useRouter();

const key = ref('');
const error = ref('');

function submit(): void {
  const value = key.value.trim();
  if (value.length === 0) {
    error.value = 'Enter an API key.';
    return;
  }
  setApiKey(value);
  void router.replace({ name: 'overview' });
}
</script>

<template>
  <div class="center-page">
    <form class="panel login-card stack" @submit.prevent="submit">
      <div>
        <h1>Sign in</h1>
        <p class="muted">
          Paste an API key with the <code>admin</code> scope. It is stored in
          this browser's localStorage and sent with every request.
        </p>
      </div>
      <div class="field">
        <label for="api-key">API key</label>
        <input
          id="api-key"
          v-model="key"
          type="password"
          autocomplete="off"
          spellcheck="false"
          placeholder="sk-..."
        />
      </div>
      <p v-if="error" class="error">{{ error }}</p>
      <button class="btn" type="submit">Continue</button>
    </form>
  </div>
</template>
