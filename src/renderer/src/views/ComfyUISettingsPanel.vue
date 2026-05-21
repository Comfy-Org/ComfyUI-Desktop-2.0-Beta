<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { X } from 'lucide-vue-next'
import ComfyUISettingsContent, {
  type ComfyUISettingsTab,
} from '../components/settings/ComfyUISettingsContent.vue'
import type { Installation, ShowProgressOpts } from '../types/ipc'

/**
 * Brand-redesigned Settings drawer (v2). Right-anchored slide-in panel
 * triggered by the title-bar Settings icon. The body (tab strip,
 * scrollable section list, footer) is delegated to
 * `<ComfyUISettingsContent>` so the same UI can be reused inside the
 * instance-picker's expanded right pane.
 *
 * This file owns drawer chrome only: backdrop, slide-in `<aside>`,
 * header (title + close), focus trap, and ESC/Tab handlers.
 */

interface Props {
  open: boolean
  installation: Installation | null
  initialTab?: ComfyUISettingsTab
}

const props = withDefaults(defineProps<Props>(), {
  initialTab: 'config',
})

const emit = defineEmits<{
  close: []
  'show-progress': [opts: ShowProgressOpts]
  /** Fired when an action's `result.navigate === 'list'` — the install
   *  was removed (delete / untrack). The host should close this drawer
   *  and tear down the comfy window. */
  'navigate-list': []
}>()

const { t } = useI18n()

// Decoupled from `props.open` so we own the leave-animation timing —
// the user-dismiss path (ESC/backdrop/icon) flips `internalOpen` first
// and only emits 'close' on `@after-leave`. An external prop flip
// (e.g. forced close on host teardown / install removal) follows
// synchronously and intentionally skips the animation.
const internalOpen = ref(props.open)

watch(
  () => props.open,
  (next) => {
    internalOpen.value = next
  },
)

function requestClose(): void {
  // Start the leave animation locally; defer emit until @after-leave.
  internalOpen.value = false
}

// Exposed so the title-bar close path (via panel:request-close-drawer
// IPC) can drive the same animated dismiss as ESC / backdrop.
defineExpose({ requestClose })

function handleAfterLeave(): void {
  emit('close')
}

const drawerRef = useTemplateRef<HTMLElement>('drawer')
const contentRef =
  useTemplateRef<InstanceType<typeof ComfyUISettingsContent>>('content')
let lastFocusedBeforeOpen: HTMLElement | null = null

function handleEsc(event: KeyboardEvent): void {
  if (event.key === 'Escape' && internalOpen.value) {
    event.preventDefault()
    requestClose()
  }
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

// `aria-modal="true"` promises tab order is constrained — without this
// trap Tab would leak into the underlying ComfyUI canvas.
function handleTab(event: KeyboardEvent): void {
  if (event.key !== 'Tab' || !internalOpen.value) return
  const root = drawerRef.value
  if (!root) return
  const focusables = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  )
  if (focusables.length === 0) return
  const first = focusables[0]!
  const last = focusables[focusables.length - 1]!
  const active = document.activeElement as HTMLElement | null
  if (event.shiftKey && (active === first || !root.contains(active))) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && active === last) {
    event.preventDefault()
    first.focus()
  }
}

async function handleRelaunch(): Promise<void> {
  await window.api.relaunchApp()
}

function handleShowProgress(opts: ShowProgressOpts): void {
  emit('show-progress', opts)
}

function handleNavigateList(): void {
  emit('navigate-list')
}

watch(internalOpen, async (next) => {
  if (next) {
    lastFocusedBeforeOpen = (document.activeElement as HTMLElement | null) ?? null
    await nextTick()
    contentRef.value?.focusActiveTab()
  } else if (lastFocusedBeforeOpen && document.contains(lastFocusedBeforeOpen)) {
    lastFocusedBeforeOpen.focus()
    lastFocusedBeforeOpen = null
  }
})

onMounted(() => {
  document.addEventListener('keydown', handleEsc)
  document.addEventListener('keydown', handleTab)
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleEsc)
  document.removeEventListener('keydown', handleTab)
})
</script>

<template>
  <Teleport to="body">
    <Transition name="settings-drawer-fade" appear>
      <div
        v-if="internalOpen"
        class="settings-v2-backdrop"
        :aria-hidden="true"
        @click="requestClose"
      ></div>
    </Transition>
    <Transition name="settings-drawer-slide" appear @after-leave="handleAfterLeave">
      <aside
        v-if="internalOpen"
        ref="drawer"
        class="settings-v2-drawer"
        role="dialog"
        aria-modal="true"
        :aria-label="t('comfyUISettings.title', 'Settings')"
      >
        <header class="settings-v2-header">
          <h2 class="settings-v2-header-title">
            {{ t('comfyUISettings.title', 'Settings') }}
          </h2>
          <button
            type="button"
            class="settings-v2-header-close"
            :aria-label="t('common.close', 'Close')"
            @click="requestClose"
          >
            <X :size="14" />
          </button>
        </header>

        <ComfyUISettingsContent
          ref="content"
          :installation="installation"
          :initial-tab="initialTab"
          @show-progress="handleShowProgress"
          @navigate-list="handleNavigateList"
          @request-close="requestClose"
          @relaunch="handleRelaunch"
        />
      </aside>
    </Transition>
  </Teleport>
</template>

<style scoped>
.settings-v2-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(33, 25, 39, 0.7);
  z-index: 60;
  cursor: pointer;
}

.settings-v2-drawer {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: 400px;
  max-width: 100vw;
  z-index: 61;
  display: flex;
  flex-direction: column;
  background: var(--neutral-800);
  border-left: 1px solid var(--border);
  box-shadow: -8px 0 32px rgba(0, 0, 0, 0.35);
  color: var(--text);
}

/* Drawer header — Figma: title left + close right, hairline divider
 * separating from the tab strip. */
.settings-v2-header {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 12px 12px 16px;
  border-bottom: 1px solid var(--border-hover);
  -webkit-app-region: drag;
}

.settings-v2-header-title {
  margin: 0;
  font-size: var(--takeover-fs-body);
  font-weight: 500;
  color: var(--neutral-100);
  letter-spacing: 0;
}

.settings-v2-header-close {
  -webkit-app-region: no-drag;
  width: 28px;
  height: 28px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--neutral-100);
  border: none;
}

/* Tabs / body / footer styles live in `ComfyUISettingsContent.vue`
 * (the component that renders them) — both the drawer and the
 * picker's expanded right pane pick them up via that component's
 * own scoped style block. */
</style>
