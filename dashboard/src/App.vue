<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { clearApiKey } from './api/client';

const route = useRoute();
const router = useRouter();

const navItems = [
  { name: 'overview', label: 'Overview' },
  { name: 'models', label: 'Models' },
  { name: 'clients', label: 'Clients' },
  { name: 'aliases', label: 'Aliases' },
  { name: 'logs', label: 'Logs' },
] as const;

// The login screen is chrome-less; every authenticated view shares the nav.
const showNav = computed(() => route.name !== 'login');

function signOut(): void {
  clearApiKey();
  void router.replace({ name: 'login' });
}
</script>

<template>
  <div class="layout">
    <header v-if="showNav" class="topbar">
      <span class="brand">ms-gateway-llm · admin</span>
      <nav class="nav">
        <RouterLink
          v-for="item in navItems"
          :key="item.name"
          class="nav-link"
          :to="{ name: item.name }"
        >
          {{ item.label }}
        </RouterLink>
      </nav>
      <button class="btn btn-ghost" type="button" @click="signOut">Sign out</button>
    </header>
    <main class="content">
      <RouterView />
    </main>
  </div>
</template>
