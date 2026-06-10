<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertCircle, ArrowDownToLine, ArrowRightLeft, MoreVertical } from 'lucide-vue-next'
import { useSessionStore } from '../../stores/sessionStore'
import { installTypeMetaForInstall } from '../../lib/installTypeIcon'
import { TID } from '../../../../shared/testIds'
import type { Installation } from '../../types/ipc'

interface Props {
  installation: Installation
  /** True when REQUIRES_STOPPED actions (update / migrate / restore / delete) are gated. */
  isStoppedActionGated: boolean
  /** Pre-formatted last-launched label. Prop stays wired while the
   *  launched pill is soft-disabled in the template. */
  // eslint-disable-next-line vue/no-unused-properties
  lastLaunchedLabel: string
}

const props = defineProps<Props>()

const emit = defineEmits<{
  pick: [installation: Installation]
  'open-card-menu': [event: MouseEvent, installation: Installation]
  'open-kebab-menu': [event: MouseEvent, installation: Installation]
  'trigger-action': [action: 'update' | 'migrate', installation: Installation]
  'view-error': [installation: Installation]
}>()

const { t } = useI18n()
const sessionStore = useSessionStore()

const inst = computed(() => props.installation)

const isRunning = computed(() => sessionStore.isRunning(inst.value.id))
const isLaunching = computed(() => sessionStore.isLaunching(inst.value.id))
const isStopping = computed(() => sessionStore.isStopping(inst.value.id))
const hasError = computed(() => sessionStore.errorInstances.has(inst.value.id))

const statusClasses = computed<Record<string, boolean>>(() => ({
  'chooser-tile-running': isRunning.value && !isStopping.value,
  'chooser-tile-stopping': isStopping.value,
  'chooser-tile-errored': hasError.value,
}))

/* Lifecycle → top-right status pill (dot + label). Stopping wins over
 * launching wins over running; an idle tile gets no pill. An errored
 * tile shows the clickable error badge instead (see template). */
const statusPill = computed<{ label: string; dotClass: string } | null>(() => {
  if (isStopping.value) return { label: 'chooser.statusStopping', dotClass: 'chooser-tile-status--stopping' }
  if (isLaunching.value) return { label: 'chooser.statusLaunching', dotClass: 'chooser-tile-status--launching' }
  if (isRunning.value) return { label: 'chooser.statusRunning', dotClass: 'chooser-tile-status--running' }
  return null
})

const hasUpdate = computed(() => inst.value.statusTag?.style === 'update')
// The backend tags every migratable install (Legacy Desktop, portable, git)
// with a `migrate` status tag — mirror `hasUpdate` rather than special-casing
// a single source.
const hasMigratePrompt = computed(() => inst.value.statusTag?.style === 'migrate')

const typeMeta = computed(() => installTypeMetaForInstall(inst.value))

/* Desktop's listPreview is the bare installPath (useless in a pill), so
 * fall back to sourceLabel. Gated on `sourceId` because `sourceCategory`
 * reports `local` for desktop in production. */
const sourcePillLabel = computed(() =>
  inst.value.sourceId === 'desktop'
    ? inst.value.sourceLabel
    : inst.value.listPreview || inst.value.sourceLabel,
)

function handleClick(): void {
  if (isStopping.value) return
  emit('pick', inst.value)
}
</script>

<template>
  <div
    role="button"
    tabindex="0"
    class="chooser-tile"
    :class="statusClasses"
    :data-testid="TID.dashboardTile(inst.id)"
    :data-source-category="inst.sourceCategory"
    @click="handleClick"
    @keydown.enter="handleClick"
    @keydown.space.prevent="handleClick"
    @contextmenu.prevent="emit('open-card-menu', $event, inst)"
  >
    <div
      class="chooser-tile-icon"
      :title="t(typeMeta.labelKey)"
    >
      <component :is="typeMeta.icon" :size="28" />
    </div>
    <!-- Top-right cluster: lifecycle indicator + kebab. The status pill is
         non-interactive (clicks fall through to the body); the error badge
         is a click target that opens the error details. -->
    <div class="chooser-tile-actions">
      <button
        v-if="hasError"
        type="button"
        class="chooser-tile-error-badge"
        :title="t('chooser.viewErrorTooltip')"
        @click.stop="emit('view-error', inst)"
        @keydown.enter.stop="emit('view-error', inst)"
      >
        <AlertCircle :size="14" />
        {{ t('chooser.statusError') }}
      </button>
      <span
        v-else-if="statusPill"
        class="chooser-tile-pill chooser-tile-status"
        :class="statusPill.dotClass"
      >
        <span class="chooser-tile-status-dot" aria-hidden="true" />
        {{ t(statusPill.label) }}
      </span>
      <button
        type="button"
        class="chooser-tile-kebab"
        :title="t('chooser.moreActions')"
        :aria-label="t('chooser.moreActions')"
        :data-testid="TID.dashboardTileKebab(inst.id)"
        @click.stop="emit('open-kebab-menu', $event, inst)"
        @contextmenu.stop="emit('open-kebab-menu', $event, inst)"
      >
        <MoreVertical :size="16" />
      </button>
    </div>
    <div class="chooser-tile-name">
      {{ inst.name }}
    </div>
    <div class="chooser-tile-meta">
      <!-- Single no-wrap pill row: source pill + an optional action /
           version pill. The source pill is the shrink target. -->
      <span
        class="chooser-tile-pill"
        :title="sourcePillLabel"
      >
        {{ sourcePillLabel }}
      </span>
      <span
        v-if="hasUpdate"
        class="chooser-tile-pill chooser-tile-pill-update"
        :class="{ 'chooser-tile-pill-disabled': isStoppedActionGated }"
        role="button"
        tabindex="0"
        :aria-disabled="isStoppedActionGated || undefined"
        :title="inst.statusTag?.label"
        @click.stop="isStoppedActionGated || emit('trigger-action', 'update', inst)"
        @keydown.enter.stop="isStoppedActionGated || emit('trigger-action', 'update', inst)"
        @keydown.space.prevent.stop="isStoppedActionGated || emit('trigger-action', 'update', inst)"
      >
        <ArrowDownToLine :size="11" />
        {{ t('chooser.updatePill') }}
      </span>
      <span
        v-else-if="hasMigratePrompt"
        class="chooser-tile-pill chooser-tile-pill-migrate"
        :class="{ 'chooser-tile-pill-disabled': isStoppedActionGated }"
        role="button"
        tabindex="0"
        :aria-disabled="isStoppedActionGated || undefined"
        :title="t('dashboard.migrateBannerTitle')"
        @click.stop="isStoppedActionGated || emit('trigger-action', 'migrate', inst)"
        @keydown.enter.stop="isStoppedActionGated || emit('trigger-action', 'migrate', inst)"
        @keydown.space.prevent.stop="isStoppedActionGated || emit('trigger-action', 'migrate', inst)"
      >
        <ArrowRightLeft :size="11" />
        {{ t('chooser.migratePill') }}
      </span>
      <span
        v-else-if="inst.version"
        class="chooser-tile-pill chooser-tile-pill-version"
        :title="inst.version"
      >
        {{ inst.version }}
      </span>
      <!-- Launched pill disabled per redesign; kept for later restore.
      <span
        class="chooser-tile-pill chooser-tile-pill-launched"
        :title="lastLaunchedLabel"
      >
        {{ lastLaunchedLabel }}
      </span>
      -->
    </div>
  </div>
</template>

<style scoped>
@import './chooser-tiles.css';
</style>
