<script setup lang="ts">
// Intentionally NOT a variant of `components/DetailSection.vue`:
// DetailSection is the legacy install-scoped detail surface (channel
// cards, items, fields, args/env editors, IPC writes) and is marked
// `TODO(stale-old-modal)` for deletion. Coupling the new global-
// settings UI to it would block that removal.
defineProps<{
  title: string
}>()
</script>

<template>
  <section class="gs-micro-section">
    <h3 class="gs-micro-title">{{ title }}</h3>
    <div class="gs-micro-body">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.gs-micro-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.gs-micro-title {
  margin: 0;
  padding: 0 0 4px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
  opacity: 0.55;
}

.gs-micro-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
</style>
