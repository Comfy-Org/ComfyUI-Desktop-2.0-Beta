<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import MenuView from './MenuView.vue'
import DownloadsView from './DownloadsView.vue'

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

interface Bridge {
  activate(id: string): void
  close(): void
  ready(): void
  notifyRendered(): void
  onConfig(cb: (config: PopupConfig) => void): () => void
  onDownloadsChanged(cb: (state: DownloadsState) => void): () => void
  /** Ask main to resize the popup view to the given natural content
   *  height (CSS px). Only meaningful for the `'downloads'` kind —
   *  menu kind is sized deterministically from its item list. */
  requestSize(height: number): void
}

const bridge = (window as unknown as { __comfyTitlePopup?: Bridge }).__comfyTitlePopup

const kind = ref<'menu' | 'downloads'>('menu')
const items = ref<MenuItem[]>([])
const themeBg = ref<string>('#262729')
const themeText = ref<string>('#dddddd')
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
  if (kind.value !== 'downloads') return
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
}

onMounted(() => {
  unsubConfig = bridge?.onConfig((cfg) => {
    kind.value = cfg.kind
    items.value = cfg.kind === 'menu' ? cfg.items : []
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
onUnmounted(() => {
  unsubConfig?.()
  unsubDownloads?.()
  window.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <div
    :key="openSeq"
    class="popup"
    :class="{ 'is-light': isLight }"
    :style="{ background: themeBg, color: themeText }"
  >
    <MenuView v-if="kind === 'menu'" :items="items" @activate="handleActivate" />
    <DownloadsView v-else :state="downloadsState" />
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
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  user-select: none;
  overflow: hidden;
  height: 100%;
  width: 100%;
  box-sizing: border-box;
  transform-origin: top center;
  animation: title-popup-fade-in 150ms ease-out;
}

@keyframes title-popup-fade-in {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .popup {
    animation: none;
  }
}
</style>
