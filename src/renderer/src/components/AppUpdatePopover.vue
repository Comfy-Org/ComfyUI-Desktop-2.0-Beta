<script setup lang="ts">
import { computed } from 'vue'
import { useAppUpdateState } from '../composables/useAppUpdateState'

/**
 * Phase 3 §18 — small floating popover surfaced by the title-bar
 * app-update pill (`PanelApp.vue` mounts this when
 * `currentOverlay.kind === 'app-update'`). Reads the same shared state
 * as `UpdateBanner` via `useAppUpdateState`, so the two surfaces never
 * disagree about what update is pending.
 *
 * No telemetry of its own — the popover is a redundant entry point to
 * the underlying capability and the banner already owns the
 * `desktop2.update.cta` action stream. Users who never dismiss the
 * banner won't even see the popover; the title-bar pill is for users
 * who closed the banner and need a way back in.
 *
 * Pinned to the top-right corner via `position: fixed` so it overlays
 * whatever panel is mounted underneath. Emits `close` for the host to
 * route through `dismissTakeoverDirect` (the popover doesn't need the
 * cancel-prompt that Tier 2/3 ops do — the underlying state is
 * unaffected by the dismiss; the next broadcast repaints).
 */
const { state, canAutoUpdate, systemManaged } = useAppUpdateState()

defineEmits<{ close: [] }>()

const versionLabel = computed<string | null>(() => {
  const s = state.value
  if (!s) return null
  if (s.type === 'available' || s.type === 'ready') return s.version
  return null
})

async function download(): Promise<void> {
  await window.api.downloadUpdate()
}

async function install(): Promise<void> {
  await window.api.installUpdate()
}
</script>

<template>
  <div
    v-if="state"
    class="app-update-popover"
    role="dialog"
    aria-labelledby="app-update-popover-title"
  >
    <div class="app-update-popover-body">
      <p id="app-update-popover-title" class="app-update-popover-title">
        <template v-if="state.type === 'available'">
          {{ $t(systemManaged ? 'update.debAvailable' : 'update.available', { version: versionLabel ?? '' }).replace(/\*\*/g, '') }}
        </template>
        <template v-else-if="state.type === 'ready'">
          {{ $t('update.ready', { version: versionLabel ?? '' }).replace(/\*\*/g, '') }}
        </template>
        <template v-else-if="state.type === 'downloading'">
          {{ $t('update.downloading', { progress: `${Math.round(state.percent)}%` }) }}
        </template>
        <template v-else-if="state.type === 'error'">
          {{ $t('update.checkFailed') }}
        </template>
      </p>

      <div class="app-update-popover-actions">
        <template v-if="state.type === 'available' && canAutoUpdate">
          <button class="primary" type="button" @click="download">
            {{ $t('update.download') }}
          </button>
        </template>
        <template v-else-if="state.type === 'ready'">
          <button class="primary" type="button" @click="install">
            {{ $t('update.restartUpdate') }}
          </button>
        </template>
        <button type="button" @click="$emit('close')">
          {{ $t('update.dismiss') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.app-update-popover {
  position: fixed;
  top: 12px;
  right: 12px;
  z-index: 1000;
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
  min-width: 280px;
  max-width: 360px;
  padding: 12px 14px;
  font: 13px/1.4 var(--font-sans, 'Inter', system-ui, sans-serif);
}

.app-update-popover-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.app-update-popover-title {
  margin: 0;
  font-weight: 500;
  word-break: break-word;
}

.app-update-popover-actions {
  display: flex;
  flex-direction: row;
  gap: 8px;
  justify-content: flex-end;
}

.app-update-popover-actions button {
  background: var(--surface-2, rgba(255, 255, 255, 0.06));
  color: inherit;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 4px 12px;
  font: inherit;
  cursor: pointer;
}

.app-update-popover-actions button.primary {
  background: var(--accent, #3b82f6);
  color: #fff;
  border-color: transparent;
}

.app-update-popover-actions button:hover {
  filter: brightness(1.1);
}
</style>
