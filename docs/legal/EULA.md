# End-User License Agreement (EULA)

**Effective date:** 2026-05-08
**Applies to:** ComfyUI Desktop 2.0 (the "Desktop App," "we," "us," "our")
**Publisher:** Comfy Org

---

## TL;DR (Plain-English summary)

- Comfy Desktop 2.0 is free to install and use, including commercially.
- Our **source code is open-source under the MIT License** (see [`/LICENSE`](../../LICENSE)). This EULA governs only the **compiled binary** we distribute via comfy.org and our update servers.
- Your workflows, models, and generated content **stay on your machine**. We don't see them, store them, or have any rights to them.
- We collect **anonymous usage analytics and crash reports**, which you can turn off at any time. Details are in the [Privacy Policy](./PRIVACY_POLICY.md).
- We provide the Desktop App **"as-is"** — no warranties, no guarantees. To the extent permitted by law, our liability is capped.
- You can stop using the Desktop App at any time. Uninstalling it ends our agreement.

If you don't agree to these terms, don't install or use the Desktop App.

---

## 1. Definitions

- **"Desktop App"** means the ComfyUI Desktop 2.0 application, including all binaries, installers, signed packages, scripts, configuration, and bundled assets we distribute under the names "ComfyUI Desktop 2.0," "Comfy Desktop 2," or any successor naming.
- **"You"** means the individual or entity installing or using the Desktop App.
- **"Source Code"** means the open-source source code published at [github.com/Comfy-Org/ComfyUI-Desktop-2.0-Beta](https://github.com/Comfy-Org/ComfyUI-Desktop-2.0-Beta).
- **"Your Content"** means any workflows, prompts, models, generated outputs, configurations, or other data you create, import, or store using the Desktop App.

## 2. License grant

Subject to the terms of this EULA, we grant you a **worldwide, non-exclusive, royalty-free, revocable** license to:

- Install the Desktop App on any number of devices you own or control.
- Use the Desktop App for personal, internal-business, or commercial purposes.
- Make backup copies of the installed Desktop App.

**Source code:** The Source Code from which the Desktop App is compiled is separately licensed under the **MIT License** — that license is unaffected by this EULA, and nothing in this EULA limits the rights granted by the MIT License with respect to the Source Code itself.

This EULA governs only your use of the **compiled binary** we distribute (which includes auto-update behavior, bundled dependencies, telemetry endpoints, branding, and signed installers) — components that are not part of the open-source Source Code.

## 3. Permitted use and restrictions

You may use the Desktop App for any lawful purpose. You agree **not to**:

- Use the Desktop App in violation of any applicable law, regulation, or third-party right.
- Use the Desktop App to generate or distribute content that is illegal in your jurisdiction, including but not limited to child sexual abuse material (CSAM), non-consensual intimate imagery, or material that infringes another person's intellectual property.
- Remove, alter, or obscure any copyright, trademark, or other proprietary notices in the Desktop App's user interface.
- Use the Comfy Org name, logo, or branding to imply endorsement or affiliation that does not exist (see Section 8, Trademarks).
- Distribute modified compiled binaries under our trademarks (you may modify and redistribute the **Source Code** under the MIT License, but the resulting binaries must not be branded as "ComfyUI Desktop," "Comfy Desktop," or any confusingly similar name).
- Use the Desktop App to develop a competing product that is substantially derived from the proprietary (non-MIT) portions of the distributed binary, such as our signed installer wrapper or auto-update integration. *[REVIEW: tighten or remove based on competitive-protection stance; MIT-licensed core does not allow blanket non-compete restrictions.]*

## 4. Updates and auto-update

The Desktop App includes an automatic update mechanism that may, from time to time:

- Check our update servers for new versions.
- Download and install updates automatically or after your confirmation, depending on your settings.
- Update bundled dependencies (Python runtime, ComfyUI core, etc.) as part of the app's normal operation.

You can disable automatic updates in Settings. If you do, you accept responsibility for keeping the Desktop App up to date and acknowledge that security fixes will not be applied automatically.

We may discontinue support for older versions of the Desktop App at any time without notice. Discontinued versions may stop working with our cloud services, partner APIs, or model formats. *[REVIEW: refine to reflect actual support window before GA.]*

## 5. Data collection

The Desktop App collects anonymous telemetry (usage analytics and crash reports) as described in our [Privacy Policy](./PRIVACY_POLICY.md). You can turn telemetry off at any time in Settings → Desktop panel → Telemetry. Doing so does not affect your ability to use the Desktop App.

Your workflows, models, prompts, and generated outputs are **not** transmitted to us and remain on your local machine.

If you separately sign in to **Comfy Cloud** from within the Desktop App, that activity is governed by the [Comfy Org Terms of Service](https://comfy.org/terms) and the Comfy Cloud privacy notice — not by this EULA or Privacy Policy.

## 6. Your Content

You retain **all rights** to Your Content. We claim no ownership, license, or interest in:

- Workflows you create or import
- Prompts you write
- Models you install
- Images, videos, audio, or other outputs you generate
- Configurations and settings

Because the Desktop App runs locally and we don't transmit Your Content, this is mostly self-evident — we simply have no copy of it and no ability to use it.

You are solely responsible for ensuring that Your Content does not infringe third-party rights or violate applicable laws.

## 7. Third-party components

### 7.1 Components bundled in the Desktop App

The Desktop App bundles the following major third-party open-source and commercial components, each under their own licenses:

- **Electron** (Chromium and Node.js) — MIT License
- **Vue 3, Pinia, Tailwind, Vite** — MIT License
- **Datadog Browser RUM** — Apache 2.0 License
- **PostHog (JS and Node SDKs)** — MIT License
- **ToDesktop runtime** — vendor terms
- **bootstrap-python** (minimal Python runtime, bundled to enable first-install of ComfyUI) — Python Software Foundation License

A complete list of bundled third-party components and their licenses is in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) and in the About panel within the Desktop App.

### 7.2 Components Desktop installs but does not bundle

The Desktop App is a **shell** that installs and manages ComfyUI environments on your machine. The following are **not part of the Desktop App's distributed binary** but are downloaded and installed on your machine at your direction. They are governed by their own licenses, which apply to your use directly:

- **ComfyUI core** (downloaded from https://github.com/comfyanonymous/ComfyUI under its own license)
- **ComfyUI custom nodes** (installed at your direction from ComfyUI Manager or other sources, each under its own license)
- **AI models** (checkpoints, LoRAs, etc.) you choose to download and install (each under its own license, e.g. Stable Diffusion, FLUX, etc.)
- **Python packages** installed into individual ComfyUI environments

You agree to comply with the terms of each third-party license that applies to components you bundle with or install through the Desktop App. Comfy Org is not a party to the agreements between you and the authors of components in Section 7.2.

## 8. Trademarks

"Comfy," "ComfyUI," "Comfy Desktop," "Comfy Cloud," and the Comfy logo are trademarks of Comfy Org. Nothing in this EULA grants you a license to use those marks. *[REVIEW: confirm registered status and exact trademark portfolio; update if applicable.]*

You may make non-commercial, descriptive references to the Desktop App in articles, tutorials, and reviews. You may not use our trademarks to brand modified versions, competing products, or services that imply endorsement we have not given.

## 9. Disclaimer of warranty

**THE DESKTOP APP IS PROVIDED "AS-IS" AND "AS-AVAILABLE," WITHOUT WARRANTIES OF ANY KIND, WHETHER EXPRESS, IMPLIED, OR STATUTORY**, including (but not limited to) warranties of merchantability, fitness for a particular purpose, title, non-infringement, accuracy, or uninterrupted operation.

We do not warrant that the Desktop App will be error-free, secure, or compatible with your hardware, operating system, or third-party software. Generative AI models bundled with or installed by the Desktop App may produce inaccurate, biased, offensive, or otherwise unsuitable outputs; we make no representation about output quality or fitness.

Some jurisdictions do not allow exclusion of certain implied warranties, so some of these exclusions may not apply to you.

## 10. Limitation of liability

**TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW**, in no event shall Comfy Org, its officers, employees, contractors, or affiliates be liable for:

- Indirect, incidental, special, consequential, exemplary, or punitive damages.
- Loss of profits, revenue, data, goodwill, or business opportunity.
- Costs of substitute goods or services.
- Damages resulting from your inability to use the Desktop App, errors in generated outputs, or interactions with third-party services.

Our **total cumulative liability** to you for all claims arising from or related to the Desktop App will not exceed **the greater of (a) USD 100 or (b) the total amount you have paid us for the Desktop App in the 12 months preceding the claim**, which for most users will be USD 100 because the Desktop App is free. *[REVIEW: confirm liability cap with counsel; standard for free software is the minimum permitted by law.]*

Some jurisdictions do not allow these limitations, so some may not apply to you. In such jurisdictions, our liability is limited to the maximum extent permitted by law.

## 11. Term and termination

This EULA takes effect when you install or use the Desktop App and continues until terminated.

**You may terminate** this EULA at any time by uninstalling the Desktop App. Uninstalling stops new telemetry collection. Past anonymous telemetry records remain in our systems subject to the retention terms in the [Privacy Policy](./PRIVACY_POLICY.md).

**We may terminate** this EULA if you materially breach it. Upon termination, you must stop using the Desktop App and uninstall it. Sections that by their nature survive termination (Sections 6, 9, 10, 12, 13, 14) will survive.

## 12. Export and sanctions compliance

You represent that you are not located in, and will not use the Desktop App from, a country subject to a comprehensive U.S. embargo (currently Cuba, Iran, North Korea, Syria, and the Crimea, Donetsk, and Luhansk regions of Ukraine), and that you are not on a U.S. government denied-party list. You agree to comply with all applicable export control and sanctions laws when using the Desktop App.

*[REVIEW: align list with current OFAC sanctions before GA.]*

## 13. Governing law and disputes

This EULA is governed by the laws of the **State of Delaware, USA**, excluding its conflict-of-law rules. Any dispute arising from this EULA will be resolved exclusively in the state or federal courts located in Delaware, and you consent to the personal jurisdiction of those courts.

*[REVIEW: confirm Comfy Org's legal jurisdiction and dispute-resolution preference (e.g. arbitration vs courts, Delaware vs California). The above is a reasonable US-software default but should be confirmed.]*

If you are a consumer in the EU, UK, or another jurisdiction that grants non-waivable consumer rights, this section does not override those rights.

## 14. Assignment

You may not assign or transfer this EULA or any rights under it without our prior written consent. We may assign this EULA, in whole or in part, to any successor entity (e.g. in connection with a merger, acquisition, or sale of substantially all of our assets) without your consent, provided that the successor agrees to be bound by the terms of this EULA.

## 15. No agency, partnership, or joint venture

Nothing in this EULA creates an agency, partnership, joint venture, or employment relationship between you and Comfy Org.

## 16. Force majeure

Neither party is liable for failure to perform under this EULA when caused by events outside reasonable control (natural disaster, war, terrorism, civil unrest, government action, internet or infrastructure outages, pandemic, etc.), provided that we make commercially reasonable efforts to resume performance.

## 17. Changes to this EULA

We may update this EULA from time to time. The **Effective date** at the top reflects the latest version. Material changes will be surfaced in the Desktop App (e.g. on first launch after the change). Your continued use of the Desktop App after the Effective date means you accept the updated EULA. If you don't agree to the changes, your remedy is to stop using and uninstall the Desktop App.

## 18. Severability

If any provision of this EULA is held unenforceable, the remaining provisions remain in full effect.

## 19. Entire agreement

This EULA, together with the [Privacy Policy](./PRIVACY_POLICY.md), the [Comfy Org Terms of Service](https://comfy.org/terms) (for any cloud services you separately access), and the MIT License for the Source Code, constitutes the entire agreement between you and Comfy Org regarding the Desktop App.

## 20. Contact

Questions about this EULA: **legal@comfy.org**
Privacy questions: **privacy@comfy.org**
General support: through Comfy Org's official channels at [comfy.org](https://comfy.org)

---

*Items marked `[REVIEW]` flag sections where counsel input is particularly important before GA. This document is an AI-drafted starting point.*
