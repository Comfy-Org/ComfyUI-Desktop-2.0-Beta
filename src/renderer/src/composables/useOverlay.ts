import { ref, computed, type Ref, type ComputedRef } from 'vue'
import { useModal } from './useModal'
import { i18n } from '../i18n'

/**
 * Overlay slot foundation. Each panel host (PanelApp, ChooserView) owns one slot
 * with a single mounted overlay; opening a new one replaces the current per the
 * tier-collision rules in openOverlay. Tier 2 = progress (ends outside the app),
 * Tier 3 = takeover (ends in the app). Replacing/closing an in-flight Tier 2,
 * or pre-empting it with Tier 3, prompts to cancel.
 */

export type OverlayKind = 'progress' | 'takeover'

export interface ProgressOverlay {
  kind: 'progress'
  installationId: string
  operationName?: string
  /** Fired after the user confirms the cancel-prompt so the main-side op can roll back. */
  onCancel?: () => void
}

export type FlowComponent = 'new-install' | 'track' | 'load-snapshot' | 'quick-install'

export interface TakeoverOverlay {
  kind: 'takeover'
  component: string
  operationName?: string
  /** Set for progress-style takeovers ('update') so the slot binds ProgressModal to the right install. */
  installationId?: string
  /** Selects non-default cancel-prompt copy: 'quit-setup' (first-use) or 'discard-setup' (install wizards). */
  cancelCopyKey?: 'quit-setup' | 'discard-setup'
  /** Fired after the user confirms the cancel-prompt so the main-side op can roll back. */
  onCancel?: () => void
}

export type Overlay =
  | ProgressOverlay
  | TakeoverOverlay

const TIER: Record<OverlayKind, 2 | 3> = {
  progress: 2,
  takeover: 3,
}

export function tierOf(o: Overlay | null): 0 | 2 | 3 {
  return o ? TIER[o.kind] : 0
}

export interface OpenOverlayOpts {
  from?: OverlayKind
}

export interface UseOverlayApi {
  current: Ref<Overlay | null>
  tier: ComputedRef<number>
  /** Replace the current overlay with `next` (or `null` to close). Returns false if a cancel prompt was dismissed. */
  openOverlay: (next: Overlay | null, opts?: OpenOverlayOpts) => Promise<boolean>
  closeOverlay: () => Promise<boolean>
}

// Module-level singleton so Tier-collision rules apply app-wide, not per component instance.
const _current = ref<Overlay | null>(null)
const _tier = computed(() => tierOf(_current.value))

export function useOverlay(): UseOverlayApi {
  const current = _current
  const modal = useModal()

  const tier = _tier

  async function confirmCancelCurrent(cur: Overlay): Promise<boolean> {
    const t = i18n.global.t
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

    // Replacing/closing or pre-empting an in-flight Tier 2 prompts; on confirm fire
    // onCancel BEFORE swapping so the main-side op rolls back rather than being orphaned.
    if (cur?.kind === 'progress' && nextTier >= 2) {
      const ok = await confirmCancelCurrent(cur)
      if (!ok) return false
      cur.onCancel?.()
    }
    if (next === null && (cur?.kind === 'progress' || cur?.kind === 'takeover')) {
      const ok = await confirmCancelCurrent(cur)
      if (!ok) return false
      cur.onCancel?.()
    }

    // Silent Tier 3 → Tier 3 swap still fires onCancel, EXCEPT when re-presenting the
    // same install (matching installationId) — that would cancel the very op being re-shown.
    if (cur?.kind === 'takeover' && next?.kind === 'takeover') {
      const sameInstall =
        cur.installationId !== undefined && cur.installationId === next.installationId
      if (!sameInstall) cur.onCancel?.()
    }
    void curTier
    current.value = next
    return true
  }

  async function closeOverlay(): Promise<boolean> {
    return openOverlay(null)
  }

  return { current, tier, openOverlay, closeOverlay }
}
