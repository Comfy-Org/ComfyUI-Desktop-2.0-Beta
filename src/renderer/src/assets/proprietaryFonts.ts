/**
 * Registers the proprietary PP Formula display face at runtime.
 *
 * PP Formula (Pangram Pangram) is license-restricted and must never be
 * committed to this public repo. It is fetched at build time into the renderer
 * public dir (`public/fonts/`, see scripts/fetch-font.mjs) and is absent in OSS
 * clones and most dev/CI builds.
 *
 * We register it via the FontFace API rather than a CSS `@font-face` for two
 * reasons:
 *   1. The build must not depend on the binary existing. A CSS `url()` to a
 *      bundled asset fails the Vite build when the file is missing; a public
 *      asset would need a root-absolute `/fonts/...` URL that does not resolve
 *      under the `file://` origin used in production (loadFile).
 *   2. A document-relative `./fonts/...` URL resolves correctly under `file://`
 *      (it matches the `./images/*` convention used elsewhere in the renderer)
 *      and a missing file simply rejects the load, leaving the `--font-display`
 *      stack to fall back to Inter.
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
      // Font not present (OSS / dev / CI build). Intentionally ignored: the
      // --font-display stack falls back to Inter.
    })
}
