<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useNavigation } from '../composables/useNavigation'
import type { OverlayEntry, OverlayKey, OverlayPropsMap } from '../composables/useNavigation'
import type { Installation } from '../types/ipc'

import DetailModal from '../views/DetailModal.vue'
import ConsoleModal from '../views/ConsoleModal.vue'
import ProgressModal from '../views/ProgressModal.vue'
import NewInstallModal from '../views/NewInstallModal.vue'
import QuickInstallModal from '../views/QuickInstallModal.vue'
import TrackModal from '../views/TrackModal.vue'
import LoadSnapshotModal from '../views/LoadSnapshotModal.vue'

const emit = defineEmits<{
  'show-progress': [
    opts: {
      installationId: string
      title: string
      apiCall: () => Promise<unknown>
      cancellable?: boolean
      returnTo?: string
    }
  ]
  'show-detail': [installationId: string]
  'show-console': [installationId: string]
  'navigate-list': []
  'update:installation': [inst: Installation]
  'overlay-closed': [key: OverlayKey]
}>()

const nav = useNavigation()


// --- Props accessors (avoids inline import() casts in template) ---
function propsAs<K extends keyof OverlayPropsMap>(entry: OverlayEntry, _key: K): OverlayPropsMap[K] {
  return entry.props as OverlayPropsMap[K]
}

// --- Overlay dismiss helpers ---
const mouseDownOnOverlay = ref<string | null>(null)

function handleOverlayMouseDown(event: MouseEvent, entry: OverlayEntry): void {
  if (event.target === event.currentTarget) {
    mouseDownOnOverlay.value = entry.id
  }
}

function handleOverlayClick(event: MouseEvent, entry: OverlayEntry): void {
  if (mouseDownOnOverlay.value === entry.id && event.target === event.currentTarget) {
    handleClose(entry.key)
  }
  mouseDownOnOverlay.value = null
}

function handleEscapeKey(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  const top = nav.topOverlay.value
  if (!top) return
  event.stopImmediatePropagation()
  handleClose(top.key)
}

onMounted(() => {
  document.addEventListener('keydown', handleEscapeKey)
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleEscapeKey)
})

// --- Event forwarding ---
function handleClose(key: OverlayKey): void {
  nav.dismiss(key)
  emit('overlay-closed', key)
}

</script>

<template>
  <template v-for="(entry, index) in nav.overlays.value" :key="entry.id">
    <div
      :class="entry.mode === 'fullscreen' ? 'view-fullscreen' : 'view-modal active'"
      :data-overlay-key="entry.key"
      :data-overlay-mode="entry.mode"
      :style="{ zIndex: (entry.mode === 'fullscreen' ? 40 : 50) + index }"
      @mousedown="entry.mode === 'modal' ? handleOverlayMouseDown($event, entry) : undefined"
      @click="entry.mode === 'modal' ? handleOverlayClick($event, entry) : undefined"
    >
      <!-- Detail -->
      <DetailModal
        v-if="entry.key === 'detail'"
        :installation="propsAs(entry, 'detail').installation"
        :initial-tab="propsAs(entry, 'detail').initialTab"
        :auto-action="propsAs(entry, 'detail').autoAction"
        @close="handleClose('detail')"
        @show-progress="(opts) => emit('show-progress', opts)"
        @navigate-list="emit('navigate-list')"
        @update:installation="(inst) => emit('update:installation', inst)"
      />

      <!-- Console -->
      <ConsoleModal
        v-else-if="entry.key === 'console'"
        :installation-id="propsAs(entry, 'console').installationId"
        @close="handleClose('console')"
      />

      <!-- Progress -->
      <ProgressModal
        v-else-if="entry.key === 'progress'"
        :installation-id="propsAs(entry, 'progress').installationId"
        @close="handleClose('progress')"
        @show-detail="(id) => emit('show-detail', id)"
        @show-console="(id) => emit('show-console', id)"
      />

      <!-- New Install -->
      <NewInstallModal
        v-else-if="entry.key === 'new-install'"
        @close="handleClose('new-install')"
        @show-progress="(opts) => emit('show-progress', opts)"
        @navigate-list="emit('navigate-list')"
      />

      <!-- Quick Install -->
      <QuickInstallModal
        v-else-if="entry.key === 'quick-install'"
        @close="handleClose('quick-install')"
        @show-progress="(opts) => emit('show-progress', opts)"
      />

      <!-- Track -->
      <TrackModal
        v-else-if="entry.key === 'track'"
        @close="handleClose('track')"
        @navigate-list="emit('navigate-list')"
      />

      <!-- Load Snapshot -->
      <LoadSnapshotModal
        v-else-if="entry.key === 'load-snapshot'"
        @close="handleClose('load-snapshot')"
        @show-progress="(opts) => emit('show-progress', opts)"
      />
    </div>
  </template>
</template>
