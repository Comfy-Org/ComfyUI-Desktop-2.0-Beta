<script setup lang="ts">
import { computed } from 'vue'

defineProps<{
  title?: string
}>()

const isMac = computed(() => navigator.userAgent.toLowerCase().includes('mac'))
</script>

<template>
  <header class="titlebar" :class="{ 'titlebar--mac': isMac }">
    <div class="titlebar-drag-region">
      <span v-if="title" class="titlebar-title">{{ title }}</span>
    </div>
  </header>
</template>

<style scoped>
.titlebar {
  height: var(--titlebar-height, 37px);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  background: var(--surface);
  position: relative;
  z-index: 1000;
  box-sizing: border-box;
  border-bottom: 1px solid var(--border);
}

.titlebar-drag-region {
  flex: 1;
  min-width: 0;
  height: 100%;
  display: flex;
  align-items: center;
  padding-left: 12px;
  padding-right: 140px;
  app-region: drag;
}

/* On macOS, leave room for the traffic light buttons (close/minimize/maximize) */
.titlebar--mac .titlebar-drag-region {
  padding-left: 78px;
  padding-right: 12px;
}

.titlebar-title {
  font-size: 12px;
  color: var(--text-muted);
  user-select: none;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
