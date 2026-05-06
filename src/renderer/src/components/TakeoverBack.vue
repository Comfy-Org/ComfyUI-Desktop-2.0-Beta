<script setup lang="ts">
/**
 * Modal-unification (Track M-5) — back / "Return to main concern"
 * affordance for binding takeover-modals.
 *
 * Per the design rules in `docs/modal-unification-plan.md`, binding
 * takeover-modals replace the corner ✕ with an explicit "back to
 * main concern" affordance: either a back chevron or a "Return to
 * <Dashboard|ComfyUI>" button. This component is the chevron-with-
 * label variant — it sits at the START of the takeover's
 * `view-modal-header` (before `TakeoverHeader`'s grand title) and
 * emits a `back` event that the host modal wires to its existing
 * `close` emit (which, on the four install-flow takeovers, returns
 * to the chooser body underneath).
 *
 * Per-flow choices captured in the plan doc:
 *  - NewInstallModal / TrackModal / LoadSnapshotModal / QuickInstallModal:
 *    chevron + "Back to Dashboard" label (mounted on the chooser
 *    host window — close emit returns to chooser).
 *  - FirstUseTakeover: NO back affordance — the bootstrap flow has
 *    no underlying dashboard to return to. Skip Onboarding via the
 *    file menu (M-2.2) is the post-consent escape; the consent
 *    step has no escape by design.
 *  - ProgressModal in takeover mode (update-while-running): deferred
 *    to M-6 alongside the cancel-on-window-close wiring (the
 *    semantics there are "cancel update with rollback", not "go
 *    back to a still-live underlying surface").
 */
import { ChevronLeft } from 'lucide-vue-next'

defineProps<{
  /** Visible label sat next to the chevron (e.g. "Back to Dashboard"). */
  label: string
}>()

const emit = defineEmits<{
  back: []
}>()
</script>

<template>
  <button
    type="button"
    class="takeover-back"
    :title="label"
    :aria-label="label"
    @click="emit('back')"
  >
    <ChevronLeft :size="18" class="takeover-back-icon" aria-hidden="true" />
    <span class="takeover-back-label">{{ label }}</span>
  </button>
</template>

<style scoped>
.takeover-back {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: none;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 4px 10px 4px 6px;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 13px;
  line-height: 1.2;
  flex-shrink: 0;
  transition: color 0.15s, background 0.15s, border-color 0.15s;
}

.takeover-back:hover {
  color: var(--text);
  background: var(--surface-hover, rgba(127, 127, 127, 0.08));
  border-color: var(--border-strong, var(--border));
}

.takeover-back:focus-visible {
  outline: 2px solid var(--accent, #60a5fa);
  outline-offset: 2px;
}

.takeover-back-icon {
  flex-shrink: 0;
}

.takeover-back-label {
  white-space: nowrap;
}
</style>
