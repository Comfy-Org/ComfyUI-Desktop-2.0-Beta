<script setup lang="ts">
// Takeover chrome shared across the brand-refreshed first-use screens.
// Owns the teleport-to-body root, fixed full-viewport positioning, fade-in,
// the top-left logo, and the dialog a11y baseline (role, aria-modal, focus
// capture/restore). Background visuals live in BrandBackground.vue.
// Forces dark; light-mode brand parity is deferred.
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import ComfyCLogo from './icons/ComfyCLogo.vue'
import BrandBackground from './BrandBackground.vue'

withDefaults(
  defineProps<{
    theme?: 'dark' | 'light'
    vignette?: boolean
    ariaLabel?: string
  }>(),
  { theme: 'dark', vignette: false, ariaLabel: undefined },
)

const rootRef = ref<HTMLElement | null>(null)
let returnFocusTo: HTMLElement | null = null

function focusFirstInteractive(): void {
  if (!rootRef.value) return
  // Honor an explicit opt-in (e.g. a text input that should be ready to type),
  // otherwise focus the dialog container itself — not the first button. This
  // keeps focus trapped for keyboard/AT users without painting a focus-visible
  // ring on a control the user didn't tab to. They Tab from here to reach it.
  const explicit = rootRef.value.querySelector<HTMLElement>('[autofocus]')
  ;(explicit ?? rootRef.value).focus()
}

onMounted(() => {
  returnFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null
  void nextTick(focusFirstInteractive)
})

onBeforeUnmount(() => {
  try {
    returnFocusTo?.focus()
  } catch {
    /* trigger element was removed while takeover was open */
  }
  returnFocusTo = null
})
</script>

<template>
  <Teleport to="body">
    <div
      ref="rootRef"
      class="brand-takeover-root"
      :data-theme="theme"
      role="dialog"
      aria-modal="true"
      :aria-label="ariaLabel"
      tabindex="-1"
    >
      <BrandBackground :vignette="vignette">
        <div class="brand-logo-row">
          <ComfyCLogo class="brand-logo" />
        </div>
        <slot />
        <template #footer-left>
          <slot name="footer-left" />
        </template>
        <template #footer>
          <slot name="footer" />
        </template>
      </BrandBackground>
    </div>
  </Teleport>
</template>

<style scoped>
.brand-takeover-root {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  animation: brand-takeover-in 240ms cubic-bezier(0.22, 1, 0.36, 1) both;
}

@keyframes brand-takeover-in {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .brand-takeover-root {
    animation: none;
  }
}

.brand-logo-row {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 2;
  padding: 16px 15px;
  display: flex;
  align-items: center;
}
.brand-logo {
  color: var(--comfy-yellow);
  display: inline-flex;
  width: var(--takeover-logo-size);
  height: var(--takeover-logo-size);
}
</style>
