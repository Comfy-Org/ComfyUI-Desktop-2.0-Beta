import { Cloud, Computer, LaptopMinimal, Globe, Box } from 'lucide-vue-next'
import type { LucideIcon } from 'lucide-vue-next'

/** Stable UX-side install-type key. Callers switch on this for styling /
 *  analytics rather than the raw `sourceCategory` from the source plugins. */
export type InstallTypeKey =
  | 'standalone'
  | 'cloud'
  | 'legacyDesktop'
  | 'remote'
  | 'unknown'

export interface InstallTypeIconMeta {
  key: InstallTypeKey
  icon: LucideIcon
  labelKey: string
}

/** Map a raw `sourceCategory` to its install-type icon metadata. Shared by
 *  the chooser tile and the title bar so the icon vocabulary can't diverge. */
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

/** Resolve install-type metadata for a concrete installation. Legacy Desktop
 *  installs report `sourceCategory === 'local'`, so the distinct
 *  `legacyDesktop` identity is keyed off the `desktop` sourceId instead. */
export function installTypeMetaForInstall(inst: {
  sourceId?: unknown
  sourceCategory: string | null | undefined
}): InstallTypeIconMeta {
  if (inst.sourceId === 'desktop') return installTypeMetaFor('desktop')
  return installTypeMetaFor(inst.sourceCategory)
}
