import { ref, computed, type Ref, type ComputedRef } from 'vue'
import { useModal } from './useModal'
import { i18n } from '../i18n'
import type { Installation } from '../types/ipc'

/**
 * Overlay slot foundation.
 *
 * Each panel host (`PanelApp` and `ChooserView`) owns exactly ONE
 * `currentOverlay` slot — one DOM node mounted at a time. Opening a
 * new overlay replaces whatever is currently in the slot, subject to
 * the tier-collision rules below.
 *
 * The kinds form a discriminated union:
 *   - `settings`  — Unified Settings modal (ComfyUI Settings tab via
 *                   embedded DetailModal, Directories tab, Global
 *                   Settings tab). Replaces the legacy `manage` and
 *                   `page` kinds. Tier 1.
 *   - `progress` — ProgressModal for a long-running action that does
 *                  NOT end in the running ComfyUI app (delete,
 *                  snapshot, copy, update-while-stopped). Tier 2.
 *   - `takeover` — Full-window takeover for actions that end in the
 *                  app (launch, install, update-then-restart,
 *                  first-use). Tier 3.
 *
 * Modal-unification — the legacy `'app-update'` Tier 1 overlay popover
 * was retired in upstream's auto-updater pill+modal flow refactor.
 * The title-bar app-update pill now drives a `useModal.confirm` modal
 * (rendered by the global `<ModalDialog />` mount) directly from
 * `PanelApp`'s `panel-trigger-overlay 'app-update'` handler, instead
 * of going through this slot. The kind is gone from `OverlayKind` and
 * the discriminated `Overlay` union to keep the type narrow to the
 * surfaces this slot actually owns.
 *
 * App-update is NOT an overlay kind — the title-bar pill click pops a
 * `useModal.confirm` modal rendered by the global `<ModalDialog />`
 * mount, not by this slot.
 *
 * Modal-unification (Track M-7) — the legacy `'flow'` Tier 3 kind
 * was retired here. Pre-M-3 the four install-flow modals
 * (NewInstall / Track / LoadSnapshot / QuickInstall) mounted via
 * `kind: 'flow'` while they still rendered as panel bodies, and
 * the M-3 migration moved them into `kind: 'takeover'` chrome. The
 * `'flow'` kind has had no caller since M-3 shipped, so the
 * discriminated-union member, the TIER entry, and the corresponding
 * collision rules are gone. Tier 3 itself stays — `kind: 'takeover'`
 * still owns first-use, the four install-flow wizards, and update-
 * while-running, all of which need the binding-modal chrome the
 * tier provides.
 *
 * Tier-collision rules — implemented by `openOverlay`:
 *   - Tier 1 → any tier: auto-replace silently.
 *   - Tier 2 → Tier 1: silently kill the lower-tier overlay (Tier 1
 *             would normally replace silently anyway, but a Tier 2 op
 *             on top doesn't "drop" to Tier 1 — the Tier 2 wins).
 *   - Tier 2 → Tier 2 (replace while running): prompt to cancel the
 *             current op via the standardised cancel-prompt copy.
 *   - Tier 3 → Tier 1: pre-empts silently.
 *   - Tier 3 → Tier 2: pre-empts with the same cancel prompt.
 *   - Anything → Tier 3 already mounted: pre-empts silently
 *             (takeover replacing takeover is rare — used by the
 *             multi-step first-use flow chaining into new-install).
 *
 * The standardised cancel-prompt copy is sourced from
 * `overlay.cancelCurrentTitle` / `overlay.cancelNamedTitle` so every
 * caller speaks with one voice ("Cancel current operation?" /
 * `Cancel "Updating ComfyUI"?`).
 */

export type OverlayKind = 'settings' | 'progress' | 'takeover'

/**
 * Unified Settings modal — ModalShell with a left-rail tab switcher
 * hosting "ComfyUI Settings" (per-install DetailModal body),
 * "Directories" (combined Models / Media browser), and "Global
 * Settings" (launcher-wide settings). Replaces the legacy `manage`
 * and `page` overlay kinds; every install-pill / waffle / chooser-
 * card-Manage entry-point routes through here.
 *
 * `installation` is null on install-less host windows opening the
 * modal from the file-menu Settings entry — the "ComfyUI Settings"
 * tab is hidden and the default falls through to "Global Settings".
 *
 * `initialDetailTab` and `autoAction` are forwarded to the embedded
 * DetailModal so chooser-card update / migrate pills can deep-link
 * straight to the Update tab with the relevant action pre-armed.
 *
 * `noSidebar` collapses the modal to just the active tab's content
 * (no left rail, no tab switcher). Used for chooser-card "Manage…" /
 * Update / Migrate entry-points where the user picked a specific
 * install and wants the focused per-install Settings surface — the
 * sidebar's Directories / Global Settings tabs would be a distraction
 * in that flow. The file-menu / title-bar Settings entry leaves it
 * unset (default false) so the full sidebar layout renders.
 */
export interface SettingsOverlay {
  kind: 'settings'
  installation: Installation | null
  initialTab: 'comfy' | 'directories' | 'global'
  initialDetailTab?: string
  autoAction?: string | null
  noSidebar?: boolean
}

export interface ProgressOverlay {
  kind: 'progress'
  installationId: string
  /** Friendly label for the cancel-prompt copy ("Updating ComfyUI"). */
  operationName?: string
  /**
   * Modal-unification (Track M-6) — fired AFTER the user confirms the
   * cancel-prompt during a window-close consult (or any other slot-
   * clearing transition that triggers the prompt). Callers wire this
   * to the underlying cancel/rollback path in main (typically
   * `progressStore.cancelOperation(installationId)`) so the in-flight
   * operation is told to stop rather than being orphaned by window
   * destruction. Optional — Tier 2 progress overlays without an
   * in-flight cancellable op leave it unset.
   */
  onCancel?: () => void
}

/**
 * Modal-unification (Track M-7) — string union of the four install-
 * flow takeover component identifiers. Pre-M-7 this was the body of
 * the now-retired `FlowOverlay`; the union itself stays useful as
 * the type of `openFlowTakeover`'s `component` parameter (and of
 * the `TakeoverOverlay.component` value when one of these
 * particular wizards mounts).
 */
export type FlowComponent = 'new-install' | 'track' | 'load-snapshot' | 'quick-install'

export interface TakeoverOverlay {
  kind: 'takeover'
  /** Free-form identifier — Step 3+ wires concrete components per id. */
  component: string
  /** Optional label for the takeover-replacing-progress cancel prompt. */
  operationName?: string
  /**
   * Set for progress-style takeovers (Step 5 §10 — the `'update'`
   * component) so the takeover slot can bind ProgressModal to the
   * right install. Other takeover components ignore this.
   */
  installationId?: string
  /**
   * Modal-unification (Track M-2.4 / M-6) — opt the takeover into a
   * non-default cancel-prompt copy when main consults the renderer
   * via `comfy-window:request-close`. Variants:
   *   - `'quit-setup'` (M-2.4) — first-use bootstrap takeover
   *     (consent / pick / mirrors / localBranch). Reads "Quit setup?"
   *     / "your selection won't be saved …".
   *   - `'discard-setup'` (M-6) — install-flow wizards
   *     (NewInstall / Track / LoadSnapshot / QuickInstall) on the
   *     dashboard. Reads "Discard install setup?" / "Your wizard
   *     selections won't be saved …". Distinct from `'quit-setup'`
   *     because the user is mid-wizard with no first-use bootstrap
   *     gating, and from the generic operation-cancel copy because
   *     no destructive op has started yet.
   * Undefined keeps the generic
   * `overlay.cancelCurrentTitle` / `overlay.cancelMessage` pair —
   * appropriate for in-flight Tier 3 ops like update-while-running
   * (`component: 'update'`) where there IS a destructive op the
   * user might be cancelling.
   */
  cancelCopyKey?: 'quit-setup' | 'discard-setup'
  /**
   * Modal-unification (Track M-6) — fires AFTER the user confirms the
   * cancel-prompt for this takeover. Same shape as `ProgressOverlay.
   * onCancel` (see there). Set on `component: 'update'` (mirrors the
   * Tier 2 progress branch — both wrap the same in-flight
   * `progressStore` op that has to be cancel-called in main to
   * actually roll back, otherwise the window destruction orphans the
   * underlying process). Wizard takeovers (install flows / first-use)
   * leave it unset — the cancel-prompt for those just dismisses the
   * wizard with no main-side rollback to fire.
   */
  onCancel?: () => void
}

export type Overlay =
  | SettingsOverlay
  | ProgressOverlay
  | TakeoverOverlay

const TIER: Record<OverlayKind, 1 | 2 | 3> = {
  settings: 1,
  progress: 2,
  takeover: 3,
}

export function tierOf(o: Overlay | null): 0 | 1 | 2 | 3 {
  return o ? TIER[o.kind] : 0
}

export interface OpenOverlayOpts {
  /** Caller's own kind — purely advisory, useful for logging. */
  from?: OverlayKind
}

export interface UseOverlayApi {
  /** The current overlay (read-only outside the composable). */
  current: Ref<Overlay | null>
  /** Tier of the currently-mounted overlay (`0` when nothing is mounted). */
  tier: ComputedRef<number>
  /**
   * Replace the current overlay with `next`.
   *
   * Returns `true` when the swap actually happened. A Tier 2/3 op that
   * pre-empts an in-flight Tier 2 returns `false` if the user dismissed
   * the cancel prompt — the slot is left untouched.
   *
   * Pass `null` to close whatever is currently open (subject to the
   * same Tier 2 cancel-prompt rule when the slot holds a progress op).
   */
  openOverlay: (next: Overlay | null, opts?: OpenOverlayOpts) => Promise<boolean>
  /** Convenience — equivalent to `openOverlay(null)`. */
  closeOverlay: () => Promise<boolean>
}

// Module-level singleton — every consumer of useOverlay() shares the same
// slot so Tier-collision rules apply across the whole app, not just within
// one component's instance.
const _current = ref<Overlay | null>(null)
const _tier = computed(() => tierOf(_current.value))

export function useOverlay(): UseOverlayApi {
  const current = _current
  const modal = useModal()

  const tier = _tier

  async function confirmCancelCurrent(cur: Overlay): Promise<boolean> {
    const t = i18n.global.t
    // Modal-unification (Track M-2.4 / M-6) — takeovers can opt into a
    // dedicated copy bundle:
    //   - `'quit-setup'` (M-2.4) — first-use bootstrap takeover.
    //   - `'discard-setup'` (M-6) — install-flow wizards (NewInstall
    //     / Track / LoadSnapshot / QuickInstall) on the dashboard.
    //     The user is mid-wizard with no destructive op in flight, so
    //     the prompt copy is "Discard install setup?" rather than
    //     either the bootstrap-flavoured "Quit setup?" or the
    //     in-flight-op "Cancel current operation?".
    if (cur.kind === 'takeover' && cur.cancelCopyKey === 'quit-setup') {
      return await modal.confirm({
        title: t('overlay.quitSetupTitle'),
        message: t('overlay.quitSetupMessage'),
        confirmLabel: t('overlay.quitSetupConfirm'),
        confirmStyle: 'danger',
      })
    }
    if (cur.kind === 'takeover' && cur.cancelCopyKey === 'discard-setup') {
      return await modal.confirm({
        title: t('overlay.discardSetupTitle'),
        message: t('overlay.discardSetupMessage'),
        confirmLabel: t('overlay.discardSetupConfirm'),
        confirmStyle: 'danger',
      })
    }
    const curName =
      (cur.kind === 'progress' || cur.kind === 'takeover') ? cur.operationName : undefined
    const title = curName
      ? t('overlay.cancelNamedTitle', { name: curName })
      : t('overlay.cancelCurrentTitle')
    return await modal.confirm({
      title,
      message: t('overlay.cancelMessage'),
      confirmLabel: t('overlay.cancelConfirm'),
      confirmStyle: 'danger',
    })
  }

  async function openOverlay(next: Overlay | null, _opts: OpenOverlayOpts = {}): Promise<boolean> {
    const cur = current.value
    const curTier = tierOf(cur)
    const nextTier = next ? TIER[next.kind] : 0

    // Replacing / closing an in-flight Tier 2 always prompts. Pre-empting
    // it with Tier 3 follows the same rule (the design treats Tier 3 as
    // "ends in the app" so we still give the user one chance to abort).
    // Modal-unification (Track M-6) — when the prompt is confirmed we
    // fire the overlay's `onCancel` BEFORE swapping the slot so the
    // underlying main-side op is told to stop and roll back. Without
    // this the slot-clear (or pre-empt) would orphan the in-flight
    // process, which is exactly the rollback hole the cancel matrix
    // calls out for Tier 2 progress + Tier 3 update-while-running.
    if (cur?.kind === 'progress' && nextTier >= 2) {
      const ok = await confirmCancelCurrent(cur)
      if (!ok) return false
      cur.onCancel?.()
    }
    // Closing (`next === null`) an in-flight progress op also prompts —
    // window-close / dashboard-return paths drive that branch. Step 5
    // §16 — the takeover variant covers Tier 3 ops (update on a
    // running install, install / first-use takeovers) so the user
    // can't lose work without confirmation when main consults the
    // renderer via `comfy-window:request-close`.
    if (next === null && (cur?.kind === 'progress' || cur?.kind === 'takeover')) {
      const ok = await confirmCancelCurrent(cur)
      if (!ok) return false
      cur.onCancel?.()
    }

    // Silent Tier 3 → Tier 3 swap (chain-local, e.g. first-use →
    // new-install). The current Tier 3 is being replaced WITHOUT a
    // prompt by design — but if it has an `onCancel` rollback
    // attached, fire it here so the underlying main-side op (if any)
    // is told to stop. First-use's takeover doesn't set `onCancel`,
    // so this is a no-op for the only chain-local caller today; it
    // closes the rollback hole for any future Tier 3 takeover that
    // does set one. See post-unification-code-review.md F13.
    if (cur?.kind === 'takeover' && next?.kind === 'takeover') {
      cur.onCancel?.()
    }
    // All other transitions are silent: Tier 1 ↔ Tier 1 (chooser's
    // manage swap), Tier 2/3 onto Tier 1 (manage being pre-empted),
    // Tier 3 onto nothing (first-use), close from Tier 1 / Tier 3.
    void curTier // currently unused — kept for future rule expansion.
    current.value = next
    return true
  }

  async function closeOverlay(): Promise<boolean> {
    return openOverlay(null)
  }

  return { current, tier, openOverlay, closeOverlay }
}
