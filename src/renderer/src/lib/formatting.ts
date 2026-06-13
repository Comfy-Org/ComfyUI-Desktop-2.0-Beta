export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return ''
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`
  return `${(bytes / 1073741824).toFixed(2)} GB`
}

/** Rounded sizes for picker meta lines (~16 GB, not ~16.05 GB). */
export function formatBytesCoarse(bytes: number): string {
  if (!bytes || bytes <= 0) return ''
  if (bytes < 1048576) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1073741824) return `${Math.round(bytes / 1048576)} MB`
  return `${Math.round(bytes / 1073741824)} GB`
}
