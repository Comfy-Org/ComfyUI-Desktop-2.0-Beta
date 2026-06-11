// Canonical IPC types shared across main, preload, and renderer.
// This file is the single source of truth — do not duplicate these types elsewhere.

import type { FirstUseMode } from '../shared/firstUseMode'
export type { FirstUseMode }

// Unsubscribe function returned by event listeners
export type Unsubscribe = () => void

// Theme identifiers
export type Theme = 'system' | 'dark' | 'light'
export type ResolvedTheme = Exclude<Theme, 'system'>

/** Capacity-protection status for Cloud entry points (see
 *  `getCloudCapacity` and `useCloudCapacity`). `normal` = no UI changes;
 *  `degraded` = show heavy-usage warning; `disabled` = block entry. */
export type CloudCapacityStatus = 'normal' | 'degraded' | 'disabled'

/** Signed-in user's Comfy Cloud subscription tier, normalized to the
 *  two values the capacity gate cares about. `'unknown'` = signed out
 *  or no fetch has succeeded yet this lifetime; treated as `'free'`
 *  downstream (fail-closed). See `userTier.ts`. */
export type CloudUserTier = 'free' | 'paid' | 'unknown'

// --- Installation types ---
export interface Installation {
  id: string
  name: string
  sourceLabel: string
  sourceCategory: string
  version?: string
  statusTag?: { style: string; label: string }
  seen?: boolean
  listPreview?: string
  launchMode?: string
  launchArgs?: string
  hasConsole?: boolean
  installPath?: string
  status?: string
  lastLaunchedAt?: number
  /** Per-source-category last-launched timestamps (epoch ms). Written
   *  alongside `lastLaunchedAt` by `installations.markLaunched()` on the
   *  main side; consumed by recency-aware UI surfaces such as the
   *  startup picker. */
  lastLaunchedAtByCategory?: Record<string, number>
  [key: string]: unknown // allow extra fields from sources
}

export interface RunningInstance {
  installationId: string
  installationName: string
  port?: number
  url?: string
  mode: string
  startedAt?: number
}

// --- Source / New Install types ---
export interface Source {
  id: string
  label: string
  category?: string
  description?: string
  fields: SourceField[]
  hideInstallPath?: boolean
  skipInstall?: boolean
}

export interface SourceField {
  id: string
  label: string
  type: 'text' | 'select'
  defaultValue?: string
  action?: { label: string }
  errorTarget?: string
  renderAs?: 'cards'
}

export interface FieldOption {
  value: string
  label: string
  description?: string
  recommended?: boolean
  data?: Record<string, unknown>
}

// --- Detail types ---
export interface DetailSection {
  title?: string
  description?: string
  collapsed?: boolean
  pinBottom?: boolean
  tab?: string
  items?: DetailItem[]
  fields?: DetailField[]
  actions?: ActionDef[]
}

export interface DetailItem {
  label: string
  active?: boolean
  tag?: string
  actions?: ActionDef[]
}

export interface DetailFieldOption {
  value: string
  label: string
  description?: string
  recommended?: boolean
  data?: Record<string, unknown>
}

export interface ComfyArgDef {
  name: string
  flag: string
  help: string
  /** `multi-value` is a variadic flag (argparse nargs `*`/`+`, shown as `[X ...]`
   *  in --help) that accepts several space-separated values, e.g. `--cache-ram 4 8`. */
  type: 'boolean' | 'value' | 'optional-value' | 'multi-value'
  metavar?: string
  choices?: string[]
  exclusiveGroup?: string
  category: string
}

export interface DetailField {
  id: string
  label: string
  value: string | boolean | number | string[] | Record<string, string> | null
  editable?: boolean
  editType?:
  | 'select'
  | 'boolean'
  | 'text'
  | 'number'
  | 'path'
  | 'channel-cards'
  | 'args-builder'
  | 'env-vars'
  | 'model-dirs'
  | 'hidden'
  options?: DetailFieldOption[]
  refreshSection?: boolean
  /** Action id to fire automatically when this field's value changes
   *  (e.g. switching update channel triggers `check-update`). */
  onChangeAction?: string
  browseOnly?: boolean
  /** Renders the field indented behind a hairline rail to signal it
   *  depends on the toggle directly above it (e.g. the per-install
   *  output-path picker under "Use shared output directory"). Set
   *  explicitly by the field builder — the renderer must not infer
   *  nesting from the field id, since ids like `outputDir` are reused
   *  for equal-weight rows in the Shared Directories section. */
  nested?: boolean
  tooltip?: string
  /** Marks fields that only take effect on next process start.
   *  Renderer shows a per-field tag + promotes the footer Restart
   *  button when one of these is edited while the install is running. */
  requiresRestart?: boolean
  /** Inline explanatory text rendered beneath the control. Used for
   *  fields whose effect is not self-evident from the label (e.g.
   *  Chinese mirrors lists which hosts it swaps). */
  description?: string
  // text / number support — surfaced from SettingsField when DetailField
  // is built from a global SettingsSection (Global Settings panel).
  placeholder?: string
  min?: number
  max?: number
}

export interface ActionDef {
  id: string
  label: string
  /** Visual style for the action button.
   *  - `primary`: solid blue, does the thing immediately on click.
   *  - `accent`: hollow blue, telegraphs that a confirmation step
   *    will run before doing anything.
   *  - `danger`: red, destructive action. */
  style?: 'primary' | 'accent' | 'danger'
  enabled?: boolean
  disabledMessage?: string
  tooltip?: string
  confirm?: ConfirmDef
  showProgress?: boolean
  progressTitle?: string
  cancellable?: boolean
  data?: Record<string, unknown>
  fieldSelects?: FieldSelectDef[]
  select?: SelectDef
  prompt?: PromptDef
}

export interface ConfirmDef {
  title?: string
  message?: string
  confirmLabel?: string
  options?: ConfirmOption[]
  messageDetails?: ModalDetailGroup[]
  /** Optional snapshot diff rendered as a collapsible SnapshotDiffView in the
   *  confirm modal (restore flow). Reuses the Snapshots-tab diff component. */
  restoreDiff?: SnapshotDiffResult | null
}

export interface ConfirmOption {
  id: string
  label: string
  checked?: boolean
}

export interface FieldSelectDef {
  sourceId: string
  fieldId: string
  field: string
  title?: string
  message?: string
  emptyMessage?: string
}

export interface SelectDef {
  source: string
  excludeSelf?: boolean
  filters?: Record<string, string>
  title?: string
  message?: string
  field: string
  emptyMessage?: string
}

export interface PromptDef {
  title?: string
  message?: string
  placeholder?: string
  defaultValue?: string
  confirmLabel?: string
  field: string
  required?: boolean | string
  messageDetails?: ModalDetailGroup[]
}

export interface ModalDetailGroup {
  label: string
  items: string[]
}

// --- List actions ---
export interface ListAction {
  id: string
  label: string
  style?: 'primary' | 'danger'
  enabled?: boolean
  disabledMessage?: string
  confirm?: { title?: string; message?: string }
  showProgress?: boolean
  progressTitle?: string
  cancellable?: boolean
}

/** Payload carried by every component's `show-progress` emit. The host
 *  (typically `PanelApp`) consumes the closure-bound `apiCall` to drive
 *  ProgressModal. */
export interface ShowProgressOpts {
  installationId: string
  title: string
  apiCall: () => Promise<unknown>
  cancellable?: boolean
  returnTo?: string
  /** Set when the operation will spawn a ComfyUI instance (launch /
   *  restart). The chooser host listens for the resulting
   *  `instance-started` broadcast and closes itself so the new comfy
   *  window replaces the chooser visually. Without this flag,
   *  launches initiated from a Tier-1 surface like DetailModal would
   *  leave the chooser host alongside the new comfy window. */
  triggersInstanceStart?: boolean
  /** Set on install ops that should auto-launch the resulting install
   *  once the op finishes successfully. Routes the install op through
   *  the Tier 3 brand-chrome takeover so the install bar and the
   *  subsequent launch sequence (security scan → starting server) share
   *  one continuous screen. The auto-launch is wired in
   *  `useFirstUseChain` (its existing watcher fits the same shape). */
  autoLaunchOnFinish?: boolean
  /** Categorises the op for ProgressModal so the brand branch can pick
   *  the right caption set, iconography, and finished-state copy. Launch
   *  ops keep the rolling 5-step `launchCaption`; everything else maps
   *  through `friendlyCaption` (per-phase i18n) instead — without this
   *  flag, delete and update ops inherit the launch captions ("Mounting
   *  model libraries…") which read as wrong copy. Falls back to
   *  `'generic'` when omitted so legacy callers keep working. */
  opKind?: 'launch' | 'install' | 'update' | 'destructive' | 'snapshot' | 'generic'
  /** Tags this op as one leg of an install→launch chain so ProgressModal
   *  can render a unified 0→100% bar across both ops instead of letting
   *  the install fill 0→100 then stalling the launch at 100. `'install'`
   *  maps the bar to 0→70%; `'launch'` maps to 70→100%. Stamped by
   *  `useFirstUseChain` when capturing the install op and again when its
   *  auto-launch watcher fires the chained launch. Standalone ops leave
   *  this unset and keep their existing 0→100 behaviour. */
  chainSpan?: 'install' | 'launch'
  /** Set on ops that remove the install from the registry as a
   *  successful side-effect (today: the install-level delete action).
   *  Drives three carve-outs on top of the standard takeover flow:
   *    - skip the chooser-host claim (host stays in the initiating
   *      window — nothing meaningful to attach when the install is
   *      about to vanish),
   *    - in-flight footer swaps Return-to-Dashboard for Cancel,
   *    - on success the host auto-detaches before the takeover closes,
   *    - on error only Return-to-Dashboard renders (no Reboot — the
   *      install state is undefined after a partial destroy). */
  destroysInstance?: boolean
  /** Raw action identity, included so a host that can't run the closure
   *  itself (the picker popup) can forward the request to one that can
   *  (the panel) and have it rebuild `apiCall`. Drawer/panel callers
   *  ignore these and use `apiCall` directly. */
  actionId?: string
  actionData?: Record<string, unknown>
  /** When set, ProgressModal skips its 700ms auto-close on success and
   *  renders a terminal choice screen with the supplied actions. Picker-
   *  driven mutating-non-launch ops opt in via `resolveProgressRouting`
   *  to surface a `[Go to Dashboard | Open Instance]` follow-up. Generic
   *  shape — new flows mint new presets without touching ProgressModal.
   *  Imported lazily as a structural type so this declaration stays in
   *  the shared types layer. */
  successTerminal?: {
    title?: string
    actions: Array<{ id: string; label: string; variant: 'primary' | 'ghost' }>
  }
}

// --- Action results ---
export interface ActionResult {
  ok?: boolean
  navigate?: 'list' | 'detail'
  message?: string
  mode?: 'console' | 'window'
  portConflict?: PortConflictInfo
  cancelled?: boolean
  running?: boolean
  /** Set by actions that produce a new install record (copy /
   *  copy-update / release-update). ProgressModal.handleDone opens
   *  the new install in its own window — the source host stays put. */
  newInstallationId?: string
}

export interface PortConflictInfo {
  port: number
  pids?: number[]
  nextPort?: number
  isComfy?: boolean
}

export interface AddResult {
  ok: boolean
  message?: string
  entry?: Installation
}

export interface KillResult {
  ok: boolean
}

export interface QuitActiveItem {
  name: string
  type: 'session' | 'operation' | 'download'
}

// --- Settings types ---
export interface SettingsSection {
  title?: string
  fields: SettingsField[]
  actions?: SettingsAction[]
}

export interface SettingsAction {
  label: string
  url?: string
  action?: string
}

export interface SettingsField {
  id: string
  label: string
  type: 'text' | 'path' | 'select' | 'boolean' | 'pathList' | 'number'
  value: string | boolean | number | string[] | null
  readonly?: boolean
  options?: { value: string; label: string }[]
  openable?: boolean
  placeholder?: string
  min?: number
  max?: number
  tooltip?: string
  description?: string
}

// --- Models types ---
export interface ModelsResult {
  systemDefault: string
  sections: ModelsSection[]
}

export interface ModelsSection {
  title?: string
  fields: ModelsField[]
}

export interface ModelsField {
  id: string
  label: string
  type: 'pathList'
  value: string[]
  tooltip?: string
}

// --- Probe types ---
export interface ProbeResult {
  sourceLabel: string
  version?: string
  repo?: string
  branch?: string
  [key: string]: unknown
}

// --- Progress types ---
export interface ProgressData {
  installationId: string
  phase: string
  status?: string
  percent?: number
  steps?: ProgressStep[]
}

export interface ProgressStep {
  phase: string
  label: string
  /** Share of the 0→100 bar this phase owns. When set on any step, the
   *  renderer paces the bar from these (the producer is the single source of
   *  truth); when absent it falls back to a curated weight table. */
  weight?: number
}

// --- Event data types ---
export interface ComfyOutputData {
  installationId: string
  text: string
}

/** Snapshot for repainting an interactive console: the retained scrollback,
 *  the shell's current size, and whether the session has been killed. */
export interface TerminalRestore {
  buffer: string[]
  size: { cols: number; rows: number }
  exited: boolean
}

export interface ComfyExitedData {
  installationId: string
  installationName: string
  crashed?: boolean
  exitCode?: number
  /** POSIX signal name when the process was killed by signal (e.g.
   *  `'SIGKILL'`, `'SIGTERM'`). `null` / absent on a normal exit and on
   *  Windows TerminateProcess paths (Windows reports an exit code only).
   *  Surfacing this lets the lifecycle view differentiate "killed by
   *  signal" from "crashed with non-zero exit". */
  signal?: string
  lastStderr?: string
  /**
   * Wall-clock timestamp (epoch ms) when the crash was recorded main-side.
   * Set by `recordCrash()` so a renderer that hydrates the crash *after*
   * the live `comfy-exited` IPC (panel WebContents recreated, second
   * window opened on the same install, etc.) still has a real value to
   * compute crash-to-relaunch latency from. Live-path subscribers also
   * stamp this on their own copy with `Date.now()`; the main-side value
   * takes precedence on hydration so the two paths agree.
   */
  crashedAtMs?: number
}

export interface ComfyBootLogData {
  installationId: string
  bootStderr: string
}

export interface GPUInfo {
  id?: string
  label: string
  model?: string | null
}

export interface HardwareValidation {
  supported: boolean
  error?: string
}

export interface NvidiaDriverCheck {
  driverVersion: string
  minimumVersion: string
  supported: boolean
}

export interface DiskSpaceInfo {
  free: number
  total: number
}

export type PathIssue = 'insideAppBundle' | 'oneDrive' | 'insideSharedDir' | 'insideExistingInstall'

// --- Model download types ---
export type ModelDownloadStatus =
  | 'pending'
  | 'downloading'
  | 'paused'
  | 'completed'
  | 'error'
  | 'cancelled'

export interface ModelDownloadProgress {
  url: string
  filename: string
  directory?: string
  savePath?: string
  progress: number
  receivedBytes?: number
  totalBytes?: number
  speedBytesPerSec?: number
  etaSeconds?: number
  status: ModelDownloadStatus
  error?: string
  /** First-seen wall-clock timestamp (ms). Stable across status
   *  transitions — the renderer uses it to render a single
   *  insertion-ordered list so terminal entries don't jump to the
   *  bottom when they leave the in-flight bucket. Optional only for
   *  back-compat with snapshots that predate the field. */
  createdAt?: number
  /** Set on a completed asset download whose file is an image, so the surface
   *  knows to lazily request a thumbnail via `getDownloadThumbnail`. */
  isImage?: boolean
}

// --- Track types ---
export interface TrackResult {
  ok: boolean
  message?: string
}

export interface SystemGpuInfo {
  vendor: string
  model: string
  vram_mb: number | null
  driver_version: string | null
}

export interface SystemInfo {
  gpu_vendor: string | null
  gpu_label: string | null
  gpu_model: string | null
  gpus: SystemGpuInfo[]
  nvidia_driver_version: string | null
  nvidia_driver_supported: boolean | null
  platform: string
  arch: string
  os_version: string
  os_distro: string | null
  os_release: string | null
  os_arch: string | null
  electron_version: string
  chrome_version: string
  total_memory_gb: number
  cpu_model: string
  cpu_cores: number
  cpu_physical_cores: number | null
  cpu_speed_ghz: number | null
  cpu_manufacturer: string | null
  app_version: string
  auto_update: boolean
  locale: string
  installation_count: number
  installations: Array<{
    source_id: string
    variant: string
    update_channel: string
    status: string
  }>
}

export interface SnapshotDiffEntry {
  createdAt: string
  trigger: string
  label: string | null
  nodesAdded: Array<{
    id: string
    type: string
    dirName: string
    enabled: boolean
    version?: string
    commit?: string
  }>
  nodesRemoved: Array<{
    id: string
    type: string
    dirName: string
    enabled: boolean
    version?: string
    commit?: string
  }>
  nodesChanged: Array<{
    id: string
    from: { version?: string; commit?: string; enabled: boolean }
    to: { version?: string; commit?: string; enabled: boolean }
  }>
  pipsAdded: Array<{ name: string; version: string }>
  pipsRemoved: Array<{ name: string; version: string }>
  pipsChanged: Array<{ name: string; from: string; to: string }>
  comfyuiChanged: boolean
  comfyui?: {
    from: { ref: string; commit: string | null }
    to: { ref: string; commit: string | null }
  }
  updateChannelChanged: boolean
  updateChannel?: { from: string; to: string }
}

export interface InstallationDdContext {
  installation_id: string
  variant: string
  source_id: string
  update_channel: string
  comfyui_version: string
  copied_from?: string
  copy_reason?: string
  snapshot_count: number
  disk_free_gb: number | null
  disk_total_gb: number | null
  latest_snapshot: {
    createdAt: string
    trigger: string
    label: string | null
    comfyui: {
      ref: string
      commit: string | null
      releaseTag: string
      variant: string
    }
    customNodes: Array<{
      id: string
      type: string
      dirName: string
      enabled: boolean
      version?: string
      commit?: string
    }>
    pipPackages: Record<string, string>
    pythonVersion?: string
    updateChannel?: string
  } | null
  snapshot_diffs: SnapshotDiffEntry[]
}

/** Compact per-install summary for the per-session boot census
 *  emitted as `comfy.desktop.session.installs_inventory`. Strictly metadata
 *  + counts + diff summaries (no per-node / per-package contents) so
 *  the inventory can pack many installs into the same RUM payload. */
export interface InstallInventoryEntry {
  installation_id: string
  source_id: string
  variant: string
  update_channel: string
  comfyui_version: string
  snapshot_count: number
  last_launched_at: number | null
  latest_snapshot: {
    createdAt: string
    trigger: string
    /** Presence flag only — user-typed labels can carry PII / paths /
     *  model names. The inventory event bypasses the renderer-side
     *  `scrubAll` pass, so we never ship the raw label string. */
    has_label: boolean
    comfyui: { ref: string; commit: string | null; releaseTag: string }
    custom_nodes_count: number
    pip_packages_count: number
  } | null
  snapshot_diffs: Array<{
    createdAt: string
    trigger: string
    /** Same PII reasoning as `latest_snapshot.has_label`. */
    has_label: boolean
    nodesAdded: number
    nodesRemoved: number
    nodesChanged: number
    pipsAdded: number
    pipsRemoved: number
    pipsChanged: number
    comfyuiChanged: boolean
    updateChannelChanged: boolean
  }>
}

export interface InstallsInventory {
  /** Total visible (non-`installing`) installs on disk, regardless of
   *  whether they fit in the inventory payload. */
  total_install_count: number
  /** Number of installs actually packed into `installs[]` after
   *  per-install + total byte caps were applied. */
  included_install_count: number
  /** True when the total byte cap was hit and one or more
   *  least-recently-launched installs were dropped from the tail
   *  (installs are sorted most-recent first, so truncation always
   *  costs the oldest entries). */
  truncated: boolean
  /** Installs sorted most-recently-launched first; never-launched at
   *  the end. */
  installs: InstallInventoryEntry[]
}

export interface DatadogForwardedError {
  source: string
  message: string
  stack?: string
  level?: 'debug' | 'info' | 'warn' | 'error' | 'critical'
  context?: Record<string, unknown>
  /**
   * Set when the error has already been captured by main-process PostHog
   * (via `mainTelemetry.captureException`). The renderer's listener forwards
   * such errors to Datadog only, avoiding duplicate PostHog exceptions.
   */
  skipPostHog?: boolean
}

// --- Snapshot tab types ---
export interface CopyEvent {
  installationId: string
  installationName: string
  copiedAt: string
  copyReason: 'copy' | 'copy-update' | 'release-update'
  exists: boolean
  /** `out` = another install was copied FROM the install whose rail this is
   *  shown on (installationName is the destination's name).
   *  `in`  = THIS install was copied from another (installationName is the
   *  source's name, snapshotted at copy time via `copiedFromName`). */
  direction: 'in' | 'out'
}

export interface SnapshotDiffSummary {
  nodesAdded: number
  nodesRemoved: number
  nodesChanged: number
  pipsAdded: number
  pipsRemoved: number
  pipsChanged: number
  comfyuiChanged: boolean
  updateChannelChanged: boolean
}

export interface SnapshotSummary {
  filename: string
  createdAt: string
  trigger: 'boot' | 'restart' | 'manual' | 'pre-update' | 'post-update' | 'post-restore'
  label: string | null
  comfyuiVersion: string
  nodeCount: number
  pipPackageCount: number
  diffVsPrevious?: SnapshotDiffSummary
}

export interface SnapshotListData {
  snapshots: SnapshotSummary[]
  copyEvents: CopyEvent[]
  totalCount: number
  context: {
    updateChannel: string
    pythonVersion: string
    variant: string
    variantLabel: string
  }
}

export interface SnapshotNodeInfo {
  id: string
  type: 'cnr' | 'git' | 'file'
  dirName: string
  enabled: boolean
  version?: string
  commit?: string
  url?: string
}

export interface SnapshotDetailData {
  filename: string
  createdAt: string
  trigger: string
  label: string | null
  comfyuiVersion: string
  comfyui: {
    ref: string
    commit: string | null
    releaseTag: string
    variant: string
  }
  pythonVersion?: string
  updateChannel?: string
  customNodes: SnapshotNodeInfo[]
  pipPackageCount: number
  pipPackages: Record<string, string>
}

export interface SnapshotDiffNodeChange {
  id: string
  type: string
  from: { version?: string; commit?: string; enabled: boolean }
  to: { version?: string; commit?: string; enabled: boolean }
}

export interface SnapshotDiffResult {
  comfyuiChanged: boolean
  comfyui?: {
    from: { ref: string; commit: string | null; formattedVersion: string }
    to: { ref: string; commit: string | null; formattedVersion: string }
  }
  updateChannelChanged: boolean
  updateChannel?: { from: string; to: string }
  nodesAdded: SnapshotNodeInfo[]
  nodesRemoved: SnapshotNodeInfo[]
  nodesChanged: SnapshotDiffNodeChange[]
  pipsAdded: Array<{ name: string; version: string }>
  pipsRemoved: Array<{ name: string; version: string }>
  pipsChanged: Array<{ name: string; from: string; to: string }>
}

export interface SnapshotDiffData {
  mode: 'previous' | 'current'
  baseLabel: string
  diff: SnapshotDiffResult
  empty: boolean
}

export interface SnapshotFilePreview {
  filePath: string
  installationName: string
  snapshotCount: number
  snapshots: SnapshotSummary[]
  newestSnapshot: SnapshotDetailData
}

// --- Error detail (async follow-up after a locked-file error) ---
export interface ErrorDetailData {
  installationId: string
  message: string
}

// --- App-update state (mirrors src/main/lib/updater.ts AppUpdateState) ---
export interface AppUpdateState {
  /** `'available'` after `update-available`, `'downloading'` once the
   *  first user-initiated `download-progress` tick lands, `'ready'`
   *  after `update-downloaded`, `null` when nothing is pending. */
  kind: 'available' | 'downloading' | 'ready' | null
  /** Target version when `kind` is non-null, otherwise null. */
  version: string | null
  /** Mirrors the `autoInstallUpdates` setting at the moment the
   *  state was committed. */
  autoUpdate: boolean
}

/** Narrowed slice of electron-updater's `ProgressInfo` forwarded by
 *  main on `app-update:download-progress`. Any field may be null when
 *  the auto-updater doesn't report it for a given tick. */
export interface AppUpdateDownloadProgress {
  percent: number | null
  transferred: number | null
  total: number | null
  bytesPerSecond: number | null
}

// --- IPC API interface ---
export interface ElectronApi {
  /** Host OS — set synchronously by the preload from `process.platform`.
   *  Renderer uses this for OS-conditional copy (e.g. "Show in Finder"
   *  vs "Show in Explorer") without IPC. */
  platform: NodeJS.Platform

  // Sources / New Install
  getSources(): Promise<Source[]>
  getFieldOptions(
    sourceId: string,
    fieldId: string,
    selections: Record<string, FieldOption>,
    context?: Record<string, unknown>
  ): Promise<FieldOption[]>
  buildInstallation(
    sourceId: string,
    selections: Record<string, FieldOption>
  ): Promise<Record<string, unknown>>
  getDefaultInstallDir(): Promise<string>
  detectGPU(): Promise<GPUInfo | null>
  validateHardware(): Promise<HardwareValidation>
  checkNvidiaDriver(): Promise<NvidiaDriverCheck | null>

  // File/URL
  browseFolder(defaultPath?: string): Promise<string | null>
  openPath(targetPath: string): Promise<void>
  openExternal(url: string): Promise<void>
  getDiskSpace(targetPath: string): Promise<DiskSpaceInfo>
  validateInstallPath(targetPath: string): Promise<PathIssue[]>
  getInstallationSize(installationId: string): Promise<{ sizeBytes: number }>
  cancelInstallationSize(): Promise<void>

  // Locale
  getLocaleMessages(): Promise<Record<string, unknown>>
  getAvailableLocales(): Promise<{ value: string; label: string }[]>
  /** Resolved locale string from main (`language` setting or
   *  `app.getLocale()` fallback). Renderers mirror this into vue-i18n;
   *  main is the single locale authority. */
  getLocale(): Promise<string>

  /** Categorised snapshot of the persisted installs for the first-use
   *  takeover. `skipPick` is true when any non-cloud, non-legacy-desktop
   *  install exists (returning user — the cloud-vs-local pick step is
   *  suppressed). `hasLegacyDesktop` is true when the auto-tracked
   *  Legacy Desktop install is present (gates the migrate-vs-install-new
   *  sub-step on the Local branch). See `firstUseDetection.ts`. */
  getFirstUseState(): Promise<{ skipPick: boolean; hasLegacyDesktop: boolean }>

  // Installations
  getInstallations(): Promise<Installation[]>
  /** Coarse cohort summary of persisted installs for telemetry global
   *  context. Counters / booleans only — no IDs, paths, or names — so
   *  the payload is safe to register as PostHog / Datadog cohort
   *  properties on every event.
   *
   *  `localCount` excludes the always-seeded Comfy Cloud entry; that
   *  entry is re-seeded on every boot, so counting it would just shift
   *  every user's count by +1. `hasLaunchedCloud` is the meaningful
   *  Cloud signal — it's true only when the user has actually opened
   *  the Cloud entry at least once. */
  getInstallationsSummary(): Promise<{
    localCount: number
    hasLaunchedCloud: boolean
    hasLegacyDesktop: boolean
  }>
  addInstallation(data: Record<string, unknown>): Promise<AddResult>
  reorderInstallations(orderedIds: string[]): Promise<void>
  probeInstallation(dirPath: string): Promise<ProbeResult[]>
  trackInstallation(data: Record<string, unknown>): Promise<TrackResult>
  installInstance(installationId: string): Promise<void>
  updateInstallation(
    installationId: string,
    data: Record<string, unknown>
  ): Promise<ActionResult | void>

  // Running
  stopComfyUI(installationId: string): Promise<void>
  /** Bring the host window backing `installationId` to the front. Resolves
   *  to `true` when a window (or external process window) was focused,
   *  `false` when none exists. */
  focusComfyWindow(installationId: string): Promise<boolean>

  // Interactive console (per-installation shell, shared across windows)
  /** Spawn the install's shell if needed, subscribe this surface, and return
   *  the current scrollback/size/exited state to repaint. */
  terminalSubscribe(installationId: string): Promise<TerminalRestore>
  terminalUnsubscribe(installationId: string): Promise<void>
  terminalWrite(installationId: string, data: string): Promise<void>
  terminalResize(installationId: string, cols: number, rows: number): Promise<void>
  /** Kill the current shell (if any) and start a fresh one. */
  terminalRestart(installationId: string): Promise<TerminalRestore>
  /** Open a window for the install backing `installationId`. Focuses
   *  any existing install-backed window; otherwise opens a fresh
   *  chooser host so the user can pick the install from the dashboard.
   *  Used by ProgressModal's `handleDone` after copy / copy-update /
   *  release-update so the newly-created destination install gets
   *  focus without swapping the source host. */
  openInstallWindow(installationId: string): Promise<boolean>
  /** Close the BrowserWindow that hosts the given installation's ComfyUI
   *  view (and its title-bar / panel WebContentsViews). Returns true if a
   *  window was found and closed. Used by the embedded install-settings
   *  panel after a navigate-list emit (e.g. delete) so the parent window
   *  doesn't linger with no install backing it.
   *
   *  `skipConfirm` pre-clears the close so the panel-renderer quit-confirm
   *  consult is bypassed. Callers should only set it when the user has
   *  already explicitly consented (e.g. the launch guard's
   *  "Close Running & Launch" choice). */
  closeComfyWindow(installationId: string, opts?: { skipConfirm?: boolean }): Promise<boolean>
  /** Close the BrowserWindow that contains the calling panel
   *  WebContents. Used by the chooser to retire its install-less
   *  host window after a successful pick → launch hand-off.
   *  Returns true if a window was found and closed. */
  closeHostWindow(): Promise<boolean>
  /** Flip the install-backed host window containing the calling panel
   *  WebContents back to chooser mode in place — same BrowserWindow,
   *  same bounds, same window-key; the install binding is torn down
   *  (running ComfyUI stopped, listeners off, comfyView navigated to
   *  about:blank) and the title bar repaints to the chooser identity.
   *  Returns true when an install-backed entry was found and detached. */
  returnToDashboard(): Promise<boolean>
  /** Page X-close (Settings / Directories / Install Settings header).
   *  Asks main to reset the panel-history stack and return the body to
   *  the comfy/chooser root. Fire-and-forget; the panel will receive
   *  the resulting `panel-switch` like any other navigation. */
  closeCurrentPanel(): void
  /** Boot-time restore reveal handshake. The restore window is opened
   *  hidden; the panel calls this once it knows whether its launch
   *  takeover came up (`'takeover-ready'` → reveal the launching surface)
   *  or it fell back to the dashboard (`'dashboard-fallback'`). Main
   *  reveals the sender's hidden host either way. Fire-and-forget. */
  resolveStartupRestoreReveal(result: 'takeover-ready' | 'dashboard-fallback'): void
  /** Open the Global Settings popup for the panel's host window. Used
   *  by the panel-side file-menu "Settings" item and the
   *  `comfy://open-settings?tab=global` deep link. Main reuses the
   *  same helper the hamburger Settings entry calls. */
  openGlobalSettings(): void
  /** Open the instance-picker popup for the panel's host window with
   *  `installationId` seeded as the picker's right-pane selection.
   *  Used by chooser-card "Manage…" (and future per-install entry
   *  points) to land on the same WebContentsView popup the title-bar
   *  centre pill opens. Omitting `installationId` falls back to the
   *  host's active install — matches the pill-click behaviour.
   *
   *  `initialTab` seeds the active tab and `autoAction` fires an action
   *  on mount. Used by the chooser kebab's specialised entries
   *  (Update / Migrate / Restore-Snapshot / Delete) and by the
   *  per-install deep links (`comfy://install-update/<id>`,
   *  `comfy://open-settings?tab=comfy`). */
  openInstancePicker(opts?: {
    installationId?: string | null
    initialTab?: 'config' | 'status' | 'update' | 'snapshots' | 'storage' | 'console'
    autoAction?: string | null
  }): void
  /** Push the first-use takeover's current step to main so it can
   *  (a) cache the value on the host entry for
   *  `buildTitlePopupMenuItems` to read synchronously and (b)
   *  forward to the title-bar webContents. Fire-and-forget;
   *  FirstUseTakeover.vue calls this on every step change and on
   *  unmount with `'none'`. */
  setFirstUseMode(mode: FirstUseMode): void
  /** Main routes the file-menu Skip Onboarding click here. Handler
   *  runs the same `markFirstUseCompleted` + dismiss-takeover
   *  sequence the Cloud pick path uses. Returns an unsubscribe. */
  onFirstUseSkip(callback: () => void): Unsubscribe
  /** Main forwards both the title-bar feedback button and the file-menu
   *  "Send Feedback" entry here. The panel renderer fires the
   *  `comfy.desktop.feedback.opened` telemetry action (with `source` so we
   *  can tell the two affordances apart) and opens the support URL via
   *  `openExternal` — the renderer is the natural home because
   *  `buildSupportUrl()` reads `navigator.userAgent` and the telemetry
   *  helpers live renderer-side. Returns an unsubscribe. */
  onOpenFeedback(callback: (data: { source: 'titlebar' | 'menu' }) => void): Unsubscribe
  /** Main consults the panel renderer before tearing down
   *  the host window. Returns an unsubscribe; the callback receives a
   *  `requestId` it must echo back via `respondCloseRequest` so main
   *  can pair the response with the request that fired it. */
  onCloseRequest(callback: (data: { requestId: string }) => void): Unsubscribe
  /** Reply to a `comfy-window:request-close` consult. `cleared: true`
   *  lets main proceed, `cleared: false` aborts (overlay cancel-prompt
   *  dismissed). `defer: true` means no overlay was in flight, so main
   *  owns the close-window confirm itself. */
  respondCloseRequest(payload: { requestId: string; cleared?: boolean; defer?: boolean }): void
  /** Send immediately on receiving a `comfy-window:request-close` so
   *  main knows the renderer picked it up and is processing. Main's
   *  hung-renderer safety timeout only fires until the ack lands; once
   *  acked main waits indefinitely for the actual response (the user
   *  may take their time on the cancel-prompt). */
  ackCloseRequest(payload: { requestId: string }): void
  /** Main consults the panel renderer before flipping an install-backed
   *  host window back to the dashboard (File menu Return to Dashboard).
   *  The renderer layers the Tier 2/3 cancel-prompt on top of the
   *  local-install "Stop ComfyUI?" confirm and echoes the result back
   *  via `respondReturnToDashboardRequest`. */
  onReturnToDashboardRequest(callback: (data: { requestId: string }) => void): Unsubscribe
  /** Reply to a `comfy-window:request-return-to-dashboard` consult —
   *  `cleared: true` lets main detach the install, `cleared: false`
   *  aborts. */
  respondReturnToDashboardRequest(payload: { requestId: string; cleared: boolean }): void
  /** Sent immediately on receiving the return-to-dashboard request so
   *  main extends its hung-renderer timeout while the renderer prompts
   *  the user. Symmetric with `ackCloseRequest`. */
  ackReturnToDashboardRequest(payload: { requestId: string }): void
  /** Stamp the calling chooser host window's current bounds onto the
   *  install's saved-bounds slot (visual continuity). Fallback wiring
   *  for `claimAttachHost` rejections (e.g. the install uses
   *  `browserPartition === 'unique'` and needs a fresh window with
   *  its own partition). No-op for install-backed callers. */
  transferHostBoundsToInstall(installationId: string): Promise<boolean>
  /** Claim the calling install-less host window for in-place attach.
   *  Run by the chooser-host renderer right before kicking off the
   *  launch action; when the launch event eventually lands in main,
   *  `onLaunch()` consumes the claim and attaches the install to
   *  THIS host window instead of constructing a fresh one. Returns
   *  `true` when the claim was accepted (renderer should skip its
   *  fallback `closeHostWindow` + `transferHostBoundsToInstall`
   *  wiring); `false` otherwise (sender isn't an install-less host's
   *  panelView, or main rejected the claim — fall back to the
   *  close+open swap). */
  claimAttachHost(installationId: string): Promise<boolean>
  /** Release the in-progress install identity preview that
   *  `claimAttachHost` installed on this chooser host's title bar.
   *  Fired by the panel renderer when an overlay (progress / takeover)
   *  closes without producing an attach — the op was cancelled,
   *  errored, or the user backed out — so the title bar reverts to
   *  the chooser-host identity. No-op for install-backed callers and
   *  for chooser hosts with no preview currently active. */
  releaseAttachHostPreview(): Promise<boolean>
  getRunningInstances(): Promise<RunningInstance[]>
  /** Snapshot of installs currently mid-launch (id + name). Lets a window
   *  opened during an in-flight launch hydrate `sessionStore.launchingInstances`
   *  instead of missing the one-shot `onInstanceLaunching` broadcast. */
  getLaunchingInstances(): Promise<{ installationId: string; installationName: string }[]>
  /** Snapshot of installs currently being stopped. Lets a window opened
   *  mid-stop hydrate the "Stopping…" state instead of missing the one-shot
   *  `onInstanceStopping` broadcast. */
  getStoppingInstances(): Promise<string[]>
  /**
   * Read the retained crash detail for an installation, if any. Main holds
   * the last `comfy-exited` payload (with stderr tail) per installation
   * until the next launch attempt. The lifecycle view calls this on mount
   * so a refresh / view recreation after a crash still surfaces the error
   * context, even if the live `onComfyExited` event fired before this
   * panel WebContents existed. Returns `null` when no crash is on record.
   */
  getLastCrashError(installationId: string): Promise<ComfyExitedData | null>
  /** Bulk crash snapshot — every retained `comfy-exited` payload. Lets a
   *  freshly-opened window hydrate error state for crashes that happened
   *  before it existed (e.g. the dashboard's red error tiles). */
  getCrashInstances(): Promise<ComfyExitedData[]>
  cancelLaunch(): Promise<void>
  cancelOperation(installationId: string): Promise<void>
  killPortProcess(port: number): Promise<KillResult>

  // Actions
  getListActions(installationId: string): Promise<ListAction[]>
  getDetailSections(installationId: string): Promise<DetailSection[]>
  getComfyArgs(installationId: string): Promise<{ args: ComfyArgDef[]; error?: string } | null>
  runAction(
    installationId: string,
    actionId: string,
    actionData?: Record<string, unknown>
  ): Promise<ActionResult>

  // Snapshots
  getSnapshots(installationId: string): Promise<SnapshotListData>
  getSnapshotDetail(installationId: string, filename: string): Promise<SnapshotDetailData>
  getSnapshotDiff(
    installationId: string,
    filename: string,
    mode: 'previous' | 'current'
  ): Promise<SnapshotDiffData>
  exportSnapshot(
    installationId: string,
    filename: string
  ): Promise<{ ok: boolean; message?: string }>
  exportAllSnapshots(installationId: string): Promise<{ ok: boolean; message?: string }>
  importSnapshotsPreview(): Promise<{
    ok: boolean
    preview?: SnapshotFilePreview
    message?: string
  }>
  importSnapshotsDiff(
    installationId: string
  ): Promise<{ ok: boolean; diff?: SnapshotDiffData; message?: string }>
  importSnapshotsConfirm(
    installationId: string
  ): Promise<{ ok: boolean; imported?: number; restoreFile?: string; message?: string }>
  previewSnapshotFile(): Promise<{ ok: boolean; preview?: SnapshotFilePreview; message?: string }>
  previewDesktopMigration(): Promise<{
    ok: boolean
    message?: string
    preview?: SnapshotFilePreview
    snapshotPath?: string
  }>
  previewLocalMigration(installationId: string): Promise<{
    ok: boolean
    message?: string
    preview?: SnapshotFilePreview
    snapshotPath?: string
  }>
  previewSnapshotPath(
    filePath: string
  ): Promise<{ ok: boolean; preview?: SnapshotFilePreview; message?: string }>
  createFromSnapshot(
    filePath: string,
    name?: string,
    releaseTag?: string,
    variantId?: string
  ): Promise<{ ok: boolean; entry?: { id: string; name: string }; message?: string }>
  getPathForFile(file: File): string

  // Settings
  getSettingsSections(): Promise<SettingsSection[]>
  getModelsSections(): Promise<ModelsResult>
  getMediaSections(): Promise<SettingsSection[]>
  getUniqueName(baseName: string): Promise<string>
  setSetting(key: string, value: unknown): Promise<void>
  getSetting(key: string): Promise<unknown>

  // Theme
  getResolvedTheme(): Promise<ResolvedTheme>

  // App
  getAppVersion(): Promise<string>
  /** Every stable ComfyUI release tag, newest first. Returns `[]` when the
   *  remote is unreachable. Used by the install-wizard version dropdown and
   *  the per-install ChannelPicker. */
  getStableTags(): Promise<string[]>
  /** Capacity-protection switch for Cloud entry points. Resolved at boot
   *  from the `desktop-cloud-capacity` PostHog flag (variants `normal` |
   *  `degraded` | `disabled`); defaults to `'normal'` when the flag is
   *  unavailable. Renderers consume this via `useCloudCapacity`. */
  getCloudCapacity(): Promise<CloudCapacityStatus>
  getCloudUserTier(): Promise<CloudUserTier>
  quitApp(): Promise<void>
  relaunchApp(): Promise<void>
  resetZoom(): Promise<void>
  getSystemInfo(): Promise<SystemInfo>
  getInstallationDdContext(installationId: string): Promise<InstallationDdContext | null>
  /** Per-session boot census of every persisted install (metadata +
   *  snapshot diff counts). Powers the `comfy.desktop.session.installs_inventory`
   *  telemetry event so dashboards see the user's full install footprint
   *  without waiting for them to launch each one. Capped to ~200 KB
   *  total to stay under Datadog RUM's per-action context limit. */
  getInstallsInventory(): Promise<InstallsInventory>
  getDeviceId(): Promise<string>

  // Updates
  checkForUpdate(): Promise<{ available: boolean; version?: string; error?: string }>
  downloadUpdate(): Promise<void>
  installUpdate(): Promise<void>
  getUpdateCapabilities(): Promise<{ canAutoUpdate: boolean; systemManaged: boolean }>
  /**
   * Snapshot of main's cached app-update state. Used by Global Settings
   * to render the update-action panel in the right state when the
   * panel mounts AFTER an `update-available` / `update-downloaded`
   * broadcast already fired. Live updates arrive via
   * `onAppUpdateStateChanged`.
   */
  getAppUpdateState(): Promise<AppUpdateState>

  // Model downloads
  listModelDownloads(): Promise<ModelDownloadProgress[]>
  pauseModelDownload(url: string): Promise<boolean>
  resumeModelDownload(url: string): Promise<boolean>
  cancelModelDownload(url: string): Promise<boolean>
  /** Drop a single terminal (completed / error / cancelled) entry
   *  from main's recent-downloads buffer; broadcasts a
   *  `model-download-removed` event so every renderer surface drops
   *  the entry from its store in lockstep. */
  dismissModelDownload(url: string): Promise<boolean>
  /** Bulk-dismiss every terminal entry from main's recent buffer.
   *  Returns the number of entries removed. */
  clearFinishedModelDownloads(): Promise<number>
  /** Re-dispatch a terminal (error) download from main's captured
   *  original params. Returns false if it's still in flight or the
   *  params were evicted from the recent buffer. */
  retryModelDownload(url: string): Promise<boolean>
  showDownloadInFolder(savePath: string): Promise<void>
  /** Downscaled `data:` URL preview of a completed image download, or null for
   *  non-images / unreadable files. */
  getDownloadThumbnail(savePath: string): Promise<string | null>

  // Event listeners (return unsubscribe functions)
  onInstallProgress(callback: (data: ProgressData) => void): Unsubscribe
  onComfyOutput(callback: (data: ComfyOutputData) => void): Unsubscribe
  onComfyExited(callback: (data: ComfyExitedData) => void): Unsubscribe
  /** Crash broadcast to every renderer (unlike `onComfyExited`, which only
   *  reaches the launching window). Lets any open dashboard show the red
   *  error tile live. */
  onInstanceCrashed(callback: (data: ComfyExitedData) => void): Unsubscribe
  onTerminalOutput(
    callback: (data: { installationId: string; data: string }) => void
  ): Unsubscribe
  onTerminalExited(callback: (data: { installationId: string }) => void): Unsubscribe
  onComfyBootLog(callback: (data: ComfyBootLogData) => void): Unsubscribe
  onInstanceLaunching(
    callback: (data: { installationId: string; installationName: string }) => void
  ): Unsubscribe
  onInstanceLaunchFailed(callback: (data: { installationId: string }) => void): Unsubscribe
  onInstanceStarted(callback: (data: RunningInstance) => void): Unsubscribe
  onInstanceStopping(callback: (data: { installationId: string }) => void): Unsubscribe
  onInstanceStopped(callback: (data: { installationId: string }) => void): Unsubscribe
  onThemeChanged(callback: (theme: ResolvedTheme) => void): Unsubscribe
  onLocaleChanged(
    callback: (payload: { locale: string; messages: Record<string, unknown> }) => void
  ): Unsubscribe
  onConfirmQuit(callback: (details: QuitActiveItem[]) => void): Unsubscribe
  onInstallationsChanged(callback: () => void): Unsubscribe
  onInstallationsVersionsUpdated(
    callback: (updates: { id: string; version: string }[]) => void
  ): Unsubscribe
  /**
   * Fires when `release-cache.enrichCommitsAhead` actually writes a new
   * `commitsAhead` value (not on no-op short-circuits). Open settings
   * panels can refresh their channel-card section so the "Latest from
   * GitHub" label upgrades from `tag (sha)` to `tag + N commits (sha)`
   * in place, without holding the section IPC hostage during the
   * background `git fetch`/`rev-list` calls.
   */
  onReleaseCacheEnriched(callback: (data: { repo: string }) => void): Unsubscribe
  /**
   * Fires when an auto-off "Desktop Update Available" download completes
   * (i.e. user explicitly opted in via the pill confirm-modal). The
   * panel renderer pops the "Restart now?" follow-up modal automatically
   * so the flow lands on a single user gesture instead of forcing the
   * user to find the pill again.
   */
  onAppUpdatePromptRestart(callback: (data: { version: string }) => void): Unsubscribe
  /**
   * Fires whenever main's cached app-update state transitions
   * (update-available, update-downloaded, autoUpdate setting flip).
   * Mirrors the title-bar pill's `onAppUpdateStateChanged` so the
   * Global Settings update-action panel can stay in sync.
   */
  onAppUpdateStateChanged(callback: (state: AppUpdateState) => void): Unsubscribe
  /**
   * Per-tick download progress while electron-updater is fetching the
   * pending update payload. Drives the progress bar in the Global
   * Settings update panel. Any field may be null if the auto-updater
   * didn't supply it for that tick.
   */
  onAppUpdateDownloadProgress(callback: (progress: AppUpdateDownloadProgress) => void): Unsubscribe
  /**
   * Fires when a user-initiated update action (download / install) fails.
   * Background auto-on download errors are NOT broadcast — only failures
   * the user is actively waiting on. Renderer pops an alert modal.
   */
  onAppUpdateUserActionFailed(callback: (err: { message: string }) => void): Unsubscribe
  onZoomChanged(callback: (level: number) => void): Unsubscribe
  onModelDownloadProgress(callback: (progress: ModelDownloadProgress) => void): Unsubscribe
  /** Fires when main drops a single terminal entry from its recent
   *  buffer (via `dismissModelDownload`). */
  onModelDownloadRemoved(callback: (data: { url: string }) => void): Unsubscribe
  /** Fires when main bulk-dismisses every terminal entry. The payload
   *  carries the URLs that were removed so listeners can drop them in
   *  one pass instead of re-listing. */
  onModelDownloadsClearedFinished(callback: (data: { urls: string[] }) => void): Unsubscribe
  /**
   * Forward a renderer-originated telemetry event to main, which captures it
   * via PostHog Node under the current distinct_id and consent state.
   *
   * Replaces the renderer's direct `posthog-js` capture path. Fire-and-forget:
   * the renderer does not await delivery. Main is the single PostHog capture
   * point so identity, consent, and dedup all live in one place.
   */
  captureTelemetry(event: string, properties: Record<string, unknown>): void
  /**
   * Forward a renderer-originated exception to main's PostHog Node
   * `captureException` path. Used by `window.error` / `unhandledrejection`
   * handlers and any explicit `try/catch` reporter. Fire-and-forget.
   */
  captureExceptionTelemetry(payload: {
    message: string
    stack?: string
    properties?: Record<string, unknown>
  }): void
  /**
   * Update person-level cohort properties on the current PostHog person.
   * Replaces the renderer's previous `registerPostHog(properties)` calls.
   * Main routes this to `posthog.identify({ distinctId, properties: { $set: ... } })`.
   */
  registerTelemetryProperties(properties: Record<string, unknown>): void
  /**
   * Bind a user_id on the current PostHog identity after a successful login.
   * Main aliases the anonymous installation_id into user_id (PostHog merges
   * histories), sets `is_authenticated: true`, and fires `app:user_logged_in`.
   * The renderer remains responsible for Datadog `setUser` on its own SDK.
   */
  telemetryBindUserId(payload: { userId: string; properties?: Record<string, unknown> }): void
  /**
   * Unbind user_id on logout. Switches distinct_id back to the anonymous
   * installation_id (NOT posthog.reset, which would clobber installation_id
   * and download_token). Renderer also clears Datadog setUser.
   */
  telemetryUnbindUserId(): void
  /**
   * Look up an A/B experiment / feature-flag variant for this user.
   * Returns the cached value (string for multivariate, boolean for a
   * single-flag rollout) or `null` if the flag is not present in the
   * cache. Callers MUST default to the control branch on `null`.
   * Backed by `posthog.getAllFlags` via the boot-time experiments
   * refresh; see `src/main/lib/experiments.ts`.
   */
  telemetryGetExperimentFlag(key: string): Promise<string | boolean | null>
  /**
   * Record an A/B experiment exposure. Per-session dedup is enforced
   * main-side, so it's safe to call this on every render of an
   * experiment surface (a re-render won't double-count).
   */
  telemetryRecordExposure(payload: {
    experimentKey: string
    variant: string
    source?: 'cache' | 'remote' | 'fallback'
  }): void
  onTelemetrySettingChanged(callback: (enabled: boolean | undefined) => void): Unsubscribe
  onDatadogError(callback: (payload: DatadogForwardedError) => void): Unsubscribe
  onTelemetryActionFromMain(
    callback: (data: {
      event: string
      context: Record<string, unknown>
      mainAlreadyCaptured?: boolean
    }) => void
  ): Unsubscribe
  onErrorDetail(callback: (data: ErrorDetailData) => void): Unsubscribe
  onSuggestChineseMirrors(callback: () => void): Unsubscribe
  onSettingsChanged(callback: (data: { key: string }) => void): Unsubscribe
  /**
   * Fired by main when something requests a panel switch in the embedded
   * panel WebContentsView (e.g. from the ComfyUI window's title-bar buttons).
   */
  onPanelSwitch(callback: (data: { panel: string; installationId?: string }) => void): Unsubscribe
  /**
   * Main forwards a title-bar status pill / tray click here. The
   * renderer subscribes once on mount and dispatches each kind:
   *   - `'app-update-restart-prompt'` → `useModal.confirm` "Desktop
   *     Update Ready" dialog. Confirm → `installUpdate()`.
   *     Carries the target `version`.
   *   - `'app-update-download-prompt'` → `useModal.confirm` "Desktop
   *     Update Available" dialog. Confirm → `downloadUpdate()`.
   *     Carries the target `version`.
   *   - `'install-update'` → Manage overlay (DetailModal) on the
   *     update tab, scoped to the carried `installationId`.
   *   - `'open-settings'` → Tier 1 unified Settings modal at the
   *     given `settingsTab` (defaults to the host's default tab).
   *     Currently used by the title-bar downloads popup's
   *     "View all in Settings…" deep-link.
   *   - `'picker-pick-install'` → instance-picker popover picked an
   *     install that isn't already running on another window. Routed
   *     to the panel renderer (rather than launched main-side) so the
   *     same `useListAction` confirm/port-conflict UX the chooser
   *     uses fires for picker launches too. NEVER swaps the active
   *     install out of the host (that's the chooser-host path).
   *   - `'picker-install-action'` → instance-picker popover's "More"
   *     menu picked a per-install action (Open Folder / Copy /
   *     Untrack / Delete). Forwarded to the panel so the panel-side
   *     `useInstallContextMenu` dispatch reuses the dashboard's same
   *     code path — same source-action confirms, same progress UI,
   *     no parallel implementation in the picker.
   */
  onPanelTriggerOverlay(
    callback: (data: {
      kind:
      | 'install-update'
      | 'app-update-restart-prompt'
      | 'app-update-download-prompt'
      | 'open-settings'
      | 'picker-pick-install'
      | 'picker-install-action'
      | 'picker-show-progress'
      installationId?: string
      actionId?: string
      actionData?: Record<string, unknown>
      version?: string | null
      settingsTab?: 'comfy' | 'directories' | 'downloads' | 'global'
      title?: string
      cancellable?: boolean
      /** Picker-only (`picker-pick-install`): set on boot-time restore. The
       *  panel takes the dashboard-fallback path on a missing launch action
       *  (instead of opening new-install) and resolves the reveal handshake. */
      startupRestore?: boolean
      triggersInstanceStart?: boolean
      opKind?: 'launch' | 'install' | 'update' | 'destructive' | 'snapshot' | 'generic'
      isRestart?: boolean
      /** Picker-only: when `true`, ProgressModal should render a
       *  terminal choice screen on success rather than auto-closing.
       *  The panel-side handler maps this flag to a
       *  `successTerminal` preset before handing off to
       *  `progressStore.startOperation`. */
      successChoice?: boolean
    }) => void
  ): Unsubscribe
}

/** Action IDs that auto-relaunch ComfyUI after completing (stop→op→launch).
 *  Shared between main and renderer so both sides agree on the relaunch contract. */
export const IN_PLACE_RELAUNCH = new Set(['update-comfyui', 'snapshot-restore'])

/** Action IDs that require the installation to be stopped before running.
 *  Shared between main and renderer processes. */
export const REQUIRES_STOPPED = new Set([
  'delete',
  'copy',
  'copy-update',
  'release-update',
  'migrate-to-standalone',
  'snapshot-restore',
  'update-comfyui',
  'migrate-from'
])

/** Picker popup's settings-passthrough IPC channels — main registers them,
 *  preload invokes them. Single source so a typo can't desync the two sides. */
export const PICKER_SETTINGS_CHANNELS = {
  getDetailSections: 'comfy-titlepopup:picker-settings-get-detail-sections',
  getDiskSpace: 'comfy-titlepopup:picker-settings-get-disk-space',
  getInstallationSize: 'comfy-titlepopup:picker-settings-get-installation-size',
  updateInstallation: 'comfy-titlepopup:picker-settings-update-installation',
  runAction: 'comfy-titlepopup:picker-settings-run-action',
  getFieldOptions: 'comfy-titlepopup:picker-settings-get-field-options',
  getInstallations: 'comfy-titlepopup:picker-settings-get-installations',
  stopComfyUI: 'comfy-titlepopup:picker-settings-stop-comfyui',
  cancelOperation: 'comfy-titlepopup:picker-settings-cancel-operation',
  getSnapshots: 'comfy-titlepopup:picker-settings-get-snapshots',
  getSnapshotDetail: 'comfy-titlepopup:picker-settings-get-snapshot-detail',
  getSnapshotDiff: 'comfy-titlepopup:picker-settings-get-snapshot-diff',
  exportSnapshot: 'comfy-titlepopup:picker-settings-export-snapshot',
  exportAllSnapshots: 'comfy-titlepopup:picker-settings-export-all-snapshots',
  importSnapshotsPreview: 'comfy-titlepopup:picker-settings-import-snapshots-preview',
  importSnapshotsDiff: 'comfy-titlepopup:picker-settings-import-snapshots-diff',
  importSnapshotsConfirm: 'comfy-titlepopup:picker-settings-import-snapshots-confirm',
  previewSnapshotFile: 'comfy-titlepopup:picker-settings-preview-snapshot-file',
  getComfyArgs: 'comfy-titlepopup:picker-settings-get-comfy-args',
  browseFolder: 'comfy-titlepopup:picker-settings-browse-folder',
  previewDesktopMigration: 'comfy-titlepopup:picker-settings-preview-desktop-migration',
  previewLocalMigration: 'comfy-titlepopup:picker-settings-preview-local-migration',
  relaunchApp: 'comfy-titlepopup:picker-settings-relaunch-app',
  getLocaleMessages: 'comfy-titlepopup:picker-settings-get-locale-messages',
  getLocale: 'comfy-titlepopup:picker-settings-get-locale',
  getStableTags: 'comfy-titlepopup:picker-settings-get-stable-tags'
} as const
