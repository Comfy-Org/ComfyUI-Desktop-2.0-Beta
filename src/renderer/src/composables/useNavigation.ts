import { ref, computed, nextTick } from 'vue'
import type { Ref, ComputedRef } from 'vue'
import type { Installation, ActionResult } from '../types/ipc'

// ---------------------------------------------------------------------------
// Route keys
// ---------------------------------------------------------------------------

export type TabKey =
  | 'dashboard'
  | 'list'
  | 'running'
  | 'models'
  | 'media'
  | 'settings'

export type OverlayKey =
  | 'detail'
  | 'console'
  | 'progress'
  | 'new-install'
  | 'quick-install'
  | 'track'
  | 'load-snapshot'
  | 'settings'

// ---------------------------------------------------------------------------
// Per-route props
// ---------------------------------------------------------------------------

export interface OverlayPropsMap {
  detail: {
    installation: Installation
    initialTab?: string
    autoAction?: string | null
  }
  console: {
    installationId: string
  }
  progress: {
    installationId: string
  }
  'new-install': Record<string, never>
  'quick-install': Record<string, never>
  track: Record<string, never>
  'load-snapshot': Record<string, never>
  settings: Record<string, never>
}

// ---------------------------------------------------------------------------
// Navigation entries
// ---------------------------------------------------------------------------

export type NavigationMode = 'modal' | 'fullscreen'

export interface OverlayEntry<K extends OverlayKey = OverlayKey> {
  id: string
  key: K
  mode: NavigationMode
  props: OverlayPropsMap[K]
}

// ---------------------------------------------------------------------------
// Controller registry — bridges imperative component APIs
// ---------------------------------------------------------------------------

export interface NavigationControllerMap {
  list: { refresh(): void }
  settings: { loadSettings(): void }
  models: { loadModels(): void }
  media: { loadMedia(): void }

  progress: {
    startOperation(args: {
      installationId: string
      title: string
      apiCall: () => Promise<ActionResult>
      cancellable?: boolean
      returnTo?: string
    }): void
    showOperation(installationId: string): void
  }

  'new-install': { open(): void }
  'quick-install': { open(): void }
  track: { open(): void }
  'load-snapshot': { open(): void }
}

type ControllerKey = keyof NavigationControllerMap

// ---------------------------------------------------------------------------
// Present options
// ---------------------------------------------------------------------------

export type PresentStrategy = 'push' | 'replace-top' | 'replace-all'

export interface PresentOptions {
  mode?: NavigationMode
  strategy?: PresentStrategy
}

// ---------------------------------------------------------------------------
// Singleton composable state
// ---------------------------------------------------------------------------

let _idCounter = 0
function nextId(): string {
  return `nav-${++_idCounter}`
}

const activeTab = ref<TabKey>('dashboard')
const overlays = ref<OverlayEntry[]>([])
const controllers = new Map<string, unknown>()

// Pending invokeWhenReady callbacks, keyed by controller key.
const pendingInvocations = new Map<string, Array<(ctrl: unknown) => void>>()

// ---------------------------------------------------------------------------
// Composable
// ---------------------------------------------------------------------------

export interface UseNavigation {
  activeTab: Ref<TabKey>
  overlays: Ref<OverlayEntry[]>

  topOverlay: ComputedRef<OverlayEntry | null>
  isOpen: (key: OverlayKey) => boolean

  switchTab: (tab: TabKey) => void

  present: <K extends OverlayKey>(
    key: K,
    props: OverlayPropsMap[K],
    options?: PresentOptions,
  ) => void

  dismiss: (key: OverlayKey) => void
  dismissTop: () => void
  dismissAll: () => void

  patchOverlay: <K extends OverlayKey>(
    key: K,
    patch: Partial<OverlayPropsMap[K]>,
  ) => void

  registerController: <K extends ControllerKey>(
    key: K,
    controller: NavigationControllerMap[K] | null,
  ) => void

  invokeWhenReady: <K extends ControllerKey>(
    key: K,
    fn: (controller: NavigationControllerMap[K]) => void,
  ) => Promise<void>
}

export function useNavigation(): UseNavigation {
  const topOverlay = computed<OverlayEntry | null>(
    () => overlays.value[overlays.value.length - 1] ?? null,
  )

  function isOpen(key: OverlayKey): boolean {
    return overlays.value.some((e) => e.key === key)
  }

  function switchTab(tab: TabKey): void {
    activeTab.value = tab
  }

  function present<K extends OverlayKey>(
    key: K,
    props: OverlayPropsMap[K],
    options?: PresentOptions,
  ): void {
    const mode = options?.mode ?? 'modal'
    const strategy = options?.strategy ?? 'push'

    const entry: OverlayEntry<K> = { id: nextId(), key, mode, props }

    if (strategy === 'replace-all') {
      overlays.value = [entry]
    } else if (strategy === 'replace-top') {
      const copy = overlays.value.slice()
      if (copy.length > 0) copy.pop()
      copy.push(entry)
      overlays.value = copy
    } else {
      // push — remove any existing entry with the same key (singleton by key)
      overlays.value = [...overlays.value.filter((e) => e.key !== key), entry]
    }
  }

  function dismiss(key: OverlayKey): void {
    overlays.value = overlays.value.filter((e) => e.key !== key)
  }

  function dismissTop(): void {
    if (overlays.value.length > 0) {
      overlays.value = overlays.value.slice(0, -1)
    }
  }

  function dismissAll(): void {
    overlays.value = []
  }

  function patchOverlay<K extends OverlayKey>(
    key: K,
    patch: Partial<OverlayPropsMap[K]>,
  ): void {
    const idx = overlays.value.findIndex((e) => e.key === key)
    if (idx === -1) return
    const existing = overlays.value[idx]!
    const updated: OverlayEntry = {
      ...existing,
      props: { ...existing.props, ...patch },
    }
    const copy = overlays.value.slice()
    copy[idx] = updated
    overlays.value = copy
  }

  // -- Controller registry --

  function registerController<K extends ControllerKey>(
    key: K,
    controller: NavigationControllerMap[K] | null,
  ): void {
    if (controller === null) {
      controllers.delete(key)
      return
    }
    controllers.set(key, controller)
    // Flush any pending invocations.
    const pending = pendingInvocations.get(key)
    if (pending) {
      pendingInvocations.delete(key)
      for (const fn of pending) fn(controller)
    }
  }

  async function invokeWhenReady<K extends ControllerKey>(
    key: K,
    fn: (controller: NavigationControllerMap[K]) => void,
  ): Promise<void> {
    const existing = controllers.get(key) as NavigationControllerMap[K] | undefined
    if (existing) {
      fn(existing)
      return
    }
    // Wait for nextTick (component may be mounting) then check again.
    await nextTick()
    const afterTick = controllers.get(key) as NavigationControllerMap[K] | undefined
    if (afterTick) {
      fn(afterTick)
      return
    }
    // Queue for when the controller registers.
    const queue = pendingInvocations.get(key) ?? []
    queue.push(fn as (ctrl: unknown) => void)
    pendingInvocations.set(key, queue)
  }

  return {
    activeTab,
    overlays,
    topOverlay,
    isOpen,
    switchTab,
    present,
    dismiss,
    dismissTop,
    dismissAll,
    patchOverlay,
    registerController,
    invokeWhenReady,
  }
}
