import { t } from '../../lib/i18n'
import { installModelsDir, installInputDir, installOutputDir } from '../../lib/models'
import type { InstallationRecord } from '../../installations'

export interface LaunchSettingsOptions {
  defaultLaunchArgs: string
  defaultLaunchMode?: string
  defaultBrowserPartition?: string
  defaultPortConflict?: string
  extraFields?: Record<string, unknown>[]
}

/**
 * Per-install storage toggles + input/output path fields for the picker's Storage tab.
 * `useSharedModels` gates `--extra-model-paths-config`; `useSharedInputOutput` gates
 * `--input-directory` / `--output-directory`, falling back to the per-install fields
 * below (then `<installPath>/{input,output}`) when off. Shared-storage sources only.
 */
export function buildStorageFields(installation: InstallationRecord): Record<string, unknown>[] {
  const useSharedModels = (installation.useSharedModels as boolean | undefined) !== false
  const useSharedInputOutput = (installation.useSharedInputOutput as boolean | undefined) !== false
  // The install's own default dirs are computed (never persisted) so a clone
  // derives its own paths instead of pointing back at the original install.
  const installPath = installation.installPath as string | undefined
  const ownModelsDir = installPath ? installModelsDir(installPath) : ''
  const ownInputDir = installPath ? installInputDir(installPath) : ''
  const ownOutputDir = installPath ? installOutputDir(installPath) : ''
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
    // Per-install model directories, only meaningful when `useSharedModels === false`.
    // StoragePane.vue renders this through its own ModelsDirList (not the generic
    // SettingsSectionList) and hides it while shared models is on.
    {
      id: 'modelDirs', label: t('common.perInstallModelDirs'),
      value: (installation.modelDirs as string[] | undefined) ?? [],
      editable: true, editType: 'model-dirs',
      tooltip: t('tooltips.perInstallModelDirs'),
      requiresRestart: true,
    },
    // External model dir promoted to primary (`is_default`). Null/absent means
    // the install's own models dir is primary. Persisted but rendered manually.
    {
      id: 'modelDirsPrimary', label: 'modelDirsPrimary',
      value: (installation.modelDirsPrimary as string | undefined) ?? null,
      editable: true, editType: 'hidden',
      requiresRestart: true,
    },
    // The install's own models dir — shown as a locked, undeletable row in the
    // per-instance list; not persisted (computed from installPath).
    {
      id: 'installModelsDir', label: t('common.perInstallModelDirs'),
      value: ownModelsDir,
      editable: false, editType: 'hidden',
    },
    // Per-install paths, only meaningful when `useSharedInputOutput === false`;
    // StoragePane.vue hides them while the toggle is on. Empty value falls back
    // to the computed install default below (never persisted).
    {
      id: 'inputDir', label: t('common.perInstallInputDir'),
      value: (installation.inputDir as string | undefined) ?? '',
      editable: true, editType: 'path', browseOnly: true,
      tooltip: t('tooltips.perInstallInputDir'),
      requiresRestart: true,
    },
    {
      id: 'outputDir', label: t('common.perInstallOutputDir'),
      value: (installation.outputDir as string | undefined) ?? '',
      editable: true, editType: 'path', browseOnly: true,
      tooltip: t('tooltips.perInstallOutputDir'),
      requiresRestart: true,
    },
    {
      id: 'inputDirDefault', label: t('common.perInstallInputDir'),
      value: ownInputDir, editable: false, editType: 'hidden',
    },
    {
      id: 'outputDirDefault', label: t('common.perInstallOutputDir'),
      value: ownOutputDir, editable: false, editType: 'hidden',
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
