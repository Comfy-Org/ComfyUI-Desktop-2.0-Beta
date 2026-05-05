import { ref, computed, type Ref, type ComputedRef } from 'vue'
import { useModal } from './useModal'
import { i18n } from '../i18n'
import type { Installation } from '../types/ipc'

/**
 * Overlay slot foundation (Phase 3 §17 unified-window refactor).
 *
 * Each panel host (`PanelApp` and `ChooserView`) owns exactly ONE
 * `currentOverlay` slot — one DOM node mounted at a time. Opening a
 * new overlay replaces whatever is currently in the slot, subject to
 * the tier-collision rules below.
 *
 * The kinds form a discriminated union:
 *   - `manage`   — DetailModal (Manage…) + confirm/prompt/channel
 *                  cards / action menus. Tier 1.
 *   - `progress` — ProgressModal for a long-running action that does
 *                  NOT end in the running ComfyUI app (delete,
 *                  snapshot, copy, update-while-stopped). Tier 2.
 *   - `flow`     — Multi-step flow surface for a Tier 3 action that
 *                  DOES end in the running ComfyUI app (legacy slot
 *                  for `new-install` / `track` / `load-snapshot` /
 *                  `quick-install` while they still mount as panel
 *                  bodies; will move into the takeover slot in Step 3).
 *   - `takeover` — Full-window takeover for actions that end in the
 *                  app (launch, install, update-then-restart,
 *                  first-use, app-update). Tier 3.
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

export type OverlayKind = 'manage' | 'app-update' | 'progress' | 'flow' | 'takeover'

export interface ManageOverlay {
  kind: 'manage'
  installation: Installation
  initialTab?: string
  autoAction?: string | null
}

/**
 * Phase 3 §18 — Tier 1 popover surfaced from the title-bar app-update
 * pill. Reads its state (available / ready / version) from the shared
 * `useAppUpdateState` composable so the popover and `UpdateBanner`
 * never disagree. No additional payload — the composable owns the
 * data, the overlay just signals "render the popover".
 */
export interface AppUpdateOverlay {
  kind: 'app-update'
}

export interface ProgressOverlay {
  kind: 'progress'
  installationId: string
  /** Friendly label for the cancel-prompt copy ("Updating ComfyUI"). */
  operationName?: string
}

export type FlowComponent = 'new-install' | 'track' | 'load-snapshot' | 'quick-install'

export interface FlowOverlay {
  kind: 'flow'
  component: FlowComponent
}

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
}

export type Overlay =
  | ManageOverlay
  | AppUpdateOverlay
  | ProgressOverlay
  | FlowOverlay
  | TakeoverOverlay

const TIER: Record<OverlayKind, 1 | 2 | 3> = {
  manage: 1,
  'app-update': 1,
  progress: 2,
  flow: 3,
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

export function useOverlay(): UseOverlayApi {
  const current = ref<Overlay | null>(null)
  const modal = useModal()

  const tier = computed(() => tierOf(current.value))

  async function confirmCancelCurrent(curName?: string): Promise<boolean> {
    const t = i18n.global.t
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
    if (cur?.kind === 'progress' && nextTier >= 2) {
      const ok = await confirmCancelCurrent(cur.operationName)
      if (!ok) return false
    }
    // Closing (`next === null`) an in-flight progress op also prompts —
    // window-close / dashboard-return paths drive that branch. Step 5
    // §16 — the takeover variant covers Tier 3 ops (update on a
    // running install, install / first-use takeovers) so the user
    // can't lose work without confirmation when main consults the
    // renderer via `comfy-window:request-close`.
    if (next === null && (cur?.kind === 'progress' || cur?.kind === 'takeover')) {
      const ok = await confirmCancelCurrent(cur.operationName)
      if (!ok) return false
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
