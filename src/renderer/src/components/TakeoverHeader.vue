<script setup lang="ts">
/**
 * Phase 3 §19 — shared grand title + subtitle for the Tier 3
 * takeover modals (NewInstallModal, TrackModal, LoadSnapshotModal,
 * QuickInstallModal, FirstUseTakeover). Sits at the top of each
 * takeover's `.view-modal-header` and survives across internal steps
 * (e.g. NewInstallModal's per-step `stepTitle` reads as a sub-section
 * heading inside the body now, not the page heading).
 *
 * The component owns title + subtitle markup only — the close button
 * stays in the host modal's existing `.view-modal-header` row so each
 * modal keeps control of its own dismiss behaviour.
 */
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
  /* Sit at the top of `.view-modal-header` next to the close button.
     The host modal's `.view-modal-header` already provides the
     padding gutter — we only need the internal title / subtitle
     spacing here. */
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
