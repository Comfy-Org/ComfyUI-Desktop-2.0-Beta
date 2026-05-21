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
import { progressOpKindForActionId, destroysInstanceForActionId } from '../lib/progressOpKind'
import { useMigrateAction } from '../composables/useMigrateAction'
import { REQUIRES_STOPPED } from '../types/ipc'
import { Pencil } from 'lucide-vue-next'
import TooltipWrap from '../components/TooltipWrap.vue'
import type {
  Installation,
  ActionDef,
  DetailSection,
  FieldOption,
  ActionResult,
  DiskSpaceInfo,
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
   *  the unified SettingsModal's "ComfyUI Settings" tab body. The
   *  contenteditable install name renders as the first row of the
   *  bare panel; everything else (tabs, scroll body, action bar)
   *  follows unchanged. */
  embedded?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  initialTab: 'status',
  autoAction: null,
  asModal: false,
  embedded: false,
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
  settings: t('common.tabSettings'),
}))

const activeTab = ref<string>('status')

const availableTabs = computed(() => {
  const tabIds = new Set<string>()
  for (const s of sections.value) {
    if (s.tab && !s.pinBottom) tabIds.add(s.tab)
  }
  const ORDER = ['status', 'update', 'snapshots', 'settings']
  return [...ORDER.filter((id) => tabIds.has(id)), ...Array.from(tabIds).filter((id) => !ORDER.includes(id))]
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
        confirmLabel: t('actions.restartConfirm'),
      },
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
  },
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

      // Auto-trigger an action if requested (e.g. from migrate pill click)
      if (props.autoAction && !autoActionRun.value) {
        autoActionRun.value = true
        const actionId = props.autoAction
        for (const section of sections.value) {
          const action = section.actions?.find((a: ActionDef) => a.id === actionId)
          if (action) {
            await nextTick()
            runAction(action, null)
            break
          }
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
  const telemetryContext = {
    source_category: props.installation.sourceCategory || 'unknown',
    ui_surface: 'detail',
  }

  // Pre-flight: check if the installation is busy or running
  // Skip for migrate-to-standalone — the useMigrateAction composable handles its own guard
  if (action.id !== 'migrate-to-standalone' && REQUIRES_STOPPED.has(action.id)) {
    if (!await actionGuard.checkBeforeAction(props.installation.id, action.label)) return
  }

  let mutableAction = { ...action }

  // fieldSelects chain
  if (mutableAction.fieldSelects) {
    const selections: Record<string, FieldOption> = {}
    for (const fs of mutableAction.fieldSelects) {
      let items: FieldOption[]
      try {
        items = await window.api.getFieldOptions(fs.sourceId, fs.fieldId, selections)
      } catch (err: unknown) {
        await modal.alert({
          title: mutableAction.label,
          message: (err as Error).message || String(err)
        })
        return
      }
      if (!items || items.length === 0) {
        await modal.alert({
          title: mutableAction.label,
          message: fs.emptyMessage || t('common.noItems')
        })
        return
      }
      const selectItems = items.map((item) => ({
        value: item.value,
        label: (item.recommended ? '★ ' : '') + item.label,
        description: item.description
      }))
      const selected = await modal.select({
        title: fs.title || mutableAction.label,
        message: fs.message || '',
        items: selectItems
      })
      if (!selected) return
      const selectedItem = items.find((i) => i.value === selected)
      if (selectedItem) selections[fs.fieldId] = selectedItem
      mutableAction = {
        ...mutableAction,
        data: { ...mutableAction.data, [fs.field]: selectedItem }
      }
    }
  }

  // select chain
  if (mutableAction.select) {
    let items: { value: string; label: string; description?: string }[] | undefined
    if (mutableAction.select.source === 'installations') {
      let all = await window.api.getInstallations()
      if (mutableAction.select.excludeSelf && props.installation) {
        all = all.filter((i) => i.id !== props.installation!.id)
      }
      if (mutableAction.select.filters) {
        for (const [key, value] of Object.entries(mutableAction.select.filters)) {
          all = all.filter(
            (i) => (i as Record<string, unknown>)[key] === value
          )
        }
      }
      items = all.map((i) => ({ value: i.id, label: i.name, description: i.sourceLabel }))
    }
    if (!items || items.length === 0) {
      await modal.alert({
        title: mutableAction.label,
        message: mutableAction.select.emptyMessage || t('common.noItems')
      })
      return
    }
    const selected = await modal.select({
      title: mutableAction.select.title || mutableAction.label,
      message: mutableAction.select.message || '',
      items
    })
    if (!selected) return
    mutableAction = {
      ...mutableAction,
      data: { ...mutableAction.data, [mutableAction.select.field]: selected }
    }
  }

  // prompt chain
  if (mutableAction.prompt) {
    const value = await modal.prompt({
      title: mutableAction.prompt.title || mutableAction.label,
      message: mutableAction.prompt.message || '',
      placeholder: mutableAction.prompt.placeholder,
      defaultValue: mutableAction.prompt.defaultValue,
      confirmLabel: mutableAction.prompt.confirmLabel || mutableAction.label,
      required: mutableAction.prompt.required,
      messageDetails: mutableAction.prompt.messageDetails,
    })
    if (!value) return
    mutableAction = {
      ...mutableAction,
      data: { ...mutableAction.data, [mutableAction.prompt.field]: value }
    }
  }

  // Migration preview — delegates to useMigrateAction composable
  if (mutableAction.id === 'migrate-to-standalone') {
    const migrateResult = await confirmMigration(props.installation, mutableAction.confirm)
    if (!migrateResult) return

    mutableAction = {
      ...mutableAction,
      data: {
        ...mutableAction.data,
        ...migrateResult,
      },
    }
  }

  // confirm chain — skip for migrate-to-standalone since it handles its own confirmation above
  if (mutableAction.confirm && mutableAction.id !== 'migrate-to-standalone') {
    if (mutableAction.confirm.options) {
      const result = await modal.confirmWithOptions({
        title: mutableAction.confirm.title || 'Confirm',
        message: mutableAction.confirm.message || 'Are you sure?',
        options: mutableAction.confirm.options,
        confirmLabel: mutableAction.confirm.confirmLabel || mutableAction.label,
        confirmStyle: mutableAction.style || 'danger'
      })
      if (!result) return
      mutableAction = { ...mutableAction, data: { ...mutableAction.data, ...result } }
    } else {
      const confirmed = await modal.confirm({
        title: mutableAction.confirm.title || 'Confirm',
        message: mutableAction.confirm.message || 'Are you sure?',
        messageDetails: mutableAction.confirm.messageDetails,
        confirmLabel: mutableAction.label,
        confirmStyle: mutableAction.style || 'danger'
      })
      if (!confirmed) return
    }
  }

  // Disk space check for actions that write significant data
  const diskCheckActions = new Set(['copy', 'copy-update', 'release-update'])
  if (diskCheckActions.has(mutableAction.id) && props.installation?.installPath) {
    try {
      const space: DiskSpaceInfo = await window.api.getDiskSpace(props.installation.installPath)
      let estimatedRequired = 0
      if (mutableAction.id === 'copy' || mutableAction.id === 'copy-update') {
        if (installationSizeLoading.value) {
          // Size still calculating — fetch it now before proceeding
          try {
            const result = await window.api.getInstallationSize(props.installation.id)
            estimatedRequired = result.sizeBytes
          } catch {
            // Fall through to generic check
          }
        } else {
          estimatedRequired = installationSize.value ?? 0
        }
      }
      // Add 10% buffer for filesystem overhead (block alignment, journal, etc.)
      const threshold = estimatedRequired > 0 ? Math.ceil(estimatedRequired * 1.1) : 1073741824
      if (space.free < threshold) {
        const freeStr = formatBytes(space.free)
        const message = estimatedRequired > 0
          ? t('diskSpace.warningMessage', { free: freeStr, required: formatBytes(estimatedRequired) })
          : t('diskSpace.warningMessageGeneric', { free: freeStr })
        const ok = await modal.confirm({
          title: t('diskSpace.warningTitle'),
          message,
          confirmLabel: t('diskSpace.continueAnyway'),
          confirmStyle: 'primary',
        })
        if (!ok) return
      }
    } catch {
      // If disk space check fails, proceed anyway
    }
  }

  // showProgress
  if (mutableAction.showProgress) {
    const instId = props.installation.id
    const instName = props.installation.name
    const rawTitle = (mutableAction.progressTitle || mutableAction.label).replace(
      /\{(\w+)\}/g,
      (_, k: string) =>
        String((mutableAction.data as Record<string, unknown>)?.[k] ?? k)
    )
    const title = `${rawTitle} — ${instName}`
    emitTelemetryAction('desktop2.action.invoked', { action_id: mutableAction.id, ...telemetryContext })
    // Phase 3 §9 — synthetic 'restart' action: chain stopComfyUI →
    // launch in a single ProgressModal so the user sees one
    // continuous "Restarting ComfyUI" view rather than two flashes.
    // The action's confirm dialog has already run above.
    const isRestart = mutableAction.id === 'restart'
    const apiCall = isRestart
      ? async () => {
          await window.api.stopComfyUI(instId)
          // Wait for the session to actually leave the running state
          // before kicking off the new launch. The session store is
          // updated by main via 'session-status' broadcasts.
          const deadline = Date.now() + 10_000
          while (sessionStore.isRunning(instId) && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 100))
          }
          return window.api.runAction(instId, 'launch')
        }
      : () => window.api.runAction(instId, mutableAction.id, mutableAction.data ? toRaw(mutableAction.data) : undefined)
    // Tag launch / restart so PanelApp's handleShowProgress installs
    // the chooser-host close-on-instance-started subscription. Without
    // this, launches kicked off from this Tier-1 modal would leave the
    // dashboard window open next to the new comfy window.
    const triggersInstanceStart = mutableAction.id === 'launch' || isRestart
    emit('show-progress', {
      installationId: instId,
      title,
      apiCall,
      cancellable: !!mutableAction.cancellable,
      returnTo: 'detail',
      triggersInstanceStart,
      opKind: isRestart ? 'launch' : progressOpKindForActionId(mutableAction.id),
      destroysInstance: destroysInstanceForActionId(mutableAction.id),
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
    emitTelemetryAction('desktop2.action.invoked', { action_id: mutableAction.id, ...telemetryContext })
    const result = await window.api.runAction(
      props.installation.id,
      mutableAction.id,
      mutableAction.data ? toRaw(mutableAction.data) : undefined
    )
    // Fallback: backend detected running instance (race condition)
    if (result.running && props.installation) {
      await actionGuard.checkBeforeAction(props.installation.id, mutableAction.label)
      return
    }
    const resultValue = result.cancelled ? 'cancelled' : (result.ok === false ? 'failed' : 'ok')
    emitTelemetryAction('desktop2.action.result', { action_id: mutableAction.id, result: resultValue, ...telemetryContext })
    if (result.navigate === 'list') {
      emit('close')
      emit('navigate-list')
    } else if (result.navigate === 'detail') {
      await refreshAllSections()
    } else if (result.message) {
      await modal.alert({ title: mutableAction.label, message: result.message })
    }
  } catch (error: unknown) {
    emitTelemetryAction('desktop2.action.result', {
      action_id: mutableAction.id,
      result: 'failed',
      error_bucket: toErrorBucket(error),
      ...telemetryContext,
    })
    await modal.alert({
      title: mutableAction.label,
      message: error instanceof Error ? error.message : String(error),
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
          <div v-if="sectionsLoading" class="modal-loading with-spinner">{{ $t('common.loading') }}</div>
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
              @refresh-all="refreshAllSections"
            />
            <div v-if="activeTab === 'status' && (installationSizeLoading || installationSize !== null)" class="detail-section">
              <div class="detail-section-body">
                <div class="detail-fields">
                  <div>
                    <div class="detail-field-label">{{ $t('diskSpace.sizeLabel') }}</div>
                    <div class="detail-field-value">
                      {{ installationSizeLoading ? $t('diskSpace.calculatingSize') : (installationSize !== null ? formatBytes(installationSize) : $t('diskSpace.sizeUnavailable')) }}
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
            <TooltipWrap
              v-for="a in bottomActions"
              :key="a.id"
              :text="a.tooltip"
            >
              <button
                :class="[
                  a.style,
                  { 'looks-disabled': a.enabled === false && a.disabledMessage }
                ]"
                :disabled="a.enabled === false && !a.disabledMessage"
                @click="handleActionClick(a, $event)"
              >
                {{ a.label }}
              </button>
            </TooltipWrap>
          </div>
        </div>
  </ModalShell>

  <!-- Embedded mount: bare panel body for the unified SettingsModal's
       "ComfyUI Settings" tab. No ModalShell, no close button — the
       parent owns the chrome. Editable install name sits at the top
       of the body; tabs / scroll / action-bar follow as in the
       wrapped mount. -->
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
      <div v-if="sectionsLoading" class="modal-loading with-spinner">{{ $t('common.loading') }}</div>
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
          @refresh-all="refreshAllSections"
        />
        <div v-if="activeTab === 'status' && (installationSizeLoading || installationSize !== null)" class="detail-section">
          <div class="detail-section-body">
            <div class="detail-fields">
              <div>
                <div class="detail-field-label">{{ $t('diskSpace.sizeLabel') }}</div>
                <div class="detail-field-value">
                  {{ installationSizeLoading ? $t('diskSpace.calculatingSize') : (installationSize !== null ? formatBytes(installationSize) : $t('diskSpace.sizeUnavailable')) }}
                </div>
              </div>
            </div>
          </div>
        </div>
      </template>
    </div>

    <div v-if="bottomSection" id="detail-bottom-actions">
      <div class="detail-actions">
        <TooltipWrap
          v-for="a in bottomActions"
          :key="a.id"
          :text="a.tooltip"
        >
          <button
            :class="[
              a.style,
              { 'looks-disabled': a.enabled === false && a.disabledMessage }
            ]"
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
