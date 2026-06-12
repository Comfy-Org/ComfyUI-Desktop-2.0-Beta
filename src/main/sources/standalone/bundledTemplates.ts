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
export interface BundledTemplate {
  /** Real `comfyui_workflow_templates` id, matched against the frontend's
   *  `^[a-zA-Z0-9_.-]+$` deeplink validator. */
  id: string
  /** Card title shown in the wizard. */
  title: string
  /** Card subtitle. */
  description: string
  /** Coarse total download size estimate (bytes) from the template index, or 0
   *  for model-free templates. Used only for the consent label; the actual
   *  download set is resolved from the workflow JSON at install time. */
  sizeBytes: number
}

/** Sentinel "skip" option value — keeps the wizard step optional. */
export const NO_TEMPLATE_VALUE = 'none'

const GB = 1024 * 1024 * 1024

export const BUNDLED_TEMPLATES: readonly BundledTemplate[] = [
  // --- Zero-model: open instantly, never trigger a download ---
  {
    id: 'templates_purz_image_glitch',
    title: 'Apply Glitch And Distortion Effects',
    description:
      'Add customizable glitch and tearing effects to images — distortion intensity, chromatic aberration, and pattern randomness.',
    sizeBytes: 0,
  },
  {
    id: 'templates_purz_pixel_sort_image',
    title: 'Pixel Sort Glitch Effect',
    description:
      'Apply a pixel-sorting algorithm to create glitch art. Control direction, threshold, and blending with the original.',
    sizeBytes: 0,
  },
  {
    id: 'utility_interpolation_image_upscale',
    title: 'Image Upscale: Traditional Interpolation',
    description:
      'Upscale an image with fast traditional interpolation algorithms — no model required.',
    sizeBytes: 0,
  },
  // --- Small-model: a single lightweight download each ---
  {
    id: 'default',
    title: 'Image Generation',
    description: 'Generate images from text prompts (Stable Diffusion 1.5).',
    sizeBytes: 2 * GB,
  },
  {
    id: 'utility_birefnet_remove_background',
    title: 'BiRefNet: Remove Background',
    description:
      'Upload an image and get a clean background-removed version plus a precision segmentation mask.',
    sizeBytes: Math.round(0.4 * GB),
  },
  {
    id: 'utility_image_segment_sam3',
    title: 'SAM3: Image Segmentation',
    description:
      'Use SAM3 to segment the main subject from a photo, isolating specific objects or regions.',
    sizeBytes: Math.round(1.6 * GB),
  },
] as const
