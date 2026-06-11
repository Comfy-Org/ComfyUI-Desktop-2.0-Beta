import fs from 'fs'
import path from 'path'
import { t } from '../../lib/i18n'
import {
  installModelsDir,
  installInputDir,
  installOutputDir,
  resolveComfyDir,
  resolveExtraModelPaths,
} from '../../lib/models'
import type { InstallationRecord } from '../../installations'

/** One resolved per-type dir in an `extra_model_paths.yaml` section.
 *  `dirExists` lets the UI flag missing folders. */
export interface ExtraModelPathDir {
  type: string
  rawType: string
  dir: string
  dirExists: boolean
}

/** An `extra_model_paths.yaml` section for read-only display: one models-dir row
 *  (keyed by `base_path`, or `name` if none) with per-type `dirs` in a modal. */
export interface ExtraModelPathSection {
  /** Section key from the YAML (e.g. `comfyui_desktop`, `my_external`). */
  name: string
  /** Resolved absolute `base_path`, or null when the section declares none. */
  basePath: string | null
  /** Whether `basePath` currently exists on disk (false when null). */
  basePathExists: boolean
  /** `is_default: true` on the section. */
  isDefault: boolean
  /** Per-type directories the section contributes. */
  dirs: ExtraModelPathDir[]
}

export interface ExtraModelPathsView {
  /** Absolute path of the resolved `extra_model_paths.yaml`. */
  yamlPath: string
  /** Whether that file currently exists on disk. */
  exists: boolean
  /** One entry per YAML section, in declaration order. */
  sections: ExtraModelPathSection[]
}

/** Resolve an install's `extra_model_paths.yaml` (as ComfyUI does), grouped by
 *  section for read-only display. Empty view when the install has no path yet. */
export function buildExtraModelPathsView(installation: InstallationRecord): ExtraModelPathsView {
  const installPath = installation.installPath as string | undefined
  if (!installPath) return { yamlPath: '', exists: false, sections: [] }
  const yamlPath = path.join(resolveComfyDir(installPath), 'extra_model_paths.yaml')

  // Group resolved per-type dirs by section, preserving declaration order.
  const sections: ExtraModelPathSection[] = []
  const byName = new Map<string, ExtraModelPathSection>()
  for (const r of resolveExtraModelPaths(yamlPath)) {
    let section = byName.get(r.section)
    if (!section) {
      section = {
        name: r.section,
        basePath: r.basePath,
        basePathExists: r.basePath != null && fs.existsSync(r.basePath),
        isDefault: r.isDefault,
        dirs: [],
      }
      byName.set(r.section, section)
      sections.push(section)
    }
    section.dirs.push({
      type: r.type,
      rawType: r.rawType,
      dir: r.dir,
      dirExists: fs.existsSync(r.dir),
    })
  }

  return { yamlPath, exists: fs.existsSync(yamlPath), sections }
}

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
    // Read-only view of the install's extra_model_paths.yaml, rendered manually
    // by StoragePane.vue (the generic renderer ignores `hidden` fields).
    {
      id: 'extraModelPaths', label: 'extraModelPaths',
      value: buildExtraModelPathsView(installation),
      editable: false, editType: 'hidden',
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
