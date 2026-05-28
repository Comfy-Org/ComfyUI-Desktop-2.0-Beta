import fs from 'fs'
import path from 'path'
import * as releaseCache from '../../lib/release-cache'
import { buildChannelCards, buildChannelLabelMap } from '../../lib/channel-cards'
import type { ChannelDef } from '../../lib/channel-cards'
import { formatComfyVersion } from '../../lib/version'
import type { ComfyVersion } from '../../lib/version'
import { truncateNotes } from '../../lib/comfyui-releases'
import { deleteAction, untrackAction, launchAction, openFolderAction } from '../../lib/actions'
import { t } from '../../lib/i18n'
import { buildLaunchSettingsFields, buildSharedPathsField } from '../common/launchSettingsFields'
import { getVariantLabel, DEFAULT_LAUNCH_ARGS } from './envPaths'
import type { InstallationRecord } from '../../installations'
import type { StatusTag } from '../../types/sources'

export const COMFYUI_REPO = 'Comfy-Org/ComfyUI'
export const RELEASE_REPO = 'Comfy-Org/ComfyUI-Standalone-Environments'
export const R2_BASE_URL = 'https://desktop-assets.comfy.org/standalone-environments'

function getChannelDefs(): ChannelDef[] {
  return [
    { value: 'stable', label: t('standalone.channelStable'), description: t('standalone.channelStableDesc'), recommended: true },
    { value: 'latest', label: t('standalone.channelLatest'), description: t('standalone.channelLatestDesc') },
  ]
}

export function getChannelLabel(channel: string): string {
  const map = buildChannelLabelMap(getChannelDefs())
  return map[channel] || channel
}

/**
 * The channel to surface for an install. `installation.updateChannel` is a
 * *declared* preference, written only on in-app update / channel-switch /
 * snapshot-restore — it can drift from the real checkout (e.g. a user runs
 * `git pull` on master outside the app, leaving a `stable` record sitting
 * many commits past its base tag). When the working tree is ahead of its
 * base stable tag the de-facto channel is `latest`, so prefer that for
 * display and picker logic. This never mutates the stored record; the next
 * explicit in-app update reconciles it.
 */
export function getEffectiveChannel(installation: InstallationRecord): string {
  const stored = (installation.updateChannel as string | undefined) || 'stable'
  if (stored !== 'stable') return stored
  const cv = installation.comfyVersion as ComfyVersion | undefined
  return typeof cv?.commitsAhead === 'number' && cv.commitsAhead > 0 ? 'latest' : stored
}

export function getListPreview(installation: InstallationRecord): string | null {
  return getChannelLabel(getEffectiveChannel(installation))
}

export function getStatusTag(installation: InstallationRecord): StatusTag | undefined {
  const channel = getEffectiveChannel(installation)
  const info = releaseCache.getEffectiveInfo(COMFYUI_REPO, channel, installation)
  if (info && releaseCache.isUpdateAvailable(installation, channel, info)) {
    const version = info.releaseName || info.latestTag || ''
    return { label: t('standalone.updateAvailableTag', { version }), style: 'update', version }
  }
  return undefined
}

export function getDetailSections(installation: InstallationRecord): Record<string, unknown>[] {
  const installed = installation.status === 'installed'

  const infoFields: Record<string, unknown>[] = [
    { label: t('common.installMethod'), value: installation.sourceLabel as string },
    { key: 'comfyui-version', label: t('standalone.comfyui'), value: installation.comfyVersion ? formatComfyVersion(installation.comfyVersion as ComfyVersion, 'detail') : (installation.version as string | undefined) || 'unknown' },
    { label: t('common.release'), value: (installation.releaseTag as string | undefined) || '—' },
    { label: t('standalone.variant'), value: (installation.variant as string | undefined) ? getVariantLabel(installation.variant as string) : '—' },
    { label: t('standalone.python'), value: (installation.pythonVersion as string | undefined) || '—' },
    { label: t('common.location'), value: installation.installPath || '—' },
    { label: t('common.installed'), value: new Date(installation.createdAt).toLocaleDateString() },
  ]

  const copiedFrom = installation.copiedFrom as string | undefined
  if (copiedFrom) {
    const copiedFromName = installation.copiedFromName as string | undefined
    const copiedAt = installation.copiedAt as string | undefined
    const copyReason = installation.copyReason as string | undefined
    const reasonLabel = copyReason === 'copy-update' ? t('standalone.lineageCopyUpdate')
      : copyReason === 'release-update' ? t('standalone.lineageReleaseUpdate')
      : t('standalone.lineageCopy')
    const dateStr = copiedAt ? new Date(copiedAt).toLocaleString() : ''
    const nameStr = copiedFromName || copiedFrom
    infoFields.push({
      label: t('standalone.lineage'),
      value: dateStr
        ? `${reasonLabel}: ${nameStr}  ·  ${dateStr}`
        : `${reasonLabel}: ${nameStr}`,
    })
  }

  const sections: Record<string, unknown>[] = [
    {
      tab: 'status',
      title: t('common.installInfo'),
      fields: infoFields,
    },
  ]

  // Snapshot tab — minimal section so the tab appears; SnapshotTab.vue handles rendering
  if (installed && installation.installPath) {
    sections.push({
      tab: 'snapshots',
      title: t('standalone.snapshotHistory'),
    })
  }

  // Updates section
  const hasGit = installed && installation.installPath && fs.existsSync(path.join(installation.installPath, 'ComfyUI', '.git'))
  const channel = getEffectiveChannel(installation)

  // Build per-channel preview info and actions for cards
  const channelDefs = getChannelDefs()
  const baseCards = buildChannelCards(COMFYUI_REPO, channelDefs, installation)

  const channelOptions = baseCards.map((card) => {
    const actions: Record<string, unknown>[] = []
    if (card.data?.updateAvailable && hasGit) {
      const channelInfo = releaseCache.getEffectiveInfo(COMFYUI_REPO, card.value, installation)!
      const cv = installation.comfyVersion as ComfyVersion | undefined
      const installedDisplay = cv ? formatComfyVersion(cv, 'detail') : (channelInfo.installedTag || 'unknown')
      const latestCv = channelInfo.commitSha
        ? { commit: channelInfo.commitSha, baseTag: channelInfo.baseTag, commitsAhead: channelInfo.commitsAhead } as ComfyVersion
        : undefined
      const latestDisplay = latestCv ? formatComfyVersion(latestCv, 'detail') : (channelInfo.releaseName || channelInfo.latestTag || '—')
      const isSwitching = card.value !== channel
      const isDowngrade = card.value === 'stable' && cv ? (cv.commitsAhead === undefined ? !!cv.baseTag : cv.commitsAhead > 0) : false
      const msgKey = isDowngrade ? 'standalone.updateConfirmMessageDowngrade'
        : card.value === 'latest' ? 'standalone.updateConfirmMessageLatest'
        : 'standalone.updateConfirmMessage'
      const notes = truncateNotes(channelInfo.releaseNotes || '', 2000)
      const notesDetails = notes ? [{ label: t('standalone.releaseNotesLabel'), items: [notes] }] : undefined
      const switchPrefix = isSwitching
        ? t('channelCards.switchChannelPrefix', { from: `**${getChannelLabel(channel)}**`, to: `**${card.label}**` })
        : ''
      const boldInstalled = `**${installedDisplay}**`
      const boldLatest = `**${latestDisplay}**`
      const confirmMessage = t(msgKey, {
        installed: boldInstalled,
        latest: boldLatest,
      })
      actions.push({
        id: 'update-comfyui', label: t('standalone.updateNow'), style: 'primary', enabled: installed,
        tooltip: t('tooltips.updateNow'),
        showProgress: true,
        progressTitle: isDowngrade
          ? t('standalone.downgradingTitle', { version: latestDisplay })
          : t('standalone.updatingTitle', { version: latestDisplay }),
        // Always carry the explicit target channel. The stored
        // `updateChannel` can be stale (see getEffectiveChannel), so relying
        // on the action handler's fallback to it would pass `--stable` for a
        // checkout that is really on latest, silently downgrading it.
        data: {
          channel: card.value,
          isDowngrade,
        },
        confirm: {
          title: t('standalone.updateConfirmTitle'),
          message: switchPrefix + confirmMessage,
          messageDetails: notesDetails,
        },
      })
      actions.push({
        id: 'copy-update', label: t('standalone.copyAndUpdate'), style: 'default', enabled: installed,
        tooltip: t('tooltips.copyAndUpdate'),
        showProgress: true, progressTitle: t('standalone.copyUpdatingTitle', { version: latestDisplay }),
        cancellable: true,
        data: { channel: card.value },
        prompt: {
          title: t('standalone.copyAndUpdateTitle'),
          message: (isSwitching ? switchPrefix : '') + t('standalone.copyAndUpdateMessage', { installed: boldInstalled, latest: boldLatest }),
          placeholder: t('standalone.copyAndUpdatePlaceholder'),
          defaultValue: `${installation.name} (${latestDisplay})`,
          confirmLabel: t('standalone.copyAndUpdateConfirm'),
          required: true,
          field: 'name',
          messageDetails: notesDetails,
        },
      })
    } else if (card.value !== channel && hasGit) {
      actions.push({
        id: 'switch-channel', label: t('channelCards.switchChannelOnly'), style: 'default', enabled: installed,
        data: { channel: card.value },
      })
    }
    return { ...card, data: card.data ? { ...card.data, actions: actions.length ? actions : undefined } : undefined }
  })

  const updateFields: Record<string, unknown>[] = [
    { id: 'updateChannel', label: t('standalone.updateChannel'), value: channel, editable: true,
      refreshSection: true, editType: 'channel-cards', options: channelOptions, tooltip: t('tooltips.updateChannel') },
  ]
  const updateActions: Record<string, unknown>[] = [
    { id: 'check-update', label: t('actions.checkForUpdate'), style: 'default', enabled: installed },
  ]
  sections.push({
    tab: 'update',
    title: t('standalone.updates'),
    fields: updateFields,
    actions: updateActions,
  })

  sections.push(
    {
      tab: 'settings',
      title: t('common.launchSettings'),
      fields: buildLaunchSettingsFields(installation, { defaultLaunchArgs: DEFAULT_LAUNCH_ARGS }),
    },
    {
      tab: 'storage',
      fields: [buildSharedPathsField(installation)],
    },
    {
      title: 'Actions',
      pinBottom: true,
      actions: [
        launchAction(installed, !installed ? t('errors.installNotReady') : undefined),
        { id: 'copy', label: t('actions.copyInstallation'), style: 'default', enabled: installed,
          showProgress: true, progressTitle: t('actions.copyingInstallation'), cancellable: true,
          prompt: {
            title: t('actions.copyInstallationTitle'),
            message: t('actions.copyInstallationMessage'),
            defaultValue: `${installation.name} (Copy)`,
            confirmLabel: t('actions.copyInstallationConfirm'),
            required: true,
            field: 'name',
          } },
        openFolderAction(installation.installPath),
        { id: 'share', label: t('actions.share'), style: 'default', enabled: installed },
        untrackAction(),
        deleteAction(installation),
      ],
    },
  )

  return sections
}
