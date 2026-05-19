# Comfy Desktop 2.0 — Legal

> **⚠️ AI-drafted starting point.** These documents were drafted by AI as a starting point for legal review. They are NOT a substitute for review by qualified counsel before public use. Before GA, an attorney should review each document for jurisdiction-specific compliance (US, EU/GDPR, UK, California/CCPA, etc.), trademark protection, and any product-specific terms. Items flagged `[REVIEW]` in each file are particularly important.

## Desktop 2.0 is a shell

A note on scope, because it shapes how each document below is written:

Desktop 2.0 is a **shell** for installing and managing ComfyUI environments. The Desktop App's distributed binary is what these legal docs govern. **ComfyUI itself, custom nodes, and AI models are installed on your machine at runtime — they are not part of the Desktop App's binary** and are governed by their own licenses, not ours.

In practical terms:

- **In the Desktop binary:** Electron, Vue, telemetry SDKs, electron-updater, ToDesktop runtime, bootstrap-python, our own UI code, etc. → covered by [`EULA.md`](./EULA.md) and [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).
- **Installed by Desktop at runtime, not bundled:** ComfyUI core, custom nodes, AI models, full Python environments → governed by their own licenses, which apply directly between you and the respective authors.

## What's here

| File | Purpose | Covers |
|------|---------|--------|
| [`EULA.md`](./EULA.md) | End-User License Agreement | The terms governing your use of the **Desktop App's distributed binary** (auto-update, telemetry, warranty disclaimer, liability cap, etc.). The Desktop App's source code is separately licensed under MIT (see `/LICENSE`); the EULA layers on top of that for the compiled binary we distribute. |
| [`PRIVACY_POLICY.md`](./PRIVACY_POLICY.md) | Privacy Policy | What data Comfy Desktop 2.0 collects, why, who processes it, and how you can opt out, access, or delete. Long-form version of the in-product policy at `src/renderer/src/lib/privacyPolicy.ts`. |
| [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) | Open-source attributions | Licenses and copyright notices for components **bundled in the Desktop App's binary**. Components Desktop installs at runtime (ComfyUI, custom nodes, models) are noted but not redistributed by us. |

## What's NOT here, and why

### Terms of Service (ToS)

For the Desktop app, the EULA **is** the Terms of Service — they're the same document, written as an EULA because the dominant use is "install and run software." The in-product consent screen labels the checkbox "Accept the EULA and Terms of Service" to make this explicit, and the EULA modal is what opens when the user clicks Learn more on that row.

The broader **comfy.org Terms of Service** (covering the website, accounts, and Comfy Cloud) lives at [comfy.org/terms](https://comfy.org/terms) — when you sign in to Comfy Cloud from Desktop, you're agreeing to those terms separately.

### Acceptable Use Policy (AUP)

The Desktop app runs locally and generates content based on what you prompt for. We don't host, process, or moderate the outputs. AUP-style restrictions on what you can generate are governed by the model licenses (Stable Diffusion, FLUX, etc.) and Comfy Cloud's terms — not by us.

### Cookie Policy

Desktop is not a website. The embedded Comfy Cloud sign-in flow may use cookies in the standard browser sense, which is covered by the Privacy Policy.

### Licenses for ComfyUI, custom nodes, and AI models

The Desktop App installs ComfyUI, custom nodes, and AI models at your direction at runtime; it does not bundle or redistribute them. Each component carries its own license, which applies directly between you and the respective author. We are not a party to those agreements, and we don't restate their terms here. Check each component's repository or distribution page for its license.

## Authoring notes

These documents try to be:

- **Plain-English-first.** Each major doc opens with a TL;DR before any legal language. Most users will only read the summary, and that's fine.
- **Specific.** Generic boilerplate is replaced with what Comfy Desktop actually does. If a section doesn't apply to us, it's not there.
- **Honest.** Where uncertainty exists (workspace sharing reliability, cloud-bridge data flows during sign-in), the documents say so rather than overclaiming.

## When to update

- **Privacy Policy:** any time we add a new data-collection point, change a third-party processor, or change retention. Update both this file AND `src/renderer/src/lib/privacyPolicy.ts` together. The in-product version is the consent-screen excerpt; this file is the full version.
- **EULA:** when we change the license model, add new restrictions, or modify auto-update behavior.
- **Third-Party Notices:** when adding/removing significant dependencies. Should ideally be auto-generated as part of the build pipeline before GA.

## Effective dates and acceptance flow

| Doc | Current Effective Date | How it's accepted in-product |
|-----|------------------------|------------------------------|
| EULA (= ToS for the Desktop app) | See `EULA.md` | First-launch consent screen: required "Accept the EULA and Terms of Service" checkbox; full text opens in `TermsModal` via the Learn more link on that row. |
| Privacy Policy | See `PRIVACY_POLICY.md` | First-launch consent screen: optional telemetry checkbox; full text opens in `TermsModal` via the Learn more link on that row. Settings → Telemetry exposes the same toggle. |
| Third-Party Notices | See `THIRD_PARTY_NOTICES.md` | Reachable from Settings → About; the in-product structured copy is `THIRD_PARTY_NOTICES` in `src/renderer/src/lib/privacyPolicy.ts`. |

## Contact

- Privacy questions / data requests: **privacy@comfy.org**
- Legal / commercial: **legal@comfy.org** *(set up before GA if not already)*

---

*Last updated: 2026-05-19 · AI-drafted starting point pending counsel review*
