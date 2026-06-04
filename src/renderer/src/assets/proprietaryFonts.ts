/**
 * Registers the proprietary, license-restricted PP Formula display face at runtime.
 * It must never be committed (fetched at build time into `public/fonts/`) and is
 * absent in OSS/dev/CI builds. Uses the FontFace API rather than CSS `@font-face` so
 * the build doesn't depend on the binary existing and a document-relative
 * `./fonts/...` URL resolves under the production `file://` origin; a missing file
 * simply rejects the load and falls back to Inter.
 */
export function loadProprietaryFonts(): void {
  if (typeof document === 'undefined' || !('fonts' in document)) return

  const face = new FontFace(
    'PP Formula',
    "url('./fonts/PPFormula-Extrabold.otf') format('opentype')",
    { weight: '800', style: 'normal', display: 'swap' }
  )

  face
    .load()
    .then((loaded) => {
      document.fonts.add(loaded)
    })
    .catch(() => {
      // Font not present (OSS / dev / CI); fall back to Inter.
    })
}
