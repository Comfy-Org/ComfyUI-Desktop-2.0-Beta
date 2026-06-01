import { t } from '../../lib/i18n'
import type { InstallationRecord } from '../../installations'

export interface LaunchSettingsOptions {
  defaultLaunchArgs: string
  defaultLaunchMode?: string
  defaultBrowserPartition?: string
  defaultPortConflict?: string
  extraFields?: Record<string, unknown>[]
}

/** Per-install `useSharedPaths` toggle. Rendered in the picker's
 *  Storage tab next to the global model-directory UI. Emitted by
 *  sources that participate in shared-model storage (desktop /
 *  portable); git-source installs omit this section entirely. */
export function buildSharedPathsField(installation: InstallationRecord): Record<string, unknown> {
  return {
    id: 'useSharedPaths', label: t('common.useSharedPaths'),
    value: (installation.useSharedPaths as boolean | undefined) !== false,
    editable: true, editType: 'boolean', tooltip: t('tooltips.useSharedPaths'),
    requiresRestart: true,
  }
}

export function buildLaunchSettingsFields(
  installation: InstallationRecord,
  options: LaunchSettingsOptions
): Record<string, unknown>[] {
  const {
    defaultLaunchArgs,
    defaultLaunchMode = 'window',
    defaultBrowserPartition = 'shared',
    defaultPortConflict = 'ask',
    extraFields = [],
  } = options

  const fields: Record<string, unknown>[] = []

  fields.push(
    ...extraFields,
    { id: 'launchArgs', label: t('common.startupArgs'),
      value: (installation.launchArgs as string | undefined) ?? defaultLaunchArgs,
      editable: true, editType: 'args-builder', tooltip: t('tooltips.startupArgs'),
      requiresRestart: true },
    { id: 'launchMode', label: t('common.launchMode'),
      value: (installation.launchMode as string | undefined) || defaultLaunchMode,
      editable: true, editType: 'select', options: [
        { value: 'window', label: t('common.launchModeWindow') },
        { value: 'console', label: t('common.launchModeConsole') },
      ], tooltip: t('tooltips.launchMode'), requiresRestart: true },
    { id: 'browserPartition', label: t('common.browserPartition'),
      value: (installation.browserPartition as string | undefined) || defaultBrowserPartition,
      editable: true, editType: 'select', options: [
        { value: 'shared', label: t('common.partitionShared') },
        { value: 'unique', label: t('common.partitionUnique') },
      ], tooltip: t('tooltips.browserPartition'), requiresRestart: true },
    { id: 'portConflict', label: t('common.portConflict'),
      value: (installation.portConflict as string | undefined) || defaultPortConflict,
      editable: true, editType: 'select', options: [
        { value: 'ask', label: t('common.portConflictAsk') },
        { value: 'auto', label: t('common.portConflictAuto') },
      ], requiresRestart: true },
    { id: 'envVars', label: t('common.envVars'),
      value: (installation.envVars as Record<string, string> | undefined) ?? {},
      editable: true, editType: 'env-vars', tooltip: t('tooltips.envVars'),
      requiresRestart: true },
  )

  return fields
}
