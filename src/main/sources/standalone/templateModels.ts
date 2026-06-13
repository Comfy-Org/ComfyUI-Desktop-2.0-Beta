import fs from 'fs'
import path from 'path'
import { getActiveVenvDir } from '../../lib/pythonEnv'
import { findSitePackages } from './envPaths'
import { ALLOWED_EXTENSIONS, stripQueryParams } from '../../lib/comfyDownloadManager'
import { fetchJSON } from '../../lib/fetch'
import type { InstallationRecord } from '../../installations'

/**
 * A single model file a template needs, ready to download into the shared
 * models dir at `<modelsBaseDir>/<directory>/<filename>`.
 */
export interface TemplateModelDownload {
  /** Final on-disk filename (query params stripped). */
  filename: string
  /** Source URL (whitelisted host, model file extension). */
  url: string
  /** Models subdirectory, e.g. `checkpoints`, `vae`, `text_encoders`. */
  directory: string
}

/** Hosts the ComfyUI frontend whitelists for model downloads. We mirror that
 *  list so the install-time pre-download can't be pointed at an arbitrary host
 *  by a malformed template JSON. */
const ALLOWED_HOSTS = ['huggingface.co', 'civitai.com', 'civitai.red']

/** Raw embedded-model shape (matches the frontend's `zModelFile`). */
interface RawModel {
  name?: unknown
  url?: unknown
  directory?: unknown
}

const RAW_TEMPLATES_REMOTE_BASE =
  'https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main/templates'

/**
 * Resolve the workflow JSON for `templateId` — preferring the copy bundled in
 * the just-installed `comfyui_workflow_templates` package (no network), falling
 * back to the public repo when the package layout isn't found.
 */
/**
 * Packages that ship the per-template workflow JSONs. The templates were split
 * out of the monolithic `comfyui_workflow_templates` into per-modality media
 * packages (`…_media_image` / `_video` / `_other` / …), so we must probe all of
 * them — checking only the legacy single package made local resolution always
 * miss and fall back to the (slow, hang-prone) remote path.
 */
const TEMPLATE_PACKAGE_DIRS = [
  'comfyui_workflow_templates',
  'comfyui_workflow_templates_media_image',
  'comfyui_workflow_templates_media_video',
  'comfyui_workflow_templates_media_audio',
  'comfyui_workflow_templates_media_other',
  'comfyui_workflow_templates_media_api',
]

async function loadTemplateJson(
  installation: InstallationRecord,
  templateId: string,
): Promise<unknown | null> {
  const sitePackages = findSitePackages(getActiveVenvDir(installation))
  if (sitePackages) {
    for (const pkg of TEMPLATE_PACKAGE_DIRS) {
      const local = path.join(sitePackages, pkg, 'templates', `${templateId}.json`)
      try {
        const raw = await fs.promises.readFile(local, 'utf-8')
        return JSON.parse(raw)
      } catch {
        // try the next package, then fall through to remote
      }
    }
  }
  // Remote fallback uses the codebase's Electron `net.request` helper (NOT
  // global fetch — which can hang in the Electron main process), so it shares
  // the same proven network stack, timeout, and retry behaviour as every other
  // main-side HTTP call.
  try {
    return await fetchJSON(`${RAW_TEMPLATES_REMOTE_BASE}/${templateId}.json`, { refresh: true })
  } catch {
    return null
  }
}

/** True when `url` is a syntactically valid HTTPS URL on a whitelisted host
 *  whose path ends in an allowed model extension. Plain `http:` is rejected so a
 *  template can't point a model download at a tamperable transport. */
function isAcceptableModelUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  const host = parsed.hostname.toLowerCase()
  if (!ALLOWED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return false
  const lowerPath = parsed.pathname.toLowerCase()
  return ALLOWED_EXTENSIONS.some((ext) => lowerPath.endsWith(ext))
}

/**
 * Reject template-provided path traversal: a model's `directory` must be a
 * relative path with no `..` segment and its `name` a bare filename (no
 * separator), so a crafted template can't escape the models dir. Returns the
 * normalized `{ directory, filename }` or `null` to drop the entry.
 */
export function sanitizeModelPath(
  directory: string,
  name: string,
): { directory: string; filename: string } | null {
  const normalizedDir = path.posix.normalize(directory.replace(/\\/g, '/'))
  if (
    path.posix.isAbsolute(normalizedDir) ||
    normalizedDir === '..' ||
    normalizedDir.startsWith('../') ||
    normalizedDir.includes('/../')
  ) {
    return null
  }
  const filename = stripQueryParams(name)
  if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    return null
  }
  return { directory: normalizedDir, filename }
}

/** Collect every `{name,url,directory}` from a raw `models[]` array. */
function collectModels(arr: unknown, out: RawModel[]): void {
  if (Array.isArray(arr)) {
    for (const m of arr) {
      if (m && typeof m === 'object') out.push(m as RawModel)
    }
  }
}

/** Recursively walk nodes (incl. nested subgraph nodes) collecting
 *  `node.properties.models[]`. */
function walkNodes(nodes: unknown, out: RawModel[]): void {
  if (!Array.isArray(nodes)) return
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue
    const n = node as { properties?: { models?: unknown }; nodes?: unknown }
    collectModels(n.properties?.models, out)
    if (Array.isArray(n.nodes)) walkNodes(n.nodes, out)
  }
}

/**
 * Extract the de-duplicated, validated set of models a template needs.
 *
 * Scans both the top-level `models[]` and every `node.properties.models[]`
 * (including subgraph definitions) — mirroring the frontend's missing-model
 * scan — then drops anything missing a name/directory or pointing at a
 * non-whitelisted URL. Returns `[]` for model-free templates or when the JSON
 * can't be resolved (caller treats both as "nothing to download").
 */
export async function resolveTemplateModels(
  installation: InstallationRecord,
  templateId: string,
): Promise<TemplateModelDownload[]> {
  const json = await loadTemplateJson(installation, templateId)
  if (!json || typeof json !== 'object') return []

  const doc = json as {
    models?: unknown
    nodes?: unknown
    definitions?: { subgraphs?: unknown }
  }

  const raw: RawModel[] = []
  collectModels(doc.models, raw)
  walkNodes(doc.nodes, raw)
  // Subgraph definitions carry their own node arrays.
  const subgraphs = doc.definitions?.subgraphs
  if (Array.isArray(subgraphs)) {
    for (const sg of subgraphs) {
      if (sg && typeof sg === 'object') walkNodes((sg as { nodes?: unknown }).nodes, raw)
    }
  }

  const seen = new Set<string>()
  const result: TemplateModelDownload[] = []
  for (const m of raw) {
    if (typeof m.name !== 'string' || typeof m.url !== 'string' || typeof m.directory !== 'string') {
      continue
    }
    if (!isAcceptableModelUrl(m.url)) continue
    const safe = sanitizeModelPath(m.directory, m.name)
    if (!safe) continue
    const key = `${safe.directory}/${safe.filename}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push({ filename: safe.filename, url: m.url, directory: safe.directory })
  }
  return result
}
