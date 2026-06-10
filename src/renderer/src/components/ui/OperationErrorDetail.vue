<script setup lang="ts">
// Scrollable, selectable error block with a copy button for in-shelf
// operation failures. Keeps the full message (e.g. multi-line stderr)
// readable and copyable instead of clamping it to one line. Pass `compact`
// for the smaller title-popup card.
import { useI18n } from 'vue-i18n'
import BaseCopyButton from './BaseCopyButton.vue'
import { TID } from '../../../../shared/testIds'

interface Props {
  error: string
  compact?: boolean
}

const props = withDefaults(defineProps<Props>(), { compact: false })

const { t } = useI18n()
</script>

<template>
  <div class="op-error-detail" :class="{ 'is-compact': compact }">
    <pre class="op-error-detail__text" :data-testid="TID.pickerOpErrorMessage">{{ props.error }}</pre>
    <BaseCopyButton
      class="op-error-detail__copy"
      :get-value="() => props.error"
      :aria-label="t('common.copyError', 'Copy error details')"
      :data-testid="TID.pickerOpErrorCopy"
    />
  </div>
</template>

<style scoped>
.op-error-detail {
  position: relative;
  width: 100%;
  max-width: 520px;
  margin-top: 2px;
}
.op-error-detail__text {
  margin: 0;
  max-height: 200px;
  overflow-y: auto;
  padding: 10px 38px 10px 12px;
  border-radius: 8px;
  background: var(--brand-surface-bg, rgba(255, 255, 255, 0.04));
  border: 1px solid var(--brand-surface-border, rgba(255, 255, 255, 0.08));
  color: var(--brand-error, #e74c3c);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 12px;
  line-height: 1.45;
  text-align: left;
  white-space: pre-wrap;
  word-break: break-word;
  user-select: text;
}
.op-error-detail__copy {
  position: absolute;
  top: 6px;
  right: 6px;
}

.op-error-detail.is-compact {
  max-width: none;
}
.op-error-detail.is-compact .op-error-detail__text {
  max-height: 160px;
  padding: 8px 32px 8px 10px;
  font-size: 11px;
}
.op-error-detail.is-compact .op-error-detail__copy {
  top: 4px;
  right: 4px;
}
</style>
