<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown } from 'lucide-vue-next'
import type { SnapshotDiffResult } from '../types/ipc'
import { formatNodeVersion } from '../lib/snapshots'

const props = defineProps<{
  diff: SnapshotDiffResult
  /** When true, the Custom Nodes + Pip Packages sections collapse to a
   *  count header (default collapsed). Used in tight surfaces like the
   *  restore-confirm modal, where a large diff would otherwise overflow.
   *  The ComfyUI version + channel lines stay inline (they're one-liners). */
  collapsible?: boolean
}>()

const { t } = useI18n()

const nodesOpen = ref(false)
const pipsOpen = ref(false)

const nodeChangeCount = computed(
  () => props.diff.nodesAdded.length + props.diff.nodesRemoved.length + props.diff.nodesChanged.length
)
const pipChangeCount = computed(
  () => props.diff.pipsAdded.length + props.diff.pipsRemoved.length + props.diff.pipsChanged.length
)

function formatVersion(v: { formattedVersion: string }): string {
  return v.formattedVersion
}
</script>

<template>
  <!-- ComfyUI version change -->
  <div v-if="diff.comfyuiChanged && diff.comfyui" class="diff-section">
    <div class="diff-section-title">{{ t('snapshots.comfyuiVersion') }}</div>
    <div class="diff-line diff-changed">
      {{ formatVersion(diff.comfyui.from) }} → {{ formatVersion(diff.comfyui.to) }}
    </div>
  </div>

  <!-- Update channel change -->
  <div v-if="diff.updateChannelChanged && diff.updateChannel" class="diff-section">
    <div class="diff-section-title">{{ t('snapshots.updateChannel') }}</div>
    <div class="diff-line diff-changed">
      {{ diff.updateChannel.from }} → {{ diff.updateChannel.to }}
    </div>
  </div>

  <!-- Node changes -->
  <div v-if="nodeChangeCount > 0" class="diff-section">
    <div
      class="diff-section-title"
      :class="{ 'is-toggle': collapsible, 'is-open': nodesOpen }"
      @click="collapsible ? (nodesOpen = !nodesOpen) : null"
    >
      <ChevronDown v-if="collapsible" :size="12" class="diff-section-chevron" />
      <span>{{ t('snapshots.customNodes') }} ({{ nodeChangeCount }})</span>
    </div>
    <div v-show="!collapsible || nodesOpen" class="diff-section-lines">
      <div v-for="n in diff.nodesAdded" :key="'add-' + n.id" class="diff-line diff-added">
        + {{ n.id }} {{ formatNodeVersion(n) }}
      </div>
      <div v-for="n in diff.nodesRemoved" :key="'rem-' + n.id" class="diff-line diff-removed">
        − {{ n.id }} {{ formatNodeVersion(n) }}
      </div>
      <div v-for="n in diff.nodesChanged" :key="'chg-' + n.id" class="diff-line diff-changed">
        ~ {{ n.id }}: {{ n.from.version || (n.from.commit ? n.from.commit.slice(0, 7) : '?') }} →
        {{ n.to.version || (n.to.commit ? n.to.commit.slice(0, 7) : '?') }}
        <template v-if="n.from.enabled !== n.to.enabled"
          >, {{ n.from.enabled ? 'enabled' : 'disabled' }} →
          {{ n.to.enabled ? 'enabled' : 'disabled' }}</template
        >
      </div>
    </div>
  </div>

  <!-- Pip changes -->
  <div v-if="pipChangeCount > 0" class="diff-section">
    <div
      class="diff-section-title"
      :class="{ 'is-toggle': collapsible, 'is-open': pipsOpen }"
      @click="collapsible ? (pipsOpen = !pipsOpen) : null"
    >
      <ChevronDown v-if="collapsible" :size="12" class="diff-section-chevron" />
      <span>{{ t('snapshots.pipPackages') }} ({{ pipChangeCount }})</span>
    </div>
    <div v-show="!collapsible || pipsOpen" class="diff-section-lines">
      <div v-for="p in diff.pipsAdded" :key="'padd-' + p.name" class="diff-line diff-added">
        + {{ p.name }} {{ p.version }}
      </div>
      <div v-for="p in diff.pipsRemoved" :key="'prem-' + p.name" class="diff-line diff-removed">
        − {{ p.name }} {{ p.version }}
      </div>
      <div v-for="p in diff.pipsChanged" :key="'pchg-' + p.name" class="diff-line diff-changed">
        ~ {{ p.name }}: {{ p.from }} → {{ p.to }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.diff-section {
  margin-bottom: 8px;
}
.diff-section:last-child {
  margin-bottom: 0;
}

.diff-section-title {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 4px;
}
/* Collapsible variant (restore-confirm modal): the title becomes a click
 * target with a chevron; the section body shows on expand. */
.diff-section-title.is-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  user-select: none;
  margin-bottom: 0;
  padding: 3px 0;
}
.diff-section-title.is-toggle:hover {
  color: var(--text);
}
.diff-section-chevron {
  flex-shrink: 0;
  transition: transform 160ms cubic-bezier(0.4, 0, 0.2, 1);
}
.diff-section-title.is-open .diff-section-chevron {
  transform: rotate(180deg);
}
.diff-section-title.is-toggle + .diff-section-lines {
  margin-top: 2px;
  padding-left: 16px;
}

.diff-line {
  font-size: 12px;
  font-family: var(--font-mono, ui-monospace, monospace);
  padding: 1px 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  user-select: text;
  color: var(--text);
}

/* +/−/~ prefixes already encode add/remove/change — color is just a
 * second-order hint, so keep it muted. `changed` stays neutral on
 * purpose: it's by far the most common line and shouldn't out-shout
 * the actual additions/removals. */
.diff-added {
  color: color-mix(in oklab, var(--success) 60%, var(--text));
}
.diff-removed {
  color: color-mix(in oklab, var(--danger) 60%, var(--text));
}
.diff-changed {
  color: var(--text-muted);
}
</style>
