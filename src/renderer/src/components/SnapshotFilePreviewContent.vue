<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { SnapshotFilePreview } from '../types/ipc'
import { triggerLabel as _triggerLabel, formatDate, formatNodeVersion } from '../lib/snapshots'

defineProps<{
  preview: SnapshotFilePreview
}>()

const { t } = useI18n()

const nodesExpanded = ref(true)
const pipExpanded = ref(false)

function triggerLabel(trigger: string): string {
  return _triggerLabel(trigger, t)
}
</script>

<template>
  <!-- Source info -->
  <div class="ls-section">
    <div class="ls-field">
      <span class="ls-label">{{ t('list.snapshotSourceName') }}</span>
      <span class="ls-value">{{ preview.installationName }}</span>
    </div>
    <div class="ls-field">
      <span class="ls-label">{{ t('list.snapshotCount') }}</span>
      <span class="ls-value">{{ preview.snapshotCount }}</span>
    </div>
  </div>

  <!-- Snapshot timeline -->
  <div class="ls-section">
    <div class="ls-section-title">{{ t('list.snapshotTimeline') }}</div>
    <div class="ls-timeline">
      <div
        v-for="(snap, i) in preview.snapshots"
        :key="snap.filename"
        class="ls-timeline-item"
      >
        <span class="ls-trigger" :class="'ls-trigger-' + snap.trigger">{{ triggerLabel(snap.trigger) }}</span>
        <span v-if="i === 0" class="ls-current-tag">{{ t('snapshots.current') }}</span>
        <span class="ls-meta">{{ snap.comfyuiVersion }} · {{ t('snapshots.nodesCount', { count: snap.nodeCount }) }} · {{ t('snapshots.packagesCount', { count: snap.pipPackageCount }) }}</span>
        <span class="ls-time">{{ formatDate(snap.createdAt) }}</span>
      </div>
    </div>
  </div>

  <!-- Newest snapshot detail -->
  <div class="ls-section">
    <div class="ls-section-title">{{ t('list.snapshotNewestDetail') }}</div>

    <div class="ls-grid">
      <div class="ls-field">
        <span class="ls-label">{{ t('snapshots.comfyuiVersion') }}</span>
        <span class="ls-value">{{ preview.newestSnapshot.comfyuiVersion }}</span>
      </div>
      <div class="ls-field">
        <span class="ls-label">{{ t('snapshots.variant') }}</span>
        <span class="ls-value">{{ preview.newestSnapshot.comfyui.variant || '—' }}</span>
      </div>
      <div class="ls-field">
        <span class="ls-label">{{ t('snapshots.pythonVersion') }}</span>
        <span class="ls-value">{{ preview.newestSnapshot.pythonVersion || '—' }}</span>
      </div>
      <div class="ls-field">
        <span class="ls-label">{{ t('snapshots.capturedAt') }}</span>
        <span class="ls-value">{{ formatDate(preview.newestSnapshot.createdAt) }}</span>
      </div>
    </div>

    <!-- Custom nodes -->
    <div class="ls-subsection">
      <div class="ls-subsection-title" @click="nodesExpanded = !nodesExpanded">
        <span>{{ t('snapshots.customNodes') }} ({{ preview.newestSnapshot.customNodes.length }})</span>
        <span class="ls-collapse">{{ nodesExpanded ? '▾' : '▸' }}</span>
      </div>
      <template v-if="nodesExpanded">
        <div v-if="preview.newestSnapshot.customNodes.length > 0" class="recessed-list">
          <div v-for="node in preview.newestSnapshot.customNodes" :key="node.id" class="ls-node-row">
            <span class="ls-node-status" :class="node.enabled ? 'ls-node-enabled' : 'ls-node-disabled'" />
            <span class="ls-node-name">{{ node.id }}</span>
            <span class="ls-node-type">{{ node.type }}</span>
            <span class="ls-node-version" :title="formatNodeVersion(node)">{{ formatNodeVersion(node) }}</span>
          </div>
        </div>
        <div v-else class="ls-empty">—</div>
      </template>
    </div>

    <!-- Pip packages -->
    <div class="ls-subsection">
      <div class="ls-subsection-title" @click="pipExpanded = !pipExpanded">
        <span>{{ t('snapshots.pipPackages') }} ({{ preview.newestSnapshot.pipPackageCount }})</span>
        <span class="ls-collapse">{{ pipExpanded ? '▾' : '▸' }}</span>
      </div>
      <template v-if="pipExpanded">
        <div v-if="preview.newestSnapshot.pipPackageCount > 0" class="recessed-list">
          <div v-for="(version, name) in preview.newestSnapshot.pipPackages" :key="name" class="ls-pip-row">
            <span class="ls-pip-name">{{ name }}</span>
            <span class="ls-pip-version" :title="version">{{ version }}</span>
          </div>
        </div>
        <div v-else class="ls-empty">—</div>
      </template>
    </div>
  </div>
</template>
