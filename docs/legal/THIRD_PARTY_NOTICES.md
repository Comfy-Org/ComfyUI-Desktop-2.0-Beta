# Third-Party Notices

**Effective date:** 2026-05-08

**Applies to:** ComfyUI Desktop 2.0

---

## About this document

ComfyUI Desktop 2.0 (the "Desktop App") is built on top of, and bundles, third-party open-source software. This document lists the major third-party components, their licenses, and the required attribution notices.

> **Status: AI-drafted starting point.** This is the list of major direct dependencies. A complete, auto-generated list (including transitive dependencies) should be produced as part of the build pipeline before GA, and surfaced in the Desktop App's About panel. Items marked `[VERIFY]` need confirmation of the bundled version + license at build time.

## Aggregation

The Desktop App is distributed as a single application that statically and dynamically links many open-source libraries. The MIT License (under which our own source code is released, see [`/LICENSE`](../../LICENSE)) and most of the licenses below permit this kind of bundling. Where a license requires inclusion of copyright notices, those notices are reproduced in the per-component sections below; the original license text is referenced by URL.

The full text of every license listed is also available in the Desktop App's About panel.

---

## Application framework

### Electron
- **Version:** 40.4.1
- **License:** MIT
- **Source:** https://github.com/electron/electron
- **Notice:** Electron bundles Chromium, V8, Node.js, and other components, each with their own licenses (see "Bundled by Electron" below).

### Chromium (bundled by Electron)
- **License:** BSD-3-Clause and others
- **Source:** https://chromium.googlesource.com/chromium/src/
- **Notice:** Chromium includes substantial third-party code under various permissive licenses (BSD-3-Clause, BSD-2-Clause, MIT, ISC, Apache 2.0, Zlib, etc.).

### V8 JavaScript engine (bundled by Electron)
- **License:** BSD-3-Clause
- **Source:** https://v8.dev/

### Node.js (bundled by Electron)
- **License:** MIT and others
- **Source:** https://github.com/nodejs/node

---

## UI framework

### Vue.js
- **Version:** ^3.5.25
- **License:** MIT
- **Source:** https://github.com/vuejs/core

### Pinia
- **Version:** ^3.0.3
- **License:** MIT
- **Source:** https://github.com/vuejs/pinia

### @vueuse/core
- **Version:** ^13.5.0
- **License:** MIT
- **Source:** https://github.com/vueuse/vueuse

### Vue I18n
- **Version:** ^11.1.6
- **License:** MIT
- **Source:** https://github.com/intlify/vue-i18n

### Tailwind CSS
- **Version:** ^4.1.8
- **License:** MIT
- **Source:** https://github.com/tailwindlabs/tailwindcss

### Lucide Icons (Vue bindings)
- **Version:** ^0.525.0
- **License:** ISC
- **Source:** https://github.com/lucide-icons/lucide

---

## Build and runtime tooling

### Vite
- **Version:** ^7.3.1
- **License:** MIT
- **Source:** https://github.com/vitejs/vite

### electron-vite
- **Version:** ^5.0.0
- **License:** MIT
- **Source:** https://github.com/alex8088/electron-vite

### electron-builder
- **Version:** ^26.7.0
- **License:** MIT
- **Source:** https://github.com/electron-userland/electron-builder

### electron-updater
- **Version:** ^6.7.3
- **License:** MIT
- **Source:** https://github.com/electron-userland/electron-builder

---

## Telemetry and observability

### Datadog Browser RUM
- **Version:** 6.28.1
- **License:** Apache License 2.0
- **Source:** https://github.com/DataDog/browser-sdk
- **Notice:** Used to capture anonymous error reports and performance metrics when telemetry is enabled. See [Privacy Policy](./PRIVACY_POLICY.md) for details.

### PostHog (JS)
- **Version:** ^1.372.4
- **License:** MIT
- **Source:** https://github.com/PostHog/posthog-js

### PostHog (Node)
- **Version:** ^5.30.7
- **License:** MIT
- **Source:** https://github.com/PostHog/posthog-js-lite

---

## Distribution and packaging

### ToDesktop runtime
- **Version:** ^2.1.3
- **License:** *[VERIFY: commercial runtime — confirm license terms with ToDesktop. Likely proprietary used under SaaS terms with no redistribution restrictions on the runtime files bundled into our app.]*
- **Source:** https://www.todesktop.com/

### 7zip-bin
- **Version:** ^5.2.0
- **License:** MIT (wrapper) + LGPL-2.1 with linking exception + BSD-3-Clause (7-Zip core) + unRAR restriction (RAR decoder component, may not be used to develop a program able to decode any RAR archive)
- **Source:** https://github.com/develar/7zip-bin
- **Notice:** Contains the 7-Zip binaries distributed under their respective licenses. The 7-Zip source and full license text are available at https://www.7-zip.org/license.txt.

---

## File and data utilities

### smol-toml
- **Version:** ^1.6.1
- **License:** BSD-3-Clause
- **Source:** https://github.com/squirrelchat/smol-toml

### tar
- **Version:** ^7.5.11
- **License:** ISC
- **Source:** https://github.com/isaacs/node-tar

### systeminformation
- **Version:** ^5.31.5
- **License:** MIT
- **Source:** https://github.com/sebhildebrandt/systeminformation
- **Notice:** Used to gather non-personal system information (OS, GPU, CPU, memory) when telemetry is enabled. See [Privacy Policy](./PRIVACY_POLICY.md) for details on what is collected.

---

## Bundled Python runtime

The Desktop App bundles a minimal "bootstrap" Python environment as an extra resource so that the very first ComfyUI installation can proceed without the user installing Python separately. The bootstrap is built by `scripts/build-bootstrap-python.mjs` from the following components, each redistributed under its own license:

### python-build-standalone (CPython distribution)
- **Source:** https://github.com/astral-sh/python-build-standalone
- **License:** MIT (distribution build scripts and binary artifacts) + Python Software Foundation License v2 (the embedded CPython interpreter and standard library)

### pygit2 (bundled into the bootstrap via pip)
- **Source:** https://github.com/libgit2/pygit2
- **License:** GPL v2 with a linking exception (the linking exception permits combining pygit2 with software under different licenses, including proprietary, without making the combined work GPL)

### libgit2 (bundled by the pygit2 wheel)
- **Source:** https://github.com/libgit2/libgit2
- **License:** GPL v2 with a linking exception (same linking exception as pygit2)

Only this lightweight bootstrap environment is part of the Desktop App's distributed binary; full Python environments used by individual ComfyUI installs are created on-disk at runtime, are not part of our binary, and are governed by their components' licenses directly.

*[VERIFY: confirm the exact python-build-standalone release pinned in `scripts/build-bootstrap-python.mjs` and the resolved pygit2 + libgit2 versions before GA.]*

---

## Components Desktop 2.0 installs but does not bundle

Desktop 2.0 is a **shell** that installs and manages ComfyUI environments. The following components are downloaded and set up on your machine at runtime (per your action). They are **not part of the Desktop 2.0 binary** and are governed by their own licenses, which apply to your use directly:

- **ComfyUI core** — downloaded from https://github.com/comfyanonymous/ComfyUI under its own license.
- **ComfyUI custom nodes** — installed at your direction from the ComfyUI Manager catalog or other sources, each under its own license.
- **AI models** (checkpoints, LoRAs, VAEs, etc.) — downloaded at your direction from sources like Hugging Face, Civitai, or partner APIs. Each model has its own license terms.
- **Python packages** installed into ComfyUI environments by ComfyUI Manager or `pip` — each under its own license.

Comfy Org does not control the licensing of these components and is not a party to the agreements between you and their respective authors.

---

## Documentation and other notices

This document, the [EULA](./EULA.md), and the [Privacy Policy](./PRIVACY_POLICY.md) are © 2026 Comfy Org. They are AI-drafted starting points provided for internal review; we make no representation about their legal sufficiency for any other party's use, and no license is granted by their inclusion in this repository.

---

## How to generate a complete list before GA

The list above is hand-curated and covers the major components actually bundled into the shipped Desktop binary (renderer + main process + bootstrap Python). Note that the basis is "bundled in the shipped binary" rather than `package.json` classification — Vite bundles many `devDependencies` (Vue, Pinia, vueuse, Tailwind, etc.) into the renderer at build time. For a fully accurate THIRD_PARTY_NOTICES file before GA, the build pipeline should:

1. Run `pnpm licenses list --long --prod` (built-in, matches the resolved lockfile) or an equivalent license-scanning tool to capture every transitive dependency that ends up in the bundle.
2. Filter to **runtime** dependencies that end up in the shipped binary (dev tools, test runners, linters generally don't need attribution because they're not distributed).
3. Output a generated section appended to this document or a separate auto-generated file referenced from this one.
4. Surface the list in the Desktop App's About panel as a scrollable view (similar to the inline privacy policy on the consent screen).

A target convention:
```
docs/legal/
├── README.md
├── EULA.md
├── PRIVACY_POLICY.md
├── THIRD_PARTY_NOTICES.md             ← curated (this file)
└── THIRD_PARTY_NOTICES.generated.md   ← build-pipeline output
```

---

## Updates to this document

This document is updated when:
- We add or remove a significant runtime dependency.
- A bundled component's license changes.
- A new version of a bundled runtime is shipped that materially affects attribution.

For any question about third-party components or attributions, email **legal@comfy.org**.

---

*This document is an AI-drafted starting point. The lists above reflect the major components bundled into the shipped Desktop binary (renderer, main process, bootstrap Python) as of 2026-05-08 and should be expanded with a full transitive-dependency scan before GA. Items marked `[VERIFY]` flag entries that need confirmation.*
