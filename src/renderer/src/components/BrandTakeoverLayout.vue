<script setup lang="ts">
/**
 * Tier-3 takeover chrome shared across the brand-refreshed first-use
 * screens (cloud-vs-local pick, Configure Comfy Desktop, name-your-install,
 * download progress).
 *
 * Owns:
 *   - Teleport-to-body root so callers don't have to remember it.
 *   - Full-viewport fixed positioning over the launcher panel.
 *   - Fade-in animation on mount.
 *   - ComfyC logo pinned top-left.
 *   - Dialog a11y baseline: role="dialog", aria-modal, focus capture on
 *     mount + restore on unmount. Every takeover inherits this so we
 *     never ship one without it.
 *
 * Background visuals (outer frame, inner frame, beams, optional vignette)
 * live in `BrandBackground.vue` so non-takeover surfaces (chooser
 * dashboard) can reuse them without the chrome above.
 *
 * Slots:
 *   - default: hero content (heading, body, action).
 *   - footer-left: bottom-left affordance (e.g. pick step's
 *     "Why try Cloud?"). Forwarded into BrandBackground's same-named
 *     slot so any `position: absolute` rules on the slotted child still
 *     resolve against `.brand-outer-frame` like before the extraction.
 *   - footer: bottom-centered action band (e.g. ProgressModal's
 *     Cancel / Back-to-Dashboard buttons on a finished op). Sibling to
 *     `footer-left` so `position: absolute; bottom; left/right` rules
 *     resolve against `.brand-outer-frame` consistently.
 *
 * The chrome forces `data-theme="dark"` — light-mode brand parity is
 * deferred. Same approach the inline implementation used before this
 * was extracted.
 */
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import ComfyCLogo from './icons/ComfyCLogo.vue'
import BrandBackground from './BrandBackground.vue'

withDefaults(
  defineProps<{
    /** Theme override. Defaults to 'dark' — the brand chrome only
     *  ships dark today. Pass 'light' once light-mode parity lands. */
    theme?: 'dark' | 'light'
    vignette?: boolean
    /** Optional accessible name for the takeover. Falls back to a
     *  generic label so screen readers always announce something. */
    ariaLabel?: string
  }>(),
  { theme: 'dark', vignette: false, ariaLabel: undefined },
)

const rootRef = ref<HTMLElement | null>(null)
let returnFocusTo: HTMLElement | null = null

function focusFirstInteractive(): void {
  if (!rootRef.value) return
  const explicit = rootRef.value.querySelector<HTMLElement>('[autofocus]')
  if (explicit) {
    explicit.focus()
    return
  }
  const focusable = rootRef.value.querySelector<HTMLElement>(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )
  focusable?.focus()
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
