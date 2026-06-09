import fs from 'fs'
import path from 'path'
import { stripPlatform, findSitePackages, getTorchVersion } from './envPaths'
import { getActiveVenvDir } from '../../lib/pythonEnv'
import { downloadAndExtract, downloadAndExtractMulti } from '../../lib/installer'
import { copyDirWithProgress } from '../../lib/copy'
import { createCache } from '../../lib/cache'
import { download } from '../../lib/download'
import { extractNested as extract } from '../../lib/extract'
import * as settings from '../../settings'
import * as telemetry from '../../lib/telemetry'
import type { InstallationRecord } from '../../installations'

// Vendor variant → the local-version tag fragment its torch wheel must carry.
// nvidia → '+cuXXX', amd → '+rocmX', intel-xpu → '+xpu'. CPU and mac (MPS, no
// suffix) are intentionally absent: CPU is a deliberate choice and the macOS
// wheel has no suffix and always supports MPS, so neither is ever "broken".
const EXPECTED_FAMILY: Record<string, string> = {
  nvidia: 'cu',
  amd: 'rocm',
  'intel-xpu': 'xpu',
}

// Packages that make up an accelerated torch stack — the package itself plus its
// bundled GPU runtime deps. Mirrors install.ts BULKY_PREFIXES (the set the
// installer copies in / strips out), extended for ROCm. Matched after
// normalizing '-' → '_' so both import dirs (nvidia_cudnn_cu12) and dist-info
// dirs (nvidia_cudnn_cu12-9.1.0.dist-info, torch-2.10.0+cu128.dist-info) hit.
const TORCH_FAMILY_PREFIXES = ['torch', 'nvidia', 'triton', 'cuda', 'pytorch_triton', 'rocm']

export interface TorchMismatch {
  /** Vendor key, e.g. 'nvidia' | 'amd' | 'intel-xpu'. */
  variantBase: string
  /** Tag fragment the install should have, e.g. 'cu'. */
  expectedFamily: string
  /** Full installed torch version string, e.g. '2.12.0' or '2.10.0+cu128'. */
  installedVersion: string
  /** Local-version tag, e.g. 'cu128' | 'cpu' | '' (bare). */
  installedTag: string
}

function isTorchFamilyEntry(name: string): boolean {
  const norm = name.toLowerCase().replace(/-/g, '_')
  return TORCH_FAMILY_PREFIXES.some((p) => norm.startsWith(p))
}

/**
 * Detect a GPU-variant install whose torch lacks its expected accelerator tag —
 * the signature of the brief `--upgrade` bug that replaced the bundled
 * CUDA/ROCm torch with a CPU build (on Windows a bare `2.12.0`, elsewhere a
 * `+cpu`). Keys ONLY on the accelerator tag, never the version number, so a user
 * freely choosing any `+cuXXX` version is never flagged. Returns null when the
 * install is fine, is CPU/mac/adopted, or torch can't be read.
 */
export function getTorchVendorMismatch(installation: InstallationRecord): TorchMismatch | null {
  if (installation.adopted === true) return null
  const variant = typeof installation.variant === 'string' ? installation.variant : ''
  if (!variant) return null

  const base = stripPlatform(variant)
  const variantBase = Object.keys(EXPECTED_FAMILY).find((k) => base === k || base.startsWith(`${k}-`))
  if (!variantBase) return null // cpu, mps, or unknown — nothing to repair

  const expectedFamily = EXPECTED_FAMILY[variantBase]!
  const installedVersion = getTorchVersion(installation)
  if (!installedVersion) return null // can't read torch — leave it alone

  const plus = installedVersion.indexOf('+')
  const installedTag = plus >= 0 ? installedVersion.slice(plus + 1) : ''
  // Correct accelerator family present (any version, incl. a different CUDA
  // version) → not broken.
  if (installedTag.includes(expectedFamily)) return null

  return { variantBase, expectedFamily, installedVersion, installedTag }
}

export interface TorchRepairTools {
  sendProgress: (phase: string, detail: Record<string, unknown>) => void
  sendOutput?: (text: string) => void
  update: (data: Record<string, unknown>) => Promise<unknown>
  signal?: AbortSignal
}

/** Replace every torch-family entry in dstSite with the copy from srcSite. */
export async function copyTorchFamily(srcSite: string, dstSite: string, signal?: AbortSignal): Promise<void> {
  for (const entry of fs.readdirSync(dstSite)) {
    if (isTorchFamilyEntry(entry)) {
      await fs.promises.rm(path.join(dstSite, entry), { recursive: true, force: true })
    }
  }
  for (const entry of fs.readdirSync(srcSite, { withFileTypes: true })) {
    if (signal?.aborted) throw new Error('Cancelled')
    if (!isTorchFamilyEntry(entry.name)) continue
    const from = path.join(srcSite, entry.name)
    const to = path.join(dstSite, entry.name)
    if (entry.isDirectory()) {
      await copyDirWithProgress(from, to, null, { signal })
    } else {
      await fs.promises.copyFile(from, to)
    }
  }
}

/**
 * Restore the correct accelerated torch by re-acquiring the install's original
 * bundle (reusing the on-disk download cache — `maxCachedDownloads` defaults to
 * 1, so the bundle is typically still cached) and copying its torch-family
 * packages over the install's venv. Never touches ComfyUI source, .git, models,
 * or non-torch packages.
 */
export async function repairTorch(
  installation: InstallationRecord,
  tools: TorchRepairTools,
): Promise<{ ok: boolean; message: string }> {
  const installPath = installation.installPath
  const tmpDir = path.join(installPath, '.torch-repair-tmp')

  try {
    const cache = createCache(settings.get('cacheDir') as string, settings.get('maxCachedDownloads') as number)
    const ctx = { sendProgress: tools.sendProgress, download, cache, extract, signal: tools.signal }

    await fs.promises.rm(tmpDir, { recursive: true, force: true })
    await fs.promises.mkdir(tmpDir, { recursive: true })

    const files = installation.downloadFiles as Array<{ url: string; filename: string; size: number }> | undefined
    const releaseTag = installation.releaseTag as string | undefined
    const variant = installation.variant as string | undefined
    const downloadUrl = installation.downloadUrl as string | undefined

    if (files && files.length > 0 && releaseTag && variant) {
      await downloadAndExtractMulti(files, tmpDir, `${releaseTag}_${variant}`, ctx)
    } else if (downloadUrl && releaseTag) {
      const filename = downloadUrl.split('/').pop()!
      await downloadAndExtract(downloadUrl, tmpDir, `${releaseTag}_${filename}`, ctx)
    } else {
      return { ok: false, message: 'no bundle download info on the installation record' }
    }

    const srcSite = findSitePackages(path.join(tmpDir, 'standalone-env'))
    const dstSite = findSitePackages(getActiveVenvDir(installation))
    if (!srcSite || !fs.existsSync(srcSite)) {
      return { ok: false, message: 'could not locate the bundle PyTorch packages' }
    }
    if (!dstSite || !fs.existsSync(dstSite)) {
      return { ok: false, message: 'could not locate the installation venv' }
    }

    tools.sendProgress('setup', { percent: -1, status: 'Restoring GPU PyTorch…' })
    await copyTorchFamily(srcSite, dstSite, tools.signal)

    // Verify the copy actually swapped in the expected accelerator family.
    const after = getTorchVersion(installation)
    const afterTag = after && after.includes('+') ? after.slice(after.indexOf('+') + 1) : ''
    const base = stripPlatform(variant!)
    const variantBase = Object.keys(EXPECTED_FAMILY).find((k) => base === k || base.startsWith(`${k}-`))
    const expectedFamily = variantBase ? EXPECTED_FAMILY[variantBase]! : ''
    if (!after || !afterTag.includes(expectedFamily)) {
      return { ok: false, message: `PyTorch still reports "${after ?? 'unknown'}" after copy` }
    }

    return { ok: true, message: `restored PyTorch ${after}` }
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

const MAX_REPAIR_ATTEMPTS = 3

interface TorchRepairState {
  status?: 'done' | 'failed'
  attempts?: number
  at?: number
}

/**
 * One-time, autorun-at-launch repair entry point. Detects the CPU-torch-on-
 * GPU-variant damage and, if found, restores the accelerated build from the
 * bundle. Bounded to MAX_REPAIR_ATTEMPTS so a repeatedly-failing download can't
 * nag forever. A failed repair is NON-fatal: CPU torch still runs (slowly), so
 * we let the launch proceed rather than block it. Returns true when a repair
 * succeeded (caller should refresh the installation record).
 */
export async function maybeRepairTorch(
  installation: InstallationRecord,
  tools: TorchRepairTools,
): Promise<boolean> {
  const state = installation.torchRepair as TorchRepairState | undefined
  if (state?.status === 'done') return false
  if ((state?.attempts ?? 0) >= MAX_REPAIR_ATTEMPTS) return false

  const mismatch = getTorchVendorMismatch(installation)
  if (!mismatch) return false

  telemetry.emit('comfy.desktop.torch_repair.detected', {
    variant: mismatch.variantBase,
    installed_version: mismatch.installedVersion,
    installed_tag: mismatch.installedTag || 'none',
  })
  tools.sendOutput?.(`\nDetected CPU PyTorch on a ${mismatch.variantBase.toUpperCase()} install; restoring the GPU build…\n`)

  let result: { ok: boolean; message: string }
  try {
    result = await repairTorch(installation, tools)
  } catch (err) {
    result = { ok: false, message: (err as Error).message }
  }

  const attempts = (state?.attempts ?? 0) + 1
  if (result.ok) {
    await tools.update({ torchRepair: { status: 'done', attempts, at: Date.now() } })
    telemetry.emit('comfy.desktop.torch_repair.succeeded', { variant: mismatch.variantBase })
    tools.sendOutput?.('GPU PyTorch restored.\n')
    return true
  }

  await tools.update({ torchRepair: { status: 'failed', attempts, at: Date.now() } })
  telemetry.emit('comfy.desktop.torch_repair.failed', {
    variant: mismatch.variantBase,
    attempts,
    error_message: result.message.slice(0, 200),
  })
  tools.sendOutput?.(`PyTorch repair failed (will retry on next launch): ${result.message}\n`)
  return false
}
