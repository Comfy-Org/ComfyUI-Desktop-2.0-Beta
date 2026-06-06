import { EventEmitter } from 'events'
import type { BrowserWindow, WebContents, WebContentsView } from 'electron'
import { _runningSessions } from '../lib/ipc/shared'
import type { FirstUseMode } from '../../shared/firstUseMode'

/**
 * Bus for host-window install attachment changes. `'changed'` fires when the
 * `installationId → windowKey` index mutates (attach/detach/re-attach), so the
 * picker's "Current" pill flips as soon as a launch attaches — earlier than the
 * install-record `installationEvents.changed`.
 */
export const hostInstallEvents = new EventEmitter()

/**
 * Title-bar pill key. The Comfy pill maps to either the live ComfyUI view or
 * the lifecycle panel, decided in `computeBodyMode()`.
 */
export type ComfyPanelKey =
  | 'comfy'
  | 'downloads-v2'
  | 'feedback'
  | 'new-install'
  | 'track'
  | 'load-snapshot'
  | 'quick-install'
  /** Forces "panel visible, comfy hidden" while a picker-driven ProgressModal
   *  is mounted; survives `_runningSessions` flips during update→relaunch. Not
   *  a title-bar pill — set programmatically. */
  | 'progress'

export const VALID_PANELS: ReadonlySet<ComfyPanelKey> = new Set([
  'comfy',
  'downloads-v2',
  'feedback',
  'new-install',
  'track',
  'load-snapshot',
  'quick-install',
  'progress',
])

/**
 * Internal body-mode for a comfy window. `'comfy-lifecycle'` and `'chooser'`
 * are not title-bar pills — they fill the Comfy tab body when the install isn't
 * running or when the host is install-less; the Comfy pill stays highlighted.
 */
export type BodyMode =
  | 'comfy'
  | 'comfy-lifecycle'
  | 'downloads-v2'
  | 'feedback'
  | 'chooser'
  /** Mirror of the `'progress'` ComfyPanelKey; forces the panel to fully cover
   *  the canvas while a picker-driven ProgressModal is mounted. */
  | 'progress'
  | 'new-install'
  | 'track'
  | 'load-snapshot'
  | 'quick-install'

/**
 * Per-installation handle for a ComfyUI window. The window is a parent
 * BrowserWindow plus two WebContentsViews (title bar + content). Navigation /
 * restart / splash flows must target `comfyView.webContents`, NOT the parent
 * window's webContents (only a host for the views).
 */
export interface ComfyWindowEntry {
  /** Stable numeric PRIMARY key into `comfyWindows`, minted at construction.
   *  Survives attach/detach so a window can flip modes without re-keying;
   *  install-id lookups go through `getEntryByInstallationId(id)`. */
  windowKey: number
  window: BrowserWindow
  comfyView: WebContentsView
  titleBarView: WebContentsView
  /** Lazily created on the first non-comfy panel switch or when the Comfy tab
   *  needs the lifecycle or chooser body. */
  panelView: WebContentsView | null
  /** Currently rendered panel — always a user-visible key, never the internal
   *  `'comfy-lifecycle'` / `'chooser'` body modes. */
  activePanel: ComfyPanelKey
  /** Last theme reported by the ComfyUI frontend, applied to the panel on load. */
  lastTheme: { bg: string; text: string }
  /** Updates view bounds for the current activePanel. */
  layoutViews: () => void
  /** Current ComfyUI URL for the comfyView, updated on every `onLaunch` so
   *  reload / did-fail-load handlers don't hold stale URLs. Empty for
   *  install-less hosts. */
  comfyUrl: string
  /** Installation backing this window, or null for install-less hosts. `null`
   *  at construction for EVERY host; `attachInstall()` populates it and
   *  `_installCleanup` clears it — that invariant is what makes attachInstall's
   *  already-attached guard work. */
  installationId: string | null
  /** Partition the comfyView was constructed with (pinned; Electron can't
   *  change it without rebuilding). A chooser-pick claim must reject any install
   *  whose partition differs, else session data leaks across partition buckets. */
  constructedPartition: string | null
  /** Current first-use takeover step, cached so `buildTitlePopupMenuItems` can
   *  read it synchronously on file-menu click. See `src/shared/firstUseMode.ts`. */
  firstUseMode: FirstUseMode
  /** Current title-bar pill label (install name, or `'Comfy Desktop'` for
   *  install-less). Stored on the entry so the `title-bar-ready` handshake and
   *  attach/detach can re-push without closure capture. */
  titleBarText: string
  /** Install-type icon category for the title-bar renderer; `null` for
   *  install-less hosts. */
  sourceCategory: string | null
  /** Install id previewed in the title bar while this host is still install-less
   *  but has claimed an op (so the user sees "Launching MyInstall…"). Cleared
   *  when the op attaches or aborts. The pushed preview-mode boolean is derived
   *  as `!== null`. */
  previewInstallationId: string | null
  /** Keeps the BrowserWindow hidden until the first paint so the user doesn't
   *  stare at an empty body while panel.html boots. Cleared on reveal. */
  coldStartPendingReveal: boolean
  /** Symmetric undo for `attachInstall()` (set by attach, called by the close
   *  handler and `detachInstall()`). `null` when not install-backed. */
  _installCleanup: (() => void) | null
  /** Flip this host in place to install-less (chooser) mode via
   *  `_detachInstallImpl`. No-op when already install-less; always populated. */
  detachInstall: () => void
}

/** All host windows, keyed by numeric `windowKey`. Install-id lookups go
 *  through `getEntryByInstallationId(id)` (the secondary index below). */
export const comfyWindows = new Map<number, ComfyWindowEntry>()
const installationIdToWindowKey = new Map<string, number>()

/** MRU installation id, tracked by id (not window key) so detach + re-launch
 *  still resolves to the same install. Stale ids self-invalidate via
 *  `getEntryByInstallationId`, so no cleanup hook is needed. */
let lastFocusedInstallationId: string | null = null
export function getLastFocusedInstallationId(): string | null {
  return lastFocusedInstallationId
}
export function setLastFocusedInstallationId(id: string | null): void {
  lastFocusedInstallationId = id
}

/** Pending in-place attach claims (chooser host → install), keyed by
 *  installationId. `onLaunch()` consumes a claim to reuse the chooser host
 *  instead of building a fresh window; only honoured when the target is still
 *  alive and install-less. Mutate only via the helpers below. */
const pendingAttachClaims = new Map<string, number>()

/** Stake an in-place attach claim from the chooser host. */
export function claimAttachHost(installationId: string, windowKey: number): void {
  pendingAttachClaims.set(installationId, windowKey)
}

/** Atomically take the claim for `installationId` (returns `undefined` if none). */
export function consumeAttachClaim(installationId: string): number | undefined {
  const key = pendingAttachClaims.get(installationId)
  if (key === undefined) return undefined
  pendingAttachClaims.delete(installationId)
  return key
}

/** Drop every claim whose target was `windowKey` (host-window close cleanup). */
export function dropAttachClaimsForWindow(windowKey: number): void {
  for (const [installationId, claimedKey] of pendingAttachClaims) {
    if (claimedKey === windowKey) pendingAttachClaims.delete(installationId)
  }
}

/** Test-only escape hatch — reset state between cases. */
export function _resetAttachClaimsForTest(): void {
  pendingAttachClaims.clear()
}

let _nextWindowKeyValue = 0
export function nextWindowKey(): number {
  return ++_nextWindowKeyValue
}

/** Install-id → entry lookup via the secondary index. `undefined` when no
 *  install-backed entry carries the id. */
export function getEntryByInstallationId(installationId: string): ComfyWindowEntry | undefined {
  const key = installationIdToWindowKey.get(installationId)
  return key === undefined ? undefined : comfyWindows.get(key)
}

/** Set the install-id → window-key index entry. Emits `hostInstallEvents.changed`
 *  so picker snapshots repaint without waiting on `instance-started`. */
export function indexInstallationId(installationId: string, windowKey: number): void {
  installationIdToWindowKey.set(installationId, windowKey)
  hostInstallEvents.emit('changed')
}

/** Drop a stale `installationId` from the secondary index without touching the
 *  primary map. Emits `hostInstallEvents.changed` so picker snapshots clear. */
export function dropInstallationIndex(installationId: string): void {
  const had = installationIdToWindowKey.delete(installationId)
  if (had) hostInstallEvents.emit('changed')
}

/** Register an entry into the primary map and (when install-backed) the
 *  secondary index. Use instead of touching `comfyWindows.set` directly. */
export function registerHostEntry(entry: ComfyWindowEntry): void {
  comfyWindows.set(entry.windowKey, entry)
  if (entry.installationId !== null) {
    installationIdToWindowKey.set(entry.installationId, entry.windowKey)
    hostInstallEvents.emit('changed')
  }
}

/** Unregister an entry from the primary map and the secondary index. Use
 *  instead of touching `comfyWindows.delete` directly. */
export function unregisterHostEntry(entry: ComfyWindowEntry): void {
  comfyWindows.delete(entry.windowKey)
  if (entry.installationId !== null) {
    const indexed = installationIdToWindowKey.get(entry.installationId)
    if (indexed === entry.windowKey) {
      installationIdToWindowKey.delete(entry.installationId)
      hostInstallEvents.emit('changed')
    }
  }
}

/** Predicate: install-less (chooser) host. Narrows `installationId` to `null`. */
export function isChooserHost(
  entry: ComfyWindowEntry,
): entry is ComfyWindowEntry & { installationId: null } {
  return entry.installationId === null
}

/** Predicate: this entry is an install-backed host. Inverse of `isChooserHost`. */
export function isInstallHost(
  entry: ComfyWindowEntry,
): entry is ComfyWindowEntry & { installationId: string } {
  return entry.installationId !== null
}

/**
 * Predicate: tearing down / stopping this entry would kill a local ComfyUI
 * process. Drives every "are you sure?" surface. Must be install-backed AND
 * `sourceCategory === 'local'` (a preview host can carry sourceCategory without
 * an attached install).
 */
export function shouldConfirmKillForEntry(
  entry: ComfyWindowEntry | null | undefined,
): entry is ComfyWindowEntry & { installationId: string } {
  return !!entry && isInstallHost(entry) && entry.sourceCategory === 'local'
}

/**
 * Predicate: this entry has a live ComfyUI session (i.e. its body shows the
 * running ComfyUI view, not the lifecycle/crash panel). Used to decide whether
 * the install is a healthy "last active surface" worth restoring on next boot.
 */
export function hasRunningSessionForEntry(
  entry: ComfyWindowEntry | null | undefined,
): entry is ComfyWindowEntry & { installationId: string } {
  return !!entry && isInstallHost(entry) && _runningSessions.has(entry.installationId)
}

/**
 * Decide what fills a comfy window's body. Install-backed: the Comfy pill →
 * live ComfyUI view (running) or lifecycle panel (stopped). Install-less: the
 * Comfy pill → chooser. Centralised so layout and body swaps can't disagree.
 */
export function computeBodyMode(entry: ComfyWindowEntry): BodyMode {
  if (entry.installationId === null) {
    // Install-less: Comfy pill → chooser; everything else maps to itself.
    return entry.activePanel === 'comfy' ? 'chooser' : entry.activePanel
  }
  if (entry.activePanel !== 'comfy') return entry.activePanel
  return _runningSessions.has(entry.installationId) ? 'comfy' : 'comfy-lifecycle'
}

/**
 * Resolve an IPC `event.sender` to the entry whose title-bar WebContentsView
 * owns it, by reference equality. The single chokepoint every title-bar IPC
 * must funnel through, so aux windows (preload-less popups) and the
 * comfy/panel views can't pop the file/install menu. Returning `null` makes
 * every consuming handler no-op. Prefer this over open-coding a sender match.
 */
export function findEntryByTitleBarSender(wc: WebContents): { id: number; entry: ComfyWindowEntry } | null {
  for (const [id, entry] of comfyWindows) {
    if (entry.titleBarView.webContents === wc) return { id, entry }
  }
  return null
}

/** Resolve the installationId backing the comfyView whose webContents sent an
 *  IPC message. Used by the terminal bridge so the served ComfyUI frontend
 *  (which has no idea which install it belongs to) reaches the right shell. */
export function findInstallationIdByComfySender(wc: WebContents): string | null {
  for (const entry of comfyWindows.values()) {
    if (entry.comfyView.webContents === wc) return entry.installationId
  }
  return null
}

/** Resolve a host BrowserWindow back to its registry entry. */
export function findEntryByHostWindow(window: BrowserWindow): ComfyWindowEntry | null {
  for (const entry of comfyWindows.values()) {
    if (entry.window === window) return entry
  }
  return null
}

/** Find the first live host entry matching `pred`, preferring
 *  non-minimised over minimised. Within each visibility bucket, returns
 *  insertion order. Returns `null` when nothing matches. */
export function findPreferredHostByVisibility(
  pred: (entry: ComfyWindowEntry) => boolean,
): ComfyWindowEntry | null {
  let minimisedFallback: ComfyWindowEntry | null = null
  for (const [, entry] of comfyWindows) {
    if (entry.window.isDestroyed() || !pred(entry)) continue
    if (!entry.window.isMinimized()) return entry
    if (minimisedFallback === null) minimisedFallback = entry
  }
  return minimisedFallback
}

/** Find a chooser (install-less) host window to focus, preferring visible over
 *  minimised. */
export function findPreferredChooserHostWindow(): BrowserWindow | null {
  const entry = findPreferredHostByVisibility((e) => e.installationId === null)
  return entry?.window ?? null
}

/** Find the install-backed host window to focus, in priority order:
 *  visible-MRU → any-visible → minimised-MRU → any-minimised. `null` if none. */
export function findPreferredInstallHostWindow(): BrowserWindow | null {
  const mruEntry =
    lastFocusedInstallationId !== null
      ? getEntryByInstallationId(lastFocusedInstallationId)
      : undefined
  const mruAlive = mruEntry && !mruEntry.window.isDestroyed() ? mruEntry : null
  const fallback = findPreferredHostByVisibility((e) => e.installationId !== null)
  if (mruAlive && !mruAlive.window.isMinimized()) return mruAlive.window
  if (fallback && !fallback.window.isMinimized()) return fallback.window
  if (mruAlive) return mruAlive.window
  return fallback?.window ?? null
}

/** Show a window and bring it to the front, working around Windows focus-theft
 *  prevention. Restores a minimised window first. */
export function bringToFront(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore()
  if (process.platform === 'win32') {
    win.setAlwaysOnTop(true)
    win.show()
    win.focus()
    win.setAlwaysOnTop(false)
  } else {
    win.show()
    win.focus()
  }
}

/** Reveal a chooser host held hidden for its first paint. Three callers race
 *  (titlebar dom-ready, panel did-finish-load, a timeout backstop); the flag is
 *  cleared on the first, so the rest no-op. */
export function revealColdStartHostIfPending(windowKey: number): void {
  const entry = comfyWindows.get(windowKey)
  if (!entry?.coldStartPendingReveal || entry.window.isDestroyed()) return
  entry.coldStartPendingReveal = false
  entry.layoutViews()
  bringToFront(entry.window)
}

/** Reveal a host whose cold-start reveal was deferred by the caller (the
 *  startup-restore flow holds the window hidden until its launch takeover is
 *  up, so the dashboard never flashes). Reveals regardless of the
 *  `coldStartPendingReveal` flag — the caller owns the timing. */
export function forceRevealHostWindow(windowKey: number): void {
  const entry = comfyWindows.get(windowKey)
  if (!entry || entry.window.isDestroyed()) return
  entry.coldStartPendingReveal = false
  entry.layoutViews()
  bringToFront(entry.window)
}

/** Late-bound host-window factories, set by `index.ts` so the registry can
 *  spawn a chooser host without importing host-construction code (cycle). */
interface HostFactories {
  createChooser: () => BrowserWindow
}
let hostFactories: HostFactories | null = null
export function setHostFactories(factories: HostFactories): void {
  hostFactories = factories
}
function requireChooserFactory(): () => BrowserWindow {
  if (!hostFactories) {
    throw new Error('host registry: setHostFactories() must be called before openOrFocus*')
  }
  return hostFactories.createChooser
}

/** Focus an existing chooser host window if one is open (visible
 *  preferred over minimised), otherwise create a fresh one. */
export function openOrFocusChooserHostWindow(): BrowserWindow {
  const existing = findPreferredChooserHostWindow()
  if (existing) {
    bringToFront(existing)
    return existing
  }
  return requireChooserFactory()()
}

/** Focus any live host for the platform re-launch hooks; install-backed beats
 *  chooser (visible beats minimised within each), spawning a fresh chooser
 *  only when no live host exists. */
export function openOrFocusAnyHostWindow(): BrowserWindow {
  const installWin = findPreferredInstallHostWindow()
  if (installWin) {
    bringToFront(installWin)
    return installWin
  }
  const chooser = findPreferredChooserHostWindow()
  if (chooser) {
    bringToFront(chooser)
    return chooser
  }
  return requireChooserFactory()()
}

/**
 * macOS dock-icon `activate`: raise EVERY live host to the front (the preferred
 * one last, so it's frontmost), falling back to a fresh chooser if none exist.
 * macOS-only; the `index.ts` caller guards on platform.
 */
export function raiseAllHostWindows(): BrowserWindow {
  const preferred =
    findPreferredInstallHostWindow() ?? findPreferredChooserHostWindow()
  if (!preferred) return requireChooserFactory()()

  // Raise every other live host first so the whole app comes forward,
  // then bring the preferred window up last so it lands frontmost.
  for (const [, entry] of comfyWindows) {
    if (entry.window.isDestroyed() || entry.window === preferred) continue
    bringToFront(entry.window)
  }
  bringToFront(preferred)
  return preferred
}
