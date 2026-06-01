import fs from 'fs'
import path from 'path'
import { formatTime } from './util'

// Windows can briefly hold handles on `.git\refs`, `.venv\Lib\site-packages`,
// and similar after `git` / `uv pip install` exit (antivirus scanners,
// Search Indexer, the Restart Manager). The handles release within a few
// hundred ms but the `rmdir` / `unlink` syscall fails with `ENOTEMPTY`,
// `EBUSY`, `EPERM`, or `EACCES` if it arrives during that window. Retry
// with short backoff before surfacing the error.
const TRANSIENT_DELETE_ERRORS = new Set(['ENOTEMPTY', 'EBUSY', 'EPERM', 'EACCES'])
const DELETE_RETRY_DELAYS_MS = [50, 100, 200, 400, 800]

function isTransientDeleteError(err: NodeJS.ErrnoException | null): boolean {
  return !!err && !!err.code && TRANSIENT_DELETE_ERRORS.has(err.code)
}

function retryFsOp(
  op: (cb: (err: NodeJS.ErrnoException | null) => void) => void,
  cb: (err: NodeJS.ErrnoException | null) => void,
  signal?: AbortSignal,
  attempt = 0,
): void {
  op((err) => {
    if (!err || attempt >= DELETE_RETRY_DELAYS_MS.length || !isTransientDeleteError(err)) {
      return cb(err)
    }
    // Honour cancel between retries — a single hot file could otherwise
    // keep the retry loop alive for ~1.55s after the user cancels.
    if (signal?.aborted) return cb(new Error('Delete cancelled'))
    setTimeout(() => {
      if (signal?.aborted) return cb(new Error('Delete cancelled'))
      retryFsOp(op, cb, signal, attempt + 1)
    }, DELETE_RETRY_DELAYS_MS[attempt])
  })
}

export interface DeleteProgress {
  deleted: number
  total: number
  percent: number
  elapsedSecs: number
  etaSecs: number
}

function countEntries(
  dir: string,
  onBatch: ((total: number) => void) | null,
  signal?: AbortSignal
): Promise<number> {
  return new Promise((resolve, reject) => {
    let total = 0
    const batchSize = 500
    let sinceYield = 0

    function countDir(d: string, done: (err: Error | null) => void): void {
      if (signal && signal.aborted) return done(new Error('Delete cancelled'))
      fs.readdir(d, { withFileTypes: true }, (err, entries) => {
        if (err) return done(err)

        let i = 0
        function next(): void {
          if (signal && signal.aborted) return done(new Error('Delete cancelled'))
          while (i < entries.length) {
            const entry = entries[i++]!
            total++
            sinceYield++
            if (entry.isDirectory()) {
              countDir(path.join(d, entry.name), (err) => {
                if (err) return done(err)
                if (sinceYield >= batchSize) {
                  sinceYield = 0
                  if (onBatch) onBatch(total)
                  setImmediate(next)
                  return
                }
                next()
              })
              return
            }
            if (sinceYield >= batchSize) {
              sinceYield = 0
              if (onBatch) onBatch(total)
              setImmediate(next)
              return
            }
          }
          done(null)
        }
        next()
      })
    }

    countDir(dir, (err) => {
      if (err) return reject(err)
      resolve(total)
    })
  })
}

export async function deleteDir(
  dir: string,
  onProgress?: ((p: DeleteProgress) => void) | null,
  options: { signal?: AbortSignal } = {}
): Promise<void> {
  const { signal } = options
  if (!fs.existsSync(dir)) return
  if (signal && signal.aborted) throw new Error('Delete cancelled')

  const total = await countEntries(
    dir,
    (counted) => {
      if (onProgress) onProgress({ deleted: 0, total: counted, percent: 0, elapsedSecs: 0, etaSecs: -1 })
    },
    signal
  )

  let deleted = 0
  const batchSize = 200
  let sinceYield = 0
  const startTime = Date.now()
  let lastReportTime = 0
  const REPORT_INTERVAL_MS = 150

  const report = (): void => {
    if (!onProgress) return
    const now = Date.now()
    // Throttle: only report at most every REPORT_INTERVAL_MS, but always report the final state
    if (now - lastReportTime < REPORT_INTERVAL_MS && deleted < total) return
    lastReportTime = now
    const elapsedSecs = (now - startTime) / 1000
    const etaSecs = deleted > 0 ? elapsedSecs * ((total - deleted) / deleted) : -1
    onProgress({
      deleted,
      total,
      percent: total > 0 ? Math.round((deleted / total) * 100) : 100,
      elapsedSecs,
      etaSecs,
    })
  }

  await new Promise<void>((resolve, reject) => {
    function walkAsync(d: string, done: (err: Error | NodeJS.ErrnoException | null) => void): void {
      if (signal && signal.aborted) return done(new Error('Delete cancelled'))
      fs.readdir(d, { withFileTypes: true }, (err, entries) => {
        if (err) return done(err)

        let i = 0
        function next(): void {
          if (signal && signal.aborted) return done(new Error('Delete cancelled'))
          if (i >= entries.length) return done(null)
          const entry = entries[i++]!
          const fullPath = path.join(d, entry.name)
          if (entry.isDirectory()) {
            walkAsync(fullPath, (err) => {
              if (err) return done(err)
              retryFsOp((cb) => fs.rmdir(fullPath, cb), (e) => {
                if (e) return done(e)
                deleted++
                report()
                sinceYield++
                if (sinceYield >= batchSize) {
                  sinceYield = 0
                  setImmediate(next)
                } else {
                  next()
                }
              }, signal)
            })
          } else {
            retryFsOp((cb) => fs.unlink(fullPath, cb), (e) => {
              if (e) return done(e)
              deleted++
              report()
              sinceYield++
              if (sinceYield >= batchSize) {
                sinceYield = 0
                setImmediate(next)
              } else {
                next()
              }
            }, signal)
          }
        }
        next()
      })
    }

    walkAsync(dir, (err) => {
      if (err) return reject(err)
      retryFsOp((cb) => fs.rmdir(dir, cb), (e) => {
        if (e) return reject(e)
        resolve()
      }, signal)
    })
  })
}

/**
 * Build a formatted status string from a {@link DeleteProgress} update.
 * Used by IPC handlers that pipe delete progress into `sendProgress`.
 */
export function formatDeleteStatus(p: DeleteProgress, prefix = 'Deleting…'): string {
  const elapsed = formatTime(p.elapsedSecs)
  const eta = p.etaSecs >= 0 ? formatTime(p.etaSecs) : '—'
  return `${prefix} ${p.deleted} / ${p.total} items  ·  ${elapsed} elapsed  ·  ${eta} remaining`
}
