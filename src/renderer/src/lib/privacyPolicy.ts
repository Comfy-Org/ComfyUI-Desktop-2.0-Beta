/**
 * ComfyUI Desktop Privacy Policy — canonical text rendered inline on
 * the first-use consent step. Source of truth lives in the Notion doc
 * "ComfyUI Desktop Privacy Policy"; update both together.
 *
 * Kept in source (not i18n) because legal text shouldn't be machine-
 * translated, and the consent step needs the exact wording the user
 * is agreeing to. The English text is shown to all locales for the
 * same reason most installers display ToS in the source language.
 */

export interface PolicyBlock {
  /** Visual hierarchy:
   *   - 'h2'   — top-level section heading
   *   - 'h3'   — subsection heading
   *   - 'p'    — paragraph (supports inline **bold** with `*`)
   *   - 'ul'   — unordered list; `items` carries the bullet strings
   */
  kind: 'h2' | 'h3' | 'p' | 'ul'
  text?: string
  items?: string[]
}

export interface PrivacyPolicy {
  effectiveDate: string
  appliesTo: string
  blocks: PolicyBlock[]
}

export const PRIVACY_POLICY: PrivacyPolicy = {
  effectiveDate: '2026-05-05',
  appliesTo: 'ComfyUI Desktop 2.0',
  blocks: [
    { kind: 'h2', text: 'Plain-English summary' },
    {
      kind: 'p',
      text:
        "ComfyUI Desktop runs locally on your computer. Your workflows, prompts, models, and generated outputs stay on your machine. We don't see them, we don't upload them, and we have no copy of them.",
    },
    {
      kind: 'p',
      text:
        'The only data that leaves your computer is anonymous product analytics (which features get used, how often the app launches, what version + OS you’re on) and crash reports. You can turn both off in Settings at any time.',
    },
    {
      kind: 'p',
      text:
        "If you sign in to Comfy Cloud, that's a separate flow with its own terms — this policy doesn't cover the cloud service.",
    },

    { kind: 'h2', text: 'What we collect' },
    { kind: 'h3', text: 'Anonymous usage analytics (via PostHog)' },
    {
      kind: 'p',
      text: 'Sent only if you have analytics enabled (toggle in onboarding + in Settings).',
    },
    {
      kind: 'ul',
      items: [
        'App version and platform (e.g. "Desktop 2.0.1, macOS 14.4 ARM")',
        'Anonymous device ID generated locally (not tied to your name, email, or hardware identifiers we can reverse)',
        'Feature events ("install completed", "workflow opened", "settings panel opened") with non-identifying metadata',
        'Approximate timing of those events',
      ],
    },
    { kind: 'p', text: "We **don't** send:" },
    {
      kind: 'ul',
      items: [
        'Workflow content',
        'Prompts you write',
        'Generated images, videos, or audio',
        'File paths or filenames',
        'Model names or weights',
        'Network activity outside the app',
      ],
    },

    { kind: 'h3', text: 'Crash reports (via Datadog)' },
    { kind: 'p', text: 'Sent only if you have analytics enabled.' },
    {
      kind: 'ul',
      items: [
        'Stack traces and error messages from crashes',
        'App version, platform',
        'Anonymous device ID',
      ],
    },
    {
      kind: 'p',
      text:
        "We **don't** include user content, file paths, or prompts in crash reports. We strip those before sending.",
    },

    { kind: 'h3', text: 'What stays on your machine, always' },
    {
      kind: 'ul',
      items: [
        'Your workflow files',
        'Your installed models',
        'Your generated outputs (images, videos, audio)',
        "The list of installations you've created in Desktop",
        'Your local settings',
      ],
    },
    { kind: 'p', text: 'None of these are uploaded, indexed, or accessible to Comfy-Org.' },

    { kind: 'h2', text: 'Why we collect what we do' },
    {
      kind: 'ul',
      items: [
        '**Usage analytics**: to understand which features people use, where they get stuck, and what to improve.',
        '**Crash reports**: to find and fix bugs faster.',
      ],
    },
    {
      kind: 'p',
      text:
        "That's the entire purpose. We don't sell, share, or use this data for advertising.",
    },

    { kind: 'h2', text: 'Third-party processors' },
    { kind: 'p', text: 'Data is processed by:' },
    {
      kind: 'ul',
      items: [
        '**PostHog** — product analytics',
        '**Datadog** — crash reports and application logs',
        '**ClickHouse** — long-term analytics storage',
      ],
    },
    {
      kind: 'p',
      text:
        'These vendors process data on our behalf under standard data processing agreements.',
    },

    { kind: 'h2', text: 'Your choices' },
    {
      kind: 'ul',
      items: [
        '**Turn off analytics**: Settings → Desktop panel → toggle off the analytics opt-in. Future events stop immediately.',
        '**Delete past data**: email **privacy@comfy.org** with your anonymous device ID (Settings → About → "Copy device ID") and we’ll remove records associated with it.',
        "**Stop using the app**: uninstalling Desktop ends data collection. We don't keep tracking IDs after uninstall.",
      ],
    },

    { kind: 'h2', text: 'Children' },
    {
      kind: 'p',
      text:
        "ComfyUI Desktop is not intended for users under 13. If you believe a child has used the app, contact **privacy@comfy.org** and we'll remove related records.",
    },

    { kind: 'h2', text: 'International users' },
    {
      kind: 'p',
      text:
        "If you're in the EU/UK, you have rights under GDPR (access, rectification, erasure, restriction, objection, portability). Contact **privacy@comfy.org** to exercise them.",
    },
    {
      kind: 'p',
      text:
        "If you're in California, you have rights under CCPA (know, delete, opt-out of sale — note we don't sell data).",
    },

    { kind: 'h2', text: 'Changes to this policy' },
    {
      kind: 'p',
      text:
        "We'll update this document as the product evolves. The **Effective** date at the top changes when we revise. During the beta, we may iterate without re-prompting you to re-accept; at GA, we'll prompt for a fresh acceptance of the final policy.",
    },

    { kind: 'h2', text: 'Contact' },
    {
      kind: 'p',
      text: '**privacy@comfy.org** for any privacy-related question or request.',
    },
  ],
}
