import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'

import { useInstallContextMenu } from './useInstallContextMenu'
import { useSessionStore } from '../stores/sessionStore'
import { useProgressStore } from '../stores/progressStore'
import type { Installation } from '../types/ipc'
import type { ContextMenuItem } from '../types/context-menu'

vi.stubGlobal('window', {
  ...window,
  api: {
    runAction: vi.fn().mockResolvedValue({ ok: true }),
    onErrorDetail: vi.fn(() => () => {}),
  },
})

const messages = {
  en: {
    chooser: {
      manageInstall: 'Manage…',
      menuUpdate: 'Update…',
      menuMigrate: 'Migrate to Standalone…',
      menuRestoreSnapshot: 'Restore Snapshot…',
      menuRevealInFolder: 'Open Folder',
      menuDelete: 'Delete…',
    },
    actions: {
      copyInstallation: 'Copy Install',
      untrack: 'Untrack',
    },
    progress: { working: 'Working…' },
    running: { dismiss: 'Dismiss' },
  },
}

function makeInstall(overrides: Partial<Installation> = {}): Installation {
  return {
    id: 'inst-1',
    name: 'Inst 1',
    sourceLabel: 'Standalone',
    sourceCategory: 'local',
    status: 'installed',
    installPath: '/tmp/inst-1',
    statusTag: { style: 'update', label: 'Update available' },
    ...overrides,
  } as unknown as Installation
}

interface HarnessHandles {
  menu: ReturnType<typeof useInstallContextMenu>
  session: ReturnType<typeof useSessionStore>
  progress: ReturnType<typeof useProgressStore>
}

/**
 * `useInstallContextMenu` calls Pinia stores + `useI18n()` so the
 * composable (and the stores it depends on) can only be invoked from
 * inside a real component setup scope. Build a tiny harness component
 * that exposes the composable's computed `ctxMenuItems` for assertion,
 * along with the store handles so individual tests can pre-seed
 * running / stopping / in-progress state.
 */
function mountHarness(inst: Installation, mutate?: (h: HarnessHandles) => void) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const i18n = createI18n({ legacy: false, locale: 'en', messages })
  let handles!: HarnessHandles
  const Harness = defineComponent({
    setup() {
      const menu = useInstallContextMenu({ onManage: () => {} })
      const session = useSessionStore()
      const progress = useProgressStore()
      handles = { menu, session, progress }
      mutate?.(handles)
      menu.openCardMenu(
        new MouseEvent('contextmenu', { clientX: 0, clientY: 0 }),
        inst
      )
      return () => h('div')
    },
  })
  const wrapper = mount(Harness, { global: { plugins: [pinia, i18n] } })
  return { wrapper, ...handles }
}

function findItem(items: ContextMenuItem[], id: string): ContextMenuItem | undefined {
  return items.find((i) => i.id === id)
}

let _activePinia: Pinia | undefined
beforeEach(() => {
  _activePinia = createPinia()
  setActivePinia(_activePinia)
  vi.clearAllMocks()
})

describe('useInstallContextMenu — gated REQUIRES_STOPPED items', () => {
  it('renders update / migrate / restore-snapshot / delete enabled when the install is idle', () => {
    const inst = makeInstall({ sourceCategory: 'desktop' })
    const { menu } = mountHarness(inst)
    const items = menu.ctxMenuItems.value

    expect(findItem(items, 'update')?.disabled).toBeFalsy()
    expect(findItem(items, 'migrate')?.disabled).toBeFalsy()
    expect(findItem(items, 'restore-snapshot')?.disabled).toBeFalsy()
    expect(findItem(items, 'delete')?.disabled).toBeFalsy()
    expect(menu.isStoppedActionGated(inst)).toBe(false)
  })

  it('disables REQUIRES_STOPPED items when the install is running', () => {
    const inst = makeInstall({ sourceCategory: 'desktop' })
    const { menu } = mountHarness(inst, ({ session }) => {
      session.runningInstances.set(inst.id, {
        installationId: inst.id,
        installationName: inst.name,
      } as never)
    })
    const items = menu.ctxMenuItems.value

    expect(findItem(items, 'update')?.disabled).toBe(true)
    expect(findItem(items, 'migrate')?.disabled).toBe(true)
    expect(findItem(items, 'restore-snapshot')?.disabled).toBe(true)
    expect(findItem(items, 'delete')?.disabled).toBe(true)
    expect(menu.isStoppedActionGated(inst)).toBe(true)

    // Always-safe items stay enabled.
    expect(findItem(items, 'manage')?.disabled).toBeFalsy()
    expect(findItem(items, 'reveal-in-folder')?.disabled).toBeFalsy()
  })

  it('disables REQUIRES_STOPPED items when the install is stopping', () => {
    const inst = makeInstall()
    const { menu } = mountHarness(inst, ({ session }) => {
      session.stoppingInstances.add(inst.id)
    })
    expect(menu.isStoppedActionGated(inst)).toBe(true)
    expect(findItem(menu.ctxMenuItems.value, 'delete')?.disabled).toBe(true)
  })

  it('disables REQUIRES_STOPPED items when a long-running operation is in flight', () => {
    const inst = makeInstall()
    const { menu } = mountHarness(inst, ({ progress }) => {
      progress.operations.set(inst.id, {
        title: 'Updating…',
        steps: null,
        activePhase: null,
        activePercent: 0,
        lastStatus: {},
        flatStatus: 'Working…',
        flatPercent: 0.5,
        terminalOutput: '',
        done: false,
        finished: false,
        error: null,
        cancelRequested: false,
        result: null,
        unsubProgress: null,
        unsubOutput: null,
        apiCall: null,
      } as never)
    })
    expect(menu.isStoppedActionGated(inst)).toBe(true)
    expect(findItem(menu.ctxMenuItems.value, 'delete')?.disabled).toBe(true)
  })
})
