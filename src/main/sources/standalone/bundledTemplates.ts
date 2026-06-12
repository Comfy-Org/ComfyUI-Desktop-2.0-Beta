/**
 * Starter-template picker shown as the final step of the standalone install
 * wizard. Each entry's `id` is a real template id served by the
 * `comfyui_workflow_templates` package the install already ships, so opening it
 * needs no bundled assets — the desktop app appends `?template=<id>` to the
 * ComfyUI URL on first launch and the frontend's existing deeplink loader
 * (`useTemplateUrlLoader`) opens it on the canvas.
 *
 * The OFFERED list is intentionally curated (we keep it lightweight). The
 * REQUIRED MODELS for each, however, are derived dynamically at install time
 * from the template's workflow JSON (see `templateModels.ts`) — `sizeBytes`
 * here is only the index's coarse estimate, used for the wizard's "~X GB"
 * consent label before the precise per-file sizing of a later phase.
 *
 * Ids + titles + descriptions + sizes below were captured verbatim from the
 * live `Comfy-Org/workflow_templates` index. Before adding an id, confirm it
 * resolves to `/templates/<id>.json` and (for non-zero-model ones) that the
 * JSON carries a whitelisted `models[]` entry.
 */
/** Output modality a template showcases — one card per modality in the picker. */
export type TemplateModality = 'image' | 'video' | 'audio' | '3d'

export interface BundledTemplate {
  /** Real `comfyui_workflow_templates` id, matched against the frontend's
   *  `^[a-zA-Z0-9_.-]+$` deeplink validator. */
  id: string
  /** Output modality this template showcases. */
  modality: TemplateModality
  /** Card title — copied verbatim from the template index (`title`). */
  title: string
  /** Card subtitle — copied verbatim from the template index (`description`). */
  description: string
  /** Card thumbnail URL. The package ships a `<id>-1.webp` preview alongside the
   *  JSONs; we point at the public mirror so it renders before ComfyUI is up,
   *  matching the frontend's `/templates/<name>-1.<sub>` formula. */
  thumbnailUrl: string
  /** Coarse total download size estimate (bytes), from the index's `size`. Used
   *  only for the consent label + disk pre-check; the actual download set is
   *  resolved from the workflow JSON at install time. */
  sizeBytes: number
  /** Recommended VRAM (bytes), from the index's `vram`. The picker warns —
   *  never blocks — when detected VRAM is below this. */
  recommendedVramBytes?: number
}

/** Display order + i18n label key per modality, for the picker grid. */
export const TEMPLATE_MODALITY_ORDER: readonly TemplateModality[] = [
  'image',
  'video',
  'audio',
  '3d',
]

/**
 * Decide whether to show the "may run slowly" VRAM warning for a template.
 * Warn ONLY when we have a real detected figure that's below the template's
 * recommendation — undefined detected VRAM (AMD/Intel/unknown) or a template
 * with no recommendation stays silent, so we never false-warn. Pure +
 * exported so the decision is unit-testable without a GPU.
 */
export function shouldWarnVram(
  detectedVramBytes: number | undefined,
  recommendedVramBytes: number | undefined,
): boolean {
  if (!recommendedVramBytes) return false
  if (detectedVramBytes === undefined) return false
  return detectedVramBytes < recommendedVramBytes
}

/** Sentinel "skip" option value — keeps the wizard step optional. */
export const NO_TEMPLATE_VALUE = 'none'

/** Public mirror the frontend's `/templates/<name>-1.<sub>` thumbnails resolve
 *  to; the desktop picker uses it so cards render before ComfyUI is up. The
 *  thumbnail file is always a `.webp` image regardless of the template's output
 *  `mediaSubtype`. */
const THUMB_BASE = 'https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main/templates'
const thumb = (id: string): string => `${THUMB_BASE}/${id}-1.webp`

/**
 * One showcase template per modality. Ids + title/description/size/vram are
 * copied VERBATIM from the live `comfyui_workflow_templates` index (the same
 * data the ComfyUI gallery renders) — all four verified to resolve and carry a
 * real (non-API, downloadable) model set. `sizeBytes`/`recommendedVramBytes`
 * are the index's coarse `size`/`vram` (bytes); the precise download set is
 * still resolved from the workflow JSON at install time. To change a modality's
 * pick, swap the id + paste that entry's index metadata here.
 */
export const BUNDLED_TEMPLATES: readonly BundledTemplate[] = [
  {
    // Z-Image-Turbo looks great but its workflow JSON carries no embedded
    // models[], so nothing pre-downloads — defeating "ready to run". Flux.1
    // Schnell is a recognizable image showcase that DOES embed its model.
    id: 'flux_schnell',
    modality: 'image',
    title: 'Flux.1 Schnell FP8',
    description:
      'Quickly generate images with Flux.1 Schnell fp8 quantized version. Ideal for low-end hardware, requires only 4 steps to generate images.',
    thumbnailUrl: thumb('flux_schnell'),
    sizeBytes: 17233556275,
    recommendedVramBytes: 18253611008,
  },
  {
    id: 'text_to_video_wan',
    modality: 'video',
    title: 'Wan 2.1 Text to Video',
    description: 'Generate videos from text prompts using Wan 2.1.',
    thumbnailUrl: thumb('text_to_video_wan'),
    sizeBytes: 9824737690,
    recommendedVramBytes: 9824737690,
  },
  {
    id: 'audio_stable_audio_example',
    modality: 'audio',
    title: 'Stable Audio 1.0: Text to Audio',
    description: 'Generate audio from text prompts using Stable Audio.',
    thumbnailUrl: thumb('audio_stable_audio_example'),
    sizeBytes: 5690831667,
    recommendedVramBytes: 5690831667,
  },
  {
    id: '3d_hunyuan3d_image_to_model',
    modality: '3d',
    title: 'HY 3D 2.0',
    description: 'Generate 3D models from single images using Hunyuan3D 2.0.',
    thumbnailUrl: thumb('3d_hunyuan3d_image_to_model'),
    sizeBytes: 4928474972,
    recommendedVramBytes: 4928474972,
  },
] as const
