import { ref, watchEffect, type Ref } from 'vue'

/** Reads a completed download's preview into a `data:` URL. */
export type ThumbnailFetcher = (savePath: string) => Promise<string | null>

interface ThumbnailEntry {
  isImage?: boolean
  status: string
  savePath?: string
}

// Keyed by savePath so the popup and modal never fetch the same thumbnail twice
// (`null` = resolved-but-no-thumbnail, distinct from "not yet fetched").
const cache = new Map<string, string | null>()
const inflight = new Map<string, Promise<string | null>>()

/**
 * Lazily resolves a download row's thumbnail. Returns a ref that stays `null`
 * until the file is a completed image with a `savePath` and the injected
 * `fetcher` resolves a data URL. The `fetcher` is injected so the same code
 * serves the panel (`window.api`) and the popup (its bridge).
 */
export function useDownloadThumbnail(
  entry: () => ThumbnailEntry,
  fetcher: ThumbnailFetcher
): Ref<string | null> {
  // The resolved thumbnail data: URL (not the download's source URL).
  const thumbnail = ref<string | null>(null)

  watchEffect(() => {
    const e = entry()
    thumbnail.value = null
    // Only completed image assets carry a readable on-disk file; `savePath` is a
    // local filesystem path, never the (possibly external) download `url`.
    if (!e.isImage || e.status !== 'completed' || !e.savePath) return

    const savePath = e.savePath
    const cached = cache.get(savePath)
    if (cached !== undefined) {
      thumbnail.value = cached
      return
    }

    let pending = inflight.get(savePath)
    if (!pending) {
      pending = fetcher(savePath)
        .then((result) => {
          cache.set(savePath, result)
          inflight.delete(savePath)
          return result
        })
        .catch(() => {
          inflight.delete(savePath)
          return null
        })
      inflight.set(savePath, pending)
    }

    void pending.then((result) => {
      // Guard against the row's savePath changing while the fetch was in flight.
      if (entry().savePath === savePath) thumbnail.value = result
    })
  })

  return thumbnail
}
