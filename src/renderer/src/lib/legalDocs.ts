/**
 * Canonical structured-data for the four legal documents rendered
 * inside `TermsModal.vue`: the EULA, the Terms of Service, the
 * Privacy Policy, and the Third-Party Notices. This is the source of
 * truth — what the app actually displays.
 *
 * Kept in source (not i18n) because legal text shouldn't be machine-
 * translated and the consent step needs the exact wording the user is
 * agreeing to. The English text is shown to all locales — standard for
 * EULA / privacy surfaces in desktop installers.
 *
 * `LEGAL_DOCS` is the lookup the consent flow uses via the modal's
 * `doc` prop. The individual `EULA`, `TOS`, `PRIVACY_POLICY`, and
 * `THIRD_PARTY_NOTICES` exports are convenience handles for direct
 * imports.
 */

export interface LegalDocBlock {
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

export interface LegalDoc {
  effectiveDate: string
  appliesTo: string
  blocks: LegalDocBlock[]
}

/** Doc ids surfaced by `TermsModal`'s `doc` prop. */
export type LegalDocId = 'eula' | 'tos' | 'privacy' | 'notices'

/* ============================================================
 * EULA — End-User License Agreement
 * ============================================================ */

export const EULA: LegalDoc = {
  effectiveDate: '2026-05-19',
  appliesTo: 'Comfy Desktop',
  blocks: [
    {
      kind: 'p',
      text: 'This End-User License Agreement is a binding agreement between you and Comfy Org governing your installation and use of the Comfy Desktop application. By installing or using the Desktop App, you accept this EULA. If you do not agree, do not install or use the Desktop App.'
    },

    { kind: 'h2', text: '1. Definitions' },
    {
      kind: 'ul',
      items: [
        '**"Desktop App"** — the Comfy Desktop application, including all binaries, installers, signed packages, scripts, configuration, and bundled assets we distribute under the name "Comfy Desktop," "ComfyUI Desktop," "ComfyUI Desktop 2.0," "Comfy Desktop 2," or any successor naming.',
        '**"Comfy Org," "we," "us," "our"** — the publisher of the Desktop App.',
        '**"You"** — the individual or entity installing or using the Desktop App.',
        '**"Source Code"** — the open-source source code published at github.com/Comfy-Org/Comfy-Desktop.',
        '**"Your Content"** — workflows, prompts, models, generated outputs, configurations, or other data you create, import, or store using the Desktop App.'
      ]
    },

    { kind: 'h2', text: '2. License grant' },
    {
      kind: 'p',
      text: 'Subject to this EULA, we grant you a **worldwide, non-exclusive, royalty-free, revocable** license to:'
    },
    {
      kind: 'ul',
      items: [
        'Install the Desktop App on any number of devices you own or control.',
        'Use the Desktop App for personal, internal-business, or commercial purposes.',
        'Make backup copies of the installed Desktop App.'
      ]
    },
    {
      kind: 'p',
      text: '**Source code**: the Source Code from which the Desktop App is compiled is separately licensed under the **MIT License** — that license is unaffected by this EULA, and nothing here limits the rights granted by MIT with respect to the Source Code itself.'
    },
    {
      kind: 'p',
      text: 'This EULA governs only your use of the **compiled binary** we distribute (which includes auto-update behavior, bundled dependencies, telemetry endpoints, branding, and signed installers) — components that are not part of the open-source Source Code.'
    },

    { kind: 'h2', text: '3. Permitted use and restrictions' },
    {
      kind: 'p',
      text: 'You may use the Desktop App for any lawful purpose. You agree **not to**:'
    },
    {
      kind: 'ul',
      items: [
        'Use the Desktop App in violation of any applicable law, regulation, or third-party right.',
        "Use the Desktop App to generate or distribute content that is illegal in your jurisdiction, including but not limited to child sexual abuse material (CSAM), non-consensual intimate imagery, or material that infringes another person's intellectual property.",
        "Remove, alter, or obscure any copyright, trademark, or other proprietary notices in the Desktop App's user interface.",
        'Use the Comfy Org name, logo, or branding to imply endorsement or affiliation that does not exist (see Section 8, Trademarks).',
        'Distribute modified compiled binaries under our trademarks (you may modify and redistribute the **Source Code** under the MIT License, but the resulting binaries must not be branded as "ComfyUI Desktop," "Comfy Desktop," or any confusingly similar name).'
      ]
    },

    { kind: 'h2', text: '4. Updates and auto-update' },
    {
      kind: 'p',
      text: 'The Desktop App includes an automatic update mechanism that may, from time to time:'
    },
    {
      kind: 'ul',
      items: [
        'Check our update servers for new versions.',
        'Download and install updates automatically or after your confirmation, depending on your settings.',
        "Update bundled dependencies (Python runtime, app frameworks) as part of the app's normal operation."
      ]
    },
    {
      kind: 'p',
      text: 'You can disable automatic updates in Settings. If you do, you accept responsibility for keeping the Desktop App up to date and acknowledge that security fixes will not be applied automatically.'
    },
    {
      kind: 'p',
      text: 'We may discontinue support for older versions of the Desktop App at any time without notice. Discontinued versions may stop working with our cloud services, partner APIs, or model formats.'
    },

    { kind: 'h2', text: '5. Data collection' },
    {
      kind: 'p',
      text: 'The Desktop App collects telemetry (usage analytics and crash reports) as described in the Privacy Policy linked from the same consent screen. Before you sign in to Comfy Cloud, this data is keyed only by a local device ID; if you sign in, it is linked to your Comfy account. You can turn telemetry off at any time in **Settings → Telemetry**. Doing so does not affect your ability to use the Desktop App.'
    },
    {
      kind: 'p',
      text: 'Your workflows, models, prompts, and generated outputs are **not** transmitted to us and remain on your local machine.'
    },
    {
      kind: 'p',
      text: 'If you separately sign in to **Comfy Cloud** from within the Desktop App, that activity is governed by the Comfy Org Terms of Service at comfy.org/terms and the Comfy Cloud privacy notice — not by this EULA.'
    },

    { kind: 'h2', text: '6. Your Content' },
    {
      kind: 'p',
      text: 'You retain **all rights** to Your Content. We claim no ownership, license, or interest in:'
    },
    {
      kind: 'ul',
      items: [
        'Workflows you create or import',
        'Prompts you write',
        'Models you install',
        'Images, videos, audio, or other outputs you generate',
        'Configurations and settings'
      ]
    },
    {
      kind: 'p',
      text: 'You are responsible for ensuring that Your Content complies with applicable law and the licenses of the models you use.'
    },

    { kind: 'h2', text: '7. Third-party components' },
    {
      kind: 'p',
      text: 'The Desktop App bundles open-source components governed by their own licenses. See the **Third-Party Notices** document for the full list and attributions.'
    },
    {
      kind: 'p',
      text: "The Desktop App also installs and manages **ComfyUI, custom nodes, and AI models** on your machine at your direction. Those components are **not part of the Desktop App's distributed binary** and are governed by their own licenses, which apply directly between you and the respective authors. Comfy Org is not a party to those agreements."
    },

    { kind: 'h2', text: '8. Trademarks' },
    {
      kind: 'p',
      text: '"Comfy," "ComfyUI," "Comfy Desktop," "Comfy Cloud," and the Comfy logo are trademarks of Comfy Org. Nothing in this EULA grants you a license to use those marks. You may make non-commercial, descriptive references to the Desktop App in articles, tutorials, and reviews.'
    },

    { kind: 'h2', text: '9. Disclaimer of warranty' },
    {
      kind: 'p',
      text: '**THE DESKTOP APP IS PROVIDED "AS-IS" AND "AS-AVAILABLE," WITHOUT WARRANTIES OF ANY KIND**, whether express, implied, or statutory, including (but not limited to) merchantability, fitness for a particular purpose, title, non-infringement, accuracy, or uninterrupted operation.'
    },
    {
      kind: 'p',
      text: 'We do not warrant that the Desktop App will be error-free, secure, or compatible with your hardware, operating system, or third-party software. Generative AI models bundled with or installed by the Desktop App may produce inaccurate, biased, offensive, or otherwise unsuitable outputs; we make no representation about output quality or fitness. Some jurisdictions do not allow exclusion of certain implied warranties, so some exclusions may not apply to you.'
    },

    { kind: 'h2', text: '10. Limitation of liability' },
    {
      kind: 'p',
      text: '**TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW**, Comfy Org will not be liable for indirect, incidental, special, consequential, exemplary, or punitive damages, or for loss of profits, revenue, data, goodwill, or business opportunity arising from or related to the Desktop App. Our total cumulative liability for all claims will not exceed **the greater of (a) USD 100 or (b) the total amount you paid us for the Desktop App in the 12 months preceding the claim** (which is USD 0 for most users because the Desktop App is free).'
    },

    { kind: 'h2', text: '11. Term and termination' },
    {
      kind: 'p',
      text: 'This EULA takes effect when you install or use the Desktop App and continues until terminated.'
    },
    {
      kind: 'p',
      text: '**You may terminate** this EULA at any time by uninstalling the Desktop App. Uninstalling stops new telemetry collection; past telemetry records remain subject to the retention terms in the Privacy Policy.'
    },
    {
      kind: 'p',
      text: '**We may terminate** this EULA if you materially breach it. Upon termination, you must stop using the Desktop App and uninstall it. Sections that by their nature survive termination (Sections 6, 7, 8, 9, 10, 12, 13, 14, 18, 19) will survive.'
    },

    { kind: 'h2', text: '12. Export and sanctions compliance' },
    {
      kind: 'p',
      text: 'You represent that you are not located in, and will not use the Desktop App from, a country subject to a comprehensive U.S. embargo, and that you are not on a U.S. government denied-party list. You agree to comply with all applicable export-control and sanctions laws when using the Desktop App.'
    },

    { kind: 'h2', text: '13. Governing law and disputes' },
    {
      kind: 'p',
      text: 'This EULA is governed by the laws of the **State of Delaware, USA**, excluding its conflict-of-law rules. Any dispute will be resolved exclusively in the state or federal courts located in Delaware, and you consent to the personal jurisdiction of those courts. If you are a consumer in a jurisdiction that grants non-waivable consumer rights, this section does not override those rights.'
    },

    { kind: 'h2', text: '14. Assignment' },
    {
      kind: 'p',
      text: 'You may not assign or transfer this EULA without our prior written consent. We may assign this EULA to any successor entity (e.g. in connection with a merger, acquisition, or sale of substantially all of our assets) provided the successor agrees to be bound by these terms.'
    },

    { kind: 'h2', text: '15. Changes to this EULA' },
    {
      kind: 'p',
      text: "We may update this EULA from time to time. The **Effective date** at the top reflects the latest version. Material changes will be surfaced in the Desktop App (e.g. on first launch after the change). Your continued use of the Desktop App after the Effective date means you accept the updated EULA. If you don't agree, uninstall."
    },

    { kind: 'h2', text: '16. Contact' },
    {
      kind: 'ul',
      items: [
        'EULA / commercial questions: **legal@comfy.org**',
        'Privacy questions: **privacy@comfy.org**',
        'General: **comfy.org**'
      ]
    }
  ]
}

/* ============================================================
 * Terms of Service
 *
 * The EULA above governs the binary distribution (license grant,
 * restrictions on the binary, third-party components). The Terms of
 * Service here govern how you USE the Desktop App — acceptable use,
 * user obligations, content policy, and dispute resolution.
 * ============================================================ */

export const TOS: LegalDoc = {
  effectiveDate: '2026-05-19',
  appliesTo: 'Comfy Desktop',
  blocks: [
    {
      kind: 'p',
      text: 'These Terms of Service govern your use of the Comfy Desktop application. They apply alongside the End-User License Agreement (EULA), which grants your license to install and run the Desktop App binary. The EULA covers the technical license; these Terms cover usage.'
    },

    { kind: 'h2', text: '1. Acceptance' },
    {
      kind: 'p',
      text: 'By installing or using Comfy Desktop (the "Desktop App"), you agree to these Terms of Service and the EULA. If you don\'t agree, don\'t install or use the Desktop App.'
    },

    { kind: 'h2', text: '2. Acceptable use' },
    { kind: 'p', text: 'You agree **not to**:' },
    {
      kind: 'ul',
      items: [
        "Use the Desktop App to generate or distribute content that is illegal in your jurisdiction, including (without limitation) child sexual abuse material (CSAM), non-consensual intimate imagery, or material that infringes another person's intellectual property.",
        'Use the Desktop App to harass, threaten, defame, or impersonate any person.',
        'Use the Desktop App in violation of applicable export-control, sanctions, or privacy laws.',
        "Attempt to interfere with the Desktop App's update servers, telemetry endpoints, or any of our other services.",
        'Use the Desktop App to develop or train systems that compete with the Desktop App by reverse-engineering the proprietary portions of the distributed binary (this restriction does not apply to use of the open-source Source Code, which is governed by MIT).'
      ]
    },

    { kind: 'h2', text: '3. Your Content' },
    {
      kind: 'p',
      text: 'You retain **all rights** to the workflows, prompts, models, and generated outputs you produce using the Desktop App (collectively, "Your Content"). We claim no ownership, license, or interest in Your Content, and we do not see, store, or have any access to it — see the Privacy Policy.'
    },
    {
      kind: 'p',
      text: 'You are responsible for ensuring Your Content complies with applicable law and the licenses of the models you use. Comfy Org has no role in moderating Your Content, because we never see it.'
    },

    { kind: 'h2', text: '4. Third-party models and custom nodes' },
    {
      kind: 'p',
      text: 'The Desktop App installs ComfyUI, custom nodes, and AI models on your machine at your direction at runtime. Those components are governed by their own licenses, which apply directly between you and their respective authors. Comfy Org is not a party to those agreements, does not distribute those components, and is not responsible for their behavior, outputs, or licensing.'
    },
    {
      kind: 'p',
      text: 'You agree to comply with the license terms of every model and custom node you install. Many model licenses restrict commercial use, certain content categories, or specific kinds of training — check each before using it.'
    },

    { kind: 'h2', text: '5. Comfy Cloud' },
    {
      kind: 'p',
      text: 'If you sign in to Comfy Cloud from the Desktop App, your use of Comfy Cloud is governed by the **Comfy Org Terms of Service** at comfy.org/terms — not by these Desktop Terms. Comfy Cloud has its own pricing, privacy notice, and acceptable-use rules.'
    },

    { kind: 'h2', text: '6. Telemetry and privacy' },
    {
      kind: 'p',
      text: 'The Desktop App collects usage analytics and crash reports if you opt in on the first-launch consent screen. Before you sign in to Comfy Cloud, this data is keyed by a local device ID; if you sign in, it is linked to your Comfy account. You can turn this off at any time in **Settings → Telemetry**. Workflows, prompts, models, and outputs are never collected. See the Privacy Policy for details.'
    },

    { kind: 'h2', text: '7. Disclaimer of warranty' },
    {
      kind: 'p',
      text: '**THE DESKTOP APP IS PROVIDED "AS-IS" AND "AS-AVAILABLE,"** without warranties of any kind. Generative AI outputs may be inaccurate, biased, offensive, or otherwise unsuitable. We make no representation about output quality, fitness for a particular purpose, or compatibility with your hardware. See Section 9 of the EULA for the full disclaimer.'
    },

    { kind: 'h2', text: '8. Limitation of liability' },
    {
      kind: 'p',
      text: '**TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW**, Comfy Org will not be liable for indirect, incidental, special, consequential, or punitive damages, or for loss of profits, revenue, data, or business opportunity arising from or related to your use of the Desktop App. Our total cumulative liability is capped per Section 10 of the EULA.'
    },

    { kind: 'h2', text: '9. Term and termination' },
    {
      kind: 'p',
      text: 'These Terms take effect when you install or use the Desktop App and continue until terminated. You may terminate by uninstalling the app. We may terminate or suspend your access if you materially breach these Terms or the EULA. Sections 2 (acceptable use), 3 (Your Content), 4 (third-party models), 7 (warranty), 8 (liability), 10 (governing law) survive termination.'
    },

    { kind: 'h2', text: '10. Governing law and disputes' },
    {
      kind: 'p',
      text: 'These Terms are governed by the laws of the **State of Delaware, USA**, excluding its conflict-of-law rules. Any dispute will be resolved exclusively in the state or federal courts located in Delaware. If you are a consumer in a jurisdiction that grants non-waivable consumer rights, this section does not override those rights.'
    },

    { kind: 'h2', text: '11. Changes to these Terms' },
    {
      kind: 'p',
      text: 'We may update these Terms from time to time. The **Effective date** at the top reflects the latest version. Material changes will be surfaced in the Desktop App on first launch after the change. Continued use after the Effective date means you accept the updated Terms.'
    },

    { kind: 'h2', text: '12. Contact' },
    {
      kind: 'ul',
      items: [
        'Terms questions: **legal@comfy.org**',
        'Privacy questions: **privacy@comfy.org**',
        'General: **comfy.org**'
      ]
    }
  ]
}

/* ============================================================
 * Privacy Policy
 * ============================================================ */

export const PRIVACY_POLICY: LegalDoc = {
  effectiveDate: '2026-05-19',
  appliesTo: 'Comfy Desktop',
  blocks: [
    {
      kind: 'p',
      text: 'This Privacy Policy describes what data Comfy Org collects from your use of the Comfy Desktop application, how it is used, who processes it, and the choices and rights you have.'
    },

    { kind: 'h2', text: 'What we collect' },
    { kind: 'h3', text: 'Usage analytics (via PostHog)' },
    {
      kind: 'p',
      text: 'Sent only if you have analytics enabled (toggle on the consent screen and in Settings).'
    },
    {
      kind: 'ul',
      items: [
        'App version and platform (e.g. "Comfy Desktop 1.0.0, macOS 14.4 ARM")',
        'A local device ID generated locally. Before you sign in to Comfy Cloud, this ID is not tied to your name, email, or any hardware identifier we can reverse. Once you sign in, the device ID is linked to your Comfy account.',
        'Feature events ("install completed," "workflow opened," "settings panel opened") with non-identifying metadata',
        'Approximate timing of those events'
      ]
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
        'Network activity outside the app'
      ]
    },

    { kind: 'h3', text: 'Crash reports (via Datadog)' },
    { kind: 'p', text: 'Sent only if you have analytics enabled.' },
    {
      kind: 'ul',
      items: [
        'Stack traces and error messages from crashes',
        'App version, platform',
        'Local device ID (or Comfy account ID if you have signed in)'
      ]
    },
    {
      kind: 'p',
      text: "We **don't** include user content, file paths, or prompts in crash reports. We strip those before sending."
    },

    { kind: 'h3', text: 'What stays on your machine, always' },
    {
      kind: 'ul',
      items: [
        'Your workflow files',
        'Your installed models',
        'Your generated outputs (images, videos, audio)',
        "The list of installations you've created in Desktop",
        'Your local settings'
      ]
    },
    { kind: 'p', text: 'None of these are uploaded, indexed, or accessible to Comfy Org.' },

    { kind: 'h2', text: 'Why we collect what we do' },
    {
      kind: 'ul',
      items: [
        '**Usage analytics**: to understand which features people use, where they get stuck, and what to improve.',
        '**Crash reports**: to find and fix bugs faster.'
      ]
    },
    {
      kind: 'p',
      text: "That's the entire purpose. We don't sell, share, or use this data for advertising."
    },

    { kind: 'h2', text: 'Lawful basis (GDPR / UK GDPR)' },
    {
      kind: 'ul',
      items: [
        '**Consent** (Article 6(1)(a)) for analytics + crash reports — both are opt-in on the consent screen and revocable in Settings.',
        '**Legitimate interests** (Article 6(1)(f)) for update-server requests necessary to deliver software updates and security fixes. You can object via privacy@comfy.org.'
      ]
    },

    { kind: 'h2', text: 'Third-party processors' },
    { kind: 'p', text: 'Data is processed by:' },
    {
      kind: 'ul',
      items: [
        '**PostHog** — product analytics',
        '**Datadog** — crash reports and application logs',
        '**Comfy Org analytics warehouse** — long-term aggregate analytics storage, operated by Comfy Org',
        '**ToDesktop** — application distribution and auto-update servers'
      ]
    },
    {
      kind: 'p',
      text: 'External vendors process data on our behalf under standard data-processing agreements. EU/UK transfers rely on Standard Contractual Clauses where required.'
    },

    { kind: 'h2', text: 'Retention' },
    {
      kind: 'ul',
      items: [
        'Usage analytics: up to **24 months** rolling, then aggregated further or deleted.',
        'Crash reports: up to **15 days** at full fidelity, then sampled or aggregated.',
        'Long-term aggregate analytics: up to **36 months** in aggregated form.',
        'Update-server logs: up to **90 days**.',
        'Local device ID: stored on your machine only, removed on uninstall.'
      ]
    },

    { kind: 'h2', text: 'Your choices' },
    {
      kind: 'ul',
      items: [
        '**Turn off analytics**: Settings → Telemetry → toggle off. Future events stop immediately; any in-flight requests already on the wire may complete.',
        "**Delete past data**: email **privacy@comfy.org** with your approximate install date, platform, and version. We'll do a best-effort match and remove associated records within 30 days.",
        "**Stop using the app**: uninstalling Desktop ends data collection. We don't keep tracking IDs after uninstall."
      ]
    },

    { kind: 'h2', text: 'Your rights' },
    {
      kind: 'p',
      text: "If you're in the EU, UK, or EEA, you have rights under GDPR / UK GDPR — access, rectification, erasure, restriction, objection, portability. Email **privacy@comfy.org** to exercise them."
    },
    {
      kind: 'p',
      text: "If you're in California, you have rights under CCPA / CPRA — know, delete, correct, opt out of sale/sharing (note: we don't sell or share data for cross-context behavioral advertising), and limit use of sensitive personal information."
    },
    {
      kind: 'p',
      text: "You also have the right to lodge a complaint with your local data protection authority (e.g. your EU country's supervisory authority, the UK ICO, or the California Privacy Protection Agency)."
    },

    { kind: 'h2', text: 'Identity verification' },
    {
      kind: 'p',
      text: "The Desktop App doesn't require an account, so before you sign in to Comfy Cloud you are not directly identified to us — the only identifier we hold is a local device ID. If you sign in to Comfy Cloud, your telemetry is linked to your account from that point forward. For deletion or access requests, sign in and use your account to identify yourself; or, if you have never signed in, tell us your approximate install date, platform, and version and we'll do a best-effort match against our records."
    },

    { kind: 'h2', text: 'Children' },
    {
      kind: 'p',
      text: "Comfy Desktop is not intended for users under 13. If you believe a child has used the app, contact **privacy@comfy.org** and we'll remove related records."
    },

    { kind: 'h2', text: 'Changes to this policy' },
    {
      kind: 'p',
      text: "We'll update this document as the product evolves. The **Effective** date at the top changes when we revise. During the beta, we may iterate without re-prompting you to re-accept; at GA, we'll prompt for a fresh acceptance of the final policy."
    },

    { kind: 'h2', text: 'Contact' },
    {
      kind: 'p',
      text: '**privacy@comfy.org** for any privacy-related question or request.'
    }
  ]
}

/* ============================================================
 * Third-Party Notices
 * ============================================================ */

export const THIRD_PARTY_NOTICES: LegalDoc = {
  effectiveDate: '2026-05-19',
  appliesTo: 'Comfy Desktop',
  blocks: [
    { kind: 'h2', text: 'About this document' },
    {
      kind: 'p',
      text: 'Comfy Desktop is built on top of, and bundles, third-party open-source software. This document lists the major components, their licenses, and the required attribution notices. A complete auto-generated list (including transitive dependencies) is produced as part of the build pipeline before GA.'
    },
    {
      kind: 'p',
      text: 'The Desktop App is distributed as a single application that statically and dynamically links many open-source libraries. The MIT License (under which our own source code is released, see `/LICENSE`) and most of the licenses below permit this kind of bundling. Where a license requires inclusion of copyright notices, those notices are reproduced below; the original license text is referenced by URL.'
    },

    { kind: 'h2', text: 'Application framework' },
    {
      kind: 'ul',
      items: [
        '**Electron** — MIT — github.com/electron/electron (bundles Chromium, V8, Node.js, each under its own license)',
        '**Chromium** (bundled by Electron) — BSD-3-Clause and others — chromium.googlesource.com',
        '**V8** (bundled by Electron) — BSD-3-Clause — v8.dev',
        '**Node.js** (bundled by Electron) — MIT and others — github.com/nodejs/node'
      ]
    },

    { kind: 'h2', text: 'UI framework (bundled by Vite into the renderer)' },
    {
      kind: 'ul',
      items: [
        '**Vue.js** — MIT — github.com/vuejs/core',
        '**Pinia** — MIT — github.com/vuejs/pinia',
        '**@vueuse/core** — MIT — github.com/vueuse/vueuse',
        '**Vue I18n** — MIT — github.com/intlify/vue-i18n',
        '**Tailwind CSS** — MIT — github.com/tailwindlabs/tailwindcss',
        '**Lucide Icons (Vue bindings)** — ISC — github.com/lucide-icons/lucide'
      ]
    },

    { kind: 'h2', text: 'Runtime services' },
    {
      kind: 'ul',
      items: [
        '**electron-updater** — MIT — github.com/electron-userland/electron-builder',
        '**Datadog Browser RUM** — Apache License 2.0 — github.com/DataDog/browser-sdk',
        '**PostHog (Node)** — MIT — github.com/PostHog/posthog-js-lite'
      ]
    },

    { kind: 'h2', text: 'Distribution and packaging' },
    {
      kind: 'ul',
      items: [
        '**ToDesktop runtime** — proprietary, used under SaaS terms with no redistribution restrictions on the runtime files bundled into our app — todesktop.com',
        '**7zip-bin** — MIT (wrapper) + LGPL-2.1 with linking exception + BSD-3-Clause (7-Zip core) + unRAR restriction (RAR decoder may not be used to develop programs able to decode any RAR archive) — github.com/develar/7zip-bin · 7-zip.org/license.txt'
      ]
    },

    { kind: 'h2', text: 'File and data utilities' },
    {
      kind: 'ul',
      items: [
        '**smol-toml** — BSD-3-Clause — github.com/squirrelchat/smol-toml',
        '**tar** — ISC — github.com/isaacs/node-tar',
        '**systeminformation** — MIT — github.com/sebhildebrandt/systeminformation'
      ]
    },

    { kind: 'h2', text: 'Bundled Python runtime' },
    {
      kind: 'p',
      text: 'The Desktop App bundles a minimal "bootstrap" Python environment so the first ComfyUI installation can proceed without the user installing Python separately. The bootstrap is built from the following components, each redistributed under its own license:'
    },
    {
      kind: 'ul',
      items: [
        '**python-build-standalone** (CPython distribution) — MIT (distribution build scripts + binary artifacts) + Python Software Foundation License v2 (the embedded CPython interpreter and standard library) — github.com/astral-sh/python-build-standalone',
        '**pygit2** (bundled into the bootstrap via pip) — GPL v2 with a linking exception (permits combining pygit2 with software under different licenses, including proprietary) — github.com/libgit2/pygit2',
        '**libgit2** (bundled by the pygit2 wheel) — GPL v2 with a linking exception — github.com/libgit2/libgit2'
      ]
    },
    {
      kind: 'p',
      text: "Only this lightweight bootstrap environment is part of the Desktop App's distributed binary; full Python environments used by individual ComfyUI installs are created on-disk at runtime, are not part of our binary, and are governed by their components' licenses directly."
    },

    { kind: 'h2', text: 'Components Desktop installs but does NOT bundle' },
    {
      kind: 'p',
      text: 'Comfy Desktop is a **shell** that installs and manages ComfyUI environments. The following components are downloaded and set up on your machine at runtime (per your action). They are **not part of the Comfy Desktop binary** and are governed by their own licenses, which apply directly between you and the respective authors:'
    },
    {
      kind: 'ul',
      items: [
        '**ComfyUI core** — downloaded from github.com/comfyanonymous/ComfyUI under its own license.',
        '**ComfyUI custom nodes** — installed at your direction from the ComfyUI Manager catalog or other sources, each under its own license.',
        '**AI models** (checkpoints, LoRAs, VAEs) — downloaded at your direction from sources like Hugging Face, Civitai, or partner APIs. Each model has its own license terms.',
        '**Python packages** installed into ComfyUI environments by ComfyUI Manager or pip — each under its own license.'
      ]
    },
    {
      kind: 'p',
      text: 'Comfy Org does not control the licensing of these components and is not a party to the agreements between you and their respective authors.'
    },

    { kind: 'h2', text: 'Contact' },
    {
      kind: 'p',
      text: 'For any question about third-party components or attributions, email **legal@comfy.org**.'
    }
  ]
}

/* ============================================================
 * Lookup map for `TermsModal`'s `doc` prop.
 * ============================================================ */

export const LEGAL_DOCS: Record<LegalDocId, LegalDoc> = {
  eula: EULA,
  tos: TOS,
  privacy: PRIVACY_POLICY,
  notices: THIRD_PARTY_NOTICES
}
