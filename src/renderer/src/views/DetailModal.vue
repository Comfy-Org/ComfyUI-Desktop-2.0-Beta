<script setup lang="ts">
// TODO(stale-old-modal): delete after Settings drawer (v2,
// ComfyUISettingsPanel) reaches functional parity and ships everywhere.
// TODO(brand-cleanup): superseded by ComfyUISettingsPanel + useComfyUISettings
// for the Status / Update / Snapshots / Settings tab surface. This file
// still backs the hamburger → Settings → ComfyUI Settings flow during
// the v2 coexistence window. Remove (or split: keep the Directories /
// Downloads halves) once ComfyUISettingsPanel reaches parity.
import { ref, computed, watch, nextTick, toRaw } from 'vue'
import { useI18n } from 'vue-i18n'
import { useModal } from '../composables/useModal'
import { useActionGuard } from '../composables/useActionGuard'

import DetailSectionComponent from '../components/DetailSection.vue'
import SnapshotTab from '../components/SnapshotTab.vue'
import ModalShell from '../components/ModalShell.vue'
import { useInstallationStore } from '../stores/installationStore'
import { useSessionStore } from '../stores/sessionStore'
import { emitTelemetryAction, toErrorBucket } from '../lib/telemetry'
import { formatBytes } from '../lib/formatting'
import { findActionById } from '../lib/findAction'
import { progressOpKindForActionId, destroysInstanceForActionId } from '../lib/progressOpKind'
import {
  IN_PLACE_RELAUNCH,
  augmentActionWithStopWarning,
  stopAndWaitForExit
} from '../lib/stopWarning'
import { useMigrateAction } from '../composables/useMigrateAction'
import {
  runConfirmChain,
  runDiskSpaceCheck,
  runFieldSelectsChain,
  runPromptChain,
  runSelectChain
} from '../composables/actionShoppingList'
import { REQUIRES_STOPPED } from '../types/ipc'
import { Pencil } from 'lucide-vue-next'
import TooltipWrap from '../components/TooltipWrap.vue'
import type {
  Installation,
  ActionDef,
  DetailSection,
  ActionResult,
  ShowProgressOpts
} from '../types/ipc'

interface Props {
  installation: Installation | null
  initialTab?: string
  autoAction?: string | null
  /** When true, render as a Tier 1 manage overlay (Modal-wrapped, dim
   *  backdrop, no Esc/click-outside dismiss). When false (default),
   *  render inline as the install-settings panel body. */
  asModal?: boolean
  /** When true, render bare (no ModalShell wrapper, no close button)
   *  for mounting inside a parent modal that owns the chrome — e.g.
   *  ManageInstallModal. The contenteditable install name renders as
   *  the first row of the bare panel; everything else (tabs, scroll
   *  body, action bar) follows unchanged. */
  embedded?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  initialTab: 'status',
  autoAction: null,
  asModal: false,
  embedded: false
})

const emit = defineEmits<{
  close: []
  'show-progress': [opts: ShowProgressOpts]
  'navigate-list': []
  'update:installation': [inst: Installation]
}>()

const { t } = useI18n()
const modal = useModal()
const installationStore = useInstallationStore()
const sessionStore = useSessionStore()
const actionGuard = useActionGuard()
const { confirmMigration } = useMigrateAction()

/** Header X close. Always emits `close` — the parent decides what to
 *  do (the chooser-host overlay slot calls `closeOverlay`; the
 *  install-settings panel body asks main to reset the host window's
 *  panel-history stack via `closeCurrentPanel`). Phase 3 §17 dropped
 *  the `inline` prop now that DetailModal renders one way and the
 *  parent owns the close behaviour. */
function handleHeaderClose(): void {
  emit('close')
}

const scrollRef = ref<HTMLDivElement | null>(null)

const sections = ref<DetailSection[]>([])
const sectionsLoading = ref(false)
const installationSize = ref<number | null>(null)
const installationSizeLoading = ref(false)

const tabLabels = computed<Record<string, string>>(() => ({
  status: t('common.tabStatus'),
  update: t('common.tabUpdate'),
  snapshots: t('common.tabSnapshots'),
  settings: t('common.tabSettings')
}))

const activeTab = ref<string>('status')

const availableTabs = computed(() => {
  const tabIds = new Set<string>()
  for (const s of sections.value) {
    if (s.tab && !s.pinBottom) tabIds.add(s.tab)
  }
  const ORDER = ['status', 'update', 'snapshots', 'settings']
  return [
    ...ORDER.filter((id) => tabIds.has(id)),
    ...Array.from(tabIds).filter((id) => !ORDER.includes(id))
  ]
})

const hasTabs = computed(() => availableTabs.value.length > 1)

const mainSections = computed(() =>
  sections.value.filter((s) => !s.pinBottom && (!hasTabs.value || s.tab === activeTab.value))
)
const bottomSection = computed(() => sections.value.find((s) => s.pinBottom) ?? null)

/** Phase 3 §9 — When the install is already running, the primary
 *  "Launch" action becomes "Restart": hollow-blue (`accent`) styling
 *  to telegraph that it asks for confirmation before doing anything,
 *  and a stop-then-launch chain instead of a bare launch. We rewrite
 *  the action object in the renderer (synthetic id `restart`) so the
 *  source-side action definition stays single-purpose; `runAction`
 *  picks the synthetic id up and routes it through stopComfyUI →
 *  launch. */
const bottomActions = computed<ActionDef[]>(() => {
  const acts = bottomSection.value?.actions ?? []
  if (!props.installation) return acts
  const running = sessionStore.isRunning(props.installation.id)
  if (!running) return acts
  return acts.map((a) => {
    if (a.id !== 'launch') return a
    return {
      ...a,
      id: 'restart',
      label: t('actions.restart'),
      style: 'accent',
      progressTitle: t('actions.restartProgressTitle'),
      confirm: {
        title: t('actions.restartConfirmTitle'),
        message: t('actions.restartConfirmMessage'),
        confirmLabel: t('actions.restartConfirm')
      }
    }
  })
})

const previousInstId = ref<string | null>(null)
const autoActionRun = ref(false)
let sizeGeneration = 0

async function fetchInstallationSize(installationId: string): Promise<void> {
  const gen = ++sizeGeneration
  installationSize.value = null
  installationSizeLoading.value = true
  try {
    const result = await window.api.getInstallationSize(installationId)
    if (gen !== sizeGeneration) return
    installationSize.value = result.sizeBytes
  } catch {
    if (gen !== sizeGeneration) return
    installationSize.value = null
  } finally {
    if (gen === sizeGeneration) installationSizeLoading.value = false
  }
}

// Deep-link tab override — the title-bar install-update pill (and
// chooser-card Update / Migrate pills) re-open the modal with a
// non-default `initialTab` even when the same installation is
// already in view. The installation watcher below treats those
// re-opens as "not a new installation" so it skips the activeTab
// reset; this watcher fills the gap and snaps the inner tab to the
// requested one (when sections are already loaded — first-mount
// alignment is still owned by the installation watcher's
// `isNewInstallation` branch).
watch(
  () => props.initialTab,
  (next, prev) => {
    if (!next || next === prev) return
    if (sections.value.length === 0) return
    if (next === activeTab.value) return
    const tabExists = sections.value.some((s) => s.tab === next)
    if (!tabExists) return
    activeTab.value = next
    void nextTick(() => {
      if (scrollRef.value) scrollRef.value.scrollTop = 0
    })
  }
)

watch(
  () => props.installation,
  async (inst) => {
    if (!inst) {
      sections.value = []
      sectionsLoading.value = false
      previousInstId.value = null
      installationSize.value = null
      installationSizeLoading.value = false
      return
    }
    if (!inst.seen) {
      window.api.updateInstallation(inst.id, { seen: true })
    }
    const isNewInstallation = inst.id !== previousInstId.value
    previousInstId.value = inst.id
    if (isNewInstallation) autoActionRun.value = false
    if (isNewInstallation) sectionsLoading.value = true
    try {
      sections.value = await window.api.getDetailSections(inst.id)
    } finally {
      sectionsLoading.value = false
    }
    if (isNewInstallation) {
      const tabExists = sections.value.some((s) => s.tab === props.initialTab)
      activeTab.value = tabExists ? props.initialTab : 'status'
      await nextTick()
      if (scrollRef.value) scrollRef.value.scrollTop = 0
      if (inst.installPath) {
        fetchInstallationSize(inst.id)
      } else {
        sizeGeneration++
        installationSize.value = null
        installationSizeLoading.value = false
        window.api.cancelInstallationSize()
      }

      // Auto-trigger an action if requested (e.g. from migrate pill or
      // title-bar install-update pill click). Walks both
      // `section.actions[]` AND nested `field.options[].data.actions[]`
      // — the latter is where channel-card actions (`update-comfyui`,
      // `copy-update`, `switch-channel`) live, so a search of only
      // `section.actions` would silently no-op the install-update pill
      // (regression for #582). Prefers the action on the install's
      // currently-selected channel when present.
      if (props.autoAction && !autoActionRun.value) {
        autoActionRun.value = true
        const actionId = props.autoAction
        const channelField = sections.value
          .flatMap((s) => s.fields ?? [])
          .find((f) => f.editType === 'channel-cards')
        const currentChannel = typeof channelField?.value === 'string' ? channelField.value : null
        const action = findActionById(sections.value, actionId, currentChannel)
        if (action) {
          await nextTick()
          runAction(action, null)
        }
      }
    }
  },
  { immediate: true }
)

function getTitleTextNode(el: HTMLElement): Text {
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) return node as Text
  }
  const text = document.createTextNode('')
  el.prepend(text)
  return text
}

function handleTitleSelectAll(event: KeyboardEvent): void {
  event.preventDefault()
  const el = event.currentTarget as HTMLElement
  const textNode = getTitleTextNode(el)
  const range = document.createRange()
  range.selectNodeContents(textNode)
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
}

function handleTitlePaste(event: ClipboardEvent): void {
  event.preventDefault()
  const text = event.clipboardData?.getData('text/plain') ?? ''
  document.execCommand('insertText', false, text)
}

async function handleTitleBlur(event: FocusEvent): Promise<void> {
  if (!props.installation) return
  const el = event.target as HTMLElement
  const textNode = getTitleTextNode(el)
  const newName = textNode.textContent?.trim() ?? ''
  if (newName && newName !== props.installation.name) {
    const result = await window.api.updateInstallation(props.installation.id, { name: newName })
    if (result && !(result as ActionResult).ok && (result as ActionResult).ok !== undefined) {
      textNode.textContent = ` ${props.installation.name}`
      await modal.alert({
        title: props.installation.name,
        message: (result as ActionResult).message || ''
      })
    } else {
      emit('update:installation', { ...props.installation, name: newName })
    }
  } else {
    textNode.textContent = ` ${props.installation.name}`
  }
}

async function refreshSection(sectionTitle: string): Promise<void> {
  if (!props.installation) return
  const fresh = await window.api.getDetailSections(props.installation.id)
  const updated = fresh.find((s) => s.title === sectionTitle)
  if (!updated) return
  const idx = sections.value.findIndex((s) => s.title === sectionTitle)
  if (idx >= 0) {
    sections.value.splice(idx, 1, updated)
  }
}

async function refreshAllSections(): Promise<void> {
  if (!props.installation) return
  const all = await window.api.getInstallations()
  const fresh = all.find((i) => i.id === props.installation!.id)
  if (fresh) emit('update:installation', fresh)
  sections.value = await window.api.getDetailSections(props.installation.id)
}

function handleActionClick(action: ActionDef, event: MouseEvent): void {
  if (action.enabled === false && action.disabledMessage) {
    modal.alert({ title: action.label, message: action.disabledMessage })
    return
  }
  runAction(action, event.target as HTMLButtonElement)
}

async function runAction(action: ActionDef, btn: HTMLButtonElement | null): Promise<void> {
  if (!props.installation) return
  const instId = props.installation.id
  const telemetryContext = {
    source_category: props.installation.sourceCategory || 'unknown',
    ui_surface: 'detail'
  }

  // Busy-only guard. migrate-to-standalone manages its own busy check
  // + confirm UI via useMigrateAction below, so skip both pre-flights
  // for it. The apiCall self-stop still applies — migrate is
  // REQUIRES_STOPPED and the session must be torn down before the
  // backend handler runs.
  const ownsPreflight = action.id === 'migrate-to-standalone'
  const requiresStoppedGuard = REQUIRES_STOPPED.has(action.id)
  const wasRunning = sessionStore.isRunning(instId)
  if (requiresStoppedGuard && !ownsPreflight) {
    if (!(await actionGuard.checkBeforeAction(instId, action.label))) return
  }

  let mutableAction = { ...action }

  // Stop-warning augment for REQUIRES_STOPPED while running.
  if (requiresStoppedGuard && wasRunning && !ownsPreflight) {
    mutableAction = augmentActionWithStopWarning(
      mutableAction,
      t('errors.willStopRunning', { name: props.installation?.name || 'ComfyUI' })
    )
  }

  // Shopping-list chain steps — fieldSelects → select → prompt →
  // (migrate-to-standalone takeover) → confirm → disk-check. Each
  // helper short-circuits the runAction when the user cancels.
  const afterFieldSelects = await runFieldSelectsChain(mutableAction, modal, t)
  if (!afterFieldSelects) return
  mutableAction = afterFieldSelects

  const afterSelect = await runSelectChain(mutableAction, props.installation!.id, modal, t)
  if (!afterSelect) return
  mutableAction = afterSelect

  const afterPrompt = await runPromptChain(mutableAction, modal)
  if (!afterPrompt) return
  mutableAction = afterPrompt

  // Migration preview — delegates to useMigrateAction composable.
  // Lives between prompt and confirm so the takeover surface owns the
  // confirm UX for migrate-to-standalone (the helper short-circuits
  // the confirm chain below for that action id).
  if (mutableAction.id === 'migrate-to-standalone') {
    const migrateResult = await confirmMigration(props.installation, mutableAction.confirm)
    if (!migrateResult) return
    mutableAction = {
      ...mutableAction,
      data: { ...mutableAction.data, ...migrateResult }
    }
  }

  if (mutableAction.id !== 'migrate-to-standalone') {
    const afterConfirm = await runConfirmChain(mutableAction, modal)
    if (!afterConfirm) return
    mutableAction = afterConfirm
  }

  // Disk-space sanity check. DetailModal pre-loads `installationSize`
  // via watcher so the chain helper can skip the IPC round-trip when
  // the cached value is fresh; pass `null` to signal "use the cache"
  // when the loader is still running so the helper falls back to a
  // synchronous re-fetch.
  const cachedSize = installationSizeLoading.value ? null : installationSize.value
  if (!(await runDiskSpaceCheck(mutableAction, props.installation, modal, t, cachedSize))) return

  // showProgress
  if (mutableAction.showProgress) {
    const instName = props.installation.name
    const rawTitle = (mutableAction.progressTitle || mutableAction.label).replace(
      /\{(\w+)\}/g,
      (_, k: string) => String((mutableAction.data as Record<string, unknown>)?.[k] ?? k)
    )
    const title = `${rawTitle} — ${instName}`
    emitTelemetryAction('comfy.desktop.action.invoked', {
      action_id: mutableAction.id,
      ...telemetryContext
    })
    // Synthetic 'restart' action: chain stopComfyUI → launch in a
    // single ProgressModal so the user sees one continuous
    // "Restarting ComfyUI" view rather than two flashes.
    const isRestart = mutableAction.id === 'restart'
    const needsSelfStop = wasRunning && requiresStoppedGuard && !isRestart
    const wantsRelaunch = needsSelfStop && IN_PLACE_RELAUNCH.has(mutableAction.id)
    const isRunning = (): boolean => sessionStore.isRunning(instId)
    const apiCall = isRestart
      ? async () => {
          await stopAndWaitForExit(instId, isRunning)
          return window.api.runAction(instId, 'launch')
        }
      : needsSelfStop
        ? async () => {
            await stopAndWaitForExit(instId, isRunning)
            const result = await window.api.runAction(
              instId,
              mutableAction.id,
              mutableAction.data ? toRaw(mutableAction.data) : undefined
            )
            if (wantsRelaunch && result?.ok !== false) {
              await window.api.runAction(instId, 'launch')
            }
            return result
          }
        : () =>
            window.api.runAction(
              instId,
              mutableAction.id,
              mutableAction.data ? toRaw(mutableAction.data) : undefined
            )
    // Tag launch / restart so PanelApp's handleShowProgress installs
    // the chooser-host close-on-instance-started subscription. Without
    // this, launches kicked off from this Tier-1 modal would leave the
    // dashboard window open next to the new comfy window.
    const triggersInstanceStart = mutableAction.id === 'launch' || isRestart || wantsRelaunch
    emit('show-progress', {
      installationId: instId,
      title,
      apiCall,
      cancellable: !!mutableAction.cancellable,
      returnTo: 'detail',
      triggersInstanceStart,
      opKind: isRestart ? 'launch' : progressOpKindForActionId(mutableAction.id),
      destroysInstance: destroysInstanceForActionId(mutableAction.id),
      actionId: mutableAction.id
    })
    return
  }

  // Inline action with loading state
  let savedLabel: string | undefined
  if (btn) {
    savedLabel = btn.textContent || ''
    btn.disabled = true
    btn.classList.add('loading')
  }
  try {
    emitTelemetryAction('comfy.desktop.action.invoked', {
      action_id: mutableAction.id,
      ...telemetryContext
    })
    if (wasRunning && requiresStoppedGuard) {
      await stopAndWaitForExit(instId, () => sessionStore.isRunning(instId))
    }
    const result = await window.api.runAction(
      instId,
      mutableAction.id,
      mutableAction.data ? toRaw(mutableAction.data) : undefined
    )
    // Fallback: backend detected running instance (race condition)
    if (result.running && props.installation) {
      await actionGuard.checkBeforeAction(instId, mutableAction.label)
      return
    }
    if (
      wasRunning &&
      requiresStoppedGuard &&
      IN_PLACE_RELAUNCH.has(mutableAction.id) &&
      result?.ok !== false
    ) {
      await window.api.runAction(instId, 'launch')
    }
    const resultValue = result.cancelled ? 'cancelled' : result.ok === false ? 'failed' : 'ok'
    emitTelemetryAction('comfy.desktop.action.result', {
      action_id: mutableAction.id,
      result: resultValue,
      ...telemetryContext
    })
    if (result.navigate === 'list') {
      emit('close')
      emit('navigate-list')
    } else if (result.navigate === 'detail') {
      await refreshAllSections()
    } else if (result.message) {
      await modal.alert({ title: mutableAction.label, message: result.message })
    }
  } catch (error: unknown) {
    emitTelemetryAction('comfy.desktop.action.result', {
      action_id: mutableAction.id,
      result: 'failed',
      error_bucket: toErrorBucket(error),
      ...telemetryContext
    })
    await modal.alert({
      title: mutableAction.label,
      message: error instanceof Error ? error.message : String(error)
    })
  } finally {
    if (btn) {
      btn.disabled = false
      btn.classList.remove('loading')
      if (savedLabel !== undefined) btn.textContent = savedLabel
    }
  }
}

function navigateToInstallation(installationId: string): void {
  const inst = installationStore.getById(installationId)
  if (inst) emit('update:installation', inst)
}
</script>

<template>
  <ModalShell
    v-if="installation && !embedded"
    :inline="!asModal"
    opacity="dim"
    @close="handleHeaderClose"
  >
    <template #title>
      <div
        role="textbox"
        :aria-label="$t('detail.editName', 'Edit installation name')"
        contenteditable
        spellcheck="false"
        @blur="handleTitleBlur"
        @keydown.enter.prevent="($event.target as HTMLElement).blur()"
        @keydown.ctrl.a.prevent="handleTitleSelectAll"
        @paste="handleTitlePaste"
      >
        {{ installation.name }}<Pencil :size="14" class="edit-name-hint" contenteditable="false" />
      </div>
    </template>
    <div v-if="hasTabs" class="detail-tabs">
      <button
        v-for="tabId in availableTabs"
        :key="tabId"
        class="detail-tab"
        :class="{ active: activeTab === tabId }"
        @click="activeTab = tabId"
      >
        {{ tabLabels[tabId] ?? tabId }}
      </button>
    </div>
    <div ref="scrollRef" class="view-scroll">
      <div v-if="sectionsLoading" class="modal-loading with-spinner">
        {{ $t('common.loading') }}
      </div>
      <SnapshotTab
        v-else-if="activeTab === 'snapshots'"
        :installation-id="installation.id"
        @run-action="runAction"
        @refresh-all="refreshAllSections"
        @navigate-installation="navigateToInstallation"
      />
      <template v-else>
        <DetailSectionComponent
          v-for="section in mainSections"
          :key="section.title ?? 'untitled'"
          :installation-id="installation.id"
          :title="section.title"
          :description="section.description"
          :collapsed="section.collapsed"
          :items="section.items"
          :fields="section.fields"
          :actions="section.actions"
          @run-action="runAction"
          @refresh="refreshSection"
        />
        <div
          v-if="activeTab === 'status' && (installationSizeLoading || installationSize !== null)"
          class="detail-section"
        >
          <div class="detail-section-body">
            <div class="detail-fields">
              <div>
                <div class="detail-field-label">{{ $t('diskSpace.sizeLabel') }}</div>
                <div class="detail-field-value">
                  {{
                    installationSizeLoading
                      ? $t('diskSpace.calculatingSize')
                      : installationSize !== null
                        ? formatBytes(installationSize)
                        : $t('diskSpace.sizeUnavailable')
                  }}
                </div>
              </div>
            </div>
          </div>
        </div>
      </template>
    </div>

    <!-- Bottom pinned actions -->
    <div v-if="bottomSection" id="detail-bottom-actions">
      <div class="detail-actions">
        <TooltipWrap v-for="a in bottomActions" :key="a.id" :text="a.tooltip">
          <button
            :class="[a.style, { 'looks-disabled': a.enabled === false && a.disabledMessage }]"
            :disabled="a.enabled === false && !a.disabledMessage"
            @click="handleActionClick(a, $event)"
          >
            {{ a.label }}
          </button>
        </TooltipWrap>
      </div>
    </div>
  </ModalShell>

  <!-- Embedded mount: bare panel body for ManageInstallModal. No
       ModalShell, no close button — the parent owns the chrome.
       Editable install name sits at the top of the body; tabs /
       scroll / action-bar follow as in the wrapped mount. -->
  <div v-else-if="installation" class="detail-embedded">
    <div class="detail-embedded-title">
      <div
        role="textbox"
        :aria-label="$t('detail.editName', 'Edit installation name')"
        contenteditable
        spellcheck="false"
        @blur="handleTitleBlur"
        @keydown.enter.prevent="($event.target as HTMLElement).blur()"
        @keydown.ctrl.a.prevent="handleTitleSelectAll"
        @paste="handleTitlePaste"
      >
        {{ installation.name }}<Pencil :size="14" class="edit-name-hint" contenteditable="false" />
      </div>
    </div>
    <div v-if="hasTabs" class="detail-tabs">
      <button
        v-for="tabId in availableTabs"
        :key="tabId"
        class="detail-tab"
        :class="{ active: activeTab === tabId }"
        @click="activeTab = tabId"
      >
        {{ tabLabels[tabId] ?? tabId }}
      </button>
    </div>
    <div ref="scrollRef" class="view-scroll">
      <div v-if="sectionsLoading" class="modal-loading with-spinner">
        {{ $t('common.loading') }}
      </div>
      <SnapshotTab
        v-else-if="activeTab === 'snapshots'"
        :installation-id="installation.id"
        @run-action="runAction"
        @refresh-all="refreshAllSections"
        @navigate-installation="navigateToInstallation"
      />
      <template v-else>
        <DetailSectionComponent
          v-for="section in mainSections"
          :key="section.title ?? 'untitled'"
          :installation-id="installation.id"
          :title="section.title"
          :description="section.description"
          :collapsed="section.collapsed"
          :items="section.items"
          :fields="section.fields"
          :actions="section.actions"
          @run-action="runAction"
          @refresh="refreshSection"
        />
        <div
          v-if="activeTab === 'status' && (installationSizeLoading || installationSize !== null)"
          class="detail-section"
        >
          <div class="detail-section-body">
            <div class="detail-fields">
              <div>
                <div class="detail-field-label">{{ $t('diskSpace.sizeLabel') }}</div>
                <div class="detail-field-value">
                  {{
                    installationSizeLoading
                      ? $t('diskSpace.calculatingSize')
                      : installationSize !== null
                        ? formatBytes(installationSize)
                        : $t('diskSpace.sizeUnavailable')
                  }}
                </div>
              </div>
            </div>
          </div>
        </div>
      </template>
    </div>

    <div v-if="bottomSection" id="detail-bottom-actions">
      <div class="detail-actions">
        <TooltipWrap v-for="a in bottomActions" :key="a.id" :text="a.tooltip">
          <button
            :class="[a.style, { 'looks-disabled': a.enabled === false && a.disabledMessage }]"
            :disabled="a.enabled === false && !a.disabledMessage"
            @click="handleActionClick(a, $event)"
          >
            {{ a.label }}
          </button>
        </TooltipWrap>
      </div>
    </div>
  </div>
</template>
