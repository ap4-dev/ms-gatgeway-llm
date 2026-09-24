<script setup lang="ts">
import { useRoute } from 'vue-router';

const route = useRoute();
</script>

<template>
  <section class="panel">
    <h1>{{ route.meta.title ?? 'Coming soon' }}</h1>
    <p class="muted">This view is coming in the next phase.</p>
  </section>
</template>
