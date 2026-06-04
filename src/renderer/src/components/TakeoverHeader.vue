<script setup lang="ts">
// Shared grand title + subtitle for the Tier 3 takeover modals.
defineProps<{
  title: string
  subtitle?: string
}>()
</script>

<template>
  <div class="takeover-header">
    <div class="takeover-grand-title">{{ title }}</div>
    <div v-if="subtitle" class="takeover-grand-subtitle">{{ subtitle }}</div>
  </div>
</template>

<style scoped>
.takeover-header {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1 1 auto;
  min-width: 0;
}

.takeover-grand-title {
  font-size: 20px;
  font-weight: 600;
  color: var(--text);
  line-height: 1.2;
  word-break: break-word;
}

.takeover-grand-subtitle {
  font-size: 13px;
  color: var(--text-muted);
  line-height: 1.4;
  word-break: break-word;
}
</style>
