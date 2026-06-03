<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertTriangle, Info } from 'lucide-vue-next'
import GlobalStorageSections from '../../comfyTitlePopup/globalSettings/GlobalStorageSections.vue'
import SettingsSectionList from './SettingsSectionList.vue'
import type { DetailField, DetailSection, Installation } from '../../types/ipc'

/**
 * Storage tab pane for the instance-picker settings.
 *
 * Composes:
 *  - Global shared-models UI via `GlobalStorageSections` — the same
 *    component the Global Settings popup's Storage tab renders, so
 *    the two surfaces can't drift. Driven by the
 *    `globalSettingsSnapshot` the popup already streams and mutated
 *    through the popup's `__comfyTitlePopup.globalSettings*` bridge
 *    methods.
 *  - Per-install `useSharedPaths` toggle, sourced from `props.sections`
 *    (main emits `{ tab: 'storage', fields: [useSharedPaths] }` for
 *    desktop / portable installs; git installs omit it).
 *
 * Top-of-tab note swaps between an informational muted line and a
 * warning-colour restart prompt when the user has touched any field
 * in the tab during this session. The warning refers to restarting
 * the desktop application — distinct from the per-field "Restart to
 * apply" pill on `useSharedPaths`, which restarts the running Comfy
 * instance.
 */

interface ModelsDir {
  path: string
  isPrimary: boolean
  isDefault: boolean
}

export interface StorageSnapshot {
  sharedDirectoriesFields: Record<string, unknown>[]
  modelsDirs: ModelsDir[]
  modelsSystemDefault: string
}

interface Props {
  installation: Installation | null
  /** Global snapshot fields the popup streams via
   *  `onGlobalSettingsSnapshot`. Passed in as a prop so the picker view
   *  doesn't subscribe twice. */
  snapshot: StorageSnapshot
  /** Per-install storage sections (today: a single section carrying
   *  the `useSharedPaths` toggle for desktop / portable installs). */
  sections: DetailSection[]
  pendingRestartFieldIds: Set<string>
  fieldErrorMessages: Map<string, string>
  runningActionIds: Set<string>
}

const props = defineProps<Props>()

const emit = defineEmits<{
  'update-field': [field: DetailField, value: unknown]
}>()

const { t } = useI18n()

/** Tracks whether the user has touched ANY global field in this tab
 *  session. Global writes go through `globalSettingsSetModelsDirs` /
 *  `globalSettingsUpdateField`, which persist immediately — there is
 *  no save step, only the intent-to-have-changed signal that drives
 *  the warning-color swap on the top-of-tab note. */
const globalTouched = ref(false)

watch(
  () => props.installation?.id ?? null,
  () => {
    globalTouched.value = false
  }
)

const showRestartWarning = computed(() => {
  if (globalTouched.value) return true
  return props.pendingRestartFieldIds.has('useSharedPaths')
})

/** Note-bar leading icon. Computed (not inlined as `:is`-via-import)
 *  so the symbols are typed as used — otherwise `<script setup>`
 *  doesn't count `:is` template references as imports. */
const noteIcon = computed(() => (showRestartWarning.value ? AlertTriangle : Info))

/** Per-install `useSharedPaths` toggle value (defaults to on when the
 *  field is absent). When off, this install uses only its own local
 *  paths, so the shared Models / Directories config below is irrelevant
 *  and gets hidden. */
const useSharedPathsEnabled = computed<boolean>(() => {
  const field = props.sections
    .flatMap((s) => s.fields ?? [])
    .find((f) => f.id === 'useSharedPaths')
  return field ? field.value !== false : true
})

function handleUpdatePerInstallField(field: DetailField, value: unknown): void {
  emit('update-field', field, value)
}
</script>

<template>
  <div class="storage-pane">
    <div class="storage-note" :class="{ 'is-warning': showRestartWarning }" role="status">
      <component
        :is="noteIcon"
        :size="14"
        class="storage-note-icon"
        aria-hidden="true"
      />
      <p class="storage-note-text">
        <template v-if="showRestartWarning">
          {{
            t(
              'comfyUISettings.storageRestartNote',
              'Restart the application (or close and reopen) for these changes to take effect.'
            )
          }}
        </template>
        <template v-else>
          {{
            t(
              'comfyUISettings.storageGlobalNote',
              'Changes here apply to all of your ComfyUI instances.'
            )
          }}
        </template>
      </p>
    </div>

    <!-- Per-install toggle (`useSharedPaths`) above the global model
         lists so the user sees "this instance opts in to shared
         storage" before scrolling through the dirs themselves. Hidden
         for sources that opt out (git installs) where main emits no
         storage section. -->
    <SettingsSectionList
      v-if="sections.length > 0"
      :sections="sections"
      :installation-id="installation?.id"
      :running-action-ids="runningActionIds"
      :pending-restart-field-ids="pendingRestartFieldIds"
      :field-error-messages="fieldErrorMessages"
      @update-field="handleUpdatePerInstallField"
    />

    <!-- Shared Models + Shared Directories only apply when this install
         opts into shared storage. Hide them when the toggle is off so
         the user isn't configuring paths this install won't use. -->
    <GlobalStorageSections
      v-if="useSharedPathsEnabled"
      :snapshot="snapshot"
      :installation-id="installation?.id"
      :pending-restart-field-ids="pendingRestartFieldIds"
      :field-error-messages="fieldErrorMessages"
      :running-action-ids="runningActionIds"
      @touched="globalTouched = true"
    />
  </div>
</template>

<style scoped>
.storage-pane {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.storage-note {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--brand-surface-bg);
  border: 1px solid var(--chooser-surface-border);
  color: var(--text-muted);
  transition:
    color 160ms ease,
    background-color 160ms ease,
    border-color 160ms ease;
}

.storage-note-icon {
  flex-shrink: 0;
  opacity: 0.85;
}

.storage-note-text {
  margin: 0;
  font-size: 12px;
  line-height: 1.45;
}

/* Warning state — solid `--warning` border + icon so the row reads
 * as a banner, not chrome. Background + border + icon all shift to
 * the warning token. Icon `color` is explicit so it overrides the
 * base `.storage-note-icon { opacity: 0.85 }`. */
.storage-note.is-warning {
  color: var(--warning);
  border-color: var(--warning);
  background: color-mix(in srgb, var(--warning) 14%, transparent);
  font-weight: 500;
}

.storage-note.is-warning .storage-note-icon {
  color: var(--warning);
  opacity: 1;
}
</style>
