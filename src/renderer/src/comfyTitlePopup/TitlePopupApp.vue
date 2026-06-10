<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import MenuView from './MenuView.vue'
import DownloadsView from './DownloadsView.vue'
import InstancePickerView from './InstancePickerView.vue'
import GlobalSettingsView from './GlobalSettingsView.vue'
import ModalDialog from '../components/ModalDialog.vue'
import DialogHost from '../components/DialogHost.vue'
import { useModal } from '../composables/useModal'
import { dismissPickerModals } from './dismissPickerModals'
import type { DetailSection, SnapshotListData } from '../types/ipc'

// Title-bar dropdown popup shell. Hosts every title-bar dropdown in one
// reused transparent WebContentsView attached to the host window. Each open
// arrives as a `comfy-titlepopup:set-config` IPC carrying kind + theme.

interface MenuItem {
  id?: string
  label?: string
  labelKey?: string
  checked?: boolean
  kind?: 'separator'
}

interface DownloadEntry {
  url: string
  filename: string
  directory?: string
  savePath?: string
  progress: number
  receivedBytes?: number
  totalBytes?: number
  speedBytesPerSec?: number
  etaSeconds?: number
  status: 'pending' | 'downloading' | 'paused' | 'completed' | 'error' | 'cancelled'
  error?: string
  createdAt?: number
  isImage?: boolean
}

interface DownloadsState {
  active: DownloadEntry[]
  recent: DownloadEntry[]
}

interface PickerInstall {
  id: string
  name: string
  sourceLabel: string
  sourceCategory: string
  version?: string
  lastLaunchedAt?: number
  installPath?: string
  status?: string
  statusTag?: { style: string; label: string }
}

interface PickerStorageDir {
  path: string
  isPrimary: boolean
}

/** Must stay in sync with `PickerStorageSlice` in `src/main/popups/titlePopup.ts`. */
interface PickerStorageSlice {
  sharedDirectoriesFields: Record<string, unknown>[]
  modelsDirs: PickerStorageDir[]
  modelsSystemDefault: string
}

interface PickerSnapshot {
  installs: PickerInstall[]
  activeInstallationId: string | null
  runningInstallationIds: string[]
  /** Installs mid-launch. Hydrated into sessionStore because the popup
   *  preload doesn't expose onInstanceLaunching. */
  launchingInstallationIds: string[]
  selectedInstallationId: string | null
  /** Bumped only when main intentionally retargets the selection; gates
   *  the picker view's apply-over-local-pick so stale rebroadcasts can't
   *  snap back after a fast click. */
  pickerSelectionEpoch?: number
  selectedSettings: DetailSection[] | null
  selectedSnapshots: SnapshotListData | null
  storage: PickerStorageSlice
}

interface GlobalSettingsModelsDir {
  path: string
  isPrimary: boolean
}

interface GlobalSettingsSnapshot {
  generalFields: Record<string, unknown>[]
  languageFields: Record<string, unknown>[]
  telemetryFields: Record<string, unknown>[]
  desktopUpdateFields: Record<string, unknown>[]
  cacheFields: Record<string, unknown>[]
  advancedFields: Record<string, unknown>[]
  sharedDirectoriesFields: Record<string, unknown>[]
  installLocationFields: Record<string, unknown>[]
  modelsDirs: GlobalSettingsModelsDir[]
  modelsSystemDefault: string
  appUpdate: {
    state: Record<string, unknown>
    progress: Record<string, unknown> | null
    isDownloading: boolean
    capabilities: { systemManaged: boolean; canSelfUpdate: boolean }
    installedVersion: string
    platform: string
    lastCheckedAt: number | null
  }
  githubUrl: string
  githubStars: number | null
  githubStarsLoading: boolean
  i18n: {
    overview: string
    updates: string
    storage: string
    models: string
    advanced: string
    sharedDirectories: string
  }
}

type PopupConfig =
  | {
      kind: 'menu'
      items: MenuItem[]
      theme: { bg: string; text: string }
    }
  | {
      kind: 'downloads'
      theme: { bg: string; text: string }
    }
  | {
      kind: 'instance-picker'
      snapshot: PickerSnapshot
      theme: { bg: string; text: string }
    }
  | {
      kind: 'global-settings'
      snapshot: GlobalSettingsSnapshot
      theme: { bg: string; text: string }
    }

interface Bridge {
  activate(id: string): void
  close(): void
  ready(): void
  notifyRendered(): void
  onConfig(cb: (config: PopupConfig) => void): () => void
  onDownloadsChanged(cb: (state: DownloadsState) => void): () => void
  onInstancePickerSnapshot(cb: (snapshot: PickerSnapshot) => void): () => void
  onGlobalSettingsSnapshot(cb: (snapshot: GlobalSettingsSnapshot) => void): () => void
  /** Resize the popup view to fit the given natural content height (CSS px).
   *  Menu kind is sized deterministically main-side instead. */
  requestSize(height: number): void
  onWillShow(
    cb: (info: { kind: 'menu' | 'downloads' | 'instance-picker' | 'global-settings' }) => void
  ): () => void
  /** Cancel any open useModal / useDialogs entry so a half-open confirm
   *  doesn't survive a kind-switch as orphaned Vue state. */
  onDismissModals(cb: () => void): () => void
}

const bridge = (window as unknown as { __comfyTitlePopup?: Bridge }).__comfyTitlePopup

const kind = ref<'menu' | 'downloads' | 'instance-picker' | 'global-settings'>('menu')
const items = ref<MenuItem[]>([])
const themeBg = ref<string>('#262729')
const themeText = ref<string>('#dddddd')
/** App-level so both the initial set-config state and subsequent live
 *  pushes land here regardless of whether InstancePickerView is mounted. */
const pickerSnapshot = ref<PickerSnapshot>({
  installs: [],
  activeInstallationId: null,
  runningInstallationIds: [],
  launchingInstallationIds: [],
  selectedInstallationId: null,
  pickerSelectionEpoch: 0,
  selectedSettings: null,
  selectedSnapshots: null,
  storage: { sharedDirectoriesFields: [], modelsDirs: [], modelsSystemDefault: '' }
})
const globalSettingsSnapshot = ref<GlobalSettingsSnapshot>({
  generalFields: [],
  languageFields: [],
  telemetryFields: [],
  desktopUpdateFields: [],
  cacheFields: [],
  advancedFields: [],
  sharedDirectoriesFields: [],
  installLocationFields: [],
  modelsDirs: [],
  modelsSystemDefault: '',
  appUpdate: {
    state: { kind: null, version: null, autoUpdate: true },
    progress: null,
    isDownloading: false,
    capabilities: { systemManaged: false, canSelfUpdate: true },
    installedVersion: '',
    platform: 'darwin',
    lastCheckedAt: null
  },
  githubUrl: '',
  githubStars: null,
  githubStarsLoading: false,
  i18n: {
    overview: 'General',
    updates: 'Updates',
    storage: 'Storage',
    models: 'Models',
    advanced: 'Advanced',
    sharedDirectories: 'Shared Directories'
  }
})
/** App-level so the initial downloads push lands even though DownloadsView
 *  isn't mounted yet (its mount is gated on a later set-config). */
const downloadsState = ref<DownloadsState>({ active: [], recent: [] })

/** Body-luminance test driving is-light styling; matches TitleBarApp.vue. */
const isLight = computed(() => {
  const ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return false
  ctx.fillStyle = themeBg.value
  const hex = ctx.fillStyle as string
  if (!hex.startsWith('#') || hex.length < 7) return false
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return (r * 299 + g * 587 + b * 114) / 1000 >= 128
})

function handleActivate(id: string): void {
  bridge?.activate(id)
}

const { state: modalState } = useModal()

function handleKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  // Defer to the popup's own ModalDialog when open; otherwise ESC would
  // close the popup and drop the modal's in-flight action promise.
  if (modalState.visible) return
  event.preventDefault()
  bridge?.close()
}

let unsubConfig: (() => void) | undefined
let unsubDownloads: (() => void) | undefined
let unsubInstancePicker: (() => void) | undefined
let unsubGlobalSettings: (() => void) | undefined
let unsubWillShow: (() => void) | undefined
let unsubDismissModals: (() => void) | undefined

/** Guards `notifyRendered`: only the rAF closure for the most recently
 *  applied config acks, so an older config can't be marked synced. */
let renderSeq = 0

/** Measure natural content height and ask main to size the view to fit.
 *  Menu kind is sized deterministically main-side instead. */
function measureAndRequestSize(): void {
  if (kind.value === 'downloads') {
    const headEl = document.querySelector('.downloads-head') as HTMLElement | null
    const listEl = document.querySelector('.downloads-list, .downloads-empty') as HTMLElement | null
    const footEl = document.querySelector('.downloads-foot') as HTMLElement | null
    if (!footEl || !listEl) return
    let listH: number
    if (listEl.classList.contains('downloads-list')) {
      // `.downloads-list` is flex-stretched, so scrollHeight reports the
      // allocated size; sum children offset heights for the natural height.
      let childrenH = 0
      for (const child of listEl.children) {
        childrenH += (child as HTMLElement).offsetHeight
      }
      const cs = getComputedStyle(listEl)
      listH = childrenH + parseFloat(cs.paddingTop || '0') + parseFloat(cs.paddingBottom || '0')
    } else {
      listH = listEl.offsetHeight
    }
    // +2 for the .popup card's 1px top + bottom border.
    const total = (headEl?.offsetHeight ?? 0) + listH + footEl.offsetHeight + 2
    bridge?.requestSize(total)
    return
  }
  if (kind.value === 'instance-picker') {
    const rootEl = document.querySelector('.picker') as HTMLElement | null
    if (!rootEl) return
    bridge?.requestSize(rootEl.offsetHeight + 2)
  }
  // global-settings is sized once main-side and doesn't grow with content.
}

onMounted(() => {
  unsubConfig = bridge?.onConfig((cfg) => {
    kind.value = cfg.kind
    items.value = cfg.kind === 'menu' ? cfg.items : []
    if (cfg.kind === 'instance-picker') {
      pickerSnapshot.value = cfg.snapshot
    } else if (cfg.kind === 'global-settings') {
      globalSettingsSnapshot.value = cfg.snapshot
    }
    themeBg.value = cfg.theme.bg
    themeText.value = cfg.theme.text
    const seq = ++renderSeq
    // Ack after Vue flushes the DOM and the browser paints it; main keeps
    // the view hidden until then so no frame of the previous open shows.
    // Measure before the ack so main has correct bounds before it reveals.
    void nextTick(() => {
      requestAnimationFrame(() => {
        if (seq !== renderSeq) return
        measureAndRequestSize()
        bridge?.notifyRendered()
      })
    })
  })
  unsubDownloads = bridge?.onDownloadsChanged((next) => {
    downloadsState.value = next
  })
  unsubInstancePicker = bridge?.onInstancePickerSnapshot((snapshot) => {
    pickerSnapshot.value = snapshot
  })
  unsubGlobalSettings = bridge?.onGlobalSettingsSnapshot((snapshot) => {
    globalSettingsSnapshot.value = snapshot
  })
  // Deliberately does NOT re-key/remount the root: remounting after the
  // WebContentsView is visible caused flicker on 2nd+ opens. Picker local
  // state persists across reopens; transient resets ride on the
  // activeInstallationId prop watcher in InstancePickerView.vue.
  //
  // Every reopen also clears any pending `useModal` / `useDialogs` entry —
  // a confirm prompt left open when the user blurred the popup would
  // otherwise resurface on top of the picker the next time it's shown,
  // looking stuck (issue raised during version-picker review).
  unsubWillShow = bridge?.onWillShow(() => {
    dismissPickerModals()
  })
  unsubDismissModals = bridge?.onDismissModals(() => {
    dismissPickerModals()
  })
  window.addEventListener('keydown', handleKeydown)
  // Tell main the renderer is listening so it flushes any queued config.
  bridge?.ready()
})

// Re-measure on downloads-state change so the shelf grows/shrinks to fit.
watch(
  downloadsState,
  () => {
    void nextTick(() => {
      requestAnimationFrame(() => {
        measureAndRequestSize()
      })
    })
  },
  { deep: true }
)
// Re-measure on picker-snapshot change so an add/remove can re-clamp height.
watch(
  pickerSnapshot,
  () => {
    void nextTick(() => {
      requestAnimationFrame(() => {
        measureAndRequestSize()
      })
    })
  },
  { deep: true }
)
// global-settings is pinned to a fixed main-side size, so no re-measure.
onUnmounted(() => {
  unsubConfig?.()
  unsubDownloads?.()
  unsubInstancePicker?.()
  unsubGlobalSettings?.()
  unsubWillShow?.()
  unsubDismissModals?.()
  window.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <!-- No `:key` on the root: keying by openSeq remounts on every reopen,
       which for a reused WebContentsView caused an "open → close → open"
       flicker on 2nd+ clicks. -->
  <div
    class="popup"
    :class="{
      'is-light': isLight,
      'is-menu': kind === 'menu',
      'is-picker': kind === 'instance-picker',
      'is-global-settings': kind === 'global-settings'
    }"
    :style="{ background: themeBg, color: themeText }"
  >
    <MenuView v-if="kind === 'menu'" :items="items" @activate="handleActivate" />
    <DownloadsView v-else-if="kind === 'downloads'" :state="downloadsState" />
    <InstancePickerView v-else-if="kind === 'instance-picker'" :snapshot="pickerSnapshot" />
    <GlobalSettingsView v-else :snapshot="globalSettingsSnapshot" />
    <!-- Keeps useModal working inside the popup's separate WebContentsView. -->
    <ModalDialog />
    <!-- Host for the useDialogs API; lives alongside ModalDialog until migration. -->
    <DialogHost />
  </div>
</template>

<style scoped>
:global(html),
:global(body),
:global(#app) {
  margin: 0;
  width: 100%;
  height: 100%;
  background: transparent !important;
}

.popup {
  margin: 0;
  border: 1px solid var(--chooser-surface-border);
  border-radius: 8px;
  user-select: none;
  overflow: hidden;
  height: 100%;
  width: 100%;
  box-sizing: border-box;
}

/* `!important` overrides the inline background/color on `.popup` so the
 * menu surface stays consistent across hosts. */
.popup.is-menu {
  background: var(--neutral-800) !important;
  color: var(--neutral-100) !important;
  border-color: var(--chooser-surface-border);
  font-size: 13px;
}

/* Instance picker + Global Settings share the in-app modal-card chrome. */
.popup.is-picker,
.popup.is-global-settings {
  background: var(--modal-surface-bg) !important;
  border: 1px solid var(--modal-surface-border);
  border-radius: 14px;
  box-shadow: var(--modal-surface-shadow);
}
</style>
