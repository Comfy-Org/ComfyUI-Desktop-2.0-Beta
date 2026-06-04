type Translator = (key: string, params?: Record<string, unknown>) => string

/** Localised relative-time string from epoch ms, falling back to absolute date past 30 days or in the future. */
export function formatRelativeFromMs(ms: number, t: Translator): string {
  if (!Number.isFinite(ms)) return ''
  const diff = Date.now() - ms
  if (diff < 0) return new Date(ms).toLocaleDateString()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return t('snapshots.timeJustNow')
  if (mins < 60) return t('snapshots.timeMinutesAgo', { count: mins })
  const hours = Math.floor(mins / 60)
  if (hours < 24) return t('snapshots.timeHoursAgo', { count: hours })
  const days = Math.floor(hours / 24)
  if (days < 30) return t('snapshots.timeDaysAgo', { count: days })
  return new Date(ms).toLocaleDateString()
}
