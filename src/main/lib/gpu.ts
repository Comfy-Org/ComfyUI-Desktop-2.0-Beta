import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import si from 'systeminformation'
import type { HardwareValidation, NvidiaDriverCheck } from '../../types/ipc'

type GpuId = 'nvidia' | 'amd' | 'intel' | 'mps'

export interface GpuInfo {
  id: GpuId
  label: string
  model: string | null
  /** Total VRAM in bytes when we can read a real figure on any OS — NVIDIA via
   *  nvidia-smi, Apple Silicon ≈ unified memory, otherwise the cross-platform
   *  `systeminformation` graphics probe (AMD/Intel/discrete). Undefined only
   *  when no real number is available, so the picker never false-warns. */
  vramBytes?: number
}

const GPU_LABELS: Record<GpuId, string> = {
  nvidia: "NVIDIA",
  amd: "AMD",
  intel: "Intel",
  mps: "Apple Silicon",
}

const NVIDIA_VENDOR_ID = "10DE"
const AMD_VENDOR_ID = "1002"
const INTEL_VENDOR_ID = "8086"

function pickGPU(hasNvidia: boolean, hasAmd: boolean, hasIntel: boolean): GpuId | null {
  if (hasNvidia) return "nvidia"
  if (hasAmd) return "amd"
  if (hasIntel) return "intel"
  return null
}

/**
 * Detect GPU type, or null if no supported GPU is found.
 *   Windows: WMI vendor IDs, then nvidia-smi.
 *   Linux/WSL: lspci, then /sys/class/drm, then nvidia-smi.
 *   macOS: "mps" for Apple Silicon, null for Intel.
 */
async function detectGPU(): Promise<GpuInfo | null> {
  let id: GpuId | null = null
  if (process.platform === "win32") {
    id = await detectWindowsGPU()
  } else if (process.platform === "darwin") {
    id = await detectMacGPU()
  } else if (process.platform === "linux") {
    id = await detectLinuxGPU()
  }
  if (!id) return null
  return { id, label: GPU_LABELS[id], model: null, vramBytes: await detectVramBytes(id) }
}

const MIB = 1024 * 1024

/**
 * Total VRAM in bytes, or undefined when no real figure can be read — works on
 * any OS by reusing the `systeminformation` graphics probe the app already runs
 * for telemetry. Resolution order, most-accurate first:
 *   NVIDIA → nvidia-smi `memory.total` (authoritative; already in our stack).
 *   Apple Silicon (mps) → unified memory (`os.totalmem()`).
 *   anything else (AMD / Intel / discrete, on Windows / Linux / macOS) →
 *     `si.graphics()` largest controller's `vram` (MB).
 * Undefined stays the floor when even `si` can't read a number, so the picker
 * never false-warns.
 */
async function detectVramBytes(id: GpuId): Promise<number | undefined> {
  if (id === "nvidia") {
    const nvidia = await getNvidiaVramBytes()
    if (nvidia !== undefined) return nvidia
  }
  if (id === "mps") return os.totalmem()
  return getSystemInfoVramBytes()
}

/** Query nvidia-smi for total VRAM (reported in MiB) and convert to bytes. */
function getNvidiaVramBytes(): Promise<number | undefined> {
  return new Promise((resolve) => {
    execFile(
      "nvidia-smi",
      ["--query-gpu=memory.total", "--format=csv,noheader,nounits"],
      { timeout: 5000, windowsHide: true },
      (err: Error | null, stdout: string) => {
        if (err) return resolve(undefined)
        // Multi-GPU: take the largest card — that's the one a heavy template runs on.
        const mibs = stdout
          .split(/\r?\n/)
          .map((line) => parseInt(line.trim(), 10))
          .filter((n) => Number.isFinite(n) && n > 0)
        if (mibs.length === 0) return resolve(undefined)
        resolve(Math.max(...mibs) * MIB)
      },
    )
  })
}

/**
 * Cross-platform VRAM via `systeminformation` (`si.graphics()`), which reports
 * each controller's `vram` in MB on Windows/Linux/macOS for NVIDIA/AMD/Intel.
 * Take the largest controller (the one a heavy template would run on); skip
 * shared-memory (`vramDynamic`) figures since they reflect system RAM, not a
 * real dedicated budget. Best-effort — undefined on any failure / no number.
 */
async function getSystemInfoVramBytes(): Promise<number | undefined> {
  try {
    const { controllers } = await si.graphics()
    let bestMb = 0
    for (const ctrl of controllers) {
      if (ctrl.vramDynamic) continue
      const mb = ctrl.vram
      if (typeof mb === "number" && mb > bestMb) bestMb = mb
    }
    return bestMb > 0 ? bestMb * MIB : undefined
  } catch {
    return undefined
  }
}

async function detectWindowsGPU(): Promise<GpuId | null> {
  const wmiResult = await queryWmiVendorIds()
  if (wmiResult) return wmiResult
  if (await hasNvidiaSmi()) return "nvidia"
  return null
}

function queryWmiVendorIds(): Promise<GpuId | null> {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command",
        '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty PNPDeviceID | ConvertTo-Json -Compress'],
      { timeout: 10000, windowsHide: true },
      (err: Error | null, stdout: string) => {
        if (err) return resolve(null)
        try {
          const ids: unknown = JSON.parse(stdout)
          const list: unknown[] = Array.isArray(ids) ? ids : [ids]
          let hasNvidia = false, hasAmd = false, hasIntel = false
          for (const id of list) {
            if (typeof id !== "string") continue
            const match = id.match(/ven_([0-9a-f]{4})/i)
            if (!match || !match[1]) continue
            const vendor = match[1].toUpperCase()
            if (vendor === NVIDIA_VENDOR_ID) hasNvidia = true
            else if (vendor === AMD_VENDOR_ID) hasAmd = true
            else if (vendor === INTEL_VENDOR_ID) hasIntel = true
          }
          resolve(pickGPU(hasNvidia, hasAmd, hasIntel))
        } catch {
          resolve(null)
        }
      },
    )
  })
}

function hasNvidiaSmi(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("nvidia-smi", { timeout: 5000, windowsHide: true }, (err: Error | null) => {
      resolve(!err)
    })
  })
}

async function detectLinuxGPU(): Promise<GpuId | null> {
  const lspciResult = await queryLspciVendors()
  if (lspciResult) return lspciResult
  const sysfsResult = querySysfsVendors()
  if (sysfsResult) return sysfsResult
  if (await hasNvidiaSmi()) return "nvidia"
  return null
}

function queryLspciVendors(): Promise<GpuId | null> {
  return new Promise((resolve) => {
    execFile("lspci", ["-nn"], { timeout: 5000 }, (err: Error | null, stdout: string) => {
      if (err) return resolve(null)
      let hasNvidia = false, hasAmd = false, hasIntel = false
      for (const line of stdout.split("\n")) {
        if (!/vga|3d|display/i.test(line)) continue
        const match = line.match(/\[([0-9a-f]{4}):[0-9a-f]{4}\]/i)
        if (!match || !match[1]) continue
        const vendor = match[1].toUpperCase()
        if (vendor === NVIDIA_VENDOR_ID) hasNvidia = true
        else if (vendor === AMD_VENDOR_ID) hasAmd = true
        else if (vendor === INTEL_VENDOR_ID) hasIntel = true
      }
      resolve(pickGPU(hasNvidia, hasAmd, hasIntel))
    })
  })
}

function querySysfsVendors(): GpuId | null {
  try {
    const cards = fs.readdirSync("/sys/class/drm").filter((d) => /^card\d+$/.test(d))
    let hasNvidia = false, hasAmd = false, hasIntel = false
    for (const card of cards) {
      try {
        const vendor = fs.readFileSync(`/sys/class/drm/${card}/device/vendor`, "utf-8").trim().replace(/^0x/i, "").toUpperCase()
        if (vendor === NVIDIA_VENDOR_ID) hasNvidia = true
        else if (vendor === AMD_VENDOR_ID) hasAmd = true
        else if (vendor === INTEL_VENDOR_ID) hasIntel = true
      } catch {}
    }
    return pickGPU(hasNvidia, hasAmd, hasIntel)
  } catch {}
  return null
}

async function detectMacGPU(): Promise<GpuId | null> {
  return new Promise((resolve) => {
    execFile("sysctl", ["-n", "machdep.cpu.brand_string"], { timeout: 5000 }, (err: Error | null, stdout: string) => {
      if (err) return resolve(null)
      resolve(stdout.toLowerCase().includes("apple") ? "mps" : null)
    })
  })
}

/** Minimum NVIDIA driver for PyTorch 2.10 / CUDA 13.0 (cu130); matches desktop's value. */
const NVIDIA_DRIVER_MIN_VERSION = "580"

/** Compare dotted version strings numerically: negative if a<b, positive if a>b, 0 if equal. */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number)
  const pb = b.split(".").map(Number)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const na = pa[i] ?? 0
    const nb = pb[i] ?? 0
    if (na !== nb) return na - nb
  }
  return 0
}

/** Parse "Driver Version: XXX.XX" from nvidia-smi standard output. */
export function parseNvidiaDriverVersion(output: string): string | undefined {
  const match = output.match(/driver version\s*:\s*([\d.]+)/i)
  return match?.[1]
}

/** Query nvidia-smi for the driver version using the structured CSV flag. */
function getNvidiaDriverVersionQuery(): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "nvidia-smi",
      ["--query-gpu=driver_version", "--format=csv,noheader"],
      { timeout: 5000, windowsHide: true },
      (err: Error | null, stdout: string) => {
        if (err) return resolve(undefined)
        const version = stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find(Boolean)
        resolve(version || undefined)
      },
    )
  })
}

/** Fallback: parse driver version from plain nvidia-smi output. */
function getNvidiaDriverVersionFallback(): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "nvidia-smi",
      { timeout: 5000, windowsHide: true },
      (err: Error | null, stdout: string) => {
        if (err) return resolve(undefined)
        resolve(parseNvidiaDriverVersion(stdout))
      },
    )
  })
}

/** Check whether the installed NVIDIA driver meets the minimum version; null if none detected. */
async function checkNvidiaDriver(): Promise<NvidiaDriverCheck | null> {
  if (process.platform === "darwin") return null

  const driverVersion =
    (await getNvidiaDriverVersionQuery()) ?? (await getNvidiaDriverVersionFallback())
  if (!driverVersion) return null

  return {
    driverVersion,
    minimumVersion: NVIDIA_DRIVER_MIN_VERSION,
    supported: compareVersions(driverVersion, NVIDIA_DRIVER_MIN_VERSION) >= 0,
  }
}

/** Validate hardware for standalone install. Rejects Intel Macs (MPS needs Apple Silicon). */
async function validateHardware(): Promise<HardwareValidation> {
  if (process.platform === "darwin") {
    const gpu = await detectMacGPU()
    if (!gpu) {
      return {
        supported: false,
        error: "ComfyUI requires Apple Silicon (M1/M2/M3) Mac. Intel-based Macs are not supported.",
      }
    }
  }
  return { supported: true }
}

export { detectGPU, checkNvidiaDriver, validateHardware }
