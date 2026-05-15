<script setup lang="ts">
/**
 * Tier-3 takeover chrome shared across the brand-refreshed first-use
 * screens (cloud-vs-local pick, Configure Comfy Desktop, name-your-install,
 * download progress).
 *
 * Owns:
 *   - Teleport-to-body root so callers don't have to remember it.
 *   - Full-viewport fixed positioning over the launcher panel.
 *   - Dark brand-ink background + two SVG plum beams.
 *   - ComfyC logo pinned top-left.
 *
 * Slots:
 *   - default: hero content (heading, body, action).
 *   - footer-left: bottom-left affordance (e.g. pick step's
 *     "Why try Cloud?"). Rendered inside `.brand-outer-frame` so any
 *     `position: absolute` rules on the slotted child resolve against
 *     the outer frame, matching the pre-extraction layout.
 *
 * The chrome forces `data-theme="dark"` — light-mode brand parity is
 * deferred. Same approach the inline implementation used before this
 * was extracted.
 */
import ComfyCLogo from './icons/ComfyCLogo.vue'
import beamSvg from '../assets/lighting/beam.svg?raw'
import beam2Svg from '../assets/lighting/beam_2.svg?raw'

withDefaults(
  defineProps<{
    /** Theme override. Defaults to 'dark' — the brand chrome only
     *  ships dark today. Pass 'light' once light-mode parity lands. */
    theme?: 'dark' | 'light'
    vignette?: boolean
  }>(),
  { theme: 'dark', vignette: false }
)
</script>

<template>
  <Teleport to="body">
    <div class="brand-takeover-root" :data-theme="theme">
      <div class="brand-outer-frame">
        <div class="brand-inner-frame" :class="{ 'brand-inner-frame--vignette': vignette }">
          <div class="brand-beam" aria-hidden="true" v-html="beamSvg" />
          <div class="brand-beam brand-beam--2" aria-hidden="true" v-html="beam2Svg" />
          <div class="brand-logo-row">
            <ComfyCLogo class="brand-logo" />
          </div>
          <slot />
        </div>
        <slot name="footer-left" />
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.brand-takeover-root {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  background: var(--neutral-900);
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

.brand-outer-frame {
  position: relative;
  flex: 1 1 auto;
  display: flex;
  padding: 5px;
  border-radius: 10px;
  background:
    linear-gradient(0deg, rgba(240, 240, 240, 0.54) 0%, rgba(240, 240, 240, 0.54) 100%),
    var(--neutral-800);
}

.brand-beam {
  position: absolute;
  position-anchor: --brand-beam-torch;
  top: -17%;
  left: anchor(center, clamp(39%, calc(52.5vw - 135px), 44%));
  pointer-events: none;
  z-index: -1;
  overflow: visible;
  transform: translateX(-50%);
}
.brand-beam--2 {
  position-anchor: --brand-beam-target;
  anchor-name: --brand-beam-torch;
  top: -10%;
  left: anchor(end, clamp(45%, calc(56vw - 115px), 50%));
}
.brand-beam :deep(svg) {
  display: block;
  overflow: visible;
}

.brand-inner-frame {
  position: relative;
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: clamp(2rem, 5vw, 48px);
  border-radius: 8px;
  background: var(--neutral-800);
  overflow: hidden;
  isolation: isolate;
}

.brand-inner-frame--vignette {
  background:
    radial-gradient(circle 196px at 50% 50%, #151317 0%, #151317 35%, var(--neutral-800) 100%),
    var(--neutral-800);
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
