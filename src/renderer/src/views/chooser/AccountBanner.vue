<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { Sparkles, X } from 'lucide-vue-next'
import { emitTelemetryAction } from '../../lib/telemetry'

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
  // `null` from the IPC handler means "flag not present in the on-disk
  // cache" (first boot before the background fetch settles, or a flag
  // that hasn't been pushed). That's a fallback assignment, not a
  // cache hit — tagging it as `'fallback'` lets dashboards split
  // first-boot users from steady-state users.
  let source: 'cache' | 'fallback' = 'cache'
  try {
    const variant = await window.api.telemetryGetExperimentFlag(EXPERIMENT_KEY)
    if (variant === null) {
      source = 'fallback'
    } else {
      variantStr =
        typeof variant === 'string' ? variant : variant === true ? 'treatment' : 'control'
    }
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
  // Outcome metric for the smoke-test experiment. Low dismiss rate =
  // banner is welcome / unobtrusive. High dismiss rate = banner is
  // annoying enough to swat at on every chooser load. Either signal
  // is informative for the real product banner that replaces this one.
  emitTelemetryAction('desktop2.account_banner.dismissed', {
    experiment_key: EXPERIMENT_KEY
  })
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
  background: var(--bg-elev-2, rgba(127, 127, 127, 0.14));
  border: 1px solid var(--border-subtle, rgba(127, 127, 127, 0.18));
  font-size: 12px;
  color: var(--text-muted, rgba(255, 255, 255, 0.72));
  max-width: max-content;
}

.account-banner-icon {
  color: var(--accent-soft, rgba(74, 144, 226, 0.9));
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
  background: var(--bg-elev-2, rgba(127, 127, 127, 0.18));
}

.account-banner-dismiss:focus-visible {
  outline: 2px solid var(--accent-soft, rgba(74, 144, 226, 0.9));
  outline-offset: 2px;
  opacity: 1;
}
</style>
