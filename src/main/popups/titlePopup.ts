import { ipcMain, shell, dialog, WebContentsView, BrowserWindow } from 'electron'
import { TITLEBAR_HEIGHT } from '../lib/titleBarOverlay'
import {
  cancelModelDownload,
  clearFinishedDownloads,
  dismissRecentDownload,
  downloadEvents,
  getDownloadsTrayState,
  pauseModelDownload,
  resumeModelDownload,
} from '../lib/comfyDownloadManager'
import { installationEvents } from '../installations'
import * as mainTelemetry from '../lib/telemetry'
import * as updater from '../lib/updater'
import * as i18n from '../lib/i18n'
import { defaultInstallDir } from '../lib/paths'
import {
  openPath as openPathHelper,
  getAppVersion,
  _activeOperationStatus,
  _operationAborts,
  type PickerOperationStatus,
} from '../lib/ipc/shared'
import {
  applySettingSet,
  buildSettingsSections,
  buildMediaSections,
  buildModelsPayload,
} from '../lib/ipc/registerSettingsHandlers'
import { globalSettingsEvents } from '../lib/globalSettingsEvents'
import { getGithubStarCount } from '../lib/githubStars'
import {
  comfyWindows,
  findEntryByTitleBarSender,
  getEntryByInstallationId,
  isChooserHost,
} from '../host/registry'
import type { ComfyPanelKey, ComfyWindowEntry } from '../host/registry'
import {
  getTitleTooltipForParent,
  hideTitleTooltipPopup,
} from './titleTooltip'
import { EmbeddedPopupView } from './embeddedPopupView'
import { recordIpcInvocation } from '../lib/e2eOverrides'

/**
 * Title-bar dropdown popups (waffle menu, downloads tray). All title-bar
 * dropdowns share one HTML popup rendered inside a transparent child
 * WebContentsView per parent window — gives native shadow + theme-matched
 * chrome (no clipping by the title-bar view's bounds), free click-outside
 * dismissal via the popup's own blur event, and consistent styling with
 * the Vue title bar.
 */

interface TitlePopupMenuItem {
  /** Item id — main routes activation by this. Omitted for separators. */
  id?: string
  /** Visible label. Treated as the English fallback when `labelKey`
   *  is set; otherwise rendered verbatim by the popup view. */
  label?: string
  /** Optional vue-i18n key the popup view resolves against its own
   *  message catalog (`lib/i18nMessages.ts`). Lets the renderer
   *  translate menu items even though the labels are built main-side
   *  where vue-i18n isn't available. Falls back to `label` if the key
   *  isn't in the catalog. */
  labelKey?: string
  /** Render a checkmark glyph beside the label when true. */
  checked?: boolean
  /** Marks a separator row instead of an interactive item. */
  kind?: 'separator'
}

type TitlePopupKind = 'menu' | 'downloads' | 'instance-picker' | 'global-settings'

/** Single install row pushed to the instance-picker popup. Mirrors the
 *  renderer-side `Installation` shape returned by the `get-installations`
 *  IPC handler (extra fields like `version`, `statusTag`, `sourceLabel`
 *  are already attached there). The popup is read-only on this payload
 *  and renders it through the shared `useInstallList` composable, so the
 *  shape MUST stay in sync with `Installation` in `src/types/ipc.ts`. */
export interface InstancePickerInstall {
  id: string
  name: string
  sourceLabel: string
  sourceCategory: string
  version?: string
  statusTag?: { style: string; label: string }
  lastLaunchedAt?: number
  installPath?: string
  status?: string
  [key: string]: unknown
}

/** Snapshot pushed to the instance-picker popup on open and on every
 *  install-registry change. `activeInstallationId` lets the popup pre-
 *  select the host window's currently-attached install; `runningInstallationIds`
 *  drives the row-side "running" indicator and the focus-vs-launch
 *  decision in the click handler. `selectedInstallationId` /
 *  `selectedSettings` / `selectedSnapshots` carry the per-row Settings
 *  + Snapshots payload for the currently-selected install in the
 *  picker's right pane (changes whenever the user clicks a different
 *  row — picker tells main via `set-picker-selected-install` IPC and
 *  main re-broadcasts a fresh snapshot). */
/** Storage-tab slice piggy-backed on the picker snapshot. Same shape
 *  as the storage fields in `GlobalSettingsSnapshot` — main builds it
 *  off the same `buildMediaSections` / `buildModelsPayload` plumbing.
 *  Used by `StoragePane.vue` to render shared-model dirs and the
 *  Shared Directories fields without subscribing to the
 *  global-settings broadcast (which doesn't target picker popups). */
export interface PickerStorageSlice {
  sharedDirectoriesFields: Record<string, unknown>[]
  modelsDirs: GlobalSettingsModelsDir[]
  modelsSystemDefault: string
}

export interface InstancePickerSnapshot {
  installs: InstancePickerInstall[]
  activeInstallationId: string | null
  runningInstallationIds: string[]
  selectedInstallationId: string | null
  selectedSettings: Record<string, unknown>[] | null
  selectedSnapshots: Record<string, unknown> | null
  /** Tab the settings UI opens on ('config' | 'status' | 'update' |
   *  'snapshots' | 'storage'). Null = let the picker view choose its
   *  default. */
  initialTab: string | null
  /** Action id to fire automatically after the settings UI mounts
   *  (e.g. `'update-comfyui'` for the kebab Update entry). Cleared
   *  after consumption. */
  autoAction: string | null
  /** Bumped on each explicit (re)open that seeds an `autoAction`. The
   *  picker popup is cached, so a repeat pill click re-sends the same
   *  `autoAction` value with no transition — the renderer keys its
   *  "already fired" guard on this nonce so a second click re-fires. */
  autoActionNonce: number
  storage: PickerStorageSlice
  /** Installs that currently have an inline background op in flight (or
   *  recently completed). Drives the spinner dot on InstanceRow. */
  operatingInstallationIds: string[]
  /** Per-install operation status for background (cross-instance) picker
   *  ops. Keyed by installationId. Populated by the
   *  `comfy-titlepopup:start-background-op` handler; delivered to the
   *  picker renderer via the normal snapshot broadcast loop so no extra
   *  IPC channel is needed. */
  installOperationStatus: Record<string, PickerOperationStatus>
}

/** Single Models-directory row pushed to the global-settings popup.
 *  `isDefault` flags the system-default path (matches the renderer-
 *  side DirCard tag). `isPrimary` is positional — first row in
 *  `modelsDirs` wins, but we materialise it here so the view stays a
 *  pure prop reader. */
export interface GlobalSettingsModelsDir {
  path: string
  isPrimary: boolean
  isDefault: boolean
}

/** Snapshot pushed to the global-settings popup on open and on every
 *  settings-changed / app-update-state / app-update-progress /
 *  installations-changed broadcast. Field shapes use the loose
 *  `Record<string, unknown>` to keep the preload boundary type-safe
 *  without dragging renderer types into main. */
export interface GlobalSettingsSnapshot {
  generalFields: Record<string, unknown>[]
  telemetryFields: Record<string, unknown>[]
  desktopUpdateFields: Record<string, unknown>[]
  cacheFields: Record<string, unknown>[]
  advancedFields: Record<string, unknown>[]
  sharedDirectoriesFields: Record<string, unknown>[]
  modelsDirs: GlobalSettingsModelsDir[]
  modelsSystemDefault: string
  appUpdate: {
    state: Record<string, unknown>
    progress: Record<string, unknown> | null
    isDownloading: boolean
    capabilities: { systemManaged: boolean; canSelfUpdate: boolean }
    installedVersion: string
    platform: NodeJS.Platform
    lastCheckedAt: number | null
  }
  githubUrl: string
  githubStars: number | null
  i18n: {
    overview: string
    updates: string
    storage: string
    models: string
    advanced: string
    sharedDirectories: string
  }
}

interface BuildInstancePickerSnapshotArgs {
  installs: InstancePickerInstall[]
  hostInstallationId: string | null
  runningInstallationIds: string[]
  selectedInstallationId?: string | null
  selectedSettings?: Record<string, unknown>[] | null
  selectedSnapshots?: Record<string, unknown> | null
  initialTab?: string | null
  autoAction?: string | null
  autoActionNonce?: number
  storage: PickerStorageSlice
  operatingInstallationIds?: string[]
  installOperationStatus?: InstancePickerSnapshot['installOperationStatus']
}

/** The most-recently-launched install in the list (largest `lastLaunchedAt`).
 *  Mirrors the renderer's `mostRecentInstallId` so main and the picker agree
 *  on "most recent".
 *
 *  Tie-break: the always-seeded "Comfy Cloud" entry must NOT win the default
 *  just by sorting first in the registry. Cloud is only the default when it
 *  was genuinely launched most-recently (strictly higher `lastLaunchedAt`);
 *  on a tie (e.g. nothing launched yet, or equal timestamps) a real install
 *  wins. This keeps the "default = last opened" behaviour fair for users who
 *  never open cloud. Cloud is still chosen when it's the only install. */
function mostRecentlyLaunchedInstallId(installs: InstancePickerInstall[]): string | null {
  let best: InstancePickerInstall | undefined
  for (const inst of installs) {
    if (!best) {
      best = inst
      continue
    }
    const ts = inst.lastLaunchedAt ?? 0
    const bestTs = best.lastLaunchedAt ?? 0
    if (ts > bestTs) {
      best = inst
    } else if (ts === bestTs && best.sourceCategory === 'cloud' && inst.sourceCategory !== 'cloud') {
      best = inst
    }
  }
  return best?.id ?? null
}

/**
 * Resolves which install the picker should show in its detail pane.
 * Install-less hosts (dashboard) have no active install; default to the
 * most-recently-launched install so the picker opens on what the user last
 * used, not whatever happens to sort first in the registry list.
 */
export function resolvePickerSelectedInstallId(
  explicitSelection: string | null | undefined,
  hostInstallationId: string | null | undefined,
  installs: InstancePickerInstall[],
): string | null {
  const resolved = explicitSelection ?? hostInstallationId ?? null
  if (resolved) return resolved
  return mostRecentlyLaunchedInstallId(installs)
}

/**
 * Pure helper — produces the snapshot pushed to the instance-picker
 * popup. Kept separate from the IPC wiring so the shape contract can be
 * unit-tested without spinning up Electron.
 */
export function buildInstancePickerSnapshot(
  args: BuildInstancePickerSnapshotArgs,
): InstancePickerSnapshot {
  return {
    installs: args.installs,
    activeInstallationId: args.hostInstallationId,
    runningInstallationIds: args.runningInstallationIds,
    selectedInstallationId: args.selectedInstallationId ?? null,
    selectedSettings: args.selectedSettings ?? null,
    selectedSnapshots: args.selectedSnapshots ?? null,
    initialTab: args.initialTab ?? null,
    autoAction: args.autoAction ?? null,
    autoActionNonce: args.autoActionNonce ?? 0,
    storage: args.storage,
    operatingInstallationIds: args.operatingInstallationIds ?? [],
    installOperationStatus: args.installOperationStatus ?? {},
  }
}

/** Build the storage-tab slice piggy-backed on the picker snapshot.
 *  Same `buildMediaSections` / `buildModelsPayload` plumbing the
 *  global-settings snapshot uses — kept in one place so both
 *  surfaces stay in lockstep. */
function buildPickerStorageSlice(): PickerStorageSlice {
  const mediaSections = buildMediaSections()
  const modelsPayload = buildModelsPayload()
  const sharedDirectoriesFields =
    (mediaSections[0]?.fields ?? []).map(toDetailField) as unknown as Record<string, unknown>[]
  const modelsDirsRaw =
    (modelsPayload.sections[0]?.fields[0]?.value as string[] | undefined) ?? []
  const modelsDefault = modelsPayload.systemDefault
  return {
    sharedDirectoriesFields,
    modelsDirs: modelsDirsRaw.map((p, i) => ({
      path: p,
      isPrimary: i === 0,
      isDefault: p === modelsDefault,
    })),
    modelsSystemDefault: modelsDefault,
  }
}

type TitlePopupConfig =
  | {
    kind: 'menu'
    items: TitlePopupMenuItem[]
    theme: { bg: string; text: string }
  }
  | {
    kind: 'downloads'
    theme: { bg: string; text: string }
  }
  | {
    kind: 'instance-picker'
    snapshot: InstancePickerSnapshot
    theme: { bg: string; text: string }
  }
  | {
    kind: 'global-settings'
    snapshot: GlobalSettingsSnapshot
    theme: { bg: string; text: string }
  }

/**
 * One reusable popup `WebContentsView` per parent BrowserWindow.
 *
 * The popup is attached as a child view of the parent window (rather
 * than its own top-level / child BrowserWindow) so it always shares
 * the parent's window coordinate space. That is what makes it behave
 * like an in-window popup on Wayland, where detached popup windows
 * can render as separate top-level surfaces.
 *
 * Constructing the WebContentsView + loading the renderer on every
 * open would cost ~100ms of click-to-paint delay, so we lazily create
 * one popup per parent, hide it between uses, and push fresh config
 * via `comfy-titlepopup:set-config` IPC on every subsequent open. The
 * popup webContents is closed when its parent BrowserWindow closes.
 *
 * Latest values for the *current* open are tracked here too so
 * `activate` (item click) and the dismiss path (re-emits
 * `comfy-titlebar:menu-closed` for the reopen-suppression guard)
 * can route without their own per-open context.
 */
interface TitlePopupEntry {
  view: EmbeddedPopupView
  /** Numeric `windowKey` of the parent host entry, updated on every
   *  open. `0` is a sentinel for "no popup has been opened yet" since
   *  `nextWindowKey` always returns positive numbers. */
  parentEntryId: number
  /** Updated on every open. */
  kind: TitlePopupKind
  /** Updated on every open. */
  titleBarSender: Electron.WebContents
  /** Config queued before the renderer signalled ready — flushed on
   *  ready. Overwritten if multiple opens happen before ready. */
  pendingConfig: TitlePopupConfig | null
  /** JSON of the most recently sent `comfy-titlepopup:set-config`
   *  payload — used to compare against the next open's config to skip
   *  the renderer roundtrip when the DOM is already correct. */
  lastConfigJson: string | null
  /** JSON of the config the renderer has acked via
   *  `comfy-titlepopup:rendered`. When equal to the next open's
   *  config, the popup view's DOM matches what we want to show, so
   *  we can `setVisible(true)` immediately without resending the
   *  config or waiting for an ack — saves one frame + two IPC hops
   *  per open (the common case for repeated opens of the same menu
   *  in the same window). */
  lastSyncedConfigJson: string | null
  /** The instance-picker's currently-selected install (the row whose
   *  Settings + Snapshots accordions are showing in the right pane).
   *  The picker pushes its selection here via
   *  `comfy-titlepopup:set-picker-selected-install`; main uses it to
   *  scope `selectedSettings` + `selectedSnapshots` in subsequent
   *  snapshot pushes. Defaults to the host's active install on open. */
  pickerSelectedInstallationId: string | null
  /** Tab id the settings UI opens on. Forwarded into the snapshot for
   *  the picker view to consume on first render. */
  pickerInitialTab: string | null
  /** Action id the settings UI fires automatically after mounting
   *  (kebab Update / Migrate / Restore-Snapshot / Delete entry
   *  points). Cleared after the picker view consumes it. */
  pickerAutoAction: string | null
  /** Monotonic nonce stamped alongside `pickerAutoAction` so a repeat
   *  open with the same action id still reads as a fresh trigger. */
  pickerAutoActionNonce: number
  /** JSON of the most recent `installs-changed` snapshot sent to this
   *  popup. Used by `broadcastInstancePickerSnapshotToTitlePopups` to
   *  skip pushes that would re-render identical data — important
   *  because the renderer's `pickerSnapshot` watcher schedules a
   *  measure-and-resize on EVERY snapshot change, and resizing the
   *  `WebContentsView` while the open animation is still playing
   *  makes the popup visibly snap. */
  lastPickerBroadcastJson: string | null
  /** JSON of the most recent `global-settings-changed` snapshot pushed
   *  to this popup. Same dedup role as `lastPickerBroadcastJson`. */
  lastGlobalSettingsBroadcastJson: string | null
  /** Wall-clock time of the most recent `showTitlePopupNow()` for this
   *  entry. The backdrop's `mousedown` listener can fire during the
   *  same tick as the trigger click (the backdrop covers the body, and
   *  on some macOS click paths the down-event lands on the backdrop
   *  before the popup is fully composited). Guard the backdrop-dismiss
   *  IPC against dismissing inside a short window after open so the
   *  picker doesn't open → close → reopen. `0` means "never opened". */
  openedAt: number
}

/** Active popup keyed by parent BrowserWindow id (one popup per parent,
 *  cached for reuse). The webContents-id index lets
 *  `comfy-titlepopup:item-activated` / `:close` / `:ready` route by
 *  `event.sender`. */
const titlePopupsByParent = new Map<number, TitlePopupEntry>()
const titlePopupsByWebContents = new Map<number, TitlePopupEntry>()

/** Timestamp of the most recent downloads-popup dismiss per parent
 *  window. The downloads tray relies on blur-dismiss (no backdrop),
 *  so a click on the tray button blurs and hides the popup BEFORE the
 *  click IPC arrives at main — without this guard, main would see an
 *  empty `titlePopupsByParent` slot and re-open. Any click within
 *  `DOWNLOADS_REOPEN_SUPPRESS_MS` of the last hide is treated as the
 *  toggle-close completion and dropped. */
const downloadsHiddenAtByParent = new Map<number, number>()
const DOWNLOADS_REOPEN_SUPPRESS_MS = 250

/** Cached install list used to open the picker SYNCHRONOUSLY on click
 *  (no `await` on the click path → instant first frame, same as the
 *  file menu). Kept fresh by:
 *
 *   - `prewarmTitlePopup` priming the cache once at host construction,
 *   - the `installationEvents.on('changed')` subscription re-fetching
 *     on every install-registry mutation (add / remove / rename /
 *     launch — same trigger that broadcasts to open pickers),
 *   - the picker's own click handler kicking a background refresh
 *     after the synchronous open so any change since the last cache
 *     hit lands within a tick via `installs-changed` push.
 *
 *  Without this cache the click handler would have to `await
 *  bindings.getInstancePickerInstalls()` (a disk read) before the
 *  popup can be shown, which was the source of the "first click feels
 *  laggy" symptom. */
const cachedInstallsForPicker: InstancePickerInstall[] = []
let cachedInstallsResolved = false

/** Monotonic sequence for picker `autoAction` triggers. Bumped on every
 *  open that seeds an `autoAction` so a repeat trigger (e.g. clicking the
 *  title-bar Update chip again after dismissing the confirm modal) reads
 *  as a fresh nonce in the snapshot, letting the cached picker renderer
 *  re-fire the action even though the action id is unchanged. */
let _pickerAutoActionNonce = 0

/** Module-level binding stash. Populated by `registerTitlePopupIpc`
 *  (called once at `whenReady`) so `prewarmTitlePopup` can call the
 *  installs fetcher without re-threading the bindings through every
 *  host-construction site. */
let activeBindings: TitlePopupHostBindings | null = null

/** Trigger a fresh instance-picker snapshot broadcast to all open pickers.
 *  Called by main-side code that mutates `_activeOperationStatus` so the
 *  inline progress view refreshes without waiting for the next
 *  installations-changed event. No-op when no picker is open. */
export function triggerPickerSnapshotBroadcast(): void {
  if (!activeBindings) return
  void broadcastInstancePickerSnapshotToTitlePopups(activeBindings)
}

async function refreshCachedInstallsForPicker(): Promise<void> {
  if (!activeBindings) return
  try {
    const installs = await activeBindings.getInstancePickerInstalls()
    cachedInstallsForPicker.length = 0
    for (const i of installs) cachedInstallsForPicker.push(i)
    cachedInstallsResolved = true
  } catch {
    // Leave the cache as-is; the click path falls back to an empty
    // list and the background refresh after open will retry.
  }
}

/* The picker's open/close is driven by explicit user actions only —
 * pill toggle, backdrop click, ESC, item activation. The blur-based
 * dismiss path is suppressed for the picker (see
 * `EmbeddedPopupView.suppressBlurDismiss`) so click-on-trigger always
 * behaves predictably: open if closed, close if open, no timing
 * guards, no reopen races. */

/* ----------------------------------------------------------------
 * Instance-picker backdrop
 * ----------------------------------------------------------------
 * A separate transparent `WebContentsView` rendered behind the picker
 * popup that dims the host window body (not the title bar). It only
 * shows while a picker popup is open; click anywhere on the dim
 * dismisses the picker, ESC handled by the popup itself.
 *
 * Kept independent from the picker `WebContentsView` so we don't have
 * to fight Electron's child-view bounds/z-order plumbing — the dim
 * view sits below the popup view in the parent's contentView stack,
 * and the popup keeps its normal centered-card sizing.
 */
interface PopupBackdropEntry {
  view: WebContentsView
  visible: boolean
}
const popupBackdropsByParent = new Map<number, PopupBackdropEntry>()
const popupBackdropsByWebContents = new Map<number, number /* parentId */>()

/** Inline HTML loaded into the backdrop view. Fixed `position: fixed`
 *  scrim — translucent dim over the host body with a 14px backdrop
 *  blur so the underlying chrome reads as a frosted-glass background
 *  behind the centred-card popup. Scrim color (`#211927`) matches the
 *  app's neutral-800; opacity is low (40%) so the blur is the dominant
 *  effect, not the dim. A click anywhere fires the dismiss IPC; main
 *  routes it through to hide the picker / global-settings popup. */
const POPUP_BACKDROP_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:100%;height:100%;background:transparent;overflow:hidden;-webkit-user-select:none;user-select:none}
  .scrim{position:fixed;inset:0;width:100%;height:100%;background:rgba(33,25,39,0.4);backdrop-filter:blur(14px) saturate(140%);-webkit-backdrop-filter:blur(14px) saturate(140%);cursor:default}
</style></head><body>
<div class="scrim" id="s"></div>
<script>
  const { ipcRenderer } = require('electron');
  document.getElementById('s').addEventListener('mousedown', () => {
    ipcRenderer.send('comfy-popup-backdrop:dismiss');
  });
</script>
</body></html>`

function ensurePopupBackdrop(parent: BrowserWindow): PopupBackdropEntry {
  const existing = popupBackdropsByParent.get(parent.id)
  if (existing && !existing.view.webContents.isDestroyed()) return existing
  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
      sandbox: false,
    },
  })
  view.setBackgroundColor('#00000000')
  view.setVisible(false)
  view.setBounds({ x: 0, y: 0, width: 1, height: 1 })
  parent.contentView.addChildView(view)
  void view.webContents.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(POPUP_BACKDROP_HTML)}`,
  ).catch(() => { })
  const entry: PopupBackdropEntry = { view, visible: false }
  popupBackdropsByParent.set(parent.id, entry)
  popupBackdropsByWebContents.set(view.webContents.id, parent.id)
  // Re-fit the scrim to the host's content area on every parent
  // resize while visible. Without this the scrim stays at its
  // open-time bounds and either leaks past the new edges or leaves
  // an undimmed strip when the window grows. Idle ticks (popup
  // hidden) are no-ops.
  parent.on('resize', () => {
    if (!entry.visible || parent.isDestroyed() || view.webContents.isDestroyed()) return
    const cb = parent.getContentBounds()
    view.setBounds({
      x: 0,
      y: TITLEBAR_HEIGHT,
      width: cb.width,
      height: Math.max(0, cb.height - TITLEBAR_HEIGHT),
    })
  })
  const onParentClosed = (): void => {
    try { parent.contentView.removeChildView(view) } catch { /* noop */ }
    if (!view.webContents.isDestroyed()) view.webContents.close()
    popupBackdropsByParent.delete(parent.id)
    popupBackdropsByWebContents.delete(view.webContents.id)
  }
  parent.once('closed', onParentClosed)
  return entry
}

function showPopupBackdrop(parent: BrowserWindow): void {
  const entry = ensurePopupBackdrop(parent)
  const cb = parent.getContentBounds()
  // Cover everything except the title bar (where the trigger pill lives).
  entry.view.setBounds({
    x: 0,
    y: TITLEBAR_HEIGHT,
    width: cb.width,
    height: Math.max(0, cb.height - TITLEBAR_HEIGHT),
  })
  // Re-stack: backdrop first (lower), then re-stack the popup so it
  // sits above the backdrop. The popup itself is re-stacked in
  // `view.showOnTop()` right after this, so we just bring the
  // backdrop to the front of the contentView here, then the popup's
  // own re-stack lands on top.
  try {
    parent.contentView.removeChildView(entry.view)
    parent.contentView.addChildView(entry.view)
  } catch { /* noop */ }
  entry.view.setVisible(true)
  entry.visible = true
}

function hidePopupBackdrop(parent: BrowserWindow): void {
  const entry = popupBackdropsByParent.get(parent.id)
  if (!entry || !entry.visible) return
  if (!entry.view.webContents.isDestroyed()) entry.view.setVisible(false)
  entry.visible = false
}

const POPUP_WIDTH = 220
const POPUP_ITEM_HEIGHT = 28
const POPUP_SEPARATOR_HEIGHT = 9
const POPUP_VPADDING = 8 // 4px top + 4px bottom on the <ul>
const POPUP_VBORDER = 2 // 1px top + 1px bottom from the .popup card

export function computePopupHeight(items: readonly TitlePopupMenuItem[]): number {
  const content = items.reduce(
    (sum, item) => sum + (item.kind === 'separator' ? POPUP_SEPARATOR_HEIGHT : POPUP_ITEM_HEIGHT),
    0,
  )
  return content + POPUP_VPADDING + POPUP_VBORDER
}

/** Build the file-menu items for a host entry. The waffle/file menu
 *  shape changes with `firstUseMode`, install-backed vs install-less
 *  (chooser) host, current panel, and zoom level — so the items are
 *  recomputed on every open rather than cached. */
export function buildTitlePopupMenuItems(entry: ComfyWindowEntry): TitlePopupMenuItem[] {
  // First-use post-consent — the takeover is mounted (or chained into
  // new-install / migrate / install-progress), and the only file-menu
  // entry that should be reachable is the explicit escape hatch.
  // Surfacing New Install / Settings here would let the user wander out
  // of the bootstrap UX into surfaces that aren't ready for it. Skip
  // Onboarding marks completion + clears the chain state and dismisses
  // the takeover.
  if (entry.firstUseMode === 'post-consent') {
    return [
      {
        id: 'skip-onboarding',
        label: 'Skip Onboarding',
        labelKey: 'fileMenu.skipOnboarding',
      },
    ]
  }
  // Issue #497 — file-menu order:
  //   New Window
  //   ── separator ──
  //   (install-less only) New Install / Track / Load Snapshot
  //   ── separator ──
  //   Settings (unified — ComfyUI Settings on install-backed hosts,
  //             Global Settings on install-less; PanelApp picks the
  //             default tab at mount time)
  //   Send Feedback
  //   ── separator ──
  //   (install-backed only) Return to Dashboard
  //   Close All Windows
  //
  // Notes:
  //   - "Close Window" is intentionally absent — the OS-X / native
  //     close button already covers single-window dismissal; the menu
  //     only surfaces the cross-window kill switch.
  //   - Install-creation / import flows (New Install / Track / Load
  //     Snapshot) live ONLY on the dashboard (install-less host)
  //     waffle menu. Inside a Comfy Instance window the only escape
  //     hatch back to the dashboard is "Return to Dashboard" — the
  //     in-Comfy chrome stays closed-off per the design doc's
  //     "Comfy Instance is closed-off" rule.
  //   - "Return to Dashboard" is install-backed-only; install-less
  //     host windows are already on the chooser body so the entry
  //     would be a no-op there.
  const items: TitlePopupMenuItem[] = [
    { id: 'new-window', label: 'New Window', labelKey: 'fileMenu.newWindow' },
    { kind: 'separator' },
  ]
  if (isChooserHost(entry)) {
    items.push(
      { id: 'new-install', label: 'New Install', labelKey: 'fileMenu.newInstall' },
      {
        id: 'track',
        label: 'Add Existing Install',
        labelKey: 'fileMenu.addExistingInstall',
      },
      { id: 'load-snapshot', label: 'Load Snapshot', labelKey: 'fileMenu.loadSnapshot' },
      { kind: 'separator' },
      {
        id: 'settings',
        label: 'Desktop Settings',
        labelKey: 'fileMenu.globalSettings',
      },
      // Send Feedback (#493). The renderer-side handler resolves the
      // support URL and emits the `desktop2.feedback.opened`
      // telemetry action with `source: 'menu'`.
      { id: 'feedback', label: 'Send Beta Feedback', labelKey: 'fileMenu.sendFeedback' },
    )
    // Reset Zoom — discoverable recovery path for users who zoom the
    // comfyView too far to read. Only on the chooser host (the dummy
    // comfyView there can still be zoomed via Ctrl/Cmd+scroll); the
    // install host trims it out per the simplified menu spec.
    if (!entry.comfyView.webContents.isDestroyed()) {
      const level = entry.comfyView.webContents.getZoomLevel()
      if (level !== 0) {
        const percent = Math.round(Math.pow(1.2, level) * 100)
        items.push({ id: 'reset-zoom', label: `Reset Zoom (${percent}%)` })
      }
    }
    items.push(
      { kind: 'separator' },
      {
        id: 'close-all-windows',
        label: 'Quit ComfyUI',
        labelKey: 'fileMenu.exitAllWindows',
      },
    )
    return items
  }
  // Install-host menu: trimmed to the essentials. Desktop Settings,
  // Return to Dashboard, and Reset Zoom are intentionally absent —
  // Settings lives in the picker's Startup Args tab, the dashboard
  // escape is the Home icon in the picker chips row, and Reset Zoom
  // remains reachable via Ctrl/Cmd + 0. "Quit ComfyUI" stays available
  // from every window; "Close Window" is instance-only — the dashboard
  // omits it (there's nothing to close back to).
  items.push(
    { id: 'feedback', label: 'Send Beta Feedback', labelKey: 'fileMenu.sendFeedback' },
    { kind: 'separator' },
    { id: 'exit-window', label: 'Close Window', labelKey: 'fileMenu.exitWindow' },
    {
      id: 'close-all-windows',
      label: 'Quit ComfyUI',
      labelKey: 'fileMenu.exitAllWindows',
    },
  )
  return items
}

/** Push the downloads-tray snapshot to a single popup webContents. */
function notifyTitlePopupDownloads(popup: WebContentsView): void {
  if (popup.webContents.isDestroyed()) return
  popup.webContents.send('comfy-titlepopup:downloads-changed', getDownloadsTrayState())
}

/** Fan out tray-state changes to every cached title-bar dropdown popup
 *  so the downloads view repaints live while open. */
function broadcastDownloadsToTitlePopups(): void {
  for (const entry of titlePopupsByParent.values()) {
    notifyTitlePopupDownloads(entry.view.popup)
  }
}

/** Push an updated instance-picker snapshot to every popup whose
 *  current kind is `'instance-picker'`. Triggered by the
 *  `installationEvents.on('changed')` subscription wired in
 *  `registerTitlePopupIpc`, so installs that get added / removed /
 *  renamed / launched while the picker is open repaint live. */
async function broadcastInstancePickerSnapshotToTitlePopups(
  bindings: TitlePopupHostBindings,
): Promise<void> {
  const hasActivePicker = Array.from(titlePopupsByParent.values()).some(
    (entry) => entry.kind === 'instance-picker'
      && (entry.view.isOpen || entry.view.pendingShowTimer !== null),
  )
  if (!hasActivePicker) return
  // Resolve the install list once and reuse for every open picker —
  // typically there is only one, but reading the disk-backed list per
  // entry would waste IO on the rare multi-window case.
  const installs = await bindings.getInstancePickerInstalls()
  const runningInstallationIds = bindings.getRunningInstallationIds()
  for (const entry of titlePopupsByParent.values()) {
    if (entry.kind !== 'instance-picker') continue
    if (!entry.view.isOpen && entry.view.pendingShowTimer === null) continue
    if (entry.view.popup.webContents.isDestroyed()) continue
    const parentEntry = comfyWindows.get(entry.parentEntryId)
    const selectedId = resolvePickerSelectedInstallId(
      entry.pickerSelectedInstallationId,
      parentEntry?.installationId,
      installs,
    )
    if (!entry.pickerSelectedInstallationId && selectedId) {
      entry.pickerSelectedInstallationId = selectedId
    }
    const details = selectedId
      ? await bindings.getPickerDetailsForInstall(selectedId).catch(() => ({
        settings: null,
        snapshots: null,
      }))
      : { settings: null, snapshots: null }
    const snapshot = buildInstancePickerSnapshot({
      installs,
      hostInstallationId: parentEntry?.installationId ?? null,
      runningInstallationIds,
      selectedInstallationId: selectedId,
      selectedSettings: details.settings,
      selectedSnapshots: details.snapshots,
      initialTab: entry.pickerInitialTab,
      autoAction: entry.pickerAutoAction,
      autoActionNonce: entry.pickerAutoActionNonce,
      storage: buildPickerStorageSlice(),
      operatingInstallationIds: [..._activeOperationStatus.entries()].filter(([, v]) => !v.done).map(([k]) => k),
      installOperationStatus: Object.fromEntries(_activeOperationStatus),
    })
    // Dedupe: every snapshot broadcast triggers a `pickerSnapshot`
    // prop change in the renderer, which schedules a measure-and-
    // resize on the WebContentsView. Resizing during the open
    // animation makes the popup visibly snap → reads as "open →
    // close → open" flicker on the 2nd+ click (where the fast path
    // already had the install list, so the background refresh was
    // pushing identical data). Only broadcast when the JSON actually
    // changed.
    const snapshotJson = JSON.stringify(snapshot)
    if (entry.lastPickerBroadcastJson === snapshotJson) continue
    entry.lastPickerBroadcastJson = snapshotJson
    entry.view.popup.webContents.send('comfy-titlepopup:installs-changed', snapshot)
  }
}

/** Pre-warm the title-bar popup for a host window so the user's first
 *  click doesn't pay the WebContentsView + HTML/JS load cost (~100ms).
 *  Also primes the install-list cache so the picker click handler can
 *  open synchronously without an `await` on a disk read (the cause of
 *  the "first click feels slow" symptom). */
export function prewarmTitlePopup(parent: BrowserWindow): void {
  ensureTitlePopup(parent)
  if (!cachedInstallsResolved) {
    void refreshCachedInstallsForPicker()
  }
}

/** Hide any open title-bar popup attached to the given parent window.
 *  The popup is a sibling WebContentsView stacked on top of the panel
 *  view, so a renderer-side modal in the panel (e.g. the quit-confirm
 *  from `comfy-window:request-close`) is obscured by an open picker
 *  until we hide it. Callers in the close / before-quit path invoke
 *  this *before* dispatching the panel-side confirm so the modal
 *  always reaches the user.
 *
 *  No-op when no popup is open for this parent. Safe to call on a
 *  destroyed window. */
export function hideTitlePopupForParent(parent: BrowserWindow): void {
  if (parent.isDestroyed()) return
  const entry = titlePopupsByParent.get(parent.id)
  if (!entry) return
  if (entry.view.isDestroyed()) return
  hideTitlePopup(entry, { releaseFocusToParent: false })
}

/** Lazily create the reusable popup `WebContentsView` for the given
 *  parent BrowserWindow. Subsequent opens for the same parent reuse
 *  the same view — the renderer is loaded once, then we just push fresh
 *  config + reposition + show on every open. The popup is closed when
 *  its parent is. */
function ensureTitlePopup(parent: BrowserWindow): TitlePopupEntry {
  const existing = titlePopupsByParent.get(parent.id)
  if (existing && !existing.view.isDestroyed()) return existing

  // Click-outside dismissal. Item clicks inside the popup do NOT trigger
  // blur — focus stays in the popup webContents until we explicitly hide
  // it on item-activated, so item activations always reach main.
  //
  // We listen on the popup webContents (for focus moves to *another*
  // view inside the same parent window — e.g. clicking the title-bar
  // button or the comfy body) and on the parent BrowserWindow (for focus
  // moves *out* of the parent window — e.g. clicking another app or
  // another desktop window). The webContents blur alone is not reliable
  // for cross-window focus changes on macOS.
  //
  // The title-bar root is `-webkit-app-region: drag`, so a click on its
  // empty area is consumed by the OS for window dragging and never
  // reaches the title-bar webContents — neither `popup.webContents`'s
  // blur nor `parent`'s blur fires. `will-move` / `move` cover that
  // path: any title-bar drag dismisses the popup as soon as the window
  // begins to move.
  const view = new EmbeddedPopupView({
    parent,
    htmlName: 'comfyTitlePopup',
    preloadName: 'comfyTitlePopupPreload.js',
    initialBounds: { x: 0, y: 0, width: POPUP_WIDTH, height: 100 },
    hideOnParentEvents: ['blur', 'will-move', 'move'],
    hideOnPopupBlur: true,
    onParentClosed: () => {
      titlePopupsByParent.delete(parent.id)
      titlePopupsByWebContents.delete(view.popupWebContentsId)
    },
    onDestroyed: () => {
      // Identity-check so we don't drop a fresher entry that may have
      // been registered against the same parent id between the popup
      // crash and this teardown firing.
      const cur = titlePopupsByParent.get(parent.id)
      if (cur && cur.view === view) {
        titlePopupsByParent.delete(parent.id)
      }
      titlePopupsByWebContents.delete(view.popupWebContentsId)
    },
    onHide: () => {
      // Always fires when the popup transitions out of open/pending —
      // including the blur / will-move / move / popup-blur auto-dismiss
      // paths. Without this notify, the title-bar renderer's
      // `isMenuOpen` flag stays stuck true and every subsequent click
      // on the trigger button is suppressed by the reopen guard.
      if (!entry.titleBarSender.isDestroyed()) {
        entry.titleBarSender.send('comfy-titlebar:menu-closed', { menu: entry.kind })
      }
      /** Stamp the per-parent downloads-hide time so the click IPC that
       *  blur-dismissed us can't immediately reopen the popup. */
      if (entry.kind === 'downloads' && !view.parentWindow.isDestroyed()) {
        downloadsHiddenAtByParent.set(view.parentWindow.id, Date.now())
      }
      // Hide the popup backdrop on every dismiss path so the dim
      // never outlives the popup. Cheap no-op for kinds that don't
      // use the backdrop (menu / downloads).
      if (
        (entry.kind === 'instance-picker' || entry.kind === 'global-settings')
        && !view.parentWindow.isDestroyed()
      ) {
        hidePopupBackdrop(view.parentWindow)
      }
    },
  })
  const entry: TitlePopupEntry = {
    view,
    parentEntryId: 0,
    kind: 'menu',
    titleBarSender: view.popup.webContents, // overwritten on first open
    pendingConfig: null,
    lastConfigJson: null,
    lastSyncedConfigJson: null,
    pickerSelectedInstallationId: null,
    pickerInitialTab: null,
    pickerAutoAction: null,
    pickerAutoActionNonce: 0,
    openedAt: 0,
    lastPickerBroadcastJson: null,
    lastGlobalSettingsBroadcastJson: null,
  }
  titlePopupsByParent.set(view.parentWindowId, entry)
  titlePopupsByWebContents.set(view.popupWebContentsId, entry)

  // Re-fit the popup whenever the host window resizes — without this
  // the popup keeps its original bounds and spills past the new right
  // / bottom edges when the user drags the window smaller. Listener
  // lives on the parent (one per popup-entry) and is implicitly torn
  // down with the BrowserWindow itself; the `refitPopupForParent`
  // helper no-ops when the popup is hidden so an idle parent resize
  // costs effectively nothing.
  const onParentResize = (): void => refitPopupForParent(entry)
  parent.on('resize', onParentResize)

  return entry
}

/** Minimum lifetime (ms) of a freshly-shown picker popup before its
 *  backdrop `mousedown` is allowed to dismiss it. The trigger pill's
 *  click can produce a body mousedown that lands on the backdrop a
 *  few ticks after `showTitlePopupNow` paints — without this guard
 *  the picker opens then immediately closes (and the renderer's
 *  pending render-ack re-opens it on the next tick → visible flicker).
 *  Pick this larger than typical OS click-resolution latency
 *  (~50-80ms on macOS) plus one compositor frame. */
const BACKDROP_DISMISS_GUARD_MS = 180

/** Hide the popup view and re-emit the `comfy-titlebar:menu-closed`
 *  event so the title-bar renderer's 100ms `MENU_REOPEN_GUARD_MS`
 *  suppression fires.
 *
 *  `releaseFocusToParent` controls whether to explicitly hand focus
 *  back to the title-bar webContents after hiding. Use it when the
 *  popup is being dismissed *while* it still has focus (item click,
 *  Escape key) so keyboard input lands somewhere sensible. Skip it on
 *  the blur path — focus has already moved to wherever the user
 *  clicked, and stealing it back to the title bar would yank focus
 *  out of whatever they targeted (another app window, the parent's
 *  body, etc.). Also skip it when the activated item handed focus to
 *  a *different* window (e.g. `new-window` opens and `bringToFront`s
 *  a fresh chooser host) — re-focusing the title bar here races
 *  against and defeats that hand-off. */
function hideTitlePopup(
  entry: TitlePopupEntry,
  opts: { releaseFocusToParent?: boolean } = {},
): void {
  const wasActive = entry.view.isOpen || entry.view.pendingShowTimer !== null
  // The view's `onHide` callback fires the `comfy-titlebar:menu-closed`
  // IPC, so dismissals via this wrapper and via the auto-dismiss
  // listeners both clear the title-bar's reopen-suppression guard.
  entry.view.hide()
  if (!wasActive) return
  if (
    opts.releaseFocusToParent
    && !entry.view.popup.webContents.isDestroyed()
    && !entry.view.parentWindow.isDestroyed()
  ) {
    // Embedded WebContentsView: `BrowserWindow.focus()` raises the host
    // window but doesn't deterministically land keyboard focus in any
    // child view. Push focus into the title bar (the button that
    // opened the popup) so subsequent keystrokes go somewhere
    // sensible. Falls back to a plain window focus if the title-bar
    // sender is no longer alive.
    if (!entry.titleBarSender.isDestroyed()) {
      entry.titleBarSender.focus()
    } else {
      entry.view.parentWindow.focus()
    }
  }
}

/** Make the popup view visible, focus it, and mark `isOpen`. Called
 *  when the renderer acks `comfy-titlepopup:rendered` — at that point
 *  the new config has been painted and showing is safe. */
function showTitlePopupNow(entry: TitlePopupEntry): void {
  if (entry.view.popup.webContents.isDestroyed()) return
  // Bring the picker backdrop up first so it sits BELOW the popup in
  // the parent's child-view stack — the popup's own re-stack inside
  // `showOnTop` lands on top.
  if (
    (entry.kind === 'instance-picker' || entry.kind === 'global-settings')
    && !entry.view.parentWindow.isDestroyed()
  ) {
    showPopupBackdrop(entry.view.parentWindow)
  }
  // Tell the renderer the popup is about to be shown. Unlike
  // `set-config` (which is skipped on the fast path when the config is
  // unchanged), this fires on *every* open, so popup-side views can
  // reset transient per-open state (e.g. the instance picker's selected
  // row falls back to the host's currently-active install). Without
  // this signal a reopen-with-identical-config would inherit whatever
  // row the user left selected last time.
  entry.view.popup.webContents.send('comfy-titlepopup:will-show', { kind: entry.kind })
  entry.view.showOnTop({ focus: true })
  entry.openedAt = Date.now()
  // Notify the title bar so it can suppress the next click on the
  // menu button. Without this, on macOS the click event can fire
  // before the blur-driven dismiss propagates back, causing the
  // popup to reopen instead of close on a reclick.
  if (!entry.titleBarSender.isDestroyed()) {
    entry.titleBarSender.send('comfy-titlebar:menu-opened', { menu: entry.kind })
  }
}

/** Downloads popup sizing — fixed width and a fixed pixel cap on
 *  height. The popup view content scrolls internally past the cap so
 *  the dropdown stays compact even with a full recent buffer. The
 *  ratio cap is a safety net for very small windows where the fixed
 *  cap would push past the bottom of the host. The renderer measures
 *  its own natural height (empty placeholder + footer, or a list of
 *  entries) and asks for it via `requestSize`, so we don't impose a
 *  pixel floor — the empty placeholder's own padding already provides
 *  enough visual weight that the popup never reads as a sliver. */
const DOWNLOADS_POPUP_WIDTH = 405
const DOWNLOADS_POPUP_MAX_HEIGHT_PX = 396
const DOWNLOADS_POPUP_MAX_HEIGHT_RATIO = 0.6

/** Instance-picker popup geometry. Single `computePickerBounds()`
 *  function is the only place that decides where the picker sits inside
 *  the host window — every call site (open, parent-resize refit,
 *  request-size clamp) reads from it so they can't drift.
 *
 *  - `PICKER_SIDE_GUTTER` / `PICKER_BOTTOM_GUTTER`: breathing room
 *    between the popup card and the host window's right + bottom
 *    edges. Top edge is handled by `TITLEBAR_HEIGHT`. */
const PICKER_SIDE_GUTTER = 24
const PICKER_BOTTOM_GUTTER = 24
/** Extra breathing room between the title bar and the popup card.
 *  `TITLEBAR_HEIGHT` is the title-bar's measured height; without this
 *  gutter the popup kisses the chrome and reads as glued-on. */
const PICKER_TOP_GUTTER = 8
/** Width ceiling. The settings UI inside the right pane is form-shaped
 *  — inputs at full width just look stretched, not more useful. Cap at
 *  960px so on big screens the box sits centred with side gutters and
 *  the form fields read at a comfortable line length. */
const PICKER_EXPANDED_MAX_WIDTH = 960
/** Height ceiling as a fraction of host window content height. The
 *  per-install settings UI is form-shaped, so filling a 4K window top-
 *  to-bottom just leaves the form fields adrift in negative space. */
const PICKER_EXPANDED_MAX_HEIGHT_RATIO = 0.85
/** Hard ceiling on tall windows. 720px fits the settings UI's longest
 *  tab (Snapshots) without internal scroll on typical install counts. */
const PICKER_EXPANDED_MAX_HEIGHT = 720

interface PickerBounds {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Single source of truth for picker popup bounds.
 *
 * Every site that places the picker (open, parent-resize refit) calls
 * this — so the popup can't end up at one set of bounds at open and a
 * different set after a resize.
 *
 * Geometry: top edge at `TITLEBAR_HEIGHT` so the popup never paints
 * over the host's title chrome; side gutters keep the card from kissing
 * the host window's edges; width clamped to `PICKER_EXPANDED_MAX_WIDTH`
 * so form fields read at a comfortable line length on wide monitors;
 * height clamped to a host-content ratio + hard pixel ceiling so the
 * settings UI doesn't drift in negative space on a 4K window.
 *
 * Horizontally centred on the host window's content. On tall windows
 * the card drops by a third of the available slack so it sits slightly
 * above centre — title bar still anchors it visually, but it doesn't
 * kiss the bottom gutter on a 1440px-tall window.
 */
function computePickerBounds(parent: BrowserWindow): PickerBounds {
  const content = parent.getContentBounds()
  const innerTop = TITLEBAR_HEIGHT + PICKER_TOP_GUTTER
  const innerHeight = Math.max(0, content.height - innerTop - PICKER_BOTTOM_GUTTER)
  const innerWidth = Math.max(0, content.width - 2 * PICKER_SIDE_GUTTER)

  const width = Math.min(PICKER_EXPANDED_MAX_WIDTH, innerWidth)
  const height = Math.min(
    innerHeight,
    Math.round(content.height * PICKER_EXPANDED_MAX_HEIGHT_RATIO),
    PICKER_EXPANDED_MAX_HEIGHT,
  )
  const x = Math.max(PICKER_SIDE_GUTTER, Math.round((content.width - width) / 2))
  const slack = Math.max(0, innerHeight - height)
  const y = slack > 0 ? innerTop + Math.round(slack / 3) : innerTop
  return { x, y, width, height }
}

/** Global-settings popup sizing — two-pane tabbed card. Width and
 *  height are computed once per open from host content bounds (no
 *  renderer-driven `requestSize` loop) so the popup stays a fixed
 *  size regardless of which tab is selected and only re-fits when the
 *  host window itself resizes. Clamps keep the card usable on both
 *  narrow and ultra-wide windows. */
const GLOBAL_SETTINGS_POPUP_MIN_WIDTH = 640
const GLOBAL_SETTINGS_POPUP_MAX_WIDTH = 880
const GLOBAL_SETTINGS_POPUP_WIDTH_RATIO = 0.65
const GLOBAL_SETTINGS_POPUP_MIN_HEIGHT = 420
const GLOBAL_SETTINGS_POPUP_MAX_HEIGHT = 560
const GLOBAL_SETTINGS_POPUP_HEIGHT_RATIO = 0.7

function computeGlobalSettingsBounds(parent: BrowserWindow): { width: number; height: number } {
  const { width: cw, height: ch } = parent.getContentBounds()
  const width = Math.min(
    GLOBAL_SETTINGS_POPUP_MAX_WIDTH,
    Math.max(GLOBAL_SETTINGS_POPUP_MIN_WIDTH, Math.round(cw * GLOBAL_SETTINGS_POPUP_WIDTH_RATIO)),
  )
  const height = Math.min(
    GLOBAL_SETTINGS_POPUP_MAX_HEIGHT,
    Math.max(GLOBAL_SETTINGS_POPUP_MIN_HEIGHT, Math.round(ch * GLOBAL_SETTINGS_POPUP_HEIGHT_RATIO)),
  )
  return { width, height }
}

/** Right-edge gutter when the popup gets shifted away from its
 *  anchor to fit inside the host window. Keeps a small breathing
 *  space between the card and the window edge so the rounded corner
 *  doesn't visually collide with the window chrome. */
const POPUP_EDGE_GUTTER = 8

/** Shift `x` left until `x + width` fits inside the host window's
 *  content area, leaving an 8px gutter. The renderer anchors at the
 *  trigger button's left edge — works for left-side triggers, but
 *  the downloads tray sits at the right edge of the title bar and
 *  would otherwise spill past the window. Clamps to 0 so popups
 *  wider than the window collapse against the left edge instead of
 *  rendering at negative x. */
function clampPopupX(x: number, width: number, parent: BrowserWindow): number {
  const contentWidth = parent.getContentBounds().width
  const maxX = Math.max(0, contentWidth - width - POPUP_EDGE_GUTTER)
  return Math.min(x, maxX)
}

/** Re-fit an open popup to a shrunken parent. Triggered by the
 *  parent window's `resize` event while the popup is visible — the
 *  initial open path clamps X / height once, but if the user drags the
 *  window smaller AFTER the popup opens the bounds go stale and the
 *  popup's right + bottom edges spill past the new window edge.
 *
 *  We re-clamp X (same `clampPopupX` rule the open path uses) and
 *  re-clamp height to the kind's ceiling so a downloads / picker popup
 *  full of entries doesn't keep its tall ceiling when the window has
 *  no room for it. The menu kind is sized deterministically from its
 *  item list and doesn't need height refits — only X.
 *
 *  Y is left at the current value because every popup anchors directly
 *  under the title bar; resizing doesn't move the title bar.
 *
 *  No-op when the popup isn't currently open — the next open will
 *  re-clamp from scratch. */
function refitPopupForParent(entry: TitlePopupEntry): void {
  if (!entry.view.isOpen) return
  if (entry.view.popup.webContents.isDestroyed()) return
  if (entry.view.parentWindow.isDestroyed()) return

  const cur = entry.view.popup.getBounds()
  const parent = entry.view.parentWindow

  // Instance picker has its own geometry function (clamped to the inner
  // area below the title bar). Route through it so a parent resize lands
  // on the same bounds the open path would compute — single source of
  // truth.
  if (entry.kind === 'instance-picker') {
    const target = computePickerBounds(parent)
    if (
      target.x === cur.x
      && target.y === cur.y
      && target.width === cur.width
      && target.height === cur.height
    ) {
      return
    }
    entry.view.popup.setBounds(target)
    return
  }

  const contentHeight = parent.getContentBounds().height

  let height = cur.height
  let width = cur.width
  if (entry.kind === 'downloads') {
    const ceiling = Math.min(
      DOWNLOADS_POPUP_MAX_HEIGHT_PX,
      Math.round(contentHeight * DOWNLOADS_POPUP_MAX_HEIGHT_RATIO),
    )
    height = Math.max(1, Math.min(cur.height, ceiling))
  } else if (entry.kind === 'global-settings') {
    // Recompute both dimensions from the same clamp the open path uses
    // — the popup tracks the host window proportionally as it resizes,
    // not the renderer-reported content height (the right pane scrolls,
    // not the popup).
    ; ({ width, height } = computeGlobalSettingsBounds(parent))
  }

  // Re-anchor the centred-card kinds (global-settings) on the new
  // window centre so they don't drift off-axis after a resize. Other
  // kinds anchor at their trigger button — that's already in title-
  // bar-local coords (which don't move on resize) so a fresh
  // `clampPopupX` of the existing X is sufficient.
  let x: number
  let y = cur.y
  if (entry.kind === 'global-settings') {
    const { width: contentWidth, height: contentHeightForY } = parent.getContentBounds()
    x = Math.max(0, Math.round((contentWidth - width) / 2))
    y = Math.max(
      TITLEBAR_HEIGHT,
      Math.round(TITLEBAR_HEIGHT + (contentHeightForY - TITLEBAR_HEIGHT - height) / 2),
    )
  } else {
    x = clampPopupX(cur.x, cur.width, parent)
  }

  if (x === cur.x && y === cur.y && width === cur.width && height === cur.height) return
  entry.view.popup.setBounds({ x, y, width, height })
}

type OpenTitlePopupOpts = {
  parent: BrowserWindow
  parentEntryId: number
  anchor: { x: number; y: number }
  theme: { bg: string; text: string }
  titleBarSender: Electron.WebContents
} & (
    | { kind: 'menu'; items: TitlePopupMenuItem[] }
    | { kind: 'downloads' }
    | { kind: 'instance-picker'; snapshot: InstancePickerSnapshot }
    | { kind: 'global-settings'; snapshot: GlobalSettingsSnapshot }
  )

function openTitlePopup(opts: OpenTitlePopupOpts): void {
  // Dismiss any in-flight title-bar tooltip — the popup will obscure
  // the same area, and the renderer's pointer-leave on the trigger
  // button (which would otherwise hide the tooltip) doesn't fire when
  // a click moves focus straight into the popup.
  hideTitleTooltipPopup(getTitleTooltipForParent(opts.parent.id))
  const entry = ensureTitlePopup(opts.parent)
  if (entry.view.popup.webContents.isDestroyed()) return

  // Refresh the per-open routing context. `kind` + `parentEntryId` +
  // `titleBarSender` only matter for the *current* open, so we
  // overwrite on every open instead of allocating a new context object.
  entry.parentEntryId = opts.parentEntryId
  entry.kind = opts.kind
  entry.titleBarSender = opts.titleBarSender
  // Picker + global-settings own their outside-click dismiss via the
  // backdrop view — skip the blur-driven hide path so the toggle-on-
  // pill-click is deterministic. File menu + downloads tray have no
  // backdrop and still rely on blur to close when the user clicks
  // away.
  entry.view.suppressBlurDismiss =
    opts.kind === 'instance-picker' || opts.kind === 'global-settings'

  // Anchor coords are title-bar-local; the title-bar view sits at
  // content (0,0) so they map directly to parent-window content
  // coordinates, which is exactly what `WebContentsView.setBounds`
  // expects.
  const rawX = Math.round(Math.max(0, opts.anchor.x))
  let y = Math.round(Math.max(0, opts.anchor.y))

  let width: number
  let height: number
  let x: number
  if (opts.kind === 'menu') {
    width = POPUP_WIDTH
    height = computePopupHeight(opts.items)
    x = clampPopupX(rawX, width, opts.parent)
  } else if (opts.kind === 'downloads') {
    width = DOWNLOADS_POPUP_WIDTH
    const contentHeight = opts.parent.getContentBounds().height
    // Open at the ceiling (smaller of the fixed pixel cap or 60% of the
    // host window's content height, so the popup never overflows tiny
    // windows). The renderer immediately measures its natural content
    // height and asks for it via `requestSize`, which clamps back into
    // this band. The popup stays hidden until the renderer's
    // `notifyRendered` ack arrives, so the user never sees this
    // provisional size.
    height = Math.min(
      DOWNLOADS_POPUP_MAX_HEIGHT_PX,
      Math.round(contentHeight * DOWNLOADS_POPUP_MAX_HEIGHT_RATIO),
    )
    x = clampPopupX(rawX, width, opts.parent)
  } else if (opts.kind === 'instance-picker') {
    // instance-picker geometry is delegated to `computePickerBounds`
    // — single source of truth shared with the parent-resize refit so
    // both paths produce consistent bounds. Geometry function owns the
    // title-bar inset, so the popup never paints over the title chrome.
    const bounds = computePickerBounds(opts.parent)
    width = bounds.width
    height = bounds.height
    x = bounds.x
    y = bounds.y
  } else {
    // global-settings — fluid-clamped centred card. Width + height are
    // pinned once from host content bounds; tab switches inside the
    // popup never trigger a resize. Both axes centre on the area
    // below the title bar. Anchor coords are title-bar-local so `y=0`
    // sits at the title-bar top; the centred-y formula recentres
    // inside the `contentHeight - TITLEBAR_HEIGHT` band beneath it.
    ; ({ width, height } = computeGlobalSettingsBounds(opts.parent))
    const { width: contentWidth, height: contentHeight } = opts.parent.getContentBounds()
    x = Math.max(0, Math.round((contentWidth - width) / 2))
    y = Math.max(
      TITLEBAR_HEIGHT,
      Math.round(TITLEBAR_HEIGHT + (contentHeight - TITLEBAR_HEIGHT - height) / 2),
    )
  }

  // Update bounds while still hidden — the popup is flipped visible
  // only after the renderer acks the new content has painted, by
  // `showTitlePopupNow` → `view.showOnTop()` (which also re-stacks the
  // popup as the most recent child view so it paints above
  // `titleBarView` / `comfyView` / `panelView`). Re-stacking here too
  // would race with the renderer's `request-size` resize: re-attaching
  // the WebContentsView appears to reset bounds back to whatever was
  // last set before the attach, undoing the natural-height resize and
  // leaving the downloads popup stuck at the ceiling height.
  entry.view.popup.setBounds({ x, y, width, height })

  // Downloads popup feeds on a separate channel — push the latest
  // snapshot now so the first paint shows current state instead of
  // the empty-state placeholder. Subsequent updates arrive via the
  // tray-state-changed broadcast.
  if (opts.kind === 'downloads' && entry.view.rendererReady) {
    notifyTitlePopupDownloads(entry.view.popup)
  }

  // Push the new config and *wait* for the renderer to ack that the
  // new content has painted before flipping the view visible. Without
  // this the user sees a frame of the previous open's content while
  // Vue is still processing the config update.
  entry.view.cancelPendingShow()
  let config: TitlePopupConfig
  if (opts.kind === 'menu') {
    config = { kind: 'menu', items: opts.items, theme: opts.theme }
  } else if (opts.kind === 'downloads') {
    config = { kind: 'downloads', theme: opts.theme }
  } else if (opts.kind === 'instance-picker') {
    config = { kind: 'instance-picker', snapshot: opts.snapshot, theme: opts.theme }
  } else {
    config = { kind: 'global-settings', snapshot: opts.snapshot, theme: opts.theme }
  }
  const configJson = JSON.stringify(config)

  // Fast path: the renderer's DOM already matches the config we want
  // to show (e.g. repeat open of the same menu with no item / theme
  // changes). Skip the set-config IPC + render-ack roundtrip and show
  // immediately — eliminates ~1 frame + 2 IPC hops of perceived
  // open latency on the common case.
  if (
    entry.lastSyncedConfigJson === configJson
    && !entry.view.popup.webContents.isDestroyed()
  ) {
    showTitlePopupNow(entry)
    return
  }

  entry.lastConfigJson = configJson
  if (entry.view.rendererReady && !entry.view.popup.webContents.isDestroyed()) {
    entry.view.popup.webContents.send('comfy-titlepopup:set-config', config)
  } else {
    // Renderer hasn't mounted yet on the very first open. Queue the
    // config; the `ready` IPC handler flushes it.
    entry.pendingConfig = config
  }

  // Show INSTANTLY in the same frame as the click — same as native
  // apps / VS Code / Cursor. The render-ack handshake used to wait
  // up to 250ms for Vue to repaint, but cold Vue mount itself takes
  // ~270ms so the fallback timer was always the floor on first open.
  // The "stale content flash" the ack was guarding against is a
  // single frame of the previous open's content (~16ms on a warm
  // renderer) — invisible in practice. The renderer's own paint
  // settles within one frame of `set-config` arriving.
  showTitlePopupNow(entry)
}

export interface TitlePopupHostBindings {
  /** Open a fresh chooser host window. */
  openChooserHostWindow: (initialPanel?: ComfyPanelKey) => void
  /** Flip an install-backed host window in place to chooser-host mode. */
  returnToDashboard: (parentEntryId: number) => Promise<void> | void
  /** Confirm + close all host windows. The parent window is the popup's
   *  host so the confirm dialog can be parented to it. */
  confirmAndCloseAllHostWindows: (parentWindow: BrowserWindow | null) => Promise<void> | void
  /** Confirm + close a single host window. Same primitive the
   *  bulk-close uses, scoped to one window. Powers the install-host
   *  menu's `Exit Window` entry so the user gets a prompt instead of
   *  the silent-close the native OS button gives. */
  confirmAndCloseHostWindow: (parentWindow: BrowserWindow) => Promise<void> | void
  /** Switch the host's body to the named panel (settings, new-install, ...). */
  setActivePanel: (windowKey: number, panel: ComfyPanelKey) => void
  /** Forward a Send Feedback request to the host's panel renderer. */
  triggerOpenFeedback: (entryId: number, source: 'titlebar' | 'menu') => void
  /** Send an IPC to the host's panel webContents, deferring until
   *  `did-finish-load` if the bundle is still loading. */
  sendToPanelDeferred: (panelView: WebContentsView, channel: string, payload: unknown) => void
  /** Return the entry's live panelView, lazily rebuilding it in the
   *  body mode that matches the entry's current state if it was torn
   *  down (post-attach, etc.). Mirrors the
   *  `entry.panelView ?? ensurePanelView(...)` recipe in `main/index.ts`
   *  so picker IPCs that dispatch `panel-trigger-overlay` don't silently
   *  drop when the host is mid-attach or just finished switching modes. */
  ensurePanelViewForEntry: (entry: ComfyWindowEntry) => WebContentsView
  /** Build the same enriched installation list `get-installations`
   *  returns to renderer-side `installationStore`. Powers the instance-
   *  picker popup's list + detail pane. Async because the underlying
   *  `installations.list()` reads from disk. */
  getInstancePickerInstalls: () => Promise<InstancePickerInstall[]>
  /** Currently-running installation ids. Drives the picker's "running"
   *  row indicator and the focus-vs-launch decision in `pickInstall`. */
  getRunningInstallationIds: () => string[]
  /** Picker chose an install. The "from a Comfy window pick" contract:
   *  if the install is already running, focus its window; otherwise
   *  open a new Comfy window for it. NEVER swap the active install out
   *  of the host that opened the picker (that's the chooser-host path,
   *  not this one).
   *
   *  `parentEntryId` carries the picker's parent host so launches that
   *  need to route through a panel renderer land on the picker's own
   *  parent (not just any open Comfy window). Important when multiple
   *  Comfy windows are open. */
  pickInstallFromPicker: (
    installationId: string,
    parentEntryId: number,
  ) => Promise<void> | void
  /** Picker → Restart on a running install. Implementations confirm
   *  with the user (parented to the picker's host window), gracefully
   *  stop the running session, and then re-launch via the same
   *  focus-or-launch path the picker normally uses. `parentEntryId`
   *  threads the picker's host through so the confirm dialog is parented
   *  to the right window and post-stop relaunch routes back through
   *  the picker's own parent. */
  restartInstallFromPicker: (
    installationId: string,
    parentEntryId: number,
  ) => Promise<void> | void
  /** Resolve the per-install Settings sections + Snapshots payload the
   *  picker's right-pane accordions render. Returns `null` for either
   *  on the install's missing or source-failure case so the picker can
   *  fall back gracefully without crashing the popup. Resolves the
   *  same `getDetailSections` + `getSnapshotListData` data the unified
   *  Settings drawer reads, so the picker's accordions can't drift
   *  from the drawer's content. */
  getPickerDetailsForInstall: (installationId: string) => Promise<{
    settings: Record<string, unknown>[] | null
    snapshots: Record<string, unknown> | null
  }>
  /** Picker → mutate a field on the install's launch settings. Routes
   *  to the same `update-field` handler the drawer uses. After the
   *  update lands, main rebroadcasts a fresh picker snapshot so the
   *  popup's UI reflects the new value without the popup having to
   *  refetch. Returns the action result for error display. */
  pickerUpdateField: (
    installationId: string,
    fieldId: string,
    value: unknown,
  ) => Promise<{ ok: boolean; message?: string }>
  /** Picker → run an arbitrary install action. Same handler the
   *  drawer uses for snapshot-save / snapshot-restore / snapshot-delete
   *  / channel-pick / etc. The popup constrains the action id to a
   *  small safe set in the IPC validator before this resolves. */
  pickerRunAction: (
    installationId: string,
    actionId: string,
    actionData?: Record<string, unknown>,
  ) => Promise<{ ok: boolean; message?: string }>
  /** Picker → run a long-running (streaming) action as a background op.
   *  Unlike `pickerRunAction` this feeds live progress into
   *  `_activeOperationStatus` so the picker's inline progress view
   *  updates in real time via the snapshot broadcast loop.
   *  Handles the stop→action→relaunch chain for IN_PLACE_RELAUNCH
   *  actions on main's side (no renderer apiCall wrapper needed). */
  pickerRunBackgroundOp: (payload: {
    installationId: string
    actionId: string
    actionData?: Record<string, unknown>
    title: string
    cancellable: boolean
  }) => void
  /** Trigger a fresh instance-picker snapshot broadcast to all open
   *  pickers. Used after background op state changes so the inline
   *  progress view refreshes without waiting for the next
   *  installations-changed event. */
  broadcastPickerSnapshot: () => void
}

/** Open the Global Settings popup for a specific host window. Shared
 *  by the hamburger menu's `id === 'settings'` handler and the panel
 *  renderer's `comfy-titlepopup:open-global-settings` IPC — both end up
 *  doing the same thing: build a desktop-only snapshot and open the
 *  centred popup.
 *
 *  `parentEntry` is the host window's `ComfyWindowEntry`. Bail if the
 *  window is destroyed.
 *
 *  `titleBarSender` is forwarded as-is to `openTitlePopup` for the
 *  optional title-bar handshake (focus-return on dismiss). Callers
 *  that aren't the title bar pass the host's title-bar WebContents,
 *  which is the same value the hamburger handler uses. */
function openGlobalSettingsForHost(
  parentEntry: ComfyWindowEntry,
  parentEntryId: number,
  _bindings: TitlePopupHostBindings,
  titleBarSender: Electron.WebContents,
): void {
  if (parentEntry.window.isDestroyed()) return
  void (async () => {
    const snapshot = await buildGlobalSettingsSnapshot()
    if (parentEntry.window.isDestroyed()) return
    openTitlePopup({
      parent: parentEntry.window,
      parentEntryId,
      kind: 'global-settings',
      snapshot,
      anchor: { x: 0, y: TITLEBAR_HEIGHT },
      theme: parentEntry.lastTheme,
      titleBarSender,
    })
  })()
}

/**
 * Open the instance-picker popup parented to the given host window.
 * Shared by the title-bar centre-pill click and the panel-side
 * "Manage" entry-point (chooser-card kebab → `useInstallContextMenu`'s
 * `onManage`). Both call sites land on the same WebContentsView popup,
 * so the picker's open/close lifecycle (including the
 * `comfy-titlebar:menu-opened` / `menu-closed` broadcasts that drive
 * the pill's pressed-state) is identical regardless of which surface
 * initiated the open.
 *
 * `anchor` is title-bar-local pixels. For the panel-initiated path the
 * caller passes `{ x: 0, y: TITLEBAR_HEIGHT }` (or any value — main
 * horizontally centres the picker on the host window regardless of x,
 * see the `'instance-picker'` branch in `openTitlePopup`).
 *
 * `selectedInstallationId` seeds the picker's right-pane detail to a
 * specific install — used by the panel "Manage" path so the user lands
 * on the card they clicked. The title-bar pill leaves this unset (it
 * defaults to the host's active install inside the snapshot builder).
 */
function openInstancePickerForHost(
  parentEntry: ComfyWindowEntry,
  parentEntryId: number,
  bindings: TitlePopupHostBindings,
  titleBarSender: Electron.WebContents,
  anchor: { x: number; y: number },
  selectedInstallationId?: string | null,
  initialTab?: string | null,
  autoAction?: string | null,
): void {
  if (parentEntry.window.isDestroyed()) return
  const installs: InstancePickerInstall[] = cachedInstallsForPicker.slice()
  const runningInstallationIds = bindings.getRunningInstallationIds()
  const initialSelectedId = resolvePickerSelectedInstallId(
    selectedInstallationId,
    parentEntry.installationId,
    installs,
  )
  // Bump the nonce whenever this open carries an autoAction so a repeat
  // trigger re-fires in the cached renderer (see `_pickerAutoActionNonce`).
  const autoActionNonce = autoAction ? (_pickerAutoActionNonce += 1) : _pickerAutoActionNonce
  const popupEntry = titlePopupsByParent.get(parentEntry.window.id)
  if (popupEntry) {
    popupEntry.pickerSelectedInstallationId = initialSelectedId
    popupEntry.pickerInitialTab = initialTab ?? null
    popupEntry.pickerAutoAction = autoAction ?? null
    popupEntry.pickerAutoActionNonce = autoActionNonce
  }
  const snapshot = buildInstancePickerSnapshot({
    installs,
    hostInstallationId: parentEntry.installationId,
    runningInstallationIds,
    selectedInstallationId: initialSelectedId,
    selectedSettings: null,
    selectedSnapshots: null,
    initialTab: initialTab ?? null,
    autoAction: autoAction ?? null,
    autoActionNonce,
    storage: buildPickerStorageSlice(),
    operatingInstallationIds: [..._activeOperationStatus.keys()],
    installOperationStatus: Object.fromEntries(_activeOperationStatus),
  })
  openTitlePopup({
    parent: parentEntry.window,
    parentEntryId,
    kind: 'instance-picker',
    snapshot,
    anchor,
    theme: parentEntry.lastTheme,
    titleBarSender,
  })

  // Kick the data refresh asynchronously. When it lands,
  // `broadcastInstancePickerSnapshotToTitlePopups` pushes the updated
  // snapshot to the open picker — same channel that handles live
  // updates while the picker is open.
  void (async () => {
    await refreshCachedInstallsForPicker()
    await broadcastInstancePickerSnapshotToTitlePopups(bindings)
  })()
}

function activateTitlePopupMenuItem(
  entry: TitlePopupEntry,
  id: string,
  bindings: TitlePopupHostBindings,
): void {
  // Capture the click in main so the title-menu popup itself doesn't need
  // to bootstrap Datadog RUM / PostHog Browser (it's a transient view that
  // would mint a fresh session per open). PostHog Node captures here and
  // forwardToRenderer relays to the title-bar Datadog RUM session for the
  // parent host window — see `forwardToRenderer` + the relay-target
  // registry in `lib/telemetry.ts`.
  mainTelemetry.emit('desktop2.title_menu.item_clicked', {
    item_id: id,
    menu_kind: entry.kind,
    parent_entry_id: entry.parentEntryId,
  })
  // Default: re-focus the popup's parent on dismiss so keyboard input
  // lands somewhere sensible. Actions that hand focus to a *different*
  // window (e.g. `new-window` spawns a fresh chooser host and brings it
  // to the front) flip this off so the parent doesn't immediately yank
  // focus back from the new target.
  let releaseFocusToParent = true
  const parentEntry = comfyWindows.get(entry.parentEntryId)
  if (id === 'new-window') {
    bindings.openChooserHostWindow()
    releaseFocusToParent = false
  }
  else if (id === 'return-to-dashboard') {
    // Flip the install-backed host in place to chooser-host mode.
    // The same BrowserWindow stays alive; the file-menu popup is
    // parented to it so it stays valid through the in-place body
    // swap (no popup teardown).
    void bindings.returnToDashboard(entry.parentEntryId)
  } else if (id === 'exit-window') {
    // Single-window close with a confirm — mirrors the bulk-close
    // primitive so the user sees what they're about to abandon
    // (running ComfyUI, in-progress installs, downloads) instead of
    // the silent close the OS button gives.
    if (parentEntry && !parentEntry.window.isDestroyed()) {
      void bindings.confirmAndCloseHostWindow(parentEntry.window)
    }
  } else if (id === 'close-all-windows') {
    // For two or more open windows we confirm via a native dialog
    // that lists the open windows + any active operations that
    // would be cancelled. With one or zero windows the close
    // happens straight through. The parent of this popup is among
    // the windows being closed; its popup is auto-destroyed, and
    // the trailing hideTitlePopup is guarded against an
    // already-destroyed popup.
    const parentWindow = parentEntry && !parentEntry.window.isDestroyed()
      ? parentEntry.window
      : null
    void bindings.confirmAndCloseAllHostWindows(parentWindow)
  } else if (id === 'settings') {
    // Open the new Global Settings popup (centred card, picker chrome)
    // instead of routing to the legacy SettingsModal panel. The host's
    // active installation (null on chooser hosts) drives the install-
    // scoped Update Channel + Copy & Update controls.
    if (parentEntry && !parentEntry.window.isDestroyed()) {
      releaseFocusToParent = false
      openGlobalSettingsForHost(
        parentEntry,
        entry.parentEntryId,
        bindings,
        parentEntry.titleBarView.webContents,
      )
    }
  }
  else if (id === 'skip-onboarding') {
    // Forward to the panel renderer so it runs the same
    // `markFirstUseCompleted` + dismiss sequence the Cloud-branch
    // pick uses (PanelApp owns the `firstUseCompleted` flip and the
    // overlay close — see `handleFirstUseComplete`).
    if (parentEntry?.panelView && !parentEntry.panelView.webContents.isDestroyed()) {
      parentEntry.panelView.webContents.send('comfy-panel:first-use-skip')
    }
  }
  else if (id === 'feedback') {
    // Forward to the panel renderer — see `triggerOpenFeedback`.
    // The title-bar Send Feedback button lands on the same helper
    // via `comfy-window:click-feedback`; `source` distinguishes the
    // two entry points in the telemetry payload.
    bindings.triggerOpenFeedback(entry.parentEntryId, 'menu')
  }
  else if (id === 'reset-zoom') {
    // Pair to the Ctrl/Cmd + 0 shortcut wired in `onLaunch`. The menu
    // entry is only built when zoom is non-zero (see `buildTitlePopupMenuItems`),
    // so this always corresponds to a visible state change.
    if (parentEntry && !parentEntry.comfyView.webContents.isDestroyed()) {
      const previousLevel = parentEntry.comfyView.webContents.getZoomLevel()
      parentEntry.comfyView.webContents.setZoomLevel(0)
      // Mirrors the Ctrl/Cmd + 0 shortcut emit in `attachInstall`.
      // Same event name + payload shape so dashboards can group on the
      // event and pivot on `source` to compare discoverability paths.
      // No previousLevel === 0 guard here: the menu item is only built
      // when zoom is non-zero (see `buildTitlePopupMenuItems`), so any click
      // is a real reset. The complementary `desktop2.title_menu.item_clicked`
      // emit at the top of this function still fires for menu-engagement
      // rollups; this one is the action-specific signal.
      mainTelemetry.emit('desktop2.zoom.reset', {
        source: 'menu',
        parent_entry_id: entry.parentEntryId,
        installation_id: parentEntry.installationId,
        previous_zoom_level: previousLevel,
        previous_zoom_percent: Math.round(Math.pow(1.2, previousLevel) * 100),
      })
    }
  }
  else if (id === 'new-install' || id === 'track' || id === 'load-snapshot' || id === 'quick-install') {
    // Install-creation / import flows are chooser-host-only.
    // `buildTitlePopupMenuItems` already filters them out of the
    // install-backed file menu; this guard is the belt-and-braces
    // so a stale popup or an out-of-order IPC can't navigate an
    // in-Comfy host into one of these panels.
    if (parentEntry && isChooserHost(parentEntry)) {
      bindings.setActivePanel(entry.parentEntryId, id)
    }
  }
  // Item click — popup still has focus, so push it back to the parent
  // unless the action just handed focus to a different window.
  hideTitlePopup(entry, { releaseFocusToParent })
}

/* ----------------------------------------------------------------
 * Global-settings popup — snapshot builder, broadcaster, IPC handlers
 * ----------------------------------------------------------------
 * Mirrors the picker pattern: main owns the snapshot, view is pure
 * display, mutations come back through the bridge. Snapshot is
 * JSON-deduped on broadcast so identical pushes don't trigger a
 * resize during the open animation.
 */

const GLOBAL_SETTINGS_GITHUB_URL =
  'https://github.com/Comfy-Org/ComfyUI-Desktop-2.0-Beta'

/** Last seen `app-update:download-progress` payload, cached so a fresh
 *  popup open (or a snapshot rebroadcast that doesn't carry progress
 *  alongside it) can include it. Cleared whenever the update state
 *  leaves the downloading band — same logic the renderer composable
 *  applies. */
let lastAppUpdateProgress: Record<string, unknown> | null = null
/** Last `checkForUpdate()` time the popup informed us about. Renderer-
 *  owned (it persists to localStorage); main stores the most recent
 *  value so the next snapshot reflects it without going through
 *  another IPC round-trip. */
let globalSettingsLastCheckedAt: number | null = null

const SETTINGS_TYPE_TO_DETAIL_EDIT_TYPE: Record<string, string | undefined> = {
  text: 'text',
  number: 'number',
  path: 'path',
  select: 'select',
  boolean: 'boolean',
  pathList: undefined,
}

/** Map a main-side `SettingsField` into the loose-typed `DetailField`
 *  shape the renderer's `SettingsSectionList` expects. Keeps the
 *  popup view pure-display by doing the field-shape translation here
 *  rather than in `useGlobalSettings.ts` (which only ran in the panel
 *  renderer). */
function toDetailField(
  f: ReturnType<typeof buildSettingsSections>[number]['fields'][number],
): Record<string, unknown> {
  const editType = SETTINGS_TYPE_TO_DETAIL_EDIT_TYPE[f.type]
  return {
    id: f.id,
    label: f.label,
    value: f.value ?? null,
    editable: !f.readonly,
    editType,
    options: f.options?.map((o) => ({ value: o.value, label: o.label })),
    tooltip: f.tooltip,
    placeholder: f.placeholder,
    min: f.min,
    max: f.max,
    openable: f.openable,
  }
}

function findSettingsFields(
  sections: ReturnType<typeof buildSettingsSections>,
  titleKey: string,
  fallbackIndex: number,
): Record<string, unknown>[] {
  const localised = i18n.t(titleKey)
  const found = sections.find((s) => s.title === localised)
  const src = found?.fields ?? sections[fallbackIndex]?.fields ?? []
  return src.map(toDetailField)
}

async function buildGlobalSettingsSnapshot(): Promise<GlobalSettingsSnapshot> {
  const settingsSections = buildSettingsSections()
  const mediaSections = buildMediaSections()
  const modelsPayload = buildModelsPayload()
  const generalRaw = findSettingsFields(settingsSections, 'settings.general', 0)
  const desktopUpdateFields = generalRaw.filter((f) => f.id === 'autoInstallUpdates')
  const generalFields = generalRaw.filter((f) => f.id !== 'autoInstallUpdates')
  const telemetryFields = findSettingsFields(settingsSections, 'settings.telemetry', 1)
  const cache = findSettingsFields(settingsSections, 'settings.cache', 2)
  const advanced = findSettingsFields(settingsSections, 'settings.advanced', 3)
  const shared = (mediaSections[0]?.fields ?? []).map(toDetailField)
  const modelsDirsRaw = (modelsPayload.sections[0]?.fields[0]?.value as string[] | undefined) ?? []
  const modelsDefault = modelsPayload.systemDefault
  const appUpdateState = updater.getCurrentUpdateState() as unknown as Record<string, unknown>
  const isDownloading = (appUpdateState['kind'] === 'downloading')
  if (!isDownloading) lastAppUpdateProgress = null
  const githubStars = await getGithubStarCount('comfy-org/ComfyUI').catch(() => null)
  return {
    generalFields,
    telemetryFields,
    desktopUpdateFields,
    cacheFields: cache,
    advancedFields: advanced,
    sharedDirectoriesFields: shared,
    modelsDirs: modelsDirsRaw.map((p, i) => ({
      path: p,
      isPrimary: i === 0,
      isDefault: p === modelsDefault,
    })),
    modelsSystemDefault: modelsDefault,
    appUpdate: {
      state: appUpdateState,
      progress: lastAppUpdateProgress,
      isDownloading,
      capabilities: {
        systemManaged: false,
        canSelfUpdate: true,
      },
      installedVersion: getAppVersion(),
      platform: process.platform,
      lastCheckedAt: globalSettingsLastCheckedAt,
    },
    githubUrl: GLOBAL_SETTINGS_GITHUB_URL,
    githubStars,
    i18n: {
      overview: i18n.t('settings.general'),
      updates: i18n.t('settings.updatesTab'),
      storage: i18n.t('settings.storageTab'),
      models: i18n.t('settings.models'),
      advanced: i18n.t('settings.advanced'),
      sharedDirectories: i18n.t('settings.sharedDirectories'),
    },
  }
}

async function broadcastGlobalSettingsSnapshotToTitlePopups(
  _bindings: TitlePopupHostBindings,
): Promise<void> {
  const hasOpen = Array.from(titlePopupsByParent.values()).some(
    (e) => e.kind === 'global-settings'
      && (e.view.isOpen || e.view.pendingShowTimer !== null),
  )
  if (!hasOpen) return
  for (const entry of titlePopupsByParent.values()) {
    if (entry.kind !== 'global-settings') continue
    if (!entry.view.isOpen && entry.view.pendingShowTimer === null) continue
    if (entry.view.popup.webContents.isDestroyed()) continue
    const snapshot = await buildGlobalSettingsSnapshot()
    const snapshotJson = JSON.stringify(snapshot)
    if (entry.lastGlobalSettingsBroadcastJson === snapshotJson) continue
    entry.lastGlobalSettingsBroadcastJson = snapshotJson
    entry.view.popup.webContents.send('comfy-titlepopup:global-settings-changed', snapshot)
  }
}

/**
 * Wire the IPC handlers that drive the title-bar dropdown popup
 * (waffle menu + downloads tray) and subscribe to download events for
 * live tray updates. Called once at app `whenReady`.
 *
 * The title bar lives in its own WebContentsView with `height:
 * TITLEBAR_HEIGHT`, so HTML popups rendered inside it would be clipped
 * by the view's bounds. We attach a sibling `WebContentsView` to the
 * host window's content view (see `openTitlePopup`); it re-orders to
 * the top of the view stack on each open so it paints above the title
 * bar / comfy / panel views without z-order issues.
 */
export function registerTitlePopupIpc(bindings: TitlePopupHostBindings): void {
  // Stash for `prewarmTitlePopup` (host-construction site doesn't have
  // bindings). Last writer wins; only called once at `whenReady`.
  activeBindings = bindings

  ipcMain.on('comfy-titlepopup:ready', (event) => {
    const entry = titlePopupsByWebContents.get(event.sender.id)
    if (!entry) return
    entry.view.rendererReady = true
    if (entry.pendingConfig && !entry.view.popup.webContents.isDestroyed()) {
      const flushed = entry.pendingConfig
      entry.lastConfigJson = JSON.stringify(flushed)
      entry.view.popup.webContents.send('comfy-titlepopup:set-config', flushed)
      entry.pendingConfig = null
      if (flushed.kind === 'downloads') {
        notifyTitlePopupDownloads(entry.view.popup)
      }
    }
  })

  // Renderer signals that it has applied the latest config and the new
  // DOM has painted. Show the popup view and focus it — the user only
  // ever sees the popup once it's showing the right content.
  ipcMain.on('comfy-titlepopup:rendered', (event) => {
    const entry = titlePopupsByWebContents.get(event.sender.id)
    if (!entry) return
    // Mark the renderer in sync with the most recently sent config so
    // the next open of the same content can take the fast path in
    // `openTitlePopup`.
    entry.lastSyncedConfigJson = entry.lastConfigJson
    if (entry.view.pendingShowTimer === null) return
    showTitlePopupNow(entry)
  })

  ipcMain.on('comfy-titlepopup:item-activated', (event, payload: { id?: unknown }) => {
    const entry = titlePopupsByWebContents.get(event.sender.id)
    if (!entry) return
    const id = payload?.id
    if (typeof id !== 'string') return
    activateTitlePopupMenuItem(entry, id, bindings)
  })

  ipcMain.on('comfy-titlepopup:close', (event) => {
    const entry = titlePopupsByWebContents.get(event.sender.id)
    if (!entry) return
    // Escape key — popup still has focus, so push it back to the parent.
    hideTitlePopup(entry, { releaseFocusToParent: true })
  })

  // Click on the picker backdrop — dismiss the matching parent's
  // picker popup. The backdrop is keyed by the parent windowId so we
  // can route from any backdrop instance back to its popup.
  //
  // Guarded against a stray dismiss during the open transition: if the
  // popup was opened less than `BACKDROP_DISMISS_GUARD_MS` ago, ignore.
  // Without this, a click that lands on the trigger pill can fire the
  // backdrop's mousedown after the popup is composited but before the
  // OS settles focus, causing open → immediate-close → reopen flicker.
  ipcMain.on('comfy-popup-backdrop:dismiss', (event) => {
    const parentId = popupBackdropsByWebContents.get(event.sender.id)
    if (parentId === undefined) return
    const popup = titlePopupsByParent.get(parentId)
    if (!popup) return
    if (popup.kind !== 'instance-picker' && popup.kind !== 'global-settings') return
    if (!popup.view.isOpen) return
    if (Date.now() - popup.openedAt < BACKDROP_DISMISS_GUARD_MS) return
    hideTitlePopup(popup, { releaseFocusToParent: true })
  })

  // Renderer-driven resize for the downloads popup. The downloads
  // shelf has highly variable natural height (empty placeholder vs. a
  // full recent buffer with a mix of active + terminal entries) and
  // predicting it main-side is brittle, so the popup measures itself
  // and asks for the bounds it wants. We cap at MAX_PX and re-floor by
  // the host window's contentHeight ratio so the popup never overflows
  // tiny windows; otherwise we trust the measured natural height (the
  // empty placeholder's own padding keeps the empty case from reading
  // as a sliver). Width and position are preserved.
  ipcMain.on(
    'comfy-titlepopup:request-size',
    (event, payload: { height?: unknown }) => {
      const entry = titlePopupsByWebContents.get(event.sender.id)
      if (!entry) return
      // Menu / instance-picker / global-settings popups are sized
      // deterministically from host bounds — only the downloads tray
      // adapts to renderer-reported natural height. Ignore everything
      // else to avoid fighting the source of truth.
      if (entry.kind !== 'downloads') return
      const requested = payload?.height
      if (typeof requested !== 'number' || !Number.isFinite(requested)) return
      const parent = comfyWindows.get(entry.parentEntryId)?.window
      if (!parent || parent.isDestroyed()) return

      const contentHeight = parent.getContentBounds().height
      const ceiling = Math.min(
        DOWNLOADS_POPUP_MAX_HEIGHT_PX,
        Math.round(contentHeight * DOWNLOADS_POPUP_MAX_HEIGHT_RATIO),
      )
      const next = Math.max(1, Math.min(ceiling, Math.ceil(requested)))
      const cur = entry.view.popup.getBounds()
      if (cur.height === next) return
      entry.view.popup.setBounds({ x: cur.x, y: cur.y, width: cur.width, height: next })
    },
  )

  // Per-entry download action dispatched from the popup's downloads view.
  // Routes pause / resume / cancel / dismiss through the existing
  // download-manager APIs and `show-in-folder` through Electron's shell.
  // `clear-finished` is the only action that doesn't carry a url.
  ipcMain.on(
    'comfy-titlepopup:downloads-action',
    (_event, payload: { action?: unknown; url?: unknown; savePath?: unknown }) => {
      const { action, url, savePath } = payload ?? {}
      if (action === 'clear-finished') {
        clearFinishedDownloads()
        return
      }
      if (typeof url !== 'string' || url.length === 0) return
      switch (action) {
        case 'pause':
          pauseModelDownload(url)
          return
        case 'resume':
          resumeModelDownload(url)
          return
        case 'cancel':
          cancelModelDownload(url)
          return
        case 'dismiss':
          dismissRecentDownload(url)
          return
        case 'show-in-folder':
          if (typeof savePath === 'string' && savePath.length > 0) {
            shell.showItemInFolder(savePath)
          }
          return
        default:
          return
      }
    },
  )

  // Popup → host deep-link to per-install settings (instance picker) or
  // global settings, depending on `tab`. The popup dismisses first; the
  // renderer's deep-link router routes `tab` to the correct surface.
  ipcMain.on(
    'comfy-titlepopup:open-settings-tab',
    (event, payload: { tab?: unknown }) => {
      const popupEntry = titlePopupsByWebContents.get(event.sender.id)
      if (!popupEntry) return
      const tab = payload?.tab
      if (
        tab !== 'comfy'
        && tab !== 'directories'
        && tab !== 'downloads'
        && tab !== 'global'
      ) return
      const parentEntry = comfyWindows.get(popupEntry.parentEntryId)
      if (!parentEntry) return
      hideTitlePopup(popupEntry, { releaseFocusToParent: false })
      const panelView = parentEntry.panelView
      if (!panelView) return
      bindings.sendToPanelDeferred(panelView, 'panel-trigger-overlay', {
        kind: 'open-settings',
        installationId: parentEntry.installationId,
        settingsTab: tab,
      })
    },
  )

  // Popup → host deep-link to the standalone "View All Downloads" modal.
  // Flips the host into the `'downloads-v2'` overlay panel mode, which
  // `layoutViews` recognises as a transparent panel-forward state. The
  // renderer mounts `DownloadsModal` by watching `activePanel === 'downloads-v2'`.
  // No deep-link IPC needed — the mode swap IS the open signal — and dismiss
  // routes through `closeCurrentPanel()` which returns the body to `'comfy'`.
  ipcMain.on('comfy-titlepopup:open-downloads-modal', (event) => {
    const popupEntry = titlePopupsByWebContents.get(event.sender.id)
    if (!popupEntry) return
    const parentEntry = comfyWindows.get(popupEntry.parentEntryId)
    if (!parentEntry) return
    hideTitlePopup(popupEntry, { releaseFocusToParent: false })
    bindings.setActivePanel(popupEntry.parentEntryId, 'downloads-v2')
  })

  // Title-bar downloads-tray click. Opens the title-bar dropdown popup
  // in `'downloads'` mode anchored under the tray button. The popup
  // subscribes to `comfy-titlepopup:downloads-changed` for live state
  // and dispatches per-entry actions back via
  // `comfy-titlepopup:downloads-action`.
  ipcMain.on(
    'comfy-window:click-downloads-tray',
    (event, payload: { anchor?: { x?: number; y?: number } } | undefined) => {
      const found = findEntryByTitleBarSender(event.sender)
      if (!found) return
      const { id: windowKey, entry } = found
      if (entry.window.isDestroyed()) return

      /** Toggle: if the downloads popup is already open, close it.
       *  Otherwise, if a downloads popup was just blur-dismissed by this
       *  same gesture, treat the click as the close completion. */
      const parentId = entry.window.id
      const existingPopup = titlePopupsByParent.get(parentId)
      if (
        existingPopup
        && existingPopup.kind === 'downloads'
        && (existingPopup.view.isOpen || existingPopup.view.pendingShowTimer !== null)
      ) {
        hideTitlePopup(existingPopup, { releaseFocusToParent: true })
        return
      }
      const hiddenAt = downloadsHiddenAtByParent.get(parentId)
      if (hiddenAt !== undefined && Date.now() - hiddenAt < DOWNLOADS_REOPEN_SUPPRESS_MS) {
        downloadsHiddenAtByParent.delete(parentId)
        return
      }

      const x = Math.max(0, Math.round(payload?.anchor?.x ?? 0))
      const y = Math.max(0, Math.round(payload?.anchor?.y ?? TITLEBAR_HEIGHT))
      openTitlePopup({
        parent: entry.window,
        parentEntryId: windowKey,
        kind: 'downloads',
        anchor: { x, y },
        theme: entry.lastTheme,
        titleBarSender: entry.titleBarView.webContents,
      })
    },
  )

  // Title-bar waffle/file-menu click. Builds the menu items for the
  // host entry and opens the popup anchored under the button.
  ipcMain.on(
    'comfy-window:open-title-menu',
    (event, payload: { menu?: 'file'; anchor?: { x?: number; y?: number } }) => {
      const found = findEntryByTitleBarSender(event.sender)
      if (!found) return
      const { id: windowKey, entry } = found
      if (entry.window.isDestroyed()) return
      // Only the file/waffle menu is openable from the title bar.
      if (payload?.menu !== 'file') return

      const x = Math.max(0, Math.round(payload?.anchor?.x ?? 0))
      const y = Math.max(0, Math.round(payload?.anchor?.y ?? TITLEBAR_HEIGHT))

      openTitlePopup({
        parent: entry.window,
        parentEntryId: windowKey,
        kind: 'menu',
        items: buildTitlePopupMenuItems(entry),
        anchor: { x, y },
        theme: entry.lastTheme,
        titleBarSender: entry.titleBarView.webContents,
      })
    },
  )

  // Title bar asks main to dismiss the file-menu popup. Used when the
  // user reclicks the file button while the popup is open: on macOS
  // clicking a sibling WebContentsView in the same parent window
  // doesn't reliably trigger a `blur` on the popup webContents, so the
  // blur-driven dismiss path can't be relied on for the toggle case.
  ipcMain.on('comfy-window:dismiss-title-menu', (event) => {
    const found = findEntryByTitleBarSender(event.sender)
    if (!found) return
    const popup = titlePopupsByParent.get(found.entry.window.id)
    if (!popup) return
    hideTitlePopup(popup, { releaseFocusToParent: true })
  })

  // Title-bar centre-pill click. Opens the instance-picker popup
  // anchored under the pill. Available on both install-backed AND
  // install-less (chooser) hosts so users have one consistent way to
  // switch instances from anywhere in the app. On chooser hosts the
  // pick commits via the in-place swap path (see PanelApp's
  // `pickInstallFromPicker` wiring) so the dashboard becomes the
  // picked install; on install-backed hosts the pick opens a new
  // Comfy window per the focus-or-launch contract.
  ipcMain.on(
    'comfy-window:click-install-pill',
    (event, payload: { anchor?: { x?: number; y?: number } } | undefined) => {
      const found = findEntryByTitleBarSender(event.sender)
      if (!found) return
      const { id: windowKey, entry } = found
      if (entry.window.isDestroyed()) return

      const existingPopup = titlePopupsByParent.get(entry.window.id)
      // Toggle: open if closed, close if open (or opening). Single
      // source of truth for the decision lives here in main. The
      // picker's `suppressBlurDismiss` flag (set below on every open)
      // disables the blur-based dismiss path, so there's no race
      // between the click event and a blur-driven close — clicking
      // the trigger pill is the ONLY way to open it and one of three
      // ways to close it (trigger reclick, backdrop click, ESC). No
      // timing guards needed.
      if (
        existingPopup
        && existingPopup.kind === 'instance-picker'
        && (existingPopup.view.isOpen || existingPopup.view.pendingShowTimer !== null)
      ) {
        hideTitlePopup(existingPopup, { releaseFocusToParent: true })
        return
      }

      const x = Math.max(0, Math.round(payload?.anchor?.x ?? 0))
      const y = Math.max(0, Math.round(payload?.anchor?.y ?? TITLEBAR_HEIGHT))

      // Open SYNCHRONOUSLY with whatever data is already in memory.
      // The cache is primed at host construction (`prewarmTitlePopup`)
      // and kept fresh by the `installationEvents.on('changed')`
      // subscription, so on the warm path this list is correct. On a
      // very cold first click it may be empty; the background refresh
      // inside `openInstancePickerForHost` repopulates the popup within
      // a tick via the `installs-changed` push.
      openInstancePickerForHost(
        entry,
        windowKey,
        bindings,
        entry.titleBarView.webContents,
        { x, y },
      )
    },
  )

  // Panel renderer → open the instance-picker popup for a specific
  // install (chooser-card kebab "Manage…"). Routes through the same
  // WebContentsView popup the title-bar pill uses, so the picker's
  // open lifecycle (including the `comfy-titlebar:menu-opened`
  // broadcast that lights the centre pill green) fires identically
  // regardless of which surface initiated the open.
  //
  // `installationId` seeds the picker's right-pane to the install the
  // user clicked. Omitting it falls back to the host's active install
  // (matches the pill click behaviour).
  ipcMain.on(
    'comfy-window:open-instance-picker-for-install',
    (
      event,
      payload:
        | {
          installationId?: unknown
          initialTab?: unknown
          autoAction?: unknown
        }
        | undefined,
    ) => {
      recordIpcInvocation('comfy-window:open-instance-picker-for-install', payload)
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win || win.isDestroyed()) return
      let parentEntryId: number | undefined
      let parentEntry: ComfyWindowEntry | undefined
      for (const [id, e] of comfyWindows) {
        if (e.window === win) {
          parentEntryId = id
          parentEntry = e
          break
        }
      }
      if (parentEntryId === undefined || !parentEntry) return
      const requestedId = payload?.installationId
      const selectedInstallationId =
        typeof requestedId === 'string' && requestedId.length > 0 ? requestedId : null
      const initialTab =
        typeof payload?.initialTab === 'string' ? payload.initialTab : null
      const autoAction =
        typeof payload?.autoAction === 'string' ? payload.autoAction : null
      openInstancePickerForHost(
        parentEntry,
        parentEntryId,
        bindings,
        parentEntry.titleBarView.webContents,
        { x: 0, y: TITLEBAR_HEIGHT },
        selectedInstallationId,
        initialTab,
        autoAction,
      )
    },
  )

  // Picker → "I'm now showing details for this install." Updates the
  // popup entry's selected-id and rebroadcasts a fresh snapshot so the
  // right pane gets the new install's settings + snapshots. Idempotent
  // if the selection is unchanged.
  ipcMain.on(
    'comfy-titlepopup:set-picker-selected-install',
    async (event, payload: { installationId?: unknown }) => {
      const popupEntry = titlePopupsByWebContents.get(event.sender.id)
      if (!popupEntry || popupEntry.kind !== 'instance-picker') return
      const id = payload?.installationId
      if (id !== null && typeof id !== 'string') return
      const nextId = typeof id === 'string' && id.length > 0 ? id : null
      if (popupEntry.pickerSelectedInstallationId === nextId) return
      popupEntry.pickerSelectedInstallationId = nextId
      await broadcastInstancePickerSnapshotToTitlePopups(bindings)
    },
  )

  // Picker → field update. Routes to the existing handler the drawer
  // uses; main rebroadcasts a fresh snapshot on success so the popup
  // sees the latest value without polling. Errors surface via the
  // returned message (popup can show inline error UX).
  ipcMain.handle(
    'comfy-titlepopup:picker-update-field',
    async (event, payload: { installationId?: unknown; fieldId?: unknown; value?: unknown }) => {
      const popupEntry = titlePopupsByWebContents.get(event.sender.id)
      if (!popupEntry || popupEntry.kind !== 'instance-picker') {
        return { ok: false, message: 'Picker not active.' }
      }
      const installationId = payload?.installationId
      const fieldId = payload?.fieldId
      if (typeof installationId !== 'string' || typeof fieldId !== 'string') {
        return { ok: false, message: 'Invalid payload.' }
      }
      const result = await bindings.pickerUpdateField(installationId, fieldId, payload.value)
      if (result.ok) {
        await broadcastInstancePickerSnapshotToTitlePopups(bindings)
      }
      return result
    },
  )

  // Picker → run a whitelisted install action. Constrained to the
  // snapshot lifecycle actions (save / restore / delete) so the popup
  // can't fire arbitrary actions — the full action surface stays in
  // the drawer where the user has the room and context to handle the
  // outcome (delete-install navigation, channel-pick wizard, etc.).
  const PICKER_ALLOWED_ACTIONS = new Set([
    'snapshot-save',
    'snapshot-restore',
    'snapshot-delete',
  ])
  ipcMain.handle(
    'comfy-titlepopup:picker-run-action',
    async (event, payload: { installationId?: unknown; actionId?: unknown; actionData?: unknown }) => {
      const popupEntry = titlePopupsByWebContents.get(event.sender.id)
      if (!popupEntry || popupEntry.kind !== 'instance-picker') {
        return { ok: false, message: 'Picker not active.' }
      }
      const installationId = payload?.installationId
      const actionId = payload?.actionId
      if (typeof installationId !== 'string' || typeof actionId !== 'string') {
        return { ok: false, message: 'Invalid payload.' }
      }
      if (!PICKER_ALLOWED_ACTIONS.has(actionId)) {
        return { ok: false, message: `Action '${actionId}' is not available from the picker.` }
      }
      const actionData = (payload.actionData && typeof payload.actionData === 'object')
        ? payload.actionData as Record<string, unknown>
        : undefined
      const result = await bindings.pickerRunAction(installationId, actionId, actionData)
      if (result.ok) {
        await broadcastInstancePickerSnapshotToTitlePopups(bindings)
      }
      return result
    },
  )

  // Picker → pick install. Focus-or-launch contract (see
  // `pickInstallFromPicker` doc): never swaps the active install out of
  // the host that opened the picker. Popup is dismissed before the
  // launch fires so the new window comes up unobstructed.
  //
  // `parentEntryId` lets main route the launch through the picker's
  // own parent host (not just any open Comfy window) so launches
  // initiated from window A don't accidentally route through window B.
  ipcMain.on(
    'comfy-titlepopup:pick-install',
    (event, payload: { installationId?: unknown }) => {
      const entry = titlePopupsByWebContents.get(event.sender.id)
      if (!entry) return
      const installationId = payload?.installationId
      if (typeof installationId !== 'string' || installationId.length === 0) return
      hideTitlePopup(entry, { releaseFocusToParent: false })
      void bindings.pickInstallFromPicker(installationId, entry.parentEntryId)
    },
  )

  // Picker → restart a running install. Same contract as
  // `pick-install` but routed through `restartInstallFromPicker`, which
  // confirms with the user, stops the running session, then re-runs
  // the focus-or-launch flow. The popup is dismissed before the
  // confirm fires so the dialog comes up over the host body, not the
  // open popup.
  ipcMain.on(
    'comfy-titlepopup:restart-install',
    (event, payload: { installationId?: unknown }) => {
      const entry = titlePopupsByWebContents.get(event.sender.id)
      if (!entry) return
      const installationId = payload?.installationId
      if (typeof installationId !== 'string' || installationId.length === 0) return
      hideTitlePopup(entry, { releaseFocusToParent: false })
      void bindings.restartInstallFromPicker(installationId, entry.parentEntryId)
    },
  )

  // Picker → install-level action from the "More" menu (Open Folder /
  // Copy Installation / Untrack / Delete). Forwarded to the parent
  // host's panel renderer so the panel-side `useInstallContextMenu`
  // dispatch runs — same code path the dashboard kebab uses for these
  // actions, so the picker can't drift from the dashboard's confirm
  // dialogs / showProgress wiring.
  //
  // The popup is dismissed before the action fires so any native
  // confirm dialog the source-action opens (Copy / Untrack / Delete
  // each have one) comes up over the host body rather than the open
  // popup.
  // Picker → forward a `show-progress` request to the parent host's panel
  // renderer. The popup hides so the panel's ProgressModal is unobstructed;
  // the panel rebuilds the apiCall closure from actionId/actionData.
  ipcMain.on(
    'comfy-titlepopup:forward-show-progress',
    (event, payload: Record<string, unknown>) => {
      const popupEntry = titlePopupsByWebContents.get(event.sender.id)
      if (!popupEntry || popupEntry.kind !== 'instance-picker') return
      const installationId = payload?.installationId
      const actionId = payload?.actionId
      if (typeof installationId !== 'string' || installationId.length === 0) return
      if (typeof actionId !== 'string' || actionId.length === 0) return

      // `'inline-picker'` — cross-instance mutating op: keep the picker
      // open and stream progress inline via _activeOperationStatus.
      // The picker renderer receives updates via the snapshot broadcast loop.
      if (payload?.routing === 'inline-picker') {
        const title = typeof payload?.title === 'string' ? payload.title : actionId
        const cancellable = payload?.cancellable === true
        const actionData = payload?.actionData as Record<string, unknown> | undefined
        bindings.pickerRunBackgroundOp({ installationId, actionId, actionData, title, cancellable })
        return
      }

      // `'same-host'` (default) or `'target-host'` (launch/restart cross-instance):
      // hide the popup and dispatch a panel-takeover overlay.
      hideTitlePopup(popupEntry, { releaseFocusToParent: false })

      const routing = payload?.routing === 'target-host' ? 'target-host' : 'same-host'
      const targetEntry = routing === 'target-host'
        ? (getEntryByInstallationId(installationId) ?? comfyWindows.get(popupEntry.parentEntryId))
        : comfyWindows.get(popupEntry.parentEntryId)
      if (!targetEntry) return

      // Focus the target window for cross-instance routing (e.g. launch).
      if (routing === 'target-host' && !targetEntry.window.isDestroyed()) {
        targetEntry.window.show()
        targetEntry.window.focus()
      }

      // Lazy-rebuild panelView if it was torn down post-attach.
      const panelView = bindings.ensurePanelViewForEntry(targetEntry)
      if (panelView.webContents.isDestroyed()) return

      // Flip the target host into 'progress' panel mode so the layout
      // brings panelView forward (panel full, comfy hidden).
      bindings.setActivePanel(targetEntry.windowKey, 'progress')

      bindings.sendToPanelDeferred(panelView, 'panel-trigger-overlay', {
        kind: 'picker-show-progress',
        installationId,
        actionId,
        actionData: payload?.actionData,
        title: payload?.title,
        cancellable: payload?.cancellable,
        triggersInstanceStart: payload?.triggersInstanceStart,
        opKind: payload?.opKind,
        isRestart: payload?.isRestart,
        successChoice: payload?.successChoice,
      })
    },
  )

  // Picker → run a long-running action as a background op with inline
  // progress in the picker's right pane. Used for cross-instance mutating
  // ops (update, snapshot-restore, copy-update, migrate). The picker stays
  // open; progress is fed into _activeOperationStatus and delivered back
  // via the normal snapshot broadcast loop.
  ipcMain.on(
    'comfy-titlepopup:start-background-op',
    (event, payload: Record<string, unknown>) => {
      const popupEntry = titlePopupsByWebContents.get(event.sender.id)
      if (!popupEntry || popupEntry.kind !== 'instance-picker') return
      const installationId = payload?.installationId
      const actionId = payload?.actionId
      if (typeof installationId !== 'string' || installationId.length === 0) return
      if (typeof actionId !== 'string' || actionId.length === 0) return
      const title = typeof payload?.title === 'string' ? payload.title : actionId
      const cancellable = payload?.cancellable === true
      const actionData = payload?.actionData as Record<string, unknown> | undefined
      recordIpcInvocation('comfy-titlepopup:start-background-op', { installationId, actionId, actionData })
      // Fire-and-forget — progress flows back via snapshot broadcasts.
      bindings.pickerRunBackgroundOp({ installationId, actionId, actionData, title, cancellable })
    },
  )

  // Picker → cancel an in-flight background op. Fires the
  // AbortController the handler stored in `_operationAborts`; the
  // handler's own finally path is what clears the map entry and
  // `pickerRunBackgroundOp`'s outer catch maps the abort to
  // `MSG_CANCELLED`. `abort()` is idempotent against a second click,
  // so we do NOT delete the map entry here — that would race the
  // handler's catch, which still needs to see the controller to
  // recognise the cancel and surface 'Cancelled.' instead of a raw
  // error string.
  ipcMain.on(
    'comfy-titlepopup:cancel-background-op',
    (event, payload: { installationId?: unknown }) => {
      const popupEntry = titlePopupsByWebContents.get(event.sender.id)
      if (!popupEntry || popupEntry.kind !== 'instance-picker') return
      const installationId = payload?.installationId
      if (typeof installationId !== 'string' || installationId.length === 0) return
      recordIpcInvocation('comfy-titlepopup:cancel-background-op', { installationId })
      _operationAborts.get(installationId)?.abort()
    },
  )

  // Picker → dismiss a done (success/error/cancelled) background op
  // so the right pane returns to the settings view.
  ipcMain.on(
    'comfy-titlepopup:dismiss-background-op',
    (event, payload: { installationId?: unknown }) => {
      const popupEntry = titlePopupsByWebContents.get(event.sender.id)
      if (!popupEntry || popupEntry.kind !== 'instance-picker') return
      const installationId = payload?.installationId
      if (typeof installationId !== 'string' || installationId.length === 0) return
      _activeOperationStatus.delete(installationId)
      bindings.broadcastPickerSnapshot()
    },
  )

  // Actions whose downstream handler has no modal / progress chain —
  // they fire-and-forget against the OS (Reveal in Finder / Explorer)
  // and return the user straight to whatever they were doing. Keep the
  // popup open so the user's mouse anchor and the picker context aren't
  // discarded just to spawn an OS folder. The id space matches the
  // panel-side composable's menu-item ids — see
  // `useInstallContextMenu.InstallMenuActionId`.
  const PICKER_NON_MODAL_ACTIONS = new Set(['reveal-in-folder'])
  ipcMain.on(
    'comfy-titlepopup:open-install-action',
    (event, payload: { installationId?: unknown; actionId?: unknown }) => {
      const popupEntry = titlePopupsByWebContents.get(event.sender.id)
      if (!popupEntry || popupEntry.kind !== 'instance-picker') return
      const installationId = payload?.installationId
      const actionId = payload?.actionId
      if (typeof installationId !== 'string' || installationId.length === 0) return
      if (typeof actionId !== 'string' || actionId.length === 0) return
      const parentEntry = comfyWindows.get(popupEntry.parentEntryId)
      if (!parentEntry) return
      if (!PICKER_NON_MODAL_ACTIONS.has(actionId)) {
        hideTitlePopup(popupEntry, { releaseFocusToParent: false })
      }
      // Lazy-rebuild the panelView when the host has dropped it (post-
      // attach, etc.) — same recipe as `forward-show-progress`. Without
      // this, kebab actions silently no-op on a freshly-attached install.
      const panelView = bindings.ensurePanelViewForEntry(parentEntry)
      if (panelView.webContents.isDestroyed()) return
      bindings.sendToPanelDeferred(panelView, 'panel-trigger-overlay', {
        kind: 'picker-install-action',
        installationId,
        actionId,
      })
    },
  )

  // Picker → "+ New Install" row. Fires the `InstallWizardModal` as a
  // Tier 3 takeover on the current host, regardless of whether that
  // host is a chooser or an install-backed window. This matches the
  // chooser dashboard's "+ New Install" card behaviour — the user
  // expects to land in the install-creation flow, not in a second
  // dashboard window.
  ipcMain.on('comfy-titlepopup:open-new-install', (event) => {
    const entry = titlePopupsByWebContents.get(event.sender.id)
    if (!entry) return
    const parentEntry = comfyWindows.get(entry.parentEntryId)
    if (!parentEntry) return
    hideTitlePopup(entry, { releaseFocusToParent: false })
    // Reuse the current window only when it's the bare dashboard (no
    // install attached). An install-backed host opens a NEW window booted
    // straight into the new-install flow, so the running instance in this
    // window keeps running undisturbed (issue #629).
    if (parentEntry.installationId === null) {
      bindings.setActivePanel(entry.parentEntryId, 'new-install')
    } else {
      bindings.openChooserHostWindow('new-install')
    }
  })


  // Panel renderer → open the Global Settings popup for the sender's
  // host window. Used by the panel-side file-menu "Settings" item and
  // the `comfy://open-settings?tab=global` deep link, both of which
  // previously opened the legacy SettingsModal overlay.
  ipcMain.on('comfy-titlepopup:open-global-settings', (event) => {
    recordIpcInvocation('comfy-titlepopup:open-global-settings')
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) return
    let parentEntryId: number | undefined
    let parentEntry: ComfyWindowEntry | undefined
    for (const [id, e] of comfyWindows) {
      if (e.window === win) {
        parentEntryId = id
        parentEntry = e
        break
      }
    }
    if (parentEntryId === undefined || !parentEntry) return
    openGlobalSettingsForHost(
      parentEntry,
      parentEntryId,
      bindings,
      parentEntry.titleBarView.webContents,
    )
  })

  // ---- Global-settings popup IPC ----
  // Field update (Language / Theme / Cache / Advanced / Shared Dirs).
  // Same side-effects as the legacy `set-setting` handler, plus a
  // `globalSettingsEvents.emit('changed')` for the snapshot loop.
  ipcMain.handle(
    'comfy-titlepopup:global-settings-update-field',
    (event, payload: { fieldId?: unknown; value?: unknown }) => {
      const popupEntry = titlePopupsByWebContents.get(event.sender.id)
      if (
        !popupEntry
        || (popupEntry.kind !== 'global-settings' && popupEntry.kind !== 'instance-picker')
      ) {
        return { ok: false, message: 'Global Settings popup not active.' }
      }
      const fieldId = payload?.fieldId
      if (typeof fieldId !== 'string' || fieldId.length === 0) {
        return { ok: false, message: 'Invalid field id.' }
      }
      try {
        applySettingSet(fieldId, payload.value)
        return { ok: true }
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) }
      }
    },
  )

  // Models directory list — single setting, validated as a string array.
  ipcMain.handle(
    'comfy-titlepopup:global-settings-set-models-dirs',
    (event, payload: { dirs?: unknown }) => {
      const popupEntry = titlePopupsByWebContents.get(event.sender.id)
      if (
        !popupEntry
        || (popupEntry.kind !== 'global-settings' && popupEntry.kind !== 'instance-picker')
      ) {
        return { ok: false }
      }
      const dirs = payload?.dirs
      if (!Array.isArray(dirs) || dirs.some((d) => typeof d !== 'string')) {
        return { ok: false }
      }
      applySettingSet('modelsDirs', dirs)
      return { ok: true }
    },
  )

  // Folder picker dialog — used for Cache Directory + Models entries.
  // Parented to the popup's host window so the dialog stays modal to
  // the right window in multi-window setups.
  ipcMain.handle(
    'comfy-titlepopup:global-settings-browse-folder',
    async (event, payload: { defaultPath?: unknown } | undefined) => {
      const popupEntry = titlePopupsByWebContents.get(event.sender.id)
      if (
        !popupEntry
        || (popupEntry.kind !== 'global-settings' && popupEntry.kind !== 'instance-picker')
      ) {
        return null
      }
      const parentEntry = comfyWindows.get(popupEntry.parentEntryId)
      if (!parentEntry || parentEntry.window.isDestroyed()) return null
      const defaultPath = typeof payload?.defaultPath === 'string' && payload.defaultPath.length > 0
        ? payload.defaultPath
        : defaultInstallDir()
      const { canceled, filePaths } = await dialog.showOpenDialog(parentEntry.window, {
        defaultPath,
        properties: ['openDirectory', 'createDirectory'],
      })
      if (canceled || filePaths.length === 0) return null
      return filePaths[0]
    },
  )

  // Open a folder in the OS file manager.
  ipcMain.on(
    'comfy-titlepopup:global-settings-open-path',
    (event, payload: { path?: unknown }) => {
      const popupEntry = titlePopupsByWebContents.get(event.sender.id)
      if (
        !popupEntry
        || (popupEntry.kind !== 'global-settings' && popupEntry.kind !== 'instance-picker')
      ) {
        return
      }
      const targetPath = payload?.path
      if (typeof targetPath !== 'string' || targetPath.length === 0) return
      void openPathHelper(targetPath)
    },
  )

  // External URL — restricted to http/https.
  ipcMain.on(
    'comfy-titlepopup:global-settings-open-external',
    (event, payload: { url?: unknown }) => {
      const popupEntry = titlePopupsByWebContents.get(event.sender.id)
      if (!popupEntry || popupEntry.kind !== 'global-settings') return
      const url = payload?.url
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return
      void shell.openExternal(url)
    },
  )

  // Launcher updater actions.
  ipcMain.handle('comfy-titlepopup:global-settings-check-for-update', async (event) => {
    const popupEntry = titlePopupsByWebContents.get(event.sender.id)
    if (!popupEntry || popupEntry.kind !== 'global-settings') {
      return { available: false, error: 'Global Settings popup not active.' }
    }
    try {
      return await updater.runCheck('global-settings')
    } catch (err) {
      return { available: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('comfy-titlepopup:global-settings-download-update', async (event) => {
    const popupEntry = titlePopupsByWebContents.get(event.sender.id)
    if (!popupEntry || popupEntry.kind !== 'global-settings') return
    await updater.downloadUpdate()
  })

  ipcMain.on('comfy-titlepopup:global-settings-install-update', (event) => {
    const popupEntry = titlePopupsByWebContents.get(event.sender.id)
    if (!popupEntry || popupEntry.kind !== 'global-settings') return
    updater.installUpdate()
  })

  // Renderer mirrors localStorage.lastCheckedAt back to main so the
  // next snapshot rebroadcast reflects it without going through
  // another IPC round-trip.
  ipcMain.on(
    'comfy-titlepopup:global-settings-set-last-checked',
    (event, payload: { value?: unknown }) => {
      const popupEntry = titlePopupsByWebContents.get(event.sender.id)
      if (!popupEntry || popupEntry.kind !== 'global-settings') return
      const value = payload?.value
      if (typeof value !== 'number' || !Number.isFinite(value)) return
      globalSettingsLastCheckedAt = value
      void broadcastGlobalSettingsSnapshotToTitlePopups(bindings)
    },
  )

  // Newly-opened windows pick up live transitions automatically; initial
  // state for a fresh popup is pushed in `openTitlePopup`.
  downloadEvents.on('tray-state-changed', broadcastDownloadsToTitlePopups)
  installationEvents.on('changed', () => {
    // Keep the click-path cache fresh (next picker open uses the new
    // list directly) AND repaint any currently-open picker with the
    // updated snapshot. Order doesn't matter — both read from the
    // same underlying source.
    void refreshCachedInstallsForPicker()
    void broadcastInstancePickerSnapshotToTitlePopups(bindings)
    void broadcastGlobalSettingsSnapshotToTitlePopups(bindings)
  })
  // Settings writes (applySettingSet) emit 'changed' — rebroadcast so
  // the popup sees Language / Theme / Cache / Models / etc. flip live.
  // The picker piggy-backs `modelsDirs` + `sharedDirectoriesFields` on
  // its own snapshot, so it gets re-broadcast on the same event.
  globalSettingsEvents.on('changed', () => {
    void broadcastGlobalSettingsSnapshotToTitlePopups(bindings)
    void broadcastInstancePickerSnapshotToTitlePopups(bindings)
  })
  // Updater state transitions repaint the Updates accordion.
  updater.onUpdateStateChanged(() => {
    void broadcastGlobalSettingsSnapshotToTitlePopups(bindings)
  })
  // Mirror the download-progress broadcast so the accordion progress
  // bar advances. The renderer also subscribes via `_broadcastToRenderer`
  // for non-popup surfaces — we just capture the last payload here for
  // the next snapshot rebuild.
  ipcMain.on('comfy-popup-internal:noop', () => {
    /* placeholder to keep the IPC channel reservation explicit */
  })
}

/** Called by the updater module when a download-progress broadcast
 *  fires, so the next global-settings snapshot reflects the live
 *  percentage. Kept as a free-standing export so the wiring site in
 *  `updater.ts` doesn't need access to `titlePopup`'s private state. */
export function notifyGlobalSettingsDownloadProgress(
  progress: Record<string, unknown>,
): void {
  lastAppUpdateProgress = progress
  if (!activeBindings) return
  void broadcastGlobalSettingsSnapshotToTitlePopups(activeBindings)
}

/**
 * Test-only: return the bounds + kind of the first currently-open
 * title-bar dropdown popup, or `null` when no popup is visible. The
 * downloads-shelf E2E tests use this to assert the popup sized
 * itself to its content (the regression that motivated the
 * `scrollHeight === clientHeight` fix). Only called from
 * `e2eHooks.ts` which is itself only loaded when
 * `process.env['E2E'] === '1'`.
 */
export function _test_getOpenTitlePopupBounds(): { kind: TitlePopupKind; bounds: Electron.Rectangle } | null {
  for (const entry of titlePopupsByParent.values()) {
    if (!entry.view.isOpen) continue
    if (entry.view.popup.webContents.isDestroyed()) continue
    return { kind: entry.kind, bounds: entry.view.popup.getBounds() }
  }
  return null
}
