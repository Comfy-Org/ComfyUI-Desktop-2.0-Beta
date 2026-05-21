<script setup lang="ts">
import { computed } from 'vue'
import { installTypeMetaFor } from '../../lib/installTypeIcon'
import type { Installation } from '../../types/ipc'

/**
 * Compact-mode row card: identity (icon + name + running pill + meta pills)
 * on the left, Open + Manage CTA stack on the right. Power actions
 * (reveal/copy/untrack/delete) live in expanded mode, not here.
 */

interface Props {
  installation: Installation
  /** Marks this row as the host's currently-active install — paints
   *  a 2px accent marker on the left edge so the user can spot
   *  "where am I" without reading. */
  active?: boolean
  /** Install is currently running — flips the primary CTA from
   *  "Open" → "Restart" and renders a running pill in the name row. */
  running?: boolean
  /** Pre-formatted "Launched 17m ago" string. Empty for never-launched
   *  installs (the picker view owns the formatter). */
  lastLaunchedLabel: string
  /** Localised primary CTA label ("Open" / "Restart"). */
  openLabel: string
  /** Localised secondary CTA label ("Manage"). */
  manageLabel: string
  /** Localised "running" pill label. */
  runningLabel: string
}

const props = withDefaults(defineProps<Props>(), {
  active: false,
  running: false,
})

const emit = defineEmits<{
  open: [installation: Installation]
  manage: [installation: Installation]
}>()

const typeMeta = computed(() => installTypeMetaFor(props.installation.sourceCategory))

const versionLabel = computed(() => {
  const raw = props.installation.version
  if (!raw) return ''
  return raw.startsWith('v') || raw.startsWith('V') ? raw : `v${raw}`
})

function handleOpen(): void {
  emit('open', props.installation)
}
function handleManage(): void {
  emit('manage', props.installation)
}
</script>

<template>
  <article
    class="picker-row-card"
    :class="{ 'is-active': active, 'is-running': running }"
  >
    <div class="picker-row-card-identity">
      <component
        :is="typeMeta.icon"
        :size="22"
        class="picker-row-card-icon"
        :title="$t(typeMeta.labelKey)"
        aria-hidden="true"
      />
      <div class="picker-row-card-text">
        <div class="picker-row-card-name-row">
          <h3 class="picker-row-card-name">{{ installation.name }}</h3>
          <span v-if="running" class="picker-row-card-running-pill">
            <span class="picker-row-card-running-dot" aria-hidden="true" />
            {{ runningLabel }}
          </span>
        </div>
        <div class="picker-row-card-pills">
          <span class="picker-row-card-pill">{{ installation.sourceLabel }}</span>
          <span
            v-if="versionLabel"
            class="picker-row-card-pill picker-row-card-pill-version"
          >
            {{ versionLabel }}
          </span>
          <span v-if="lastLaunchedLabel" class="picker-row-card-pill">
            {{ lastLaunchedLabel }}
          </span>
        </div>
      </div>
    </div>

    <div class="picker-row-card-cta">
      <button type="button" class="picker-row-card-open" @click="handleOpen">
        {{ openLabel }}
      </button>
      <button type="button" class="picker-row-card-manage" @click="handleManage">
        {{ manageLabel }}
      </button>
    </div>
  </article>
</template>

<style scoped>
.picker-row-card {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 16px;
  padding: 12px 14px;
  border-radius: 10px;
  border: 1px solid var(--brand-surface-border-hover, var(--chooser-surface-border));
  background: var(--brand-surface-bg);
  transition:
    background-color 120ms ease,
    border-color 120ms ease;
}

.picker-row-card:hover {
  background: var(--brand-surface-bg-hover);
}

.picker-row-card.is-active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 10px;
  bottom: 10px;
  width: 2px;
  border-radius: 2px;
  background: var(--accent-primary);
}

.picker-row-card-identity {
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr);
  gap: 12px;
  align-items: center;
  min-width: 0;
}

.picker-row-card-icon {
  color: var(--accent-label);
  flex: 0 0 auto;
}

.picker-row-card-text {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.picker-row-card-name-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.picker-row-card-name {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  line-height: 20px;
  letter-spacing: -0.1px;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.picker-row-card-running-pill {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 18px;
  padding: 0 8px;
  border-radius: 9999px;
  background: color-mix(in srgb, var(--success) 18%, transparent);
  color: var(--success);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.2px;
  text-transform: uppercase;
}

.picker-row-card-running-dot {
  width: 6px;
  height: 6px;
  border-radius: 9999px;
  background: var(--success);
}

.picker-row-card-pills {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}

.picker-row-card-pill {
  display: inline-flex;
  align-items: center;
  height: 20px;
  max-width: 18ch;
  padding: 0 8px;
  border-radius: 9999px;
  background: var(--chooser-surface-border);
  font-size: 11px;
  font-weight: 500;
  line-height: 16px;
  color: var(--neutral-100);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.picker-row-card-pill-version {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.picker-row-card-cta {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
  flex: 0 0 auto;
}

.picker-row-card-open,
.picker-row-card-manage {
  min-width: 96px;
  min-height: 28px;
  padding: 4px 14px;
  border-radius: 7px;
  font-size: 12px;
  font-weight: 500;
  line-height: 18px;
  cursor: pointer;
  transition:
    filter 100ms ease,
    background-color 120ms ease,
    border-color 120ms ease;
}

.picker-row-card-open {
  border: 1px solid var(--accent-primary);
  background: var(--accent-primary);
  color: var(--text);
}
.picker-row-card-open:hover,
.picker-row-card-open:focus-visible {
  filter: brightness(1.08);
  outline: none;
}

.picker-row-card-manage {
  border: 1px solid var(--brand-surface-border-hover, var(--chooser-surface-border));
  background: transparent;
  color: var(--text);
}
.picker-row-card-manage:hover,
.picker-row-card-manage:focus-visible {
  background: var(--chooser-surface-border);
  outline: none;
}
</style>
