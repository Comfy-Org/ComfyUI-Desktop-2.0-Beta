import { app, BrowserWindow, dialog } from 'electron'
import { EventEmitter } from 'events'
import fs from 'fs'
import path from 'path'
import * as settings from '../settings'
import { _broadcastToRenderer } from './ipc/shared'

export const ALLOWED_EXTENSIONS = ['.safetensors', '.sft', '.ckpt', '.pth', '.pt']

export interface DownloadProgress {
  url: string
  filename: string
  directory?: string
  savePath?: string
  progress: number
  receivedBytes?: number
  totalBytes?: number
  speedBytesPerSec?: number
  etaSeconds?: number
  status: 'pending' | 'downloading' | 'paused' | 'completed' | 'error' | 'cancelled'
  error?: string
  /** Wall-clock ms of the first time we saw this URL — stamped by
   *  `reportProgress` and preserved across status transitions so the
   *  renderer can render a single insertion-ordered list (active +
   *  terminal entries stay in their original slot rather than terminal
   *  ones jumping to the bottom of a separate "recent" bucket). */
  createdAt?: number
}

interface PendingDownload {
  url: string
  filename: string
  directory: string
  savePath: string
  tempPath?: string
  outputDir?: string
  window: BrowserWindow
  /** The webContents that initiated the download (may differ from window.webContents for WebContentsView). */
  senderContents?: Electron.WebContents
  subscriberWindows: Set<BrowserWindow>
  item?: Electron.DownloadItem
  lastProgress: DownloadProgress
  lastSpeedBytes: number
  lastSpeedTime: number
}

const attachedSessions = new WeakSet<Electron.Session>()
const pendingDownloads = new Map<string, PendingDownload>()
let mainWindow: BrowserWindow | null = null

/** Original dispatch params per URL, captured at start time so a
 *  terminal (error) entry can be re-dispatched via `retryDownload`.
 *  Kept off the broadcast `DownloadProgress` because asset downloads
 *  carry an `authToken` that must never reach the renderer. Evicted
 *  alongside `createdAtByUrl` (FIFO cap / dismiss / clear-finished). */
interface RetryParams {
  kind: 'model' | 'asset'
  filename: string
  window: BrowserWindow
  senderContents?: Electron.WebContents
  directory?: string
  outputDir?: string
  authToken?: string
}
const retryParamsByUrl = new Map<string, RetryParams>()

/**
 * Recent terminal downloads kept in main so a title-bar tray mounted
 * AFTER a download finished can still surface it. Capped at
 * `RECENT_LIMIT`; oldest entries are evicted FIFO. Re-pushed on every
 * tray state broadcast and on the `onTitleBarReady` initial-state push.
 */
const RECENT_LIMIT = 10
const recentDownloads: DownloadProgress[] = []

/** Main-process event bus for the title-bar downloads tray.
 *  Emits `'tray-state-changed'` whenever a progress event is broadcast
 *  (so subscribers can pull a fresh `getDownloadsTrayState()` snapshot
 *  without each consumer reimplementing the same projection). The
 *  listener cap is bumped because every comfy window subscribes once. */
export const downloadEvents = new EventEmitter()
downloadEvents.setMaxListeners(50)

/** Snapshot of the downloads tray state. `active` is every
 *  in-flight (`pending` / `downloading` / `paused`) entry; `recent` is
 *  the last `RECENT_LIMIT` terminal entries (oldest first). Mirror of
 *  the payload pushed on `comfy-titlebar:downloads-changed`. */
export interface DownloadsTrayState {
  active: DownloadProgress[]
  recent: DownloadProgress[]
}

function isTerminalStatus(status: DownloadProgress['status']): boolean {
  return status === 'completed' || status === 'error' || status === 'cancelled'
}

function pushRecent(progress: DownloadProgress): void {
  // Replace any prior entry for the same URL so a download that
  // transitions completed → re-attempted → completed appears once.
  const idx = recentDownloads.findIndex((d) => d.url === progress.url)
  if (idx >= 0) recentDownloads.splice(idx, 1)
  recentDownloads.push({ ...progress })
  // FIFO eviction past the cap — also drop the createdAt stamp so the
  // map doesn't grow unbounded; a re-download of the same URL after
  // eviction gets a fresh slot at the end of the list, which is the
  // user's expectation.
  while (recentDownloads.length > RECENT_LIMIT) {
    const evicted = recentDownloads.shift()
    if (evicted) {
      createdAtByUrl.delete(evicted.url)
      retryParamsByUrl.delete(evicted.url)
    }
  }
}

export function getDownloadsTrayState(): DownloadsTrayState {
  const active: DownloadProgress[] = []
  for (const pending of pendingDownloads.values()) {
    const s = pending.lastProgress.status
    if (s === 'pending' || s === 'downloading' || s === 'paused') {
      active.push(pending.lastProgress)
    }
  }
  return { active, recent: recentDownloads.slice() }
}

export function setMainWindow(win: BrowserWindow | null): void {
  mainWindow = win
}

function getModelsBaseDir(): string {
  const modelsDirs = settings.get('modelsDirs') as string[] | undefined
  return modelsDirs?.[0] || settings.defaults.modelsDirs[0]!
}

const TEMP_DIR_NAME = '.desktop2-downloads'

function getTempDir(): string {
  return path.join(getModelsBaseDir(), TEMP_DIR_NAME)
}

function getAssetTempDir(): string {
  const outputDir = (settings.get('outputDir') as string | undefined) || settings.defaults.outputDir
  return path.join(path.dirname(outputDir), TEMP_DIR_NAME)
}

// Windows MAX_PATH is 260 chars (259 usable + null terminator).
// Reserve space for deduplication suffix " (999)" = 6 chars.
const WIN_MAX_PATH = 259
const DEDUP_RESERVE = 6

/**
 * Sanitize an asset filename to prevent path traversal and ensure it fits
 * within filesystem limits.  Returns null if the filename is invalid.
 */
export function sanitizeAssetFilename(filename: string, outputDir: string): string | null {
  if (!filename || filename.trim() === '') return null

  // Normalise separators and collapse sequences
  let safe = filename.replace(/\\/g, '/')

  // Strip path traversal components
  safe = safe.split('/').filter((seg) => seg !== '..' && seg !== '.').join('/')

  // Remove leading slashes (absolute path attempt)
  safe = safe.replace(/^\/+/, '')

  if (safe === '') return null

  // Verify the resolved path stays inside outputDir
  const resolved = path.resolve(outputDir, safe)
  const resolvedBase = path.resolve(outputDir)
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) {
    return null
  }

  // On Windows, truncate filename stem if the full path exceeds MAX_PATH.
  if (process.platform === 'win32') {
    const fullLen = resolved.length
    if (fullLen + DEDUP_RESERVE > WIN_MAX_PATH) {
      const ext = path.extname(safe)
      const dir = path.dirname(safe)
      const stem = path.basename(safe, ext)
      const dirPart = path.resolve(outputDir, dir)
      const available = WIN_MAX_PATH - dirPart.length - 1 - ext.length - DEDUP_RESERVE
      if (available <= 0) return null
      const truncatedStem = stem.substring(0, available)
      safe = dir && dir !== '.' ? dir + '/' + truncatedStem + ext : truncatedStem + ext
    }
  }

  return safe
}

export function isPathContained(filePath: string, baseDir: string): boolean {
  const resolved = path.resolve(filePath)
  const resolvedBase = path.resolve(baseDir)
  return resolved.startsWith(resolvedBase + path.sep)
}

export function hasValidExtension(filename: string): boolean {
  const lower = filename.toLowerCase()
  return ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

export function stripQueryParams(rawFilename: string): string {
  const qIdx = rawFilename.indexOf('?')
  return qIdx >= 0 ? rawFilename.substring(0, qIdx) : rawFilename
}

function broadcastProgress(progress: DownloadProgress): void {
  // Send to the originating ComfyUI window and any subscribers
  const pending = pendingDownloads.get(progress.url)
  if (pending) {
    pending.lastProgress = progress
    const target = pending.senderContents || pending.window.webContents
    if (!target.isDestroyed()) {
      target.send('desktop2-download-progress', progress)
    }
    for (const sub of pending.subscriberWindows) {
      if (!sub.isDestroyed()) {
        sub.webContents.send('desktop2-download-progress', progress)
      } else {
        pending.subscriberWindows.delete(sub)
      }
    }
  }
  // Fan out to every renderer (host title-bars, panel views, popup
  // views, …) so the Settings → Downloads tab and popup downloads
  // store both receive live progress events.
  _broadcastToRenderer('model-download-progress', progress)
  // Title-bar downloads tray state. Terminal entries land in the
  // recent buffer first so the snapshot the listener pulls already
  // reflects the new state. The listener (registered in
  // src/main/index.ts) fans out to every comfy window's title-bar
  // webContents.
  if (isTerminalStatus(progress.status)) {
    pushRecent(progress)
  }
  downloadEvents.emit('tray-state-changed')
}

function setTaskbarProgress(win: BrowserWindow, progress: DownloadProgress): void {
  if (win.isDestroyed()) return
  if (progress.status === 'downloading') {
    win.setProgressBar(progress.progress)
  } else if (
    progress.status === 'completed' ||
    progress.status === 'error' ||
    progress.status === 'cancelled'
  ) {
    win.setProgressBar(-1)
  }
}

/** First-seen timestamp per URL — preserved across status transitions
 *  and across the `pendingDownloads → recentDownloads` migration that
 *  happens on terminal status. Cleared when the URL is fully evicted
 *  from `recentDownloads`. */
const createdAtByUrl = new Map<string, number>()

function reportProgress(progress: DownloadProgress): void {
  // Stamp insertion timestamp once per URL so terminal entries keep
  // their slot in the renderer's combined view rather than getting
  // appended to the bottom of a separate "recent" bucket.
  let createdAt = createdAtByUrl.get(progress.url)
  if (createdAt === undefined) {
    createdAt = Date.now()
    createdAtByUrl.set(progress.url, createdAt)
  }
  progress.createdAt = createdAt
  broadcastProgress(progress)
  const pending = pendingDownloads.get(progress.url)
  if (pending) setTaskbarProgress(pending.window, progress)
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath)
    return true
  } catch {
    return false
  }
}

export function parseContentDispositionFilename(header: string | null): string | null {
  if (!header) return null
  // Try filename*= (RFC 5987 encoded)
  const starMatch = header.match(/filename\*\s*=\s*(?:UTF-8''|utf-8'')([^;\s]+)/i)
  if (starMatch?.[1]) {
    try { return decodeURIComponent(starMatch[1]) } catch {}
  }
  // Try filename="..." or filename=...
  const match = header.match(/filename\s*=\s*"([^"]+)"/i) || header.match(/filename\s*=\s*([^;\s]+)/i)
  return match?.[1] ?? null
}

function resolveServerFilename(item: Electron.DownloadItem): string | null {
  // 1. Try Content-Disposition header from the response
  const cd = item.getContentDisposition()
  const cdName = parseContentDispositionFilename(cd)
  if (cdName) return cdName

  // 2. Try response-content-disposition query param from the URL chain (GCS pre-signed URLs)
  for (const u of item.getURLChain()) {
    try {
      const rcd = new URL(u).searchParams.get('response-content-disposition')
      const rcdName = parseContentDispositionFilename(rcd)
      if (rcdName) return rcdName
    } catch {}
  }

  return null
}

function findPendingForItem(item: Electron.DownloadItem): PendingDownload | undefined {
  const candidates = [...item.getURLChain(), item.getURL()].filter(Boolean)
  for (const u of candidates) {
    const pending = pendingDownloads.get(u)
    // Only match entries waiting for their DownloadItem (managed model downloads).
    // Entries that already have an item are active general downloads — don't hijack them.
    if (pending && !pending.item) return pending
  }
  return undefined
}

export async function startModelDownload(
  win: BrowserWindow,
  url: string,
  rawFilename: string,
  directory: string,
  senderContents?: Electron.WebContents,
): Promise<boolean> {
  const filename = stripQueryParams(rawFilename)
  const baseDir = getModelsBaseDir()
  const savePath = path.join(baseDir, directory, filename)
  const tempDir = getTempDir()
  const tempPath = path.join(tempDir, `${Date.now()}-${filename}.tmp`)

  // Capture before the validation early-returns so even a synchronous
  // error (bad path / extension) lands a retryable terminal entry.
  retryParamsByUrl.set(url, { kind: 'model', filename, directory, window: win, senderContents })

  const makeProgress = (
    overrides: Partial<DownloadProgress>,
  ): DownloadProgress => ({
    url,
    filename,
    directory,
    progress: 0,
    status: 'pending',
    ...overrides,
  })

  if (!isPathContained(savePath, baseDir)) {
    reportProgress(makeProgress({ status: 'error', error: 'Save path is outside models directory' }))
    return false
  }

  if (!hasValidExtension(filename)) {
    reportProgress(makeProgress({
      status: 'error',
      error: `Invalid file type. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`,
    }))
    return false
  }

  if (await fileExists(savePath)) {
    // File already exists — report completed without starting a download
    const progress = makeProgress({ progress: 1, status: 'completed', savePath })
    broadcastProgress(progress)
    return true
  }

  const existing = pendingDownloads.get(url)
  if (existing) {
    if (win !== existing.window) {
      existing.subscriberWindows.add(win)
    }
    if (!win.isDestroyed()) {
      win.webContents.send('desktop2-download-progress', existing.lastProgress)
    }
    return true
  }

  await fs.promises.mkdir(path.dirname(savePath), { recursive: true })
  await fs.promises.mkdir(tempDir, { recursive: true })

  if (win.isDestroyed()) return false

  const initial = makeProgress({ status: 'pending' })
  pendingDownloads.set(url, {
    url,
    filename,
    directory,
    savePath,
    tempPath,
    window: win,
    senderContents: senderContents !== win.webContents ? senderContents : undefined,
    subscriberWindows: new Set(),
    lastProgress: initial,
    lastSpeedBytes: 0,
    lastSpeedTime: Date.now(),
  })

  const sess = (senderContents || win.webContents).session
  attachSessionDownloadHandler(sess)
  sess.downloadURL(url)

  reportProgress(initial)
  return true
}

export async function startAssetDownload(
  win: BrowserWindow,
  url: string,
  filename: string,
  outputDir: string,
  authToken?: string,
  senderContents?: Electron.WebContents,
): Promise<boolean> {
  const safeFilename = sanitizeAssetFilename(filename, outputDir)
  if (!safeFilename) return false
  const savePath = await deduplicatePath(path.join(outputDir, safeFilename))
  const savedFilename = path.basename(savePath)
  // Temp dir is a sibling of the output dir — same filesystem for atomic rename,
  // but outside the output dir so ComfyUI won't scan it.
  const tempDir = path.join(path.dirname(outputDir), TEMP_DIR_NAME)
  const tempPath = path.join(tempDir, `${Date.now()}-${savedFilename}.tmp`)

  retryParamsByUrl.set(url, {
    kind: 'asset',
    filename: savedFilename,
    outputDir,
    authToken,
    window: win,
    senderContents,
  })

  const makeProgress = (
    overrides: Partial<DownloadProgress>,
  ): DownloadProgress => ({
    url,
    filename: savedFilename,
    directory: '',
    progress: 0,
    status: 'pending',
    ...overrides,
  })

  const existing = pendingDownloads.get(url)
  if (existing) {
    if (win !== existing.window) {
      existing.subscriberWindows.add(win)
    }
    if (!win.isDestroyed()) {
      win.webContents.send('desktop2-download-progress', existing.lastProgress)
    }
    return true
  }

  await fs.promises.mkdir(path.dirname(savePath), { recursive: true })
  await fs.promises.mkdir(tempDir, { recursive: true })

  if (win.isDestroyed()) return false

  const initial = makeProgress({ status: 'pending' })
  pendingDownloads.set(url, {
    url,
    filename: savedFilename,
    directory: '',
    savePath,
    tempPath,
    outputDir,
    window: win,
    senderContents: senderContents !== win.webContents ? senderContents : undefined,
    subscriberWindows: new Set(),
    lastProgress: initial,
    lastSpeedBytes: 0,
    lastSpeedTime: Date.now(),
  })

  const sess = (senderContents || win.webContents).session
  attachSessionDownloadHandler(sess)
  // Pass auth headers directly — Electron follows redirects internally and
  // the original URL stays in item.getURLChain(), so findPendingForItem matches.
  const downloadOptions = authToken
    ? { headers: { Authorization: `Bearer ${authToken}` } }
    : undefined
  sess.downloadURL(url, downloadOptions)

  reportProgress(initial)
  return true
}

async function deduplicatePath(filePath: string): Promise<string> {
  if (!(await fileExists(filePath))) return filePath
  const dir = path.dirname(filePath)
  const ext = path.extname(filePath)
  const base = path.basename(filePath, ext)
  let i = 1
  let candidate: string
  do {
    candidate = path.join(dir, `${base} (${i})${ext}`)
    i++
  } while (await fileExists(candidate))
  return candidate
}

function attachDownloadListeners(item: Electron.DownloadItem, pending: PendingDownload): void {
  item.on('updated', (_ev, state) => {
    if (state !== 'progressing') return
    const total = item.getTotalBytes()
    const received = item.getReceivedBytes()
    const progress = total > 0 ? received / total : 0

    const now = Date.now()
    const elapsed = (now - pending.lastSpeedTime) / 1000
    let speed: number | undefined
    let eta: number | undefined
    if (elapsed >= 0.5) {
      const delta = received - pending.lastSpeedBytes
      speed = delta / elapsed
      pending.lastSpeedBytes = received
      pending.lastSpeedTime = now
      if (speed > 0 && total > 0) {
        eta = (total - received) / speed
      }
    } else {
      speed = pending.lastProgress.speedBytesPerSec
      eta = pending.lastProgress.etaSeconds
    }

    reportProgress({
      url: pending.url,
      filename: pending.filename,
      directory: pending.directory,
      progress,
      receivedBytes: received,
      totalBytes: total,
      speedBytesPerSec: speed,
      etaSeconds: eta,
      status: item.isPaused() ? 'paused' : 'downloading',
    })
  })

  item.once('done', (_ev, state) => {
    if (state === 'completed') {
      // Model downloads use a temp file that needs to be moved to the final path
      if (pending.tempPath) {
        try {
          fs.renameSync(pending.tempPath, pending.savePath)
        } catch {
          try { fs.unlinkSync(pending.tempPath) } catch {}
          if (!fs.existsSync(pending.savePath)) {
            reportProgress({
              url: pending.url,
              filename: pending.filename,
              directory: pending.directory,
              progress: 0,
              status: 'error',
              error: 'Failed to move downloaded file to final location',
            })
            pendingDownloads.delete(pending.url)
            return
          }
        }
        // Try to remove the temp directory if it's now empty (safe — fails silently if not empty)
        try { fs.rmdirSync(path.dirname(pending.tempPath)) } catch {}
      }
      reportProgress({
        url: pending.url,
        filename: pending.filename,
        directory: pending.directory,
        savePath: pending.savePath,
        progress: 1,
        status: 'completed',
      })
    } else if (state === 'cancelled') {
      if (pending.tempPath) {
        try { fs.unlinkSync(pending.tempPath) } catch {}
        try { fs.rmdirSync(path.dirname(pending.tempPath)) } catch {}
      }
      reportProgress({
        url: pending.url,
        filename: pending.filename,
        directory: pending.directory,
        progress: 0,
        status: 'cancelled',
      })
    } else {
      if (pending.tempPath) {
        try { fs.unlinkSync(pending.tempPath) } catch {}
        try { fs.rmdirSync(path.dirname(pending.tempPath)) } catch {}
      }
      reportProgress({
        url: pending.url,
        filename: pending.filename,
        directory: pending.directory,
        progress: 0,
        status: 'error',
        error: `Download failed: ${state}`,
      })
    }
    pendingDownloads.delete(pending.url)
  })
}

export function attachSessionDownloadHandler(sess: Electron.Session): void {
  if (attachedSessions.has(sess)) return
  attachedSessions.add(sess)

  sess.on('will-download', (_event, item, webContents) => {
    const pending = findPendingForItem(item)

    if (pending) {
      // Managed download — auto-save to the resolved path
      pending.item = item

      // For asset downloads, try to resolve a better filename from the server
      // response (Content-Disposition or GCS response-content-disposition param).
      // Cloud uses content hashes as filenames in the WebSocket message, so the
      // real human-readable name is only available from the HTTP response.
      if (pending.tempPath && pending.outputDir) {
        const serverName = resolveServerFilename(item)
        if (serverName) {
          // Use the output dir root (not the subfolder from the original path)
          // so the server name is placed directly in the output directory.
          const baseDir = pending.outputDir
          const safeServer = sanitizeAssetFilename(serverName, baseDir)
          if (safeServer) {
            const newSavePath = path.join(baseDir, safeServer)
            // Only update if it differs (avoid overwriting display_name with same value)
            if (newSavePath !== pending.savePath) {
              // Synchronous dedup since will-download must be handled synchronously
              const saveDir = path.dirname(newSavePath)
              let candidate = newSavePath
              let i = 1
              while (fs.existsSync(candidate)) {
                const ext = path.extname(newSavePath)
                const base = path.basename(newSavePath, ext)
                candidate = path.join(saveDir, `${base} (${i})${ext}`)
                i++
              }
              // Ensure the target directory exists (server name may introduce subdirs)
              fs.mkdirSync(path.dirname(candidate), { recursive: true })
              pending.savePath = candidate
              pending.filename = path.basename(candidate)
              pending.tempPath = path.join(path.dirname(pending.tempPath), `${Date.now()}-${pending.filename}.tmp`)
              pending.lastProgress = { ...pending.lastProgress, filename: pending.filename }
            }
          }
        }
      }

      item.setSavePath(pending.tempPath!)
      attachDownloadListeners(item, pending)
    } else {
      // General download — browser-like save dialog
      const suggestedName = item.getFilename()
      const downloadsDir = app.getPath('downloads')
      // `webContents` is null for downloads initiated via
      // `session.downloadURL(...)` (e.g. our setWindowOpenHandler
      // intercept in createHostWindow.ts) — Electron only populates it
      // when a real page-initiated navigation triggered the download.
      // Fall back to the focused window so the Save dialog still has a
      // parent and the user gets the expected modal sheet.
      const sourceWin = webContents ? BrowserWindow.fromWebContents(webContents) : null
      const win = sourceWin ?? BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null

      let savePath: string | undefined
      if (win) {
        const filePath = dialog.showSaveDialogSync(win, {
          defaultPath: path.join(downloadsDir, suggestedName),
        })
        if (filePath) {
          savePath = filePath
        } else {
          item.cancel()
          return
        }
      } else {
        // setSavePath must be synchronous within will-download
        let candidate = path.join(downloadsDir, suggestedName)
        let i = 1
        while (fs.existsSync(candidate)) {
          const ext = path.extname(suggestedName)
          const base = path.basename(suggestedName, ext)
          candidate = path.join(downloadsDir, `${base} (${i})${ext}`)
          i++
        }
        savePath = candidate
      }

      item.setSavePath(savePath)

      const url = item.getURL()
      const filename = path.basename(savePath)
      const fallbackWindow = win || mainWindow || BrowserWindow.getAllWindows()[0]
      const general: PendingDownload = {
        url,
        filename,
        directory: '',
        savePath,
        window: fallbackWindow!,
        subscriberWindows: new Set(),
        item,
        lastProgress: { url, filename, progress: 0, status: 'pending' },
        lastSpeedBytes: 0,
        lastSpeedTime: Date.now(),
      }
      pendingDownloads.set(url, general)
      reportProgress(general.lastProgress)
      attachDownloadListeners(item, general)
    }
  })
}

// ---- Pause / Resume / Cancel ----

export function pauseModelDownload(url: string): boolean {
  const pending = pendingDownloads.get(url)
  if (!pending) return false
  if (pending.item && !pending.item.isPaused()) {
    pending.item.pause()
    reportProgress({
      ...pending.lastProgress,
      status: 'paused',
    })
  }
  return true
}

export function resumeModelDownload(url: string): boolean {
  const pending = pendingDownloads.get(url)
  if (!pending) return false
  if (pending.item && pending.item.isPaused()) {
    pending.item.resume()
    reportProgress({
      ...pending.lastProgress,
      status: 'downloading',
    })
  }
  return true
}

export function cancelModelDownload(url: string): boolean {
  const pending = pendingDownloads.get(url)
  if (!pending) return false
  if (pending.item) {
    pending.item.cancel()
  } else {
    // Download hasn't reached will-download yet — clean up immediately
    pendingDownloads.delete(url)
    reportProgress({
      url,
      filename: pending.filename,
      directory: pending.directory,
      progress: 0,
      status: 'cancelled',
    })
  }
  return true
}

/** Re-dispatch a terminal (error) download from its captured original
 *  params. No-op if the URL is still in flight or its params have been
 *  evicted (FIFO cap / dismiss / clear-finished). The old terminal row
 *  is removed first — both from the recent buffer and every renderer
 *  store — and its `createdAt` stamp is dropped so the retried download
 *  gets a fresh top-of-list slot rather than leaving a duplicate. */
export function retryDownload(url: string): boolean {
  if (pendingDownloads.has(url)) return false
  const params = retryParamsByUrl.get(url)
  if (!params) return false

  const win = !params.window.isDestroyed()
    ? params.window
    : mainWindow && !mainWindow.isDestroyed()
      ? mainWindow
      : (BrowserWindow.getAllWindows()[0] ?? null)
  if (!win || win.isDestroyed()) return false

  const sender =
    params.senderContents && !params.senderContents.isDestroyed()
      ? params.senderContents
      : undefined

  const idx = recentDownloads.findIndex((d) => d.url === url)
  if (idx >= 0) recentDownloads.splice(idx, 1)
  createdAtByUrl.delete(url)
  _broadcastToRenderer('model-download-removed', { url })
  downloadEvents.emit('tray-state-changed')

  if (params.kind === 'asset') {
    // Best-effort token reuse — if the captured token has expired the
    // download simply re-enters `error` and stays retryable.
    void startAssetDownload(win, url, params.filename, params.outputDir!, params.authToken, sender)
  } else {
    void startModelDownload(win, url, params.filename, params.directory ?? '', sender)
  }
  return true
}

// ---- Snapshot for seeding Launcher UI ----

export function getActiveDownloads(): DownloadProgress[] {
  const result: DownloadProgress[] = []
  for (const pending of pendingDownloads.values()) {
    result.push(pending.lastProgress)
  }
  return result
}

/** Full snapshot the renderer-side download store seeds itself from on
 *  mount — active in-flight entries plus the recent terminal buffer.
 *  Without the recent slice the Settings tab + popup history would be
 *  empty until the next status broadcast. */
export function getAllDownloads(): DownloadProgress[] {
  const result: DownloadProgress[] = []
  for (const pending of pendingDownloads.values()) {
    result.push(pending.lastProgress)
  }
  for (const recent of recentDownloads) {
    result.push(recent)
  }
  return result
}

/** Dismiss a single terminal entry from the recent buffer. In-flight
 *  entries are not dismissable here — cancel them first. Broadcasts a
 *  `model-download-removed` event so every renderer surface drops the
 *  entry from its store in lockstep. Returns true if anything was
 *  removed. */
export function dismissRecentDownload(url: string): boolean {
  const idx = recentDownloads.findIndex((d) => d.url === url)
  if (idx < 0) return false
  recentDownloads.splice(idx, 1)
  createdAtByUrl.delete(url)
  retryParamsByUrl.delete(url)
  _broadcastToRenderer('model-download-removed', { url })
  downloadEvents.emit('tray-state-changed')
  return true
}

/** Bulk-dismiss every terminal entry from the recent buffer. */
export function clearFinishedDownloads(): number {
  if (recentDownloads.length === 0) return 0
  const removed = recentDownloads.splice(0, recentDownloads.length)
  for (const r of removed) {
    createdAtByUrl.delete(r.url)
    retryParamsByUrl.delete(r.url)
  }
  _broadcastToRenderer('model-downloads-cleared-finished', {
    urls: removed.map((r) => r.url),
  })
  downloadEvents.emit('tray-state-changed')
  return removed.length
}

// ---- Window closed: detach downloads so they continue in the background ----

export function detachWindowDownloads(win: BrowserWindow): void {
  for (const pending of pendingDownloads.values()) {
    if (pending.window === win) {
      // Clear the taskbar progress on the closing window
      if (!win.isDestroyed()) win.setProgressBar(-1)
      // Downloads continue — the Launcher window still receives progress via broadcastProgress
    }
  }
}

// ---- Temp file cleanup ----

/** Remove the temp download directories and all their contents. */
export async function cleanupTempDownloads(): Promise<void> {
  try {
    await fs.promises.rm(getTempDir(), { recursive: true, force: true })
  } catch {}
  // Clean asset temp dir (sibling of output dir)
  try {
    await fs.promises.rm(getAssetTempDir(), { recursive: true, force: true })
  } catch {}
}

// ---- E2E test seeding ----

/**
 * Test-only: replace the in-memory active + recent buffers with the
 * provided snapshot and emit `tray-state-changed` so every renderer
 * surface (title-bar tray, popup, Settings tab) repaints exactly as
 * if the snapshot had arrived through the production
 * `broadcastProgress` path.
 *
 * The seeded `active` entries are stub `PendingDownload` records that
 * carry only the fields `getDownloadsTrayState()` reads
 * (`lastProgress`); the unused fields are nulled out so test code
 * never has to fabricate a `BrowserWindow` / `DownloadItem`. Only
 * called from `e2eHooks.ts` which is itself only loaded when
 * `process.env['E2E'] === '1'`.
 */
export function _test_setSeededTrayState(snapshot: DownloadsTrayState): void {
  pendingDownloads.clear()
  for (const entry of snapshot.active) {
    const stub: PendingDownload = {
      url: entry.url,
      filename: entry.filename,
      directory: entry.directory ?? '',
      savePath: entry.savePath ?? '',
      window: null as unknown as BrowserWindow,
      subscriberWindows: new Set(),
      lastProgress: { ...entry },
      lastSpeedBytes: 0,
      lastSpeedTime: Date.now(),
    }
    pendingDownloads.set(entry.url, stub)
  }
  recentDownloads.length = 0
  for (const entry of snapshot.recent) {
    recentDownloads.push({ ...entry })
  }
  downloadEvents.emit('tray-state-changed')
}


