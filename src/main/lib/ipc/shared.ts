import path from 'path'
import fs from 'fs'
import os from 'os'
import { EventEmitter } from 'events'
import { app, ipcMain, dialog, shell, BrowserWindow, nativeTheme } from 'electron'
import { execFile, spawn, execFileSync } from 'child_process'
import type { ChildProcess } from 'child_process'
import sources from '../../sources/index'
import * as installations from '../../installations'
import type { InstallationRecord } from '../../installations'
import { formatComfyVersion } from '../version'
import type { ComfyVersion } from '../version'
import { resolveLocalVersion, clearVersionCache } from '../version-resolve'
import type { LatestTagOverride } from '../version-resolve'
import { readGitHead, readGitRemoteUrl, fetchTags, findLatestVersionTag, revParseRef, hasGitDir, isGitAvailable, tryConfigureBootstrapPygit2, tryConfigurePygit2Fallback } from '../git'
import { ensureRemoteUrl } from '../github-mirror'
import * as settings from '../../settings'
import { defaultInstallDir, sanitizeDirName, allocateUniqueDir } from '../paths'
import { download } from '../download'
import { createCache } from '../cache'
import { extractNested as extract } from '../extract'
import { deleteDir, formatDeleteStatus } from '../delete'
import { deleteAction, untrackAction } from '../actions'
import { _broadcastToRenderer } from './broadcast'
import { appendLog } from '../logsBroadcast'
import {
  spawnProcess, waitForPort, waitForUrl, killProcessTree, killByPort,
  findPidsByPort, getProcessInfo, looksLikeComfyUI, setPortArg,
  findAvailablePort, isPortListening, writePortLock, readPortLock, removePortLock,
  COMFY_BOOT_TIMEOUT_MS,
} from '../process'
import { detectGPU, validateHardware, checkNvidiaDriver } from '../gpu'
import { detectDesktopInstall, stageDesktopSnapshot } from '../desktopDetect'
import { performLocalMigration, stageLocalSnapshot } from '../localMigration'
import { getDiskSpace, getDirectorySize, validateInstallPath } from '../disk'
import { syncOemSeed } from '../oem'
import type { GpuInfo } from '../gpu'
import { formatTime } from '../util'
import { getActiveDownloads } from '../comfyDownloadManager'
import * as releaseCache from '../release-cache'
import * as i18n from '../i18n'
import { syncCustomModelFolders, discoverExtraModelFolders } from '../models'
import { copyDirWithProgress } from '../copy'
import { fetchJSON } from '../fetch'
import { fetchLatestRelease, getLatestStableTag } from '../comfyui-releases'
import { captureSnapshotIfChanged, getSnapshotCount, getSnapshotListData, getSnapshotDetailData, getSnapshotDiffVsPrevious, diffAgainstCurrent, loadSnapshot, listSnapshots, deleteSnapshot, diffSnapshots, buildExportEnvelope, validateExportEnvelope, importSnapshots, saveSnapshot, statesMatch, restoreCustomNodes, restorePipPackages, restoreComfyUIVersion, buildPostRestoreState, formatSnapshotVersion, resolveSnapshotVersion } from '../snapshots'
import type { SnapshotExportEnvelope, Snapshot } from '../snapshots'
import { getVariantLabel } from '../../sources/standalone'
import type { FieldOption, SourcePlugin } from '../../types/sources'
import { REQUIRES_STOPPED } from '../../../types/ipc'
import type { Theme, ResolvedTheme, QuitActiveItem } from '../../../types/ipc'
import { findLockingProcesses } from '../file-lock-info'
import type { LaunchCmd } from '../process'
import { getComfyArgsSchema, filterUnsupportedArgs } from '../comfy-args'
import type { ComfyArgDef } from '../comfy-args'
import { getComfyFeatureFlagRegistry } from '../comfy-feature-flags'
import type { FeatureFlagRegistry } from '../comfy-feature-flags'

// Re-export frequently used imports so handler modules can import from shared
export {
  path, fs, os, app, ipcMain, dialog, shell, BrowserWindow, nativeTheme,
  execFile, spawn, execFileSync,
  sources, installations, settings, releaseCache, i18n,
  formatComfyVersion, resolveLocalVersion, clearVersionCache,
  readGitRemoteUrl, fetchTags, findLatestVersionTag, revParseRef, hasGitDir, isGitAvailable, tryConfigureBootstrapPygit2, tryConfigurePygit2Fallback,
  ensureRemoteUrl,
  defaultInstallDir, sanitizeDirName, allocateUniqueDir, download, createCache, extract, deleteDir, formatDeleteStatus, deleteAction, untrackAction,
  spawnProcess, waitForPort, waitForUrl, killProcessTree, killByPort,
  findPidsByPort, getProcessInfo, looksLikeComfyUI, setPortArg,
  findAvailablePort, isPortListening, writePortLock, readPortLock, removePortLock,
  COMFY_BOOT_TIMEOUT_MS,
  detectGPU, validateHardware, checkNvidiaDriver,
  detectDesktopInstall, stageDesktopSnapshot,
  performLocalMigration, stageLocalSnapshot,
  getDiskSpace, getDirectorySize, validateInstallPath,
  syncOemSeed, formatTime, getActiveDownloads,
  syncCustomModelFolders, discoverExtraModelFolders,
  copyDirWithProgress, fetchJSON, fetchLatestRelease, getLatestStableTag,
  captureSnapshotIfChanged, getSnapshotCount, getSnapshotListData, getSnapshotDetailData,
  getSnapshotDiffVsPrevious, diffAgainstCurrent, loadSnapshot, listSnapshots, diffSnapshots,
  buildExportEnvelope, validateExportEnvelope, importSnapshots, saveSnapshot, statesMatch, deleteSnapshot,
  restoreCustomNodes, restorePipPackages, restoreComfyUIVersion, buildPostRestoreState, formatSnapshotVersion, resolveSnapshotVersion,
  getVariantLabel, REQUIRES_STOPPED, findLockingProcesses,
  getComfyArgsSchema, filterUnsupportedArgs,
  getComfyFeatureFlagRegistry,
}
export type {
  ChildProcess, InstallationRecord, ComfyVersion, LatestTagOverride,
  GpuInfo, SnapshotExportEnvelope, Snapshot, FieldOption, SourcePlugin,
  Theme, ResolvedTheme, QuitActiveItem, LaunchCmd, ComfyArgDef,
  FeatureFlagRegistry,
}

export { MSG_CANCELLED } from '../../../shared/operationStatus'

export const MARKER_FILE = '.comfyui-desktop-2'
export const COMFYUI_REPO = 'Comfy-Org/ComfyUI'
export const UPDATE_CHECK_INTERVAL = 10 * 60 * 1000
export const IGNORE_FILES = new Set([MARKER_FILE, '.DS_Store', 'Thumbs.db', 'desktop.ini'])
export const ALL_UPDATE_CHANNELS = ['stable', 'latest']
export const RESERVED_ENV_VARS = new Set(['PYTHONIOENCODING', '__COMFY_CLI_SESSION__', 'CM_USE_PYGIT2'])
export const SENSITIVE_ARG_RE = /^--(api[-_]?key|token|secret|password|auth)$/i

export interface SessionInfo {
  proc: ChildProcess | null
  port: number
  url?: string
  mode: string
  installationName: string
  startedAt: number
}

export interface LaunchCallbackInfo {
  port: number
  url?: string
  process: ChildProcess | null
  installation: InstallationRecord
  mode: string
}

export interface StopCallbackInfo {
  installationId?: string
}

export interface ExitCallbackInfo {
  installationId?: string
  /** True when the process exited unexpectedly (non-zero code or a signal),
   *  as opposed to a clean user-initiated stop. */
  crashed?: boolean
}

export interface RestartCallbackInfo {
  installationId?: string
  process?: ChildProcess
}

export type LaunchCallback = (info: LaunchCallbackInfo) => void
export type StopCallback = (info: StopCallbackInfo) => void
export type ExitCallback = (info: ExitCallbackInfo) => void
export type RestartCallback = (info: RestartCallbackInfo) => void
export type ModelFolderRelaunchCallback = (info: { installationId: string }) => void | Promise<void>
export type LocaleCallback = () => void
export type ThemeChangedCallback = () => void

export interface RegisterCallbacks {
  onLaunch?: LaunchCallback
  onStop?: StopCallback
  onComfyExited?: ExitCallback
  onComfyRestarted?: RestartCallback
  onModelFolderRelaunch?: ModelFolderRelaunchCallback
  onLocaleChanged?: LocaleCallback
  /** Fires when the resolved theme flips. Index repaints install-less host title bars +
   *  OS overlays; install-backed comfy windows track ComfyUI's own theme observer. */
  onThemeChanged?: ThemeChangedCallback
}

export type CopyReason = 'copy' | 'copy-update'

export const sourceMap: Record<string, SourcePlugin> = Object.fromEntries(sources.map((s) => [s.id, s]))

export let _onLaunch: LaunchCallback | null = null
export let _onStop: StopCallback | null = null
export let _onComfyExited: ExitCallback | null = null
export let _onComfyRestarted: RestartCallback | null = null
export let _onModelFolderRelaunch: ModelFolderRelaunchCallback | null = null
export let _onLocaleChanged: LocaleCallback | null = null
export let _onThemeChanged: ThemeChangedCallback | null = null
let _gpuPromise: Promise<GpuInfo | null> | null = null

export const _operationAborts = new Map<string, AbortController>()
export const _runningSessions = new Map<string, SessionInfo>()
export const _pendingPorts = new Map<number, string>()

/**
 * Installs mid-launch (between `instance-launching` and `instance-started` /
 * `instance-launch-failed`), keyed by id → name. Mirrors the renderer's
 * `sessionStore.launchingInstances` so the picker popup (which can't subscribe to
 * `instance-launching` itself) and freshly-opened windows hydrate from a snapshot.
 */
const _launchingInstances = new Map<string, { installationName: string }>()

/**
 * Internal bus emitted whenever the launching set or `_runningSessions` mutates, so the
 * picker popup repaints its "Current" pill / running-dot live during the launching window.
 */
export const sessionLifecycleEvents = new EventEmitter()

export function _getLaunchingInstallationIds(): string[] {
  return Array.from(_launchingInstances.keys())
}

/** Snapshot of launching installs (id + name), so a window opened mid-launch can
 *  hydrate `sessionStore.launchingInstances` instead of missing the live event. */
export function _getLaunchingInstances(): { installationId: string; installationName: string }[] {
  return Array.from(_launchingInstances.entries()).map(([installationId, { installationName }]) => ({
    installationId,
    installationName,
  }))
}

/** Mark `installationId` mid-launch and broadcast `instance-launching`. Idempotent. */
export function _markLaunching(installationId: string, installationName: string): void {
  const wasNew = !_launchingInstances.has(installationId)
  _launchingInstances.set(installationId, { installationName })
  _broadcastToRenderer('instance-launching', { installationId, installationName })
  if (wasNew) sessionLifecycleEvents.emit('changed')
}

/** Failure-path clear for `_markLaunching`; broadcasts `instance-launch-failed`. The success
 *  path clears inline in `_addSession`. */
export function _clearLaunchingFailed(installationId: string): void {
  const had = _launchingInstances.delete(installationId)
  _broadcastToRenderer('instance-launch-failed', { installationId })
  if (had) sessionLifecycleEvents.emit('changed')
}

/**
 * Installs currently being stopped (between `instance-stopping` and `instance-stopped`).
 * Lets a window opened mid-stop hydrate the "Stopping…" state instead of missing the
 * one-shot broadcast. Maintained by `stopRunning`; read via `_isStopping`. Exported
 * (like `_runningSessions`) so unit tests can seed body-mode scenarios.
 */
export const _stoppingInstallationIds = new Set<string>()

export function _getStoppingInstallationIds(): string[] {
  return Array.from(_stoppingInstallationIds)
}

/** O(1) membership test for the body-mode computation, which runs on every
 *  layout pass and shouldn't allocate an array. */
export function _isStopping(installationId: string): boolean {
  return _stoppingInstallationIds.has(installationId)
}

export interface PickerOperationStatus {
  /** Current phase label. Empty string while not yet started. */
  status: string
  /** 0–100, or -1 for indeterminate. */
  percent: number
  /** Download/transfer speed in bytes per second, if known. */
  speedBytesPerSec?: number | null
  /** True once the operation resolved (success, error, or cancel). */
  done: boolean
  /** null while in-flight; true/false after done. */
  ok: boolean | null
  /** Error message when done && !ok. */
  error: string | null
  /** Whether the operation can be cancelled. */
  cancellable: boolean
  /** Friendly title (e.g. "Update ComfyUI — My Install"). */
  title: string
  /** The action id — preserved so the picker can retry on error. */
  actionId: string
  actionData?: Record<string, unknown>
}

/** Per-install state for background picker ops, pushed into the picker snapshot so the
 *  renderer gets live progress without its own IPC listener. */
export const _activeOperationStatus = new Map<string, PickerOperationStatus>()

export function setCallbacks(callbacks: RegisterCallbacks): void {
  _onLaunch = callbacks.onLaunch ?? null
  _onStop = callbacks.onStop ?? null
  _onComfyExited = callbacks.onComfyExited ?? null
  _onComfyRestarted = callbacks.onComfyRestarted ?? null
  _onModelFolderRelaunch = callbacks.onModelFolderRelaunch ?? null
  _onLocaleChanged = callbacks.onLocaleChanged ?? null
  _onThemeChanged = callbacks.onThemeChanged ?? null
}

export function setGpuPromise(p: Promise<GpuInfo | null> | null): void {
  _gpuPromise = p
}

export function getGpuPromise(): Promise<GpuInfo | null> | null {
  return _gpuPromise
}

export async function syncOemSeedBestEffort(): Promise<void> {
  try {
    await syncOemSeed()
  } catch (err) {
    console.warn('OEM sync failed:', err)
  }
}

export function isEffectivelyEmptyInstallDir(dirPath: string): boolean {
  if (!dirPath) return true
  try {
    const entries = fs.readdirSync(dirPath)
    return entries.every((name) => IGNORE_FILES.has(name))
  } catch (e) {
    if (e && (e as NodeJS.ErrnoException).code === 'ENOENT') return true
    return false
  }
}

export function openPath(targetPath: string): Promise<string> {
  if (process.platform === 'linux') {
    return new Promise((resolve) => {
      execFile('dbus-send', [
        '--session', '--print-reply', '--type=method_call',
        '--dest=org.freedesktop.FileManager1',
        '/org/freedesktop/FileManager1',
        'org.freedesktop.FileManager1.ShowFolders',
        `array:string:file://${targetPath}`, 'string:',
      ], (err) => {
        if (!err) return resolve('')
        const child = spawn('xdg-open', [targetPath], { stdio: 'ignore', detached: true })
        child.unref()
        resolve('')
      })
    })
  }
  return shell.openPath(targetPath)
}

export function getAppVersion(): string {
  let version = app.getVersion()
  if (!app.isPackaged) {
    try {
      // Restrict to release tags so unrelated tags (e.g. `bootstrap-v1`) don't bleed in.
      version = execFileSync('git', ['describe', '--tags', '--always', '--match', 'v[0-9]*'], { cwd: __dirname, encoding: 'utf8' }).trim() || version
    } catch {}
  }
  return version.replace(/^v/, '')
}

export async function findDuplicatePath(installPath: string): Promise<InstallationRecord | null> {
  const normalized = path.resolve(installPath)
  return (await installations.list()).find((i) => i.installPath && path.resolve(i.installPath) === normalized) ?? null
}

export async function uniqueName(baseName: string): Promise<string> {
  const all = await installations.list()
  return installations.uniqueName(baseName, all)
}

export async function copyBrowserPartition(sourceId: string, destId: string, sourceBrowserPartition?: string): Promise<void> {
  if (sourceBrowserPartition !== 'unique') return
  const partitionsDir = path.join(app.getPath('userData'), 'Partitions')
  const srcPartition = path.join(partitionsDir, sourceId)
  const destPartition = path.join(partitionsDir, destId)
  try {
    if (fs.existsSync(srcPartition)) {
      await fs.promises.cp(srcPartition, destPartition, { recursive: true })
    }
  } catch (err) {
    console.warn('Failed to copy browser partition:', (err as Error).message)
  }
}

export async function performCopy(
  inst: InstallationRecord,
  name: string,
  sendProgress: (phase: string, detail: Record<string, unknown>) => void,
  signal?: AbortSignal,
  copyReason: CopyReason = 'copy'
): Promise<{ entry: InstallationRecord; destPath: string }> {
  const parentDir = path.dirname(inst.installPath)
  const dirName = sanitizeDirName(name)
  const destPath = allocateUniqueDir(parentDir, dirName)

  const duplicate = await findDuplicatePath(destPath)
  if (duplicate) {
    throw new Error(`That directory is already used by "${duplicate.name}".`)
  }

  try {
    sendProgress('copy', { percent: 0, status: i18n.t('actions.copyingFiles') })
    await copyDirWithProgress(inst.installPath, destPath, (copied, total, elapsedSecs, etaSecs) => {
      const percent = Math.round((copied / total) * 100)
      const elapsed = formatTime(elapsedSecs)
      const eta = etaSecs >= 0 ? formatTime(etaSecs) : '—'
      sendProgress('copy', {
        percent,
        status: `${i18n.t('actions.copyingFiles')}  ${copied} / ${total}  ·  ${elapsed} elapsed  ·  ${eta} remaining`,
      })
    }, { signal })

    const source = sourceMap[inst.sourceId]
    if (source?.fixupCopy) {
      await source.fixupCopy(inst, destPath, sendProgress, signal)
    }

    const adopted = inst.adopted === true && typeof inst.adoptedBaseDir === 'string'

    const {
      id: _id, name: _name, installPath: _path, createdAt: _created, seen: _seen, status: _status,
      copiedFrom: _copiedFrom, copiedAt: _copiedAt, copiedFromName: _copiedFromName, copyReason: _copyReason,
      ...inherited
    } = inst

    // Adopted copies are self-contained after `fixupCopy`. Re-home adopted-* fields to the
    // new install so adopted-aware code keeps working; drop the metadata-only "where did
    // this come from" fields since they describe the original adoption, not the copy.
    let recordData: Record<string, unknown> = {
      ...inherited,
      name: '',  // overwritten below
      installPath: destPath,
      status: 'installed',
      seen: false,
      browserPartition: 'unique',
      copiedFrom: inst.id,
      copiedFromName: inst.name,
      copiedAt: new Date().toISOString(),
      copyReason,
    }

    if (adopted) {
      const newComfyUI = path.join(destPath, 'ComfyUI')
      const newAdoptedPython = path.join(
        newComfyUI, '.venv',
        process.platform === 'win32' ? 'Scripts' : 'bin',
        process.platform === 'win32' ? 'python.exe' : 'python3',
      )
      const {
        adoptedFromLegacyVersion: _afv, adoptedFromGpu: _afg,
        adoptedSelectedDevice: _asd, adoptedComfyTagAtMigration: _act,
        adoptedSourceMode: _asm,
        inputDir: _idn, outputDir: _odn,
        ...adoptInherited
      } = recordData as Record<string, unknown>
      recordData = {
        ...adoptInherited,
        adopted: true,
        adoptedAt: new Date().toISOString(),
        adoptedBaseDir: newComfyUI,
        adoptedPythonPath: newAdoptedPython,
        // Point per-install I/O at the deep-copied data so launches don't write to the
        // legacy workspace.
        useSharedInputOutput: false,
        inputDir: path.join(newComfyUI, 'input'),
        outputDir: path.join(newComfyUI, 'output'),
      }
    }

    const finalName = await uniqueName(name)
    recordData.name = finalName
    const entry = await installations.add(recordData)

    try { fs.writeFileSync(path.join(destPath, MARKER_FILE), entry.id) } catch {}

    await copyBrowserPartition(inst.id, entry.id, inst.browserPartition as string | undefined)

    return { entry, destPath }
  } catch (err) {
    try { await fs.promises.rm(destPath, { recursive: true, force: true }) } catch {}
    throw err
  }
}

export function createSessionPath(): string {
  return path.join(os.tmpdir(), `comfyui-desktop-2-${Date.now()}`)
}

export function sanitizeEnvVars(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const result: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = String(k).trim()
    if (!key || typeof v !== 'string') continue
    if (RESERVED_ENV_VARS.has(key.toUpperCase())) continue
    result[key] = v
  }
  return result
}

export function buildLaunchEnv(inst: InstallationRecord, sessionPath?: string): Record<string, string | undefined> {
  const userEnvVars = sanitizeEnvVars(inst.envVars)
  return {
    ...process.env,
    ...userEnvVars,
    PYTHONIOENCODING: 'utf-8',
    ...(sessionPath ? { __COMFY_CLI_SESSION__: sessionPath } : {}),
    ...(inst.sourceId === 'standalone' ? { CM_USE_PYGIT2: '1' } : {}),
  }
}

export function checkRebootMarker(sessionPath: string): boolean {
  const marker = sessionPath + '.reboot'
  if (fs.existsSync(marker)) {
    try { fs.unlinkSync(marker) } catch {}
    return true
  }
  return false
}

export function _reservePort(port: number, installationName: string): void {
  _pendingPorts.set(port, installationName)
}

export function _releasePort(port: number): void {
  _pendingPorts.delete(port)
}

// Re-exported from ./broadcast so leaf modules can register without importing this file's
// whole IPC handler universe.
export { _registerExtraBroadcastTarget, _unregisterExtraBroadcastTarget, _broadcastToRenderer } from './broadcast'

export function _addSession(installationId: string, { proc, port, url, mode, installationName }: Omit<SessionInfo, 'startedAt'>, bootTimeMs?: number): void {
  _runningSessions.set(installationId, { proc, port, url, mode, installationName, startedAt: Date.now() })
  // Clear the launching marker first so subscribers never double-count this id across the
  // transition.
  _launchingInstances.delete(installationId)
  _broadcastToRenderer('instance-started', { installationId, port, url, mode, installationName, bootTimeMs })
  sessionLifecycleEvents.emit('changed')
  // Stamps lastLaunchedAt + per-category recency so those surfaces needn't scan every record.
  installations.markLaunched(installationId, (inst) => sourceMap[inst.sourceId]?.category)
    .then(() => _broadcastToRenderer('installations-changed', {}))
    .catch((err) => {
      console.error('Failed to mark installation launched:', err)
    })
}

export function _removeSession(installationId: string): void {
  const session = _runningSessions.get(installationId)
  if (!session) return
  if (session.port) removePortLock(session.port)
  _runningSessions.delete(installationId)
  _broadcastToRenderer('instance-stopped', { installationId })
  sessionLifecycleEvents.emit('changed')
}

export function _getPublicSessions(): Record<string, unknown>[] {
  return Array.from(_runningSessions.entries()).map(([id, s]) => ({
    installationId: id,
    port: s.port,
    url: s.url,
    mode: s.mode,
    installationName: s.installationName,
    startedAt: s.startedAt,
  }))
}

export async function _fetchAndResolveLatestTags(
  installs: Array<{ comfyuiDir: string }>
): Promise<Map<string, LatestTagOverride>> {
  const mirrorEnabled = settings.get('useChineseMirrors') === true
  await Promise.all(installs.map(({ comfyuiDir }) => ensureRemoteUrl(comfyuiDir, mirrorEnabled)))

  const originGroups = new Map<string, string[]>()
  for (const { comfyuiDir } of installs) {
    const origin = readGitRemoteUrl(comfyuiDir)
    if (!origin) continue
    const group = originGroups.get(origin) ?? []
    group.push(comfyuiDir)
    originGroups.set(origin, group)
  }

  const result = new Map<string, LatestTagOverride>()
  await Promise.all([...originGroups.entries()].map(async ([origin, dirs]) => {
    await Promise.all(dirs.map((d) => fetchTags(d)))
    const representative = dirs[0]!
    const tagName = await findLatestVersionTag(representative)
    if (!tagName) return
    const sha = await revParseRef(representative, tagName)
    if (!sha) return
    result.set(origin, { name: tagName, sha })
  }))
  return result
}

// Single-flight + TTL guard for the background resolver invoked from `get-installations`, so
// repeated UI fetches don't churn the bundled Python interpreter with pygit2 bursts.
let _resolveVersionsInFlight: Promise<void> | null = null
let _lastResolveVersionsAt = 0
const RESOLVE_VERSIONS_TTL_MS = 10 * 60 * 1000

export function scheduleResolveAndBroadcastVersions(list: InstallationRecord[]): void {
  if (_resolveVersionsInFlight) return
  if (Date.now() - _lastResolveVersionsAt < RESOLVE_VERSIONS_TTL_MS) return
  _lastResolveVersionsAt = Date.now()
  _resolveVersionsInFlight = _resolveAndBroadcastVersions(list).catch(() => {}).finally(() => {
    _resolveVersionsInFlight = null
  })
}

export async function _resolveAndBroadcastVersions(list: InstallationRecord[]): Promise<void> {
  const candidates = list.flatMap((inst) => {
    const cv = inst.comfyVersion as ComfyVersion | undefined
    if (!cv?.commit || !inst.installPath) return []
    const comfyuiDir = path.join(inst.installPath, 'ComfyUI')
    if (!hasGitDir(comfyuiDir)) return []
    return [{ inst, cv, comfyuiDir }]
  })
  if (candidates.length === 0) return

  const tagOverrides = await _fetchAndResolveLatestTags(candidates)
  clearVersionCache()

  const updates: { id: string; version: string }[] = []
  await Promise.all(candidates.map(async ({ inst, cv, comfyuiDir }) => {
    const origin = readGitRemoteUrl(comfyuiDir)
    const override = origin ? tagOverrides.get(origin) : undefined
    try {
      // Read actual HEAD; it may differ from cv.commit after external changes (manual pull, checkout).
      const actualHead = readGitHead(comfyuiDir) || cv.commit

      const resolved = await resolveLocalVersion(comfyuiDir, actualHead, undefined, override)

      // Downgrade ratchet: tag-resolution can transiently fail and return a bare `{ commit }`.
      // Persisting it would clobber a populated `{ commit, baseTag, commitsAhead }` for the
      // same commit, so bail; a genuinely-new commit still writes through.
      if (cv?.baseTag && !resolved.baseTag && resolved.commit === cv.commit) {
        return
      }
      const resolvedStr = formatComfyVersion(resolved, 'short')
      const storedStr = formatComfyVersion(cv, 'short')
      const versionChanged = resolvedStr !== storedStr

      const existing = inst.updateInfoByChannel as Record<string, Record<string, unknown>> | undefined
      let reconciledChannels: Record<string, Record<string, unknown>> | undefined
      if (existing) {
        let changed = false
        const reconciled: Record<string, Record<string, unknown>> = {}
        for (const [ch, info] of Object.entries(existing)) {
          if (info?.installedTag && info.installedTag !== resolvedStr) {
            reconciled[ch] = { ...info, installedTag: resolvedStr }
            changed = true
          } else {
            reconciled[ch] = info
          }
        }
        if (changed) reconciledChannels = reconciled
      }

      if (versionChanged || reconciledChannels) {
        const patch: Record<string, unknown> = {}
        if (versionChanged) patch.comfyVersion = resolved
        if (reconciledChannels) patch.updateInfoByChannel = reconciledChannels
        await installations.update(inst.id, patch)
        updates.push({ id: inst.id, version: resolvedStr })
      }
    } catch {
      // ignore — keep stored version
    }
  }))
  if (updates.length > 0) {
    _broadcastToRenderer('installations-versions-updated', { updates })
  }
}

export async function migrateDefaults(): Promise<void> {
  const all = await installations.list()
  let changed = false
  for (const inst of all) {
    const source = sourceMap[inst.sourceId]
    if (!source || !source.getDefaults) continue
    const defaults = source.getDefaults()
    for (const [key, value] of Object.entries(defaults)) {
      if (!(key in inst)) {
        inst[key] = value
        changed = true
      }
    }
    if (inst.updateInfoByChannel) {
      const repo = 'Comfy-Org/ComfyUI'
      const channelMap = inst.updateInfoByChannel as Record<string, Record<string, unknown>>
      for (const [channel, info] of Object.entries(channelMap)) {
        if (info.latestTag && !releaseCache.get(repo, channel)) {
          const { installedTag: _it, available: _av, ...releaseFields } = info
          releaseCache.set(repo, channel, releaseFields)
        }
        if (info.latestTag || info.releaseName || info.releaseNotes) {
          channelMap[channel] = { installedTag: info.installedTag }
          changed = true
        }
      }
    }
  }
  if (changed) {
    for (const inst of all) await installations.update(inst.id, inst)
  }
}

const VALID_THEMES: readonly string[] = ['system', 'dark', 'light'] satisfies readonly Theme[]

export function resolveTheme(): ResolvedTheme {
  const raw = settings.get('theme') as string | undefined
  const theme: Theme = raw && VALID_THEMES.includes(raw) ? (raw as Theme) : 'system'
  return theme === 'system' ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light') : theme
}

// Single-flight: overlapping calls (boot, periodic timer, manual refresh) share one run
// rather than firing parallel git/pygit2 bursts.
let _checkInstallationUpdatesInFlight: Promise<void> | null = null

export function checkInstallationUpdates(): Promise<void> {
  if (_checkInstallationUpdatesInFlight) return _checkInstallationUpdatesInFlight
  _checkInstallationUpdatesInFlight = (async (): Promise<void> => {
    try {
      await Promise.allSettled(
        ALL_UPDATE_CHANNELS.map((channel) =>
          releaseCache.getOrFetch(COMFYUI_REPO, channel, async () => {
            const release = await fetchLatestRelease(channel)
            if (!release) return null
            return releaseCache.buildCacheEntry(release)
          }, true)
        )
      )
      await _enrichLatestCommitsAhead()
      _broadcastToRenderer('installations-changed', {})
    } catch {}
  })().finally(() => {
    _checkInstallationUpdatesInFlight = null
  })
  return _checkInstallationUpdatesInFlight
}

async function _enrichLatestCommitsAhead(): Promise<void> {
  const all = await installations.list()
  for (const inst of all) {
    if (!inst.installPath) continue
    const comfyuiDir = path.join(inst.installPath, 'ComfyUI')
    if (!hasGitDir(comfyuiDir)) continue
    await releaseCache.enrichCommitsAhead(COMFYUI_REPO, comfyuiDir)
    if (releaseCache.get(COMFYUI_REPO, 'latest')?.commitsAhead !== undefined) return
  }
}

/** Helper to create a sendProgress callback from an IPC event sender */
export function makeSendProgress(sender: Electron.WebContents, installationId: string): (phase: string, detail: Record<string, unknown>) => void {
  return (phase: string, detail: Record<string, unknown>): void => {
    if (!sender.isDestroyed()) {
      sender.send('install-progress', { installationId, phase, ...detail })
    }
  }
}

/** Helper to create a sendOutput callback from an IPC event sender */
export function makeSendOutput(sender: Electron.WebContents, installationId: string): (text: string) => void {
  return (text: string): void => {
    try { if (!sender.isDestroyed()) sender.send('comfy-output', { installationId, text }) } catch {}
    appendLog(installationId, text)
  }
}

/**
 * Stop running session(s) and kill their process tree(s).
 *
 * @param onEnterStopping Fires once an install is flagged stopping, before the
 *   slow `killProcessTree` await. The interactive `stop-comfyui` handler uses it
 *   to show the "Stopping…" panel up front (avoiding a black flash mid-kill);
 *   quit/detach/update callers omit it so the primitive stays free of host-
 *   layout side effects.
 */
export async function stopRunning(
  installationId?: string,
  onEnterStopping?: (info: { installationId: string }) => void,
): Promise<void> {
  if (installationId) {
    const session = _runningSessions.get(installationId)
    if (!session) return
    _stoppingInstallationIds.add(installationId)
    _broadcastToRenderer('instance-stopping', { installationId })
    onEnterStopping?.({ installationId })
    if (session.port) removePortLock(session.port)
    _runningSessions.delete(installationId)
    if (session.proc && !session.proc.killed) {
      await killProcessTree(session.proc)
    }
    _stoppingInstallationIds.delete(installationId)
    _broadcastToRenderer('instance-stopped', { installationId })
    sessionLifecycleEvents.emit('changed')
  } else {
    const sessions = [..._runningSessions.entries()]
    for (const [id] of sessions) {
      _stoppingInstallationIds.add(id)
      _broadcastToRenderer('instance-stopping', { installationId: id })
      onEnterStopping?.({ installationId: id })
    }
    for (const [, session] of sessions) {
      if (session.port) removePortLock(session.port)
    }
    _runningSessions.clear()
    const kills: Promise<void>[] = []
    for (const [, session] of sessions) {
      if (session.proc && !session.proc.killed) {
        kills.push(killProcessTree(session.proc))
      }
    }
    await Promise.all(kills)
    for (const [id] of sessions) {
      _stoppingInstallationIds.delete(id)
      _broadcastToRenderer('instance-stopped', { installationId: id })
    }
    if (sessions.length > 0) sessionLifecycleEvents.emit('changed')
  }
}

export function hasRunningSessions(): boolean {
  return _runningSessions.size > 0
}

export function getSessionProcess(installationId: string): ChildProcess | null {
  return _runningSessions.get(installationId)?.proc ?? null
}

export function hasActiveOperations(): boolean {
  return _runningSessions.size > 0 || _operationAborts.size > 0 || getActiveDownloads().length > 0
}

export async function getActiveDetails(): Promise<QuitActiveItem[]> {
  const items: QuitActiveItem[] = []
  for (const [, session] of _runningSessions) {
    items.push({ name: session.installationName, type: 'session' })
  }
  const operationIds = [..._operationAborts.keys()].filter((id) => !_runningSessions.has(id))
  if (operationIds.length > 0) {
    const all = await installations.list()
    const byId = new Map(all.map((inst) => [inst.id, inst]))
    for (const id of operationIds) {
      items.push({ name: byId.get(id)?.name || id, type: 'operation' })
    }
  }
  for (const dl of getActiveDownloads()) {
    items.push({ name: dl.filename, type: 'download' })
  }
  return items
}

/** Test-only: register a synthetic running session without spawning ComfyUI. Mirrors
 *  `_addSession`'s side effects so the REQUIRES_STOPPED guard fires; `stopRunning` handles
 *  the null `proc`. Called only via `__e2e.seedRunningSession`. */
export function _test_addRunningSession(
  installationId: string,
  installationName: string,
): void {
  _runningSessions.set(installationId, {
    proc: null,
    port: 0,
    url: undefined,
    mode: 'window',
    installationName,
    startedAt: Date.now(),
  })
  _broadcastToRenderer('instance-started', {
    installationId,
    port: 0,
    url: undefined,
    mode: 'window',
    installationName,
  })
}

/** Test-only: drop every synthetic session, broadcasting `instance-stopped` per entry. */
export function _test_clearRunningSessions(): void {
  const ids = Array.from(_runningSessions.keys())
  _runningSessions.clear()
  for (const id of ids) {
    _broadcastToRenderer('instance-stopped', { installationId: id })
  }
}

export function cancelAll(): void {
  for (const [_id, abort] of _operationAborts) {
    abort.abort()
  }
  _operationAborts.clear()
  stopRunning()
}
