<script setup lang="ts">
/**
 * Shared brand-finished takeover primitive.
 *
 * Owns the chrome of the "operation completed" takeover that ProgressModal
 * shows when a launch / install / delete / update reaches a terminal
 * state — glyph background, wordmark, banner, optional secondary
 * message with inline Copy, optional logs accordion, and a slotted
 * footer button row.
 *
 * Used today by ComfyLifecycleView to render the stopped / crashed
 * states in the same visual language users just saw when their launch
 * finished. Designed so ProgressModal's own finished branch can migrate
 * to it in a follow-up without changing the rendered pixels — the class
 * names and structure mirror ProgressModal's brand-progress subtree
 * intentionally.
 *
 * Variants:
 *  - `success`  — green check + success banner color.
 *  - `error`    — red X + danger banner color, intended for crashes
 *                 / failed ops. Pair with `message` for the human-
 *                 readable detail and `logs` for the raw output.
 *  - `cancelled`— neutral triangle + muted banner, intended for stopped
 *                 / user-cancelled states.
 *
 * Slots:
 *  - `actions` — footer button row. Use `brand-primary` /
 *                `brand-ghost` + `brand-progress__footer-btn` classes
 *                to match the ProgressModal finished-state buttons.
 */
import { ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, X, TriangleAlert, ChevronDown } from 'lucide-vue-next'
import BrandTakeoverLayout from './BrandTakeoverLayout.vue'
import BrandProgressGlyph from './icons/BrandProgressGlyph.vue'
import ComfyWordmark from './icons/ComfyWordmark.vue'
import BaseAccordion from './ui/BaseAccordion.vue'
import BaseCopyButton from './ui/BaseCopyButton.vue'

interface Props {
  variant: 'success' | 'error' | 'cancelled'
  /** Banner headline. Short — a single line. */
  title: string
  /** Optional secondary message under the banner (e.g. crash detail
   *  with exit code). Plain text, selectable, with an inline Copy
   *  button for the share-to-Discord / paste-into-issue-thread flow. */
  message?: string
  /** Optional log/stderr block. When set, renders a collapsible
   *  accordion above the footer with a Copy button for the full text. */
  logs?: string
  /** Override for the "View logs" label / accordion title. Defaults to
   *  `launch.viewLogs` so it matches the ProgressModal disclosure. */
  logsLabel?: string
  /** Forwarded to BrandTakeoverLayout for screen readers. */
  ariaLabel?: string
}

const props = withDefaults(defineProps<Props>(), {
  message: undefined,
  logs: undefined,
  logsLabel: undefined,
  ariaLabel: undefined,
})

const { t } = useI18n()
const logsExpanded = ref(false)
// Per-instance unique id so multiple BrandFinishedSurface instances
// mounted simultaneously (e.g. lifecycle view + a future migrated
// ProgressModal finished branch) don't collide on `aria-controls`.
const logsId = useId()

function toggleLogs(): void {
  logsExpanded.value = !logsExpanded.value
}

// Closure so the BaseCopyButton resolves the full logs string at click
// time. Matches the ProgressModal pattern where the terminal buffer
// could grow between mount and click.
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
          :class="{
            'brand-progress__banner--success': variant === 'success',
            'brand-progress__banner--error': variant === 'error',
            'brand-progress__banner--cancelled': variant === 'cancelled',
          }"
          aria-live="polite"
        >
          <Check v-if="variant === 'success'" :size="20" />
          <X v-else-if="variant === 'error'" :size="20" />
          <TriangleAlert v-else :size="20" />
          <span>{{ title }}</span>
        </div>
        <div v-if="message" class="brand-progress__error-row">
          <div class="brand-progress__error-message">{{ message }}</div>
          <BaseCopyButton
            :value="message"
            :aria-label="t('common.copy')"
            class="brand-progress__error-copy"
          />
        </div>
      </div>
    </div>
    <template #footer>
      <div class="brand-progress__footer">
        <BaseAccordion
          v-if="logs"
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
        <div
          class="brand-progress__footer-bar"
          :class="{ 'is-centered': !logs && !$slots.actions }"
        >
          <div class="brand-progress__footer-left">
            <slot name="actions" />
          </div>
          <button
            v-if="logs"
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
/* Mirrors ProgressModal's brand-progress finished-state subtree.
 * Keeping the class names and rules in sync is what makes the two
 * surfaces visually indistinguishable. If you change one, change
 * both — until ProgressModal migrates to consume this component
 * (planned follow-up). */
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
  color: var(--neutral-200);
}
.brand-progress__banner :deep(svg) {
  flex: none;
}
.brand-progress__banner--success {
  color: var(--semantic-success, var(--neutral-50));
}
.brand-progress__banner--error {
  color: var(--semantic-danger, #ff7a7a);
}
.brand-progress__banner--cancelled {
  color: var(--neutral-300);
}

/* Error / message detail row beneath the banner. */
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

/* Footer — positioned container for the bar + the logs panel above it */
.brand-progress__footer {
  position: absolute;
  bottom: clamp(16px, 2.5vh, 32px);
  left: clamp(16px, 2.5vw, 32px);
  right: clamp(16px, 2.5vw, 32px);
  z-index: 3;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.brand-progress__footer-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.brand-progress__footer-bar.is-centered {
  justify-content: center;
}
.brand-progress__footer-left {
  display: inline-flex;
  align-items: center;
  gap: 10px;
}
/* `:slotted()` mirrors plain selectors here because consumers pass
   their action buttons in via `<slot name="actions" />`. Without it,
   Vue 3 scoped styles only reach the local logs-toggle button and the
   slotted buttons end up un-styled — icons crashing into their labels
   was the visible symptom. Keep the two selector groups in sync. */
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

/* View Logs toggle (lives in the footer bar) */
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
/* Log panel that opens above the footer bar */
.brand-progress__logs-wrap {
  border-radius: 10px;
  overflow: hidden;
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
  height: clamp(140px, 25vh, 260px);
  overflow-y: auto;
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
