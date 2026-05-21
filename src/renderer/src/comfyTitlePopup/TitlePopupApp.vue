<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import MenuView from './MenuView.vue'
import DownloadsView from './DownloadsView.vue'
import InstancePickerView from './InstancePickerView.vue'
import GlobalSettingsView from './GlobalSettingsView.vue'
import ModalDialog from '../components/ModalDialog.vue'
import type { DetailSection, SnapshotListData } from '../types/ipc'

/**
 * Title-bar dropdown popup shell.
 *
 * Hosts every title-bar dropdown (waffle menu, downloads tray, …)
 * inside one transparent `WebContentsView` attached to the host window
 * so we get theme-matched chrome and no clipping by the title-bar
 * view's bounds.
 *
 * The view is reused across opens (created once per parent window,
 * hidden between uses) so opening feels instant after the first paint.
 * Each open arrives as a `comfy-titlepopup:set-config` IPC carrying
 * kind + theme (+ items for the menu kind); the renderer re-renders
 * before main shows the view.
 */

interface MenuItem {
  id?: string
  label?: string
  /** Optional vue-i18n key — MenuView resolves it against the
   *  shared en catalog. */
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

interface PickerSnapshot {
  installs: PickerInstall[]
  activeInstallationId: string | null
  runningInstallationIds: string[]
  /** Per-row Settings + Snapshots payload for the picker's right
   *  pane. Scoped to the picker's currently-selected install (changes
   *  every time the user clicks a different row; popup tells main via
   *  `setPickerSelectedInstall` and main rebroadcasts). Null fields
   *  mean "no selection / no install path / source failure" — the
   *  picker renders the empty state in that case. */
  selectedInstallationId: string | null
  selectedSettings: DetailSection[] | null
  selectedSnapshots: SnapshotListData | null
}

interface GlobalSettingsModelsDir {
  path: string
  isPrimary: boolean
  isDefault: boolean
}

interface GlobalSettingsSnapshot {
  overviewFields: Record<string, unknown>[]
  cacheFields: Record<string, unknown>[]
  advancedFields: Record<string, unknown>[]
  sharedDirectoriesFields: Record<string, unknown>[]
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
  channelPickerField: Record<string, unknown> | null
  activeInstallationId: string | null
  hasActiveInstall: boolean
  githubUrl: string
  i18n: {
    overview: string
    updates: string
    cache: string
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
  /** Ask main to resize the popup view to the given natural content
   *  height (CSS px). Only meaningful for the `'downloads'` /
   *  `'instance-picker'` / `'global-settings'` kinds — menu kind is
   *  sized deterministically from its item list. */
  requestSize(height: number): void
  /** Per-open notification — fires on every show including the fast
   *  path that skips `set-config`. Used to bump `openSeq` so popup
   *  views can reset transient per-open state. */
  onWillShow(cb: (info: { kind: 'menu' | 'downloads' | 'instance-picker' | 'global-settings' }) => void): () => void
}

const bridge = (window as unknown as { __comfyTitlePopup?: Bridge }).__comfyTitlePopup

const kind = ref<'menu' | 'downloads' | 'instance-picker' | 'global-settings'>('menu')
const items = ref<MenuItem[]>([])
const themeBg = ref<string>('#262729')
const themeText = ref<string>('#dddddd')
/** Latest instance-picker snapshot — owned at the app level so the
 *  initial state from `set-config` AND subsequent live pushes via
 *  `comfy-titlepopup:installs-changed` both land here, regardless of
 *  whether `<InstancePickerView>` is currently mounted. */
const pickerSnapshot = ref<PickerSnapshot>({
  installs: [],
  activeInstallationId: null,
  runningInstallationIds: [],
  selectedInstallationId: null,
  selectedSettings: null,
  selectedSnapshots: null
})
/** Latest global-settings snapshot — same lifecycle as `pickerSnapshot`. */
const globalSettingsSnapshot = ref<GlobalSettingsSnapshot>({
  overviewFields: [],
  cacheFields: [],
  advancedFields: [],
  sharedDirectoriesFields: [],
  modelsDirs: [],
  modelsSystemDefault: '',
  appUpdate: {
    state: { kind: null, version: null, autoUpdate: true },
    progress: null,
    isDownloading: false,
    capabilities: { systemManaged: false, canSelfUpdate: true },
    installedVersion: '',
    platform: 'darwin',
    lastCheckedAt: null,
  },
  channelPickerField: null,
  activeInstallationId: null,
  hasActiveInstall: false,
  githubUrl: '',
  i18n: {
    overview: 'Overview',
    updates: 'Updates',
    cache: 'Cache',
    models: 'Models',
    advanced: 'Advanced',
    sharedDirectories: 'Shared Directories',
  },
})
/** Owned at the app level — the listener stays registered for the
 *  popup's entire lifetime so the initial state push from main on a
 *  fresh `'downloads'` open lands even though `<DownloadsView>` is not
 *  mounted yet at that instant (its mount is gated on `kind` flipping
 *  via `set-config`, which arrives after the snapshot push). */
const downloadsState = ref<DownloadsState>({ active: [], recent: [] })

/** Body-luminance test — drives is-light styling (lighter hover state),
 *  matching the convention in TitleBarApp.vue. */
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

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    bridge?.close()
  }
}

let unsubConfig: (() => void) | undefined
let unsubDownloads: (() => void) | undefined
let unsubInstancePicker: (() => void) | undefined
let unsubGlobalSettings: (() => void) | undefined
let unsubWillShow: (() => void) | undefined

/** Sequence counter — only the rAF closure for the most recently
 *  applied config gets to fire `notifyRendered`. Without this guard,
 *  rapid `set-config` pushes would queue overlapping rAFs that all ack
 *  back to main, generating redundant IPC noise and (worst case)
 *  marking an older config as "synced" if its rAF happens to fire
 *  after main has already advanced `lastConfigJson`. */
let renderSeq = 0

/** Measure the popup's natural content height and ask main to size
 *  the WebContentsView to fit. Downloads kind only — menu kind is
 *  sized deterministically main-side from its item list. */
function measureAndRequestSize(): void {
  if (kind.value === 'downloads') {
    // Header is only rendered when there's something to clear; treat
    // missing as 0px contribution.
    const headEl = document.querySelector('.downloads-head') as HTMLElement | null
    const listEl = document.querySelector('.downloads-list, .downloads-empty') as HTMLElement | null
    const footEl = document.querySelector('.downloads-foot') as HTMLElement | null
    if (!footEl || !listEl) return
    let listH: number
    if (listEl.classList.contains('downloads-list')) {
      // `.downloads-list` is `flex: 1 1 auto` so it stretches to fill
      // the popup body — `scrollHeight` would equal `clientHeight` when
      // the items fit (per the CSS spec: with no overflow,
      // `scrollHeight === clientHeight`), reporting the flex-allocated
      // size instead of the natural content size. Sum the children's
      // own offset heights to get the unstretched height the list wants.
      let childrenH = 0
      for (const child of listEl.children) {
        childrenH += (child as HTMLElement).offsetHeight
      }
      const cs = getComputedStyle(listEl)
      listH = childrenH + parseFloat(cs.paddingTop || '0') + parseFloat(cs.paddingBottom || '0')
    } else {
      // `.downloads-empty` shrinks to content, so its `offsetHeight` is
      // already the natural rendered size.
      listH = listEl.offsetHeight
    }
    // +2 for the .popup card's 1px top + 1px bottom border so the inner
    // content lands inside the bordered card without clipping the last
    // row.
    const total = (headEl?.offsetHeight ?? 0) + listH + footEl.offsetHeight + 2
    bridge?.requestSize(total)
    return
  }
  if (kind.value === 'instance-picker') {
    // Picker measures its rendered root and asks main to size the popup
    // view to fit. Main clamps to the ceiling band so the popup never
    // overflows the host window.
    const rootEl = document.querySelector('.picker') as HTMLElement | null
    if (!rootEl) return
    bridge?.requestSize(rootEl.offsetHeight + 2)
    return
  }
  if (kind.value === 'global-settings') {
    const rootEl = document.querySelector('.global-settings') as HTMLElement | null
    if (!rootEl) return
    bridge?.requestSize(rootEl.offsetHeight + 2)
  }
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
    // Do NOT bump openSeq here. Main always sends `will-show` right
    // after `set-config` on every open, and that handler bumps the
    // seq. Bumping here too caused a double remount → the popup
    // animated in, the keyed root tore down, then animated in again
    // → visible flicker on the first frame of every open.
    const seq = ++renderSeq
    // Ack after Vue has flushed the DOM update *and* the browser has
    // had a chance to paint it. Main keeps the popup view hidden until
    // this ack arrives so the user never sees a frame of the previous
    // open's content on a new open. The seq guard suppresses stale
    // rAFs queued by earlier configs. Measure-and-request-size runs
    // *before* the rendered ack so main has the correct bounds applied
    // by the time it flips the view visible — without this the popup
    // would flash up at the previous open's height and then resize.
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
  // `onWillShow` fires on every open (including the fast-path reopen
  // that doesn't re-send `set-config`). We deliberately do NOT bump
  // a key to re-mount the root here — re-mounting after the
  // WebContentsView is already visible was the visible flicker on
  // 2nd+ opens. The picker view's local state (selectedId, accordion
  // open flags) intentionally persists across reopens of the same
  // host; transient resets that used to depend on the remount now
  // ride on `props.snapshot.activeInstallationId` changes via the
  // existing prop watcher in `InstancePickerView.vue`.
  unsubWillShow = bridge?.onWillShow(() => {
    /* no-op for now — kept registered for forward compatibility */
  })
  window.addEventListener('keydown', handleKeydown)
  // Tell main the renderer is mounted and listening — main flushes any
  // config that was queued before this point.
  bridge?.ready()
})

// Re-measure whenever the downloads state changes (entries added /
// removed / status transitions / dismissals) so the shelf grows and
// shrinks to fit. Wait one frame so Vue has flushed the DOM update.
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
// Re-measure when the picker snapshot changes — install added/removed
// affects the list height, and the row count can flip past the popup
// ceiling without an open-time `requestSize`.
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
// Re-measure when the global-settings snapshot changes — accordion
// counts + field values affect natural height.
watch(
  globalSettingsSnapshot,
  () => {
    void nextTick(() => {
      requestAnimationFrame(() => {
        measureAndRequestSize()
      })
    })
  },
  { deep: true }
)
onUnmounted(() => {
  unsubConfig?.()
  unsubDownloads?.()
  unsubInstancePicker?.()
  unsubGlobalSettings?.()
  unsubWillShow?.()
  window.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <!-- No `:key` on the root.
       Keying the root by `openSeq` unmounts + remounts the popup on
       every reopen so the CSS open animation replays — but for a
       reused WebContentsView that unmount happens AFTER `showOnTop()`
       has made the view visible, so the user sees the popup appear,
       its DOM tear down (looks like a close), and the freshly-mounted
       DOM animate back in. That was the visible "open → close → open"
       flicker on the 2nd+ click. VS Code / Cursor dropdowns just
       appear; we do the same — no key, no animation. -->
  <div
    class="popup"
    :class="{
      'is-light': isLight,
      'is-picker': kind === 'instance-picker',
      'is-global-settings': kind === 'global-settings',
    }"
    :style="{ background: themeBg, color: themeText }"
  >
    <MenuView v-if="kind === 'menu'" :items="items" @activate="handleActivate" />
    <DownloadsView v-else-if="kind === 'downloads'" :state="downloadsState" />
    <InstancePickerView v-else-if="kind === 'instance-picker'" :snapshot="pickerSnapshot" />
    <GlobalSettingsView v-else :snapshot="globalSettingsSnapshot" />
    <!-- Singleton ModalDialog host for `useModal.confirm/alert/select`
         calls fired by anything inside the popup (per-install settings
         UI's confirm chains, snapshot prompts, etc.). The panel mounts
         its own copy; this one keeps `useModal` working inside the
         popup's separate WebContentsView. -->
    <ModalDialog />
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

/* Instance picker surface chrome per Figma. Menu / downloads kinds keep
 * the legacy lightweight surface. */
.popup.is-picker,
.popup.is-global-settings {
  background: var(--neutral-800, #211927) !important;
  border: 1px solid var(--chooser-surface-border);
  border-radius: 12px;
  box-shadow:
    0 20px 24px -4px rgba(10, 13, 18, 0.08),
    0 8px 8px -4px rgba(10, 13, 18, 0.03),
    0 3px 3px -1.5px rgba(10, 13, 18, 0.04);
}
</style>
