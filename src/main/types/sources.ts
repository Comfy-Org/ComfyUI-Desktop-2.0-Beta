import type { InstallationRecord } from '../installations'
import type { Cache } from '../lib/cache'
import type { DownloadProgress } from '../lib/download'
import type { ExtractProgress } from '../lib/extract'

// --- Field types ---

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

// --- Launch command ---

export interface LaunchCommand {
  cmd?: string
  args?: string[]
  cwd?: string
  port?: number
  remote?: boolean
  url?: string
  host?: string
  env?: NodeJS.ProcessEnv
  /** When true, show the spawned process window (disables windowsHide). */
  showWindow?: boolean
  /** When true, skip port conflict detection and port readiness waiting.
   *  The session is registered immediately after spawning. */
  skipPortWait?: boolean
  /** When true, skip injecting shared model/input/output path args.
   *  Used for external apps that don't accept ComfyUI CLI flags. */
  skipSharedPaths?: boolean
}

// --- Install / action tools ---

export interface InstallTools {
  sendProgress: (step: string, data: { percent: number; status: string }) => void
  download: (url: string, dest: string, onProgress: ((p: DownloadProgress) => void) | null, options?: { signal?: AbortSignal; expectedSize?: number }) => Promise<string>
  cache: Cache
  extract: (archivePath: string, dest: string, onProgress?: ((p: ExtractProgress) => void) | null, options?: { signal?: AbortSignal }) => Promise<void>
  signal?: AbortSignal
}

export interface ActionTools {
  update: (data: Record<string, unknown>) => Promise<void>
  sendProgress: (step: string, data: Record<string, unknown>) => void
  sendOutput: (text: string) => void
  signal?: AbortSignal
}

export interface PostInstallTools {
  sendProgress: (step: string, data: { percent: number; status: string }) => void
  update: (data: Record<string, unknown>) => Promise<void>
  signal?: AbortSignal
}

// --- Action / detail section types ---

export interface ActionResult {
  ok: boolean
  navigate?: string
  message?: string
}

export interface StatusTag {
  label: string
  style: string
  /** Raw version string the tag refers to (e.g. an `update`-style tag's
   *  target release). Surfaces beyond the chooser tile (notably the
   *  Comfy Instance title-bar install-update pill) want to show a
   *  bare "Update v1.2.3" label without re-parsing the localised
   *  `label`, so source plugins now expose the version separately. */
  version?: string
}

export interface InstallStep {
  phase: string
  label: string
}

// --- Source plugin interface ---

export interface SourcePlugin {
  id: string
  label: string
  description?: string
  category: string
  hasConsole?: boolean
  skipInstall?: boolean
  platforms?: readonly string[]
  hidden?: boolean
  fields: readonly SourceField[]
  defaultLaunchArgs?: string
  installSteps?: readonly InstallStep[]

  getDefaults?(): Record<string, unknown>
  getStatusTag?(installation: InstallationRecord): StatusTag | undefined
  buildInstallation(selections: Record<string, FieldOption | undefined>): Record<string, unknown>
  getListPreview?(installation: InstallationRecord): string | null
  getLaunchCommand(installation: InstallationRecord): LaunchCommand | null
  getListActions?(installation: InstallationRecord): Record<string, unknown>[]
  getDetailSections(installation: InstallationRecord): Record<string, unknown>[]
  install?(installation: InstallationRecord, tools: InstallTools): Promise<void>
  postInstall?(installation: InstallationRecord, tools: PostInstallTools): Promise<void>
  probeInstallation(dirPath: string): Record<string, unknown> | null | Promise<Record<string, unknown> | null>
  handleAction(
    actionId: string,
    installation: InstallationRecord,
    actionData: Record<string, unknown> | undefined,
    tools: ActionTools
  ): Promise<ActionResult>
  getFieldOptions?(
    fieldId: string,
    selections: Record<string, FieldOption | undefined>,
    context: Record<string, unknown>
  ): Promise<FieldOption[]>
  /**
   * Source-specific post-processing for a freshly copied installation.
   * Invoked by `performCopy` after the wrapper tree is copied to
   * `destPath`. Implementations can:
   *
   * - Rewrite venv path metadata (pyvenv.cfg, script shebangs) so the
   *   new install boots cleanly from its new location.
   * - Pull in additional files that don't live under `inst.installPath`
   *   — e.g. an adopted install's legacy venv + workspace data, which
   *   sit under `inst.adoptedBaseDir`.
   *
   * `sendProgress`/`signal` are forwarded from `performCopy` so heavy
   * file copies can report progress under the same `copy` phase and
   * respect cancellation.
   */
  fixupCopy?(
    inst: InstallationRecord,
    destPath: string,
    sendProgress: (phase: string, detail: Record<string, unknown>) => void,
    signal?: AbortSignal,
  ): Promise<void>
}
