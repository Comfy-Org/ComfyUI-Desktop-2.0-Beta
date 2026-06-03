import { t } from '../../lib/i18n'
import type { InstallationRecord } from '../../installations'

export interface LaunchSettingsOptions {
  defaultLaunchArgs: string
  defaultLaunchMode?: string
  defaultBrowserPartition?: string
  defaultPortConflict?: string
  extraFields?: Record<string, unknown>[]
}

/**
 * Per-install storage toggles + per-install input/output path fields,
 * rendered in the picker's Storage tab next to the global model-directory
 * UI. Emitted by sources that participate in shared storage (desktop /
 * portable); git-source installs omit these entirely.
 *
 * Two independent toggles:
 *  - `useSharedModels` — gates `--extra-model-paths-config` injection.
 *    Defaults to `true`. Off is intentionally rare (the renderer surfaces
 *    an inline warning) because most users want their model library
 *    visible to every install.
 *  - `useSharedInputOutput` — gates `--input-directory` /
 *    `--output-directory` injection from the global shared dirs. When
 *    off, the per-install `inputDir` / `outputDir` fields below are used
 *    instead, defaulting to ComfyUI's own `<installPath>/{input,output}`
 *    when also unset.
 */
export function buildStorageFields(installation: InstallationRecord): Record<string, unknown>[] {
  const useSharedModels = (installation.useSharedModels as boolean | undefined) !== false
  const useSharedInputOutput = (installation.useSharedInputOutput as boolean | undefined) !== false
  return [
    {
      id: 'useSharedModels', label: t('common.useSharedModels'),
      value: useSharedModels,
      editable: true, editType: 'boolean', tooltip: t('tooltips.useSharedModels'),
      requiresRestart: true,
    },
    {
      id: 'useSharedInputOutput', label: t('common.useSharedInputOutput'),
      value: useSharedInputOutput,
      editable: true, editType: 'boolean', tooltip: t('tooltips.useSharedInputOutput'),
      requiresRestart: true,
    },
    // Per-install input/output paths — only meaningful when
    // `useSharedInputOutput === false`. StoragePane.vue filters them
    // out of the rendered field list while the toggle is on, so they
    // don't clutter the common case.
    {
      id: 'inputDir', label: t('common.perInstallInputDir'),
      value: (installation.inputDir as string | undefined) ?? '',
      editable: true, editType: 'path', tooltip: t('tooltips.perInstallInputDir'),
      requiresRestart: true,
    },
    {
      id: 'outputDir', label: t('common.perInstallOutputDir'),
      value: (installation.outputDir as string | undefined) ?? '',
      editable: true, editType: 'path', tooltip: t('tooltips.perInstallOutputDir'),
      requiresRestart: true,
    },
  ]
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
