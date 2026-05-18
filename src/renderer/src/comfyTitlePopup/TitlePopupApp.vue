<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import MenuView from './MenuView.vue'
import DownloadsView from './DownloadsView.vue'
import InstancePickerView from './InstancePickerView.vue'

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

interface Bridge {
  activate(id: string): void
  close(): void
  ready(): void
  notifyRendered(): void
  onConfig(cb: (config: PopupConfig) => void): () => void
  onDownloadsChanged(cb: (state: DownloadsState) => void): () => void
  onInstancePickerSnapshot(cb: (snapshot: PickerSnapshot) => void): () => void
  /** Ask main to resize the popup view to the given natural content
   *  height (CSS px). Only meaningful for the `'downloads'` and
   *  `'instance-picker'` kinds — menu kind is sized deterministically
   *  from its item list. */
  requestSize(height: number): void
}

const bridge = (window as unknown as { __comfyTitlePopup?: Bridge }).__comfyTitlePopup

const kind = ref<'menu' | 'downloads' | 'instance-picker'>('menu')
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
})
/** Bumped on every `set-config` so the `.popup` root is keyed and Vue
 *  recreates the element on each open, guaranteeing the CSS open
 *  animation replays. The WebContentsView is reused across opens, so
 *  without the key the animation would only run on the very first
 *  mount. */
const openSeq = ref(0)

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
  }
}

onMounted(() => {
  unsubConfig = bridge?.onConfig((cfg) => {
    kind.value = cfg.kind
    items.value = cfg.kind === 'menu' ? cfg.items : []
    if (cfg.kind === 'instance-picker') {
      pickerSnapshot.value = cfg.snapshot
    }
    themeBg.value = cfg.theme.bg
    themeText.value = cfg.theme.text
    openSeq.value++
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
onUnmounted(() => {
  unsubConfig?.()
  unsubDownloads?.()
  unsubInstancePicker?.()
  window.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <div
    :key="openSeq"
    class="popup"
    :class="{ 'is-light': isLight, 'is-picker': kind === 'instance-picker' }"
    :style="{ background: themeBg, color: themeText }"
  >
    <MenuView v-if="kind === 'menu'" :items="items" @activate="handleActivate" />
    <DownloadsView v-else-if="kind === 'downloads'" :state="downloadsState" />
    <InstancePickerView v-else :snapshot="pickerSnapshot" />
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
  transform-origin: top center;
  animation: title-popup-spring-in 240ms cubic-bezier(0.32, 0.72, 0, 1);
}

/* Instance picker surface chrome per Figma — deeper plum bg, 12px
 * radius, layered drop-shadow. Menu / downloads kinds keep the legacy
 * lightweight surface. */
.popup.is-picker {
  background: var(--neutral-800, #211927) !important;
  border-radius: 12px;
  box-shadow:
    0 20px 24px -4px rgba(10, 13, 18, 0.08),
    0 8px 8px -4px rgba(10, 13, 18, 0.03),
    0 3px 3px -1.5px rgba(10, 13, 18, 0.04);
}

@keyframes title-popup-spring-in {
  from {
    opacity: 0;
    transform: scale(0.96) translateY(-8px);
  }
  to {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .popup {
    animation: none;
  }
}
</style>
