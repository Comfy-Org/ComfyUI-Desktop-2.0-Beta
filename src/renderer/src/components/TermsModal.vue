<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import BaseModal from './ui/BaseModal.vue'
import InlineRichText from './InlineRichText.vue'
import { LEGAL_DOCS, type LegalDocId } from '../lib/legalDocs'

const props = withDefaults(
  defineProps<{
    open?: boolean
    doc?: LegalDocId
  }>(),
  { open: true, doc: 'privacy' },
)

const emit = defineEmits<{
  close: []
}>()

const { t } = useI18n()

const policy = computed(() => LEGAL_DOCS[props.doc] ?? LEGAL_DOCS.privacy)
const titleKey = computed(() => {
  switch (props.doc) {
    case 'eula':
      return 'firstUse.eulaModalTitle'
    case 'tos':
      return 'firstUse.tosModalTitle'
    case 'notices':
      return 'firstUse.noticesModalTitle'
    default:
      return 'firstUse.privacyModalTitle'
  }
})
</script>

<template>
  <BaseModal
    :open="open"
    size="lg"
    blur-overlay
    :aria-label="t(titleKey)"
    content-class="terms-content"
    @close="emit('close')"
  >
    <template #header>
      <h2 class="terms-title">{{ t(titleKey) }}</h2>
      <div class="terms-meta">
        <span
          ><strong>{{ t('firstUse.legalDocEffective') }}:</strong>
          {{ policy.effectiveDate }}</span
        >
        <span
          ><strong>{{ t('firstUse.legalDocAppliesTo') }}:</strong>
          {{ policy.appliesTo }}</span
        >
      </div>
    </template>
    <div class="terms-body" tabindex="0">
      <template v-for="(block, i) in policy.blocks" :key="`${doc}-${i}`">
        <h2 v-if="block.kind === 'h2'" class="terms-h2">{{ block.text }}</h2>
        <h3 v-else-if="block.kind === 'h3'" class="terms-h3">{{ block.text }}</h3>
        <p v-else-if="block.kind === 'p' && block.text" class="terms-p">
          <InlineRichText :text="block.text" />
        </p>
        <ul v-else-if="block.kind === 'ul' && block.items" class="terms-ul">
          <li v-for="(item, k) in block.items" :key="k">
            <InlineRichText :text="item" />
          </li>
        </ul>
      </template>
    </div>
  </BaseModal>
</template>

<style scoped>
:deep(.base-modal-panel.terms-content) {
  width: min(100%, 720px);
}
:deep(.base-modal-panel.terms-content) .base-modal-header {
  padding: clamp(1.25rem, 2.5vw, 2rem) clamp(1.5rem, 3vw, 2.25rem) 1rem;
}
:deep(.base-modal-panel.terms-content) .base-modal-body {
  padding: 1.25rem clamp(1.5rem, 3vw, 2.25rem) clamp(1.5rem, 3vw, 2.25rem);
}

.terms-title {
  margin: 0 0 8px 0;
  font-family: var(--font-display);
  font-size: var(--takeover-fs-h3);
  font-weight: 800;
  letter-spacing: 0;
  color: var(--neutral-100);
}
.terms-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  font-size: var(--takeover-fs-caption);
  color: var(--neutral-300);
}
.terms-meta strong {
  color: var(--neutral-100);
  font-weight: 600;
}

.terms-body {
  user-select: text;
  font-size: var(--takeover-fs-body);
  line-height: 1.6;
  color: var(--neutral-300);
}
.terms-body:focus {
  outline: none;
}

.terms-h2 {
  font-size: var(--takeover-fs-lead);
  font-weight: 600;
  margin: 18px 0 8px 0;
  color: var(--neutral-100);
}
.terms-h2:first-child {
  margin-top: 0;
}
.terms-h3 {
  font-size: var(--takeover-fs-body);
  font-weight: 600;
  margin: 14px 0 6px 0;
  color: var(--neutral-100);
}
.terms-p {
  margin: 0 0 10px 0;
}
.terms-ul {
  margin: 0 0 10px 0;
  padding-left: 20px;
}
.terms-ul li {
  margin-bottom: 6px;
}
.terms-body :deep(strong) {
  color: var(--neutral-100);
  font-weight: 600;
}
</style>
