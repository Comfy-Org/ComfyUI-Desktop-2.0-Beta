import { app, BrowserWindow, dialog, nativeImage } from 'electron'
import { EventEmitter } from 'events'
import fs from 'fs'
import path from 'path'
import * as settings from '../settings'
import { _broadcastToRenderer } from './ipc/shared'

export const ALLOWED_EXTENSIONS = ['.safetensors', '.sft', '.ckpt', '.pth', '.pt']

/** Asset (output) downloads whose final file is itself an image we can preview. */
export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif']

/**
 * Build "Save as type" filters for the generic Save dialog from the suggested
 * filename. Electron's `showSaveDialog`/`showSaveDialogSync` does not infer
 * filters from the default filename — on Windows the dropdown collapses to
 * "All Files (*.*)" if you omit `filters`, which is the symptom field-reported
 * as "Can't save image from Preview Image node" (#989). Pick a primary filter
 * matching the file's actual extension so the dialog opens on the right
 * format, with "All Files" as a fallback escape hatch.
 */
export function buildSaveDialogFilters(suggestedName: string): Electron.FileFilter[] {
  const ext = path.extname(suggestedName).toLowerCase().replace(/^\./, '')
  const ALL_FILES: Electron.FileFilter = { name: 'All Files', extensions: ['*'] }
  if (!ext) return [ALL_FILES]

  // Group images / video / audio by family so the user can switch between
  // related extensions inside the same Save dialog instead of being locked
  // to the single one we infer. Comfy outputs png/webp/jpg images, mp4/webm
  // video, and wav/mp3/flac/ogg audio depending on the node graph.
  const FAMILIES: Record<string, { name: string; extensions: string[] }> = {
    png:  { name: 'PNG Image',  extensions: ['png'] },
    jpg:  { name: 'JPEG Image', extensions: ['jpg', 'jpeg'] },
    jpeg: { name: 'JPEG Image', extensions: ['jpg', 'jpeg'] },
    webp: { name: 'WebP Image', extensions: ['webp'] },
    gif:  { name: 'GIF Image',  extensions: ['gif'] },
    bmp:  { name: 'Bitmap Image', extensions: ['bmp'] },
    mp4:  { name: 'MP4 Video',  extensions: ['mp4'] },
    webm: { name: 'WebM Video', extensions: ['webm'] },
    mov:  { name: 'QuickTime Video', extensions: ['mov'] },
    wav:  { name: 'WAV Audio',  extensions: ['wav'] },
    mp3:  { name: 'MP3 Audio',  extensions: ['mp3'] },
    flac: { name: 'FLAC Audio', extensions: ['flac'] },
    ogg:  { name: 'OGG Audio',  extensions: ['ogg'] },
  }

  const primary = FAMILIES[ext]
  if (primary) return [primary, ALL_FILES]
  // Unknown extension — keep it as a literal filter so the dialog still shows
  // the user what file type they're saving instead of collapsing to *.
  return [{ name: `${ext.toUpperCase()} File`, extensions: [ext] }, ALL_FILES]
}

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
  /** First-seen ms for this URL, preserved across status transitions so the
   *  renderer keeps each entry in its insertion-ordered slot. */
  createdAt?: number
  /** Set on a completed asset download whose file is an image, so the renderer
   *  knows to lazily request a thumbnail via `download-thumbnail`. */
  isImage?: boolean
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

/** Original dispatch params per URL, for `retryDownload`. Kept off the
 *  broadcast `DownloadProgress` because asset downloads carry an `authToken`
 *  that must never reach the renderer. */
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

/** Recent terminal downloads kept in main so a tray mounted after a download
 *  finished can still surface it. FIFO-capped at `RECENT_LIMIT`. */
const RECENT_LIMIT = 10
const recentDownloads: DownloadProgress[] = []

/** Event bus for the downloads tray; emits `'tray-state-changed'` on every
 *  progress broadcast. Listener cap bumped since every comfy window subscribes. */
export const downloadEvents = new EventEmitter()
downloadEvents.setMaxListeners(50)

/** Snapshot of the downloads tray: `active` (in-flight) + `recent` (last
 *  `RECENT_LIMIT` terminal entries). Mirrors `comfy-titlebar:downloads-changed`. */
export interface DownloadsTrayState {
  active: DownloadProgress[]
  recent: DownloadProgress[]
}

function isTerminalStatus(status: DownloadProgress['status']): boolean {
  return status === 'completed' || status === 'error' || status === 'cancelled'
}

function pushRecent(progress: DownloadProgress): void {
  // Replace any prior entry for the same URL so a re-attempted download
  // appears once.
  const idx = recentDownloads.findIndex((d) => d.url === progress.url)
  if (idx >= 0) recentDownloads.splice(idx, 1)
  recentDownloads.push({ ...progress })
  // FIFO eviction past the cap; also drop the createdAt/retry stamps so the
  // maps don't grow unbounded and a re-download gets a fresh end slot.
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

function hasImageExtension(filePath: string): boolean {
  const lower = filePath.toLowerCase()
  return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

/** A completed download is previewable only if it's an asset (carries
 *  `outputDir`; model downloads never do) whose final file is an image. */
function isImageAsset(pending: PendingDownload): boolean {
  return !!pending.outputDir && hasImageExtension(pending.savePath)
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
  // Fan out to every renderer so the Settings → Downloads tab and popup store
  // both receive live progress events.
  _broadcastToRenderer('model-download-progress', progress)
  // Push terminal entries to the recent buffer first so the snapshot the
  // tray-state listener pulls already reflects the new state.
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

/** First-seen timestamp per URL, preserved across status transitions and the
 *  pending→recent migration; cleared on full eviction from `recentDownloads`. */
const createdAtByUrl = new Map<string, number>()

function reportProgress(progress: DownloadProgress): void {
  // Stamp once per URL so terminal entries keep their slot in the combined view.
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
    // Only match entries still awaiting their DownloadItem; ones that already
    // have an item are active general downloads we mustn't hijack.
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
  // Pass auth headers directly; the original URL stays in item.getURLChain()
  // across redirects, so findPendingForItem still matches.
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
        isImage: isImageAsset(pending),
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

      // Resolve a better asset filename from the server response: cloud uses
      // content hashes in the WebSocket message, so the human-readable name is
      // only available from the HTTP Content-Disposition.
      if (pending.tempPath && pending.outputDir) {
        const serverName = resolveServerFilename(item)
        if (serverName) {
          // Use the output dir root so the server name lands directly there.
          const baseDir = pending.outputDir
          const safeServer = sanitizeAssetFilename(serverName, baseDir)
          if (safeServer) {
            const newSavePath = path.join(baseDir, safeServer)
            if (newSavePath !== pending.savePath) {
              // Synchronous dedup since will-download must be handled synchronously.
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
      // Seed the dialog with the directory the user last saved to, matching
      // browser behavior. Fall back to Downloads if unset or no longer present.
      const remembered = settings.get('lastSaveDialogDir')
      const startDir = remembered && fs.existsSync(remembered) ? remembered : downloadsDir
      // `webContents` is null for `session.downloadURL(...)`-initiated downloads
      // (Electron only sets it for page-initiated ones), so fall back to the
      // focused window for the Save dialog parent.
      const sourceWin = webContents ? BrowserWindow.fromWebContents(webContents) : null
      const win = sourceWin ?? BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null

      let savePath: string | undefined
      if (win) {
        const filePath = dialog.showSaveDialogSync(win, {
          defaultPath: path.join(startDir, suggestedName),
          filters: buildSaveDialogFilters(suggestedName),
        })
        if (filePath) {
          savePath = filePath
          settings.set('lastSaveDialogDir', path.dirname(filePath))
        } else {
          item.cancel()
          return
        }
      } else {
        // setSavePath must be synchronous within will-download
        let candidate = path.join(startDir, suggestedName)
        let i = 1
        while (fs.existsSync(candidate)) {
          const ext = path.extname(suggestedName)
          const base = path.basename(suggestedName, ext)
          candidate = path.join(startDir, `${base} (${i})${ext}`)
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

/** Re-dispatch a terminal download from its captured params. No-op if still in
 *  flight or its params were evicted. Removes the old terminal row first (from
 *  the buffer and every renderer store) so the retry gets a fresh slot. */
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

export function getActiveDownloads(): DownloadProgress[] {
  const result: DownloadProgress[] = []
  for (const pending of pendingDownloads.values()) {
    result.push(pending.lastProgress)
  }
  return result
}

/** Downscaled-thumbnail data URLs keyed by `${resolvedPath}:${mtimeMs}` so a
 *  re-downloaded file at the same path re-encodes. LRU-capped. */
const THUMB_WIDTH = 96
const THUMB_CACHE_MAX = 64
const thumbnailCache = new Map<string, string>()

/** Read a completed image download and return a small `data:` URL preview, or
 *  `null` for non-images, missing/unreadable files, or any decode failure.
 *  Lazy + cached so it only runs for visible image rows.
 *
 *  `savePath` is a LOCAL filesystem path (a download's `savePath`), never a
 *  remote/source URL — this only ever reads from disk, never the network. A
 *  value with a URL scheme is rejected so a caller passing the wrong field
 *  (e.g. the entry's `url`) can't trigger a path-resolve on a URL. */
export async function getDownloadThumbnail(savePath: unknown): Promise<string | null> {
  if (typeof savePath !== 'string' || !savePath) return null
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(savePath)) return null
  const resolved = path.resolve(savePath)
  if (!hasImageExtension(resolved)) return null

  let stat: fs.Stats
  try {
    stat = await fs.promises.stat(resolved)
  } catch {
    return null
  }
  if (!stat.isFile()) return null

  const key = `${resolved}:${stat.mtimeMs}`
  const cached = thumbnailCache.get(key)
  if (cached !== undefined) {
    // LRU touch: re-insert so it counts as most-recently-used.
    thumbnailCache.delete(key)
    thumbnailCache.set(key, cached)
    return cached
  }

  try {
    const img = nativeImage.createFromPath(resolved)
    if (img.isEmpty()) return null
    const dataUrl = img.resize({ width: THUMB_WIDTH, quality: 'good' }).toDataURL()
    thumbnailCache.set(key, dataUrl)
    while (thumbnailCache.size > THUMB_CACHE_MAX) {
      const oldest = thumbnailCache.keys().next().value
      if (oldest === undefined) break
      thumbnailCache.delete(oldest)
    }
    return dataUrl
  } catch {
    return null
  }
}

/** Full snapshot for the renderer store to seed from on mount — active entries
 *  plus the recent terminal buffer. */
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

/** Dismiss a single terminal entry from the recent buffer (cancel in-flight
 *  ones first). Broadcasts `model-download-removed` so every renderer drops it. */
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

/** Detach a closing window's downloads; they continue in the background via
 *  broadcastProgress. */
export function detachWindowDownloads(win: BrowserWindow): void {
  for (const pending of pendingDownloads.values()) {
    if (pending.window === win) {
      if (!win.isDestroyed()) win.setProgressBar(-1)
    }
  }
}

/** Remove the temp download directories and all their contents. */
export async function cleanupTempDownloads(): Promise<void> {
  try {
    await fs.promises.rm(getTempDir(), { recursive: true, force: true })
  } catch {}
  try {
    await fs.promises.rm(getAssetTempDir(), { recursive: true, force: true })
  } catch {}
}

/** Test-only: replace the in-memory buffers with `snapshot` and emit
 *  `tray-state-changed`. Active entries are stubs carrying only `lastProgress`. */
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


