import { EventEmitter } from 'events'
import type { BrowserWindow, WebContents, WebContentsView } from 'electron'
import { _runningSessions } from '../lib/ipc/shared'
import type { FirstUseMode } from '../../shared/firstUseMode'

/**
 * Internal main-process bus for host-window install attachment changes.
 *
 *  Events:
 *  - `'changed'`(): the `installationId → windowKey` secondary index
 *    mutated — a host attached, detached, or re-attached an install.
 *    Distinct from `installationEvents.changed` (which fires on
 *    install-record mutations: add/remove/rename/markLaunched).
 *    Surfaces like the instance picker, whose snapshot embeds
 *    `parentEntry.installationId` as `activeInstallationId`, listen to
 *    this so the "Current" pill flips on as soon as a launch attaches
 *    its install — not at `instance-started` time, which is when
 *    `markLaunched` would have fired the install-record change.
 */
export const hostInstallEvents = new EventEmitter()

/**
 * Title-bar pill key — one of the three user-visible navigation tabs.
 *
 * The Comfy pill maps to either the live ComfyUI WebContentsView (instance
 * running) or the lifecycle panel (instance stopped / launching / stopping).
 * The decision lives in `computeBodyMode()` and is internal to main.
 */
export type ComfyPanelKey =
  | 'comfy'
  | 'downloads-v2'
  | 'feedback'
  | 'new-install'
  | 'track'
  | 'load-snapshot'
  | 'quick-install'
  /** Forces "panel visible, comfy hidden" layout while a Tier-3
   *  takeover (currently picker-driven ProgressModal) is mounted.
   *  Survives `_runningSessions` flips during update→relaunch so the
   *  terminal-state screen stays visible when the install comes back
   *  up. Not a title-bar pill — set programmatically from the picker
   *  forward-show-progress IPC, restored to `'comfy'` when the modal
   *  closes. */
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
 * Internal body-mode for a comfy window.
 *
 * `'comfy-lifecycle'` is *not* a title-bar pill — it's the panel rendered
 * inside the Comfy tab when the install isn't running (no process up yet,
 * shutting down, or crashed). The title bar still highlights the Comfy pill;
 * the lifecycle view is just what fills the body in that state.
 *
 * `'chooser'` is also not a title-bar pill — it's the panel rendered inside
 * the Comfy tab of an install-less host window (one with no install backing
 * the entry yet). Picking an install in the chooser eventually swaps the
 * window in-place to a real install.
 */
export type BodyMode =
  | 'comfy'
  | 'comfy-lifecycle'
  | 'downloads-v2'
  | 'feedback'
  | 'chooser'
  /** Mirror of the `'progress'` ComfyPanelKey. Forces showPanel=true
   *  (mode !== 'comfy') and stays out of `isOverlayMode` (which keeps
   *  comfyView visible) so the panel covers the canvas fully while a
   *  picker-driven ProgressModal is mounted. */
  | 'progress'
  | 'new-install'
  | 'track'
  | 'load-snapshot'
  | 'quick-install'

/**
 * Per-installation handle for a ComfyUI window.
 *
 * The ComfyUI window is split into a parent BrowserWindow plus two
 * WebContentsViews — a thin native title bar and the ComfyUI content view.
 * Most lifecycle code needs the BrowserWindow (show, focus, destroy, bounds)
 * but the navigation / restart / splash flows must target the ComfyUI
 * WebContents, which lives on `comfyView.webContents` — NOT on the parent
 * window's webContents (that is only used as a host for the views).
 */
export interface ComfyWindowEntry {
  /**
   * Stable monotonic numeric identifier minted at construction. The
   * PRIMARY key into the `comfyWindows` map; survives attach/detach
   * so a host window can flip between install-backed and
   * chooser-host modes without re-keying. The numeric key uncouples
   * "which window is this" from "what install backs it" so
   * `returnToDashboard` is an in-place flip via
   * `entry.detachInstall()`.
   *
   * Lookups by `installationId` route through
   * `getEntryByInstallationId(id)` (a `Map<string, number>`
   * secondary index) instead of `comfyWindows.get(id)`.
   */
  windowKey: number
  window: BrowserWindow
  comfyView: WebContentsView
  titleBarView: WebContentsView
  /**
   * Lazily-created on first non-comfy panel switch *or* when the comfy tab
   * needs to render the lifecycle body (install stopped / launching) *or*
   * the chooser body (install-less host window).
   */
  panelView: WebContentsView | null
  /**
   * Which panel is currently rendered. Always one of the user-visible
   * panel keys — never the internal `'comfy-lifecycle'` / `'chooser'`
   * body modes.
   */
  activePanel: ComfyPanelKey
  /** Last known theme reported by the ComfyUI frontend, applied to the panel when it loads. */
  lastTheme: { bg: string; text: string }
  /** Layout function bound to this entry — updates view bounds for the current activePanel. */
  layoutViews: () => void
  /**
   * The current ComfyUI URL the comfyView should display. Updated on every
   * `onLaunch` so reload / did-fail-load handlers don't hold stale URLs
   * across stop+restart cycles (the window persists, the URL may change).
   * Empty string for install-less host windows where comfyView is collapsed.
   */
  comfyUrl: string
  /**
   * Installation backing this window, or null for install-less host
   * windows (chooser / file-menu flows). Centralises the "is this
   * entry install-backed?" decision so `computeBodyMode()` can
   * route the Comfy pill to the chooser without parallel branches
   * in every call site.
   *
   * `null` at construction time for EVERY host (createHostWindow
   * always builds install-less); the install-backed wrapper (and
   * the chooser-pick claim path) call `attachInstall()` immediately
   * afterwards to populate it. Treating the field as "set only by
   * attachInstall, cleared only by _installCleanup" is what lets
   * `attachInstall`'s already-attached guard work without a
   * chicken-and-egg mismatch on first construction.
   */
  installationId: string | null
  /**
   * The partition string the comfyView was constructed with. Pinned
   * at construction (Electron has no API to change a
   * WebContentsView's partition without rebuilding it), so a
   * chooser-pick claim must reject any install whose partition
   * doesn't match this. Without this gate, attaching a non-unique
   * install (`persist:shared`) to a host backed by a unique-partition
   * install (`persist:${prevId}`) leaks the new install's session
   * data into the previous install's partition bucket.
   */
  constructedPartition: string | null
  /**
   * Current step of the first-use takeover, cached on the entry so
   * `buildTitlePopupMenuItems` can read it synchronously when the
   * user opens the file menu (the menu builder runs on click, after
   * the popup config has already been chosen).
   *
   * See `FirstUseMode` in `src/shared/firstUseMode.ts` for the full
   * union. Cached here because `buildTitlePopupMenuItems` (file-menu
   * popup config builder) reads it synchronously when the user clicks
   * the waffle — see the IPC handler comment.
   */
  firstUseMode: FirstUseMode
  /**
   * Current title-bar pill label. Install-backed windows mirror the
   * install name (and re-push on rename); install-less hosts hold
   * `'Comfy Desktop'`. Stored on the entry so the unified
   * `title-bar-ready` handshake in `createHostWindow()` can
   * synthesize the initial push without a per-mode callback
   * closure, and so `attachInstall()` / `detachInstall()` can swap
   * it as the window flips modes.
   */
  titleBarText: string
  /**
   * Install-type icon category string (`local` / `cloud` /
   * `desktop` / …) consumed by the title-bar renderer's
   * `installTypeMetaFor()` helper. `null` for install-less host
   * windows (no icon shown). Mirrors the `titleBarText` design:
   * stored on the entry so the unified `title-bar-ready` handler
   * can re-push without closure capture.
   */
  sourceCategory: string | null
  /**
   * Install id whose identity is currently being previewed in the
   * title bar while this host is still install-less but has claimed
   * itself for an op (launch / install / update / migrate / copy).
   * The user sees "Launching MyInstall…" in the title bar instead of
   * the generic chooser-host label while the op runs. Cleared when
   * the op completes (attach takes over identity) or aborts (the
   * panel renderer fires `release-attach-host-preview`). `null`
   * whenever no op is in flight. The preview-mode boolean pushed to
   * the title-bar renderer is derived as `previewInstallationId !==
   * null` at the IPC boundary; no parallel boolean field is kept.
   */
  previewInstallationId: string | null
  /**
   * Chooser cold-start keeps the BrowserWindow hidden until the panel's
   * first `did-finish-load` so the user doesn't stare at an empty body
   * while panel.html boots. Cleared when the window is revealed.
   */
  coldStartPendingReveal: boolean
  /**
   * Symmetric undo for `attachInstall()`. Set by attach (closes
   * over every event listener and map mutation it set up); called
   * by the close handler before view teardown AND by
   * `detachInstall()` to flip the host back to install-less mode in
   * place. `null` whenever the entry is not currently
   * install-backed.
   */
  _installCleanup: (() => void) | null
  /**
   * Flip this host in place from install-backed to install-less
   * (chooser) mode. Delegates to the freestanding
   * `_detachInstallImpl(entry)` helper; exposed as a method so
   * callers (`returnToDashboard`, chooser-tile re-attach) can invoke
   * it without importing the helper. No-op when the entry is
   * already install-less. Always populated (set in
   * `createHostWindow()`).
   */
  detachInstall: () => void
}

/**
 * All host windows (install-backed and install-less). Keyed by a
 * stable monotonic numeric `windowKey` minted at construction.
 *
 * Install-id → window-key lookups go through
 * `getEntryByInstallationId(id)` below (the
 * `installationIdToWindowKey` secondary index).
 */
export const comfyWindows = new Map<number, ComfyWindowEntry>()
const installationIdToWindowKey = new Map<string, number>()

/**
 * Most recently focused installation's id, or `null` when no install
 * has been focused yet. Tracked by install id (not by window key) so
 * that detach + re-launch into a different host window still resolves
 * to the same install on the next dock-icon click.
 *
 * Stale ids self-invalidate: `getEntryByInstallationId(id)` returns
 * `undefined` once the install no longer backs any window (close,
 * detach without re-launch, uninstall) and `findPreferredInstallHostWindow`
 * falls through to the insertion-order pick — no explicit cleanup hook
 * required when windows close or installs detach.
 *
 * Updated by a `'focus'` listener on every host window and consulted
 * by the platform re-launch hooks (`activate` / `second-instance`).
 */
let lastFocusedInstallationId: string | null = null
export function getLastFocusedInstallationId(): string | null {
  return lastFocusedInstallationId
}
export function setLastFocusedInstallationId(id: string | null): void {
  lastFocusedInstallationId = id
}

/**
 * Pending in-place attach claims, set by the chooser-host renderer
 * right before it kicks off a launch action. `onLaunch()` consumes
 * the claim instead of constructing a fresh BrowserWindow when the
 * launch event arrives, so the chooser host the user clicked from
 * becomes the install's own host in place. Keyed by installationId
 * so a fast double-click on the same tile resolves to the same
 * target host.
 *
 * The claim is only honoured when the target window is still alive
 * and still install-less (the user may have closed the chooser host
 * while the install spin-up was running, or picked a second install
 * before the first one finished launching). Stale claims fall
 * through to the fresh-window path; the chooser-host renderer keeps
 * a fallback `closeHostWindow` wired for that case.
 *
 * Internal — mutate only via the helpers below so the producer/
 * consumer/cleanup sites can't drift apart.
 */
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

/**
 * Install-id → entry lookup, routed through the
 * `installationIdToWindowKey` secondary index. Returns `undefined`
 * if no install-backed entry currently carries the id (install-less
 * host windows never enter the index, and a detached window leaves
 * it too).
 */
export function getEntryByInstallationId(installationId: string): ComfyWindowEntry | undefined {
  const key = installationIdToWindowKey.get(installationId)
  return key === undefined ? undefined : comfyWindows.get(key)
}

/**
 * Set the install-id → window-key secondary index entry. Use from
 * `attachInstall` after it pivots the entry's `installationId`.
 * Emits `hostInstallEvents.changed` so picker snapshots repaint with
 * the new `activeInstallationId` without waiting on `instance-started`.
 */
export function indexInstallationId(installationId: string, windowKey: number): void {
  installationIdToWindowKey.set(installationId, windowKey)
  hostInstallEvents.emit('changed')
}

/**
 * Drop a stale `installationId` from the secondary index without
 * touching the primary `comfyWindows` map. Use after destructive
 * lifecycle events (uninstall, file removed) where the entry may or
 * may not still be live. Emits `hostInstallEvents.changed` (the index
 * shrunk) so picker snapshots clear the stale `activeInstallationId`.
 */
export function dropInstallationIndex(installationId: string): void {
  const had = installationIdToWindowKey.delete(installationId)
  if (had) hostInstallEvents.emit('changed')
}

/**
 * Register an entry into the primary map AND (when install-backed)
 * the secondary index. Use this from constructors and
 * `attachInstall` instead of touching `comfyWindows.set` directly.
 */
export function registerHostEntry(entry: ComfyWindowEntry): void {
  comfyWindows.set(entry.windowKey, entry)
  if (entry.installationId !== null) {
    installationIdToWindowKey.set(entry.installationId, entry.windowKey)
    hostInstallEvents.emit('changed')
  }
}

/**
 * Unregister an entry from BOTH the primary map AND the secondary
 * index. Use this from the `'closed'` handler and `detachInstall`
 * instead of touching `comfyWindows.delete` directly.
 */
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

/**
 * Predicate: this entry is a chooser/install-less host (no install
 * attached). Use anywhere code branches on chooser-vs-install
 * semantics so the contract can't drift between sites — and so
 * TypeScript narrows `entry.installationId` to `null` /
 * `string` on each side of the branch.
 */
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
 * Predicate: this entry, if torn down or stopped, would kill a local
 * ComfyUI process the user might lose work in.
 *
 * Used by every "are you sure?" surface for actions that stop a local
 * session — Switch, Restart, Close Window, Quit, native ✕. Cloud/remote
 * windows close immediately because there is no local process at risk.
 *
 * Must be install-backed AND `sourceCategory === 'local'`: a
 * chooser/preview host can carry `sourceCategory` without an attached
 * install (see `attachHostPreview`), and a non-install host has no
 * process to kill.
 */
export function shouldConfirmKillForEntry(
  entry: ComfyWindowEntry | null | undefined,
): entry is ComfyWindowEntry & { installationId: string } {
  return !!entry && isInstallHost(entry) && entry.sourceCategory === 'local'
}

/**
 * Decide what should fill the body area of a comfy window right now.
 *
 * For install-backed windows, the Comfy pill resolves to either the live
 * ComfyUI WebContentsView (instance running) or the lifecycle panel
 * (instance stopped / launching / stopping). The other two pills always
 * map directly to themselves.
 *
 * For install-less host windows (entry.installationId === null), the Comfy
 * pill resolves to the chooser body; only the Comfy and Settings pills are
 * reachable in this mode (Settings opens the unified modal on its Global tab).
 *
 * Centralising this so layout decisions and event-driven body swaps can't
 * disagree about which view should be visible.
 */
export function computeBodyMode(entry: ComfyWindowEntry): BodyMode {
  if (entry.installationId === null) {
    // Install-less host window. Comfy pill → chooser; everything else
    // (in practice only Settings) maps to itself.
    return entry.activePanel === 'comfy' ? 'chooser' : entry.activePanel
  }
  if (entry.activePanel !== 'comfy') return entry.activePanel
  return _runningSessions.has(entry.installationId) ? 'comfy' : 'comfy-lifecycle'
}

/**
 * Resolve an IPC `event.sender` to the comfy window entry whose title-bar
 * WebContentsView owns it, by strict reference equality.
 *
 * This is the single chokepoint every title-bar IPC must funnel through —
 * see `comfy-window:open-title-menu` / `comfy-window:set-panel` /
 * `comfy-window:click-app-update-pill` / `comfy-window:click-install-update-pill`.
 *
 * Aux windows are NEVER reachable through this lookup:
 *   - OAuth / cloud-login popups spawned via `comfyContents.setWindowOpenHandler`
 *     are unregistered loose `BrowserWindow`s with `preload: undefined`. They
 *     have no `ipcRenderer`, can't send these IPCs, and even if a future
 *     change re-introduced a preload they wouldn't be in `comfyWindows`.
 *     The destructive Electron menu items they would otherwise inherit
 *     (Close Window / Close All Windows) are stripped globally by
 *     `installAppMenu()` — see `menu.ts`.
 *   - The `comfyView` and `panelView` WebContentsViews of a registered
 *     entry are deliberately matched by separate predicates
 *     (`panelView?.webContents === event.sender`) — never by this helper —
 *     so the file/install menu can't be popped from inside ComfyUI's content
 *     surface or from a panel renderer.
 *
 * Returning `null` here causes every consuming IPC handler to no-op, which
 * is the desired behaviour for every off-path sender. Keep this contract
 * tight when adding new title-bar IPCs: prefer this helper over open-coding
 * a sender match.
 */
export function findEntryByTitleBarSender(wc: WebContents): { id: number; entry: ComfyWindowEntry } | null {
  for (const [id, entry] of comfyWindows) {
    if (entry.titleBarView.webContents === wc) return { id, entry }
  }
  return null
}

/** Resolve a host BrowserWindow back to its registry entry. Used to map
 *  a popup's parent window to the title-bar webContents (e.g. the
 *  coachmark dismiss button routing its acknowledgement back to the
 *  title-bar renderer). */
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

/** Find a chooser (install-less) host window to focus, preferring a
 *  visible one over a minimised one. Used by the tray entry, the
 *  startup picker, and the chooser-first re-launch fallback. The
 *  "File → New Window" entry-point still creates a fresh chooser
 *  regardless of what this returns. */
export function findPreferredChooserHostWindow(): BrowserWindow | null {
  const entry = findPreferredHostByVisibility((e) => e.installationId === null)
  return entry?.window ?? null
}

/** Find the install-backed host window to focus, prioritising in this
 *  order:
 *    1. The most-recently-focused install, if it is still live and
 *       visible (not minimised).
 *    2. Any other visible install (insertion order).
 *    3. The most-recently-focused install if it is minimised.
 *    4. Any other minimised install (insertion order).
 *  Returns `null` when no install-backed host is open. */
export function findPreferredInstallHostWindow(): BrowserWindow | null {
  const mruEntry =
    lastFocusedInstallationId !== null
      ? getEntryByInstallationId(lastFocusedInstallationId)
      : undefined
  const mruAlive = mruEntry && !mruEntry.window.isDestroyed() ? mruEntry : null
  // Helper returns the first visible install (insertion order) or, if
  // none are visible, the first minimised install. Combined with the
  // MRU short-circuits below, this delivers the four-tier priority
  // (visible-MRU → any-visible → minimised-MRU → any-minimised).
  const fallback = findPreferredHostByVisibility((e) => e.installationId !== null)
  if (mruAlive && !mruAlive.window.isMinimized()) return mruAlive.window
  if (fallback && !fallback.window.isMinimized()) return fallback.window
  if (mruAlive) return mruAlive.window
  return fallback?.window ?? null
}

/** Show a window and bring it to the front, working around Windows
 *  focus-theft prevention. Restores a minimised window first so callers
 *  don't have to remember the two-step. */
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

/**
 * Reveal a chooser host that's been held hidden waiting for its first
 * paint. No-op once any caller has won the race (flag is cleared on
 * first reveal) or the window has been destroyed.
 *
 * Three callers race to reveal the same host:
 *  - titleBarView `dom-ready` (the fast path — titlebar bundle is
 *    ~25 KB, paints in ~50-150 ms even on Windows cold start).
 *  - panelView `did-finish-load` (older fallback — panel bundle is
 *    ~585 KB and adds ~700-1000 ms on Windows).
 *  - a short timeout (final backstop if neither view fires).
 *
 * The window's per-view `setBackgroundColor` paints the chooser surface
 * the moment any of these reveal it, so winning the race early shows a
 * solid-coloured window instead of black flash even if the panel JS
 * is still booting.
 */
export function revealColdStartHostIfPending(windowKey: number): void {
  const entry = comfyWindows.get(windowKey)
  if (!entry?.coldStartPendingReveal || entry.window.isDestroyed()) return
  entry.coldStartPendingReveal = false
  entry.layoutViews()
  bringToFront(entry.window)
}

/**
 * Late-bound host-window factories. `index.ts` calls
 * `setHostFactories({ createChooser })` during startup so the registry
 * can spawn a fresh chooser host when no live one exists, without
 * importing host-construction code (which would create a cycle:
 * createHostWindow → registry → createHostWindow).
 */
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

/** Focus any live host window for the platform re-launch hooks
 *  (`activate` on macOS, `second-instance` on Windows/Linux). Priority:
 *  install-backed beats chooser, with visible beating minimised inside
 *  each type bucket; install-backed picks track the most-recently-
 *  focused install. Spawns a fresh chooser host only when no live host
 *  exists. */
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
 * macOS dock-icon `activate` behaviour: raise EVERY live host window to
 * the front, matching the platform convention where clicking the dock
 * icon brings all of an app's windows forward (not just one). The
 * preferred host (same priority as `openOrFocusAnyHostWindow`) is shown
 * last so it ends up frontmost / focused. When no live host exists, falls
 * back to spawning a fresh chooser host.
 *
 * Returns the window left frontmost (or the freshly-spawned chooser).
 *
 * macOS-only by design — Windows / Linux re-launch keeps the single-window
 * `openOrFocusAnyHostWindow` semantics, so the caller in `index.ts` guards
 * this behind `process.platform === 'darwin'`.
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
