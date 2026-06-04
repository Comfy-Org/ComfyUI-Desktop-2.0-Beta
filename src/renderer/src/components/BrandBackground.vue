<script setup lang="ts">
// Brand-refresh backdrop (frame + angled SVG beams), extracted from
// BrandTakeoverLayout so non-takeover surfaces can reuse the visuals
// without the takeover chrome. Forces dark; the brand palette is dark-only.
import beamSvg from '../assets/lighting/beam.svg?raw'
import beam2Svg from '../assets/lighting/beam_2.svg?raw'

withDefaults(
  defineProps<{
    vignette?: boolean
  }>(),
  { vignette: false }
)
</script>

<template>
  <div class="brand-background" data-theme="dark">
    <div class="brand-outer-frame">
      <div class="brand-inner-frame" :class="{ 'brand-inner-frame--vignette': vignette }">
        <div class="brand-beam" aria-hidden="true" v-html="beamSvg" />
        <div class="brand-beam brand-beam--2" aria-hidden="true" v-html="beam2Svg" />
        <slot />
      </div>
      <slot name="footer-left" />
      <slot name="footer" />
    </div>
  </div>
</template>

<style scoped>
.brand-background {
  display: flex;
  flex: 1 1 auto;
  width: 100%;
  height: 100%;
  background: var(--neutral-900);
}

.brand-outer-frame {
  position: relative;
  flex: 1 1 auto;
  display: flex;
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
</style>
