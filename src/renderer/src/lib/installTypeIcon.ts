import { Cloud, Computer, LaptopMinimal, Globe, Box } from 'lucide-vue-next'
import type { LucideIcon } from 'lucide-vue-next'

/**
 * Stable, surface-agnostic identifier for the install-type icon set.
 *
 * The renderer talks about installs in terms of `sourceCategory` (the raw
 * `local` / `cloud` / `desktop` / `remote` strings the main-side source
 * plugins emit). The UX, on the other hand, talks about install *types*:
 *
 *   - `standalone`     — current local install (`sourceCategory === 'local'`)
 *   - `cloud`          — always-present cloud install (`'cloud'`)
 *   - `legacyDesktop`  — auto-detected pre-Desktop-2 install (`'desktop'`)
 *   - `remote`         — user-pointed-at remote ComfyUI (`'remote'`)
 *   - `unknown`        — fallback for unrecognized categories
 *
 * This key is what callers should switch on for styling / analytics — the
 * raw `sourceCategory` is an implementation detail of the source plugins.
 */
export type InstallTypeKey =
  | 'standalone'
  | 'cloud'
  | 'legacyDesktop'
  | 'remote'
  | 'unknown'

export interface InstallTypeIconMeta {
  /** Stable UX-side key (see {@link InstallTypeKey}). */
  key: InstallTypeKey
  /** Lucide icon component to render. */
  icon: LucideIcon
  /** i18n key for the short label / tooltip (e.g. `installType.standalone`). */
  labelKey: string
}

/**
 * Map a raw `sourceCategory` string to its install-type icon metadata.
 *
 * Both surfaces — the dashboard chooser tile and the Comfy Instance title
 * bar — consume this same mapping so the icon vocabulary cannot diverge
 * between them.
 *
 * Icon choices:
 *   - **Standalone** → `LaptopMinimal`. Reads as a modern, slim local
 *     device — distinct from the Legacy Desktop tower silhouette so the
 *     user sees the two install types are visibly different at a glance.
 *   - **Cloud** → `Cloud`. The obvious choice; matches the existing
 *     Cloud-tile iconography on the chooser.
 *   - **Legacy Desktop** → `Computer`. A tower-and-monitor desktop
 *     silhouette — visibly older / chunkier than the Standalone laptop,
 *     reinforcing the "this is the old install you should migrate from"
 *     read called out in the Track G design doc.
 *   - **Remote** → `Globe`. Carries forward the existing remote-install
 *     iconography from the chooser.
 *   - **Unknown / fallback** → `Box`. Generic package fallback, also the
 *     chooser's previous fallback for unrecognized categories.
 */
export function installTypeMetaFor(
  category: string | undefined | null,
): InstallTypeIconMeta {
  switch (category) {
    case 'cloud':
      return { key: 'cloud', icon: Cloud, labelKey: 'installType.cloud' }
    case 'desktop':
      return { key: 'legacyDesktop', icon: Computer, labelKey: 'installType.legacyDesktop' }
    case 'remote':
      return { key: 'remote', icon: Globe, labelKey: 'installType.remote' }
    case 'local':
      return { key: 'standalone', icon: LaptopMinimal, labelKey: 'installType.standalone' }
    default:
      return { key: 'unknown', icon: Box, labelKey: 'installType.unknown' }
  }
}
