<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertCircle, ArrowDownToLine, ArrowRightLeft, MoreVertical, X } from 'lucide-vue-next'
import { useSessionStore } from '../../stores/sessionStore'
import { installTypeMetaFor } from '../../lib/installTypeIcon'
import type { Installation } from '../../types/ipc'

interface Props {
  installation: Installation
  /** True when REQUIRES_STOPPED actions (update / migrate / restore / delete) are gated. */
  isStoppedActionGated: boolean
  /** Pre-formatted last-launched label (parent owns the time-ago formatter). */
  lastLaunchedLabel: string
  /** Whether this install's last session crashed or its last action errored. */
  hasError: boolean
}

const props = defineProps<Props>()

const emit = defineEmits<{
  pick: [installation: Installation]
  'open-card-menu': [event: MouseEvent, installation: Installation]
  'open-kebab-menu': [event: MouseEvent, installation: Installation]
  'trigger-action': [action: 'update' | 'migrate', installation: Installation]
  'close-running': [installation: Installation]
}>()

const { t } = useI18n()
const sessionStore = useSessionStore()

const inst = computed(() => props.installation)

const isRunning = computed(() => sessionStore.isRunning(inst.value.id))
const isStopping = computed(() => sessionStore.isStopping(inst.value.id))

const statusClasses = computed<Record<string, boolean>>(() => ({
  'chooser-tile-running': isRunning.value && !isStopping.value,
  'chooser-tile-stopping': isStopping.value,
  'chooser-tile-errored': props.hasError,
}))

const hasUpdate = computed(() => inst.value.statusTag?.style === 'update')
const hasMigratePrompt = computed(
  () => inst.value.sourceCategory === 'desktop' && inst.value.status === 'installed',
)

const typeMeta = computed(() => installTypeMetaFor(inst.value.sourceCategory))

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
    <div class="chooser-tile-actions">
      <span
        v-if="hasError"
        class="chooser-tile-error"
        :title="t('running.errors')"
      >
        <AlertCircle :size="16" />
      </span>
      <button
        type="button"
        class="chooser-tile-kebab"
        :title="t('chooser.moreActions')"
        :aria-label="t('chooser.moreActions')"
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
      <!--
        Source/channel pill prefers `listPreview` (e.g. "Stable" /
        "Latest" from the standalone source) so the channel reads
        instead of the bare source label.
      -->
      <span class="chooser-tile-pill">
        {{ inst.listPreview || inst.sourceLabel }}
      </span>
      <!-- Channel and version are independent: channel = stream, version = point on it. -->
      <span
        v-if="inst.version"
        class="chooser-tile-pill chooser-tile-pill-version"
      >
        {{ inst.version }}
      </span>
      <!--
        Update / migrate pills wrap REQUIRES_STOPPED actions, so they
        render disabled (and click handlers no-op) whenever the
        install is running / stopping / has a long-running op in flight.
        Same predicate gates the matching kebab-menu items.
      -->
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
        v-if="hasMigratePrompt"
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
      <span class="chooser-tile-pill">
        {{ lastLaunchedLabel }}
      </span>
    </div>
    <!--
      CTA: a single Close-instance button rendered only while running
      or stopping. main's `closeComfyWindow` IPC closes the OS window
      AND tears the process down via the window's existing close
      handler — no separate Stop call needed.
      For idle / in-progress states the body click handler covers
      launch / view-progress, so no CTA is needed.
    -->
    <div
      v-if="isRunning || isStopping"
      class="chooser-tile-cta"
    >
      <button
        type="button"
        class="chooser-tile-cta-btn chooser-tile-cta-close"
        :title="t('console.stop')"
        :aria-label="t('console.stop')"
        :disabled="isStopping"
        @click.stop="emit('close-running', inst)"
      >
        <X :size="16" />
      </button>
    </div>
  </div>
</template>

<style scoped>
@import './chooser-tiles.css';
</style>
