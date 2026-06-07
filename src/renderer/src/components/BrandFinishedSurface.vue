<script setup lang="ts">
// Terminal takeover surface for the lifecycle view, serving both the crash
// (`tone="error"`) and clean-stop (`tone="neutral"`) states. The
// `brand-progress__*` class names are layout-only and shared with ProgressModal
// so the surfaces stay visually identical; keep them in sync.
import { ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { X, Power, ChevronDown } from 'lucide-vue-next'
import BrandTakeoverLayout from './BrandTakeoverLayout.vue'
import BrandProgressGlyph from './icons/BrandProgressGlyph.vue'
import ComfyWordmark from './icons/ComfyWordmark.vue'
import BaseAccordion from './ui/BaseAccordion.vue'
import BaseCopyButton from './ui/BaseCopyButton.vue'

interface Props {
  title: string
  message?: string
  /** When set, renders a collapsible logs accordion above the footer. */
  logs?: string
  /** Override for the "View logs" label; defaults to `launch.viewLogs`. */
  logsLabel?: string
  ariaLabel?: string
  /** `'error'` (default) is the red crash chrome; `'neutral'` is the calm
   *  surface for a deliberate stop. */
  tone?: 'error' | 'neutral'
}

const props = withDefaults(defineProps<Props>(), {
  message: undefined,
  logs: undefined,
  logsLabel: undefined,
  ariaLabel: undefined,
  tone: 'error',
})

const { t } = useI18n()
const logsExpanded = ref(false)
// Per-instance id so simultaneous surfaces don't collide on aria-controls.
const logsId = useId()

function toggleLogs(): void {
  logsExpanded.value = !logsExpanded.value
}

// Resolves logs at click time since the terminal buffer can grow after mount.
function getLogText(): string {
  return props.logs ?? ''
}
</script>

<template>
  <BrandTakeoverLayout :aria-label="ariaLabel">
    <div class="brand-progress">
      <BrandProgressGlyph class="brand-progress__glyph" aria-hidden="true" />
      <div class="brand-progress__stack">
        <ComfyWordmark class="brand-progress__wordmark" />
        <div
          class="brand-progress__banner"
          :class="`brand-progress__banner--${tone}`"
          aria-live="polite"
        >
          <X v-if="tone === 'error'" :size="20" />
          <Power v-else :size="20" />
          <span>{{ title }}</span>
        </div>
        <div v-if="message" class="brand-progress__error-row">
          <div class="brand-progress__error-message">{{ message }}</div>
          <!-- Copy only makes sense for an error message worth pasting into a
               bug report — a neutral status line ("ComfyUI is stopped") doesn't. -->
          <BaseCopyButton
            v-if="tone === 'error'"
            :value="message"
            :aria-label="t('common.copy')"
            class="brand-progress__error-copy"
          />
        </div>
        <!-- Actions live in the hero stack (under the message), matching
             ProgressModal, so the CTAs stay with the failure context. -->
        <div v-if="$slots.actions" class="brand-progress__error-actions">
          <slot name="actions" />
        </div>
      </div>
    </div>
    <template v-if="logs" #footer>
      <div class="brand-progress__footer">
        <BaseAccordion
          :open="logsExpanded"
          class="brand-progress__logs-wrap"
          :class="{ 'is-expanded': logsExpanded }"
        >
          <div class="brand-progress__logs-panel-header">
            <span class="brand-progress__logs-panel-title">
              {{ logsLabel ?? t('launch.viewLogs') }}
            </span>
            <BaseCopyButton
              :get-value="getLogText"
              :aria-label="t('common.copy')"
              class="brand-progress__logs-copy"
            />
          </div>
          <div :id="logsId" class="brand-progress__logs">
            {{ logs }}
          </div>
        </BaseAccordion>
        <div class="brand-progress__footer-bar">
          <button
            type="button"
            class="brand-ghost brand-progress__footer-btn brand-progress__logs-toggle"
            :aria-expanded="logsExpanded"
            :aria-controls="logsId"
            @click="toggleLogs"
          >
            <ChevronDown
              :size="14"
              class="brand-progress__logs-chevron"
              :class="{ 'is-open': logsExpanded }"
            />
            {{ logsLabel ?? t('launch.viewLogs') }}
          </button>
        </div>
      </div>
    </template>
  </BrandTakeoverLayout>
</template>

<style scoped>
/* Mirrors ProgressModal's brand-progress error-state subtree; keep in sync. */
.brand-progress {
  position: relative;
  align-self: stretch;
  flex: 1 1 auto;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}
.brand-progress__glyph {
  position: absolute;
  top: 50%;
  left: 60%;
  transform: translate(-50%, -50%);
  height: 100vh;
  width: auto;
  pointer-events: none;
  z-index: 0;
  opacity: 0.9;
}

.brand-progress__stack {
  position: relative;
  z-index: 2;
  width: min(85%, 880px);
  max-width: calc(100vw - 48px);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: clamp(1rem, 3vh, 2rem);
  text-align: center;
  overflow: hidden;
}
.brand-progress__stack::before {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 130%;
  height: 160%;
  border-radius: 50%;
  background: radial-gradient(
    ellipse at center,
    color-mix(in srgb, var(--neutral-800) 60%, transparent) 0%,
    color-mix(in srgb, var(--neutral-800) 40%, transparent) 35%,
    transparent 60%
  );
  pointer-events: none;
  z-index: -1;
}
.brand-progress__wordmark {
  width: clamp(140px, 9.7vw, 240px);
  height: auto;
  color: var(--comfy-yellow);
  anchor-name: --brand-beam-target;
}

.brand-progress__banner {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  font-size: var(--takeover-fs-body);
  letter-spacing: 0.01em;
  min-height: 1.5em;
  color: var(--text);
}
.brand-progress__banner--error {
  color: var(--semantic-danger, #ff7a7a);
}
.brand-progress__banner--neutral {
  color: var(--text);
}
.brand-progress__banner :deep(svg) {
  flex: none;
}

/* Crash-detail row beneath the banner. */
.brand-progress__error-row {
  width: 100%;
  max-width: 640px;
  margin-top: -4px;
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.brand-progress__error-row .brand-progress__error-message {
  margin-top: 0;
  flex: 1 1 auto;
}
.brand-progress__error-copy {
  flex: none;
  margin-top: 4px;
}
.brand-progress__error-message {
  width: 100%;
  max-width: 640px;
  max-height: clamp(120px, 22vh, 240px);
  overflow-y: auto;
  overscroll-behavior: contain;
  margin-top: -4px;
  padding: 12px 14px;
  border-radius: 8px;
  border: 1px solid var(--brand-surface-border);
  background: var(--brand-surface-bg);
  color: var(--neutral-200);
  font-size: 13px;
  line-height: 1.55;
  text-align: left;
  user-select: text;
  -webkit-user-select: text;
  word-break: break-word;
  white-space: pre-wrap;
}

/* Mirrors ProgressModal's `.brand-progress__error-actions`; keep in sync. */
.brand-progress__error-actions {
  display: flex;
  flex-direction: row;
  align-items: stretch;
  gap: 12px;
  width: 100%;
  max-width: 420px;
}
.brand-progress__error-actions > :slotted(.brand-progress__footer-btn) {
  flex: 1 1 0;
  justify-content: center;
}

/* `top` is anchored so the block can't grow taller than the available gap;
 * the logs panel shrinks instead of clipping the toggle on short windows.
 * Mirrors ProgressModal's `.brand-progress__footer`; keep in sync. */
.brand-progress__footer {
  position: absolute;
  top: clamp(72px, 14vh, 160px);
  bottom: clamp(16px, 2.5vh, 32px);
  left: clamp(16px, 2.5vw, 32px);
  right: clamp(16px, 2.5vw, 32px);
  z-index: 3;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  gap: 8px;
  min-height: 0;
  pointer-events: none;
}
/* Container is a click-through geometric bound; re-enable on content. */
.brand-progress__footer > * {
  pointer-events: auto;
}
.brand-progress__footer-bar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  flex-wrap: wrap;
}
/* `:slotted()` mirrors the plain selector so these rules reach slotted
 * Back/Restart buttons (scoped styles don't cross slot boundaries). */
.brand-progress__footer-btn,
:slotted(.brand-progress__footer-btn) {
  min-width: auto;
  padding: 7px 14px;
  font-size: 13px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}
.brand-progress__footer-btn.brand-ghost,
:slotted(.brand-progress__footer-btn.brand-ghost) {
  border-color: var(--neutral-500);
  color: var(--neutral-100);
}
@media (max-width: 720px) {
  .brand-progress__footer-btn,
  :slotted(.brand-progress__footer-btn) {
    padding: 6px 10px;
    font-size: 12px;
  }
}

.brand-progress__logs-toggle {
  gap: 6px;
  border-radius: 6px;
  border: 1px solid rgba(194, 191, 185, 0.09);
  background: rgba(138, 134, 136, 0.1);
  box-shadow: 0 1px 0 0 rgba(255, 255, 255, 0.1) inset;
  backdrop-filter: blur(75px);
  color: var(--text);
}
.brand-progress__logs-chevron {
  transform: rotate(180deg);
  transition: transform 200ms cubic-bezier(0.22, 1, 0.36, 1);
}
.brand-progress__logs-chevron.is-open {
  transform: rotate(0deg);
}
/* `min-height: 0` lets the accordion shrink within the bounded footer so
 * short windows scroll the log body instead of pushing the footer off-screen. */
.brand-progress__logs-wrap {
  border-radius: 10px;
  overflow: hidden;
  min-height: 0;
}
.brand-progress__logs-wrap.is-expanded {
  border: 1px solid var(--brand-surface-border);
  background: var(--brand-surface-bg);
  backdrop-filter: blur(8px);
}
.brand-progress__logs-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--brand-surface-border);
}
.brand-progress__logs-panel-title {
  font-size: var(--takeover-fs-caption, 12px);
  color: var(--neutral-200);
  font-weight: 500;
}
.brand-progress__logs-copy {
  flex: none;
}
.brand-progress__logs {
  width: 100%;
  /* max-height (not height) so the panel shrinks on short windows. */
  max-height: clamp(88px, 25vh, 260px);
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 12px 14px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  line-height: 1.55;
  color: var(--neutral-300);
  text-align: left;
  white-space: pre-wrap;
  word-break: break-word;
  user-select: text;
  -webkit-user-select: text;
}
</style>
