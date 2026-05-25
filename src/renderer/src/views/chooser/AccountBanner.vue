<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { Sparkles, X } from 'lucide-vue-next'

/**
 * Foundation-validation A/B banner.
 *
 * A small, dismissible "Congrats — you're on a Comfy account." card that
 * shows in the chooser dashboard when the user is in the `treatment`
 * variant of the `auth_banner_smoketest_v1` experiment, and stays hidden
 * for the `control` variant.
 *
 * Purpose: smoke-test the whole A/B pipeline end-to-end (flag fetch,
 * variant assignment stability, exposure event firing, cache fallback)
 * BEFORE any real product experiment ships. No outcome events; the
 * `desktop2.experiment.exposed` counts in PostHog are the success
 * criteria. Once we've confirmed everything works, this banner gets
 * turned off and the next experiment replaces it.
 *
 * Dismiss is local-only — re-shows on next launch until the experiment
 * is turned off in PostHog.
 */
const EXPERIMENT_KEY = 'auth_banner_smoketest_v1'

const showBanner = ref(false)
const dismissed = ref(false)

onMounted(async () => {
  // Default branch + source if the fetch throws. We still record
  // exposure on the failure path — otherwise users whose fetch errors
  // are silently absent from the experiment's exposure denominator and
  // the control arm looks structurally smaller / biased.
  let variantStr = 'control'
  let source: 'cache' | 'fallback' = 'cache'
  try {
    const variant = await window.api.telemetryGetExperimentFlag(EXPERIMENT_KEY)
    variantStr = typeof variant === 'string' ? variant : variant === true ? 'treatment' : 'control'
  } catch {
    source = 'fallback'
  }
  try {
    window.api.telemetryRecordExposure({
      experimentKey: EXPERIMENT_KEY,
      variant: variantStr,
      source
    })
  } catch {
    // Telemetry must never break the chooser.
  }
  if (variantStr === 'treatment') showBanner.value = true
})

function dismiss(): void {
  dismissed.value = true
}
</script>

<template>
  <div v-if="showBanner && !dismissed" class="account-banner" role="status" aria-live="polite">
    <Sparkles :size="16" class="account-banner-icon" />
    <span class="account-banner-text"> Congrats — you're on a Comfy account. </span>
    <button type="button" class="account-banner-dismiss" aria-label="Dismiss" @click="dismiss">
      <X :size="14" />
    </button>
  </div>
</template>

<style scoped>
.account-banner {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px 6px 12px;
  margin: 0 auto 12px;
  border-radius: 999px;
  background: var(--color-surface-2, rgba(255, 255, 255, 0.06));
  border: 1px solid var(--color-border-subtle, rgba(255, 255, 255, 0.08));
  font-size: 12px;
  color: var(--color-text-secondary, rgba(255, 255, 255, 0.72));
  max-width: max-content;
}

.account-banner-icon {
  color: var(--color-accent, #a5b4fc);
  flex-shrink: 0;
}

.account-banner-text {
  white-space: nowrap;
}

.account-banner-dismiss {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  margin-left: 4px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: inherit;
  opacity: 0.6;
  cursor: pointer;
  transition:
    opacity 120ms ease,
    background 120ms ease;
}

.account-banner-dismiss:hover {
  opacity: 1;
  background: var(--color-surface-3, rgba(255, 255, 255, 0.06));
}

.account-banner-dismiss:focus-visible {
  outline: 2px solid var(--color-focus-ring, #6366f1);
  outline-offset: 2px;
  opacity: 1;
}
</style>
