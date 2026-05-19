# Comfy Desktop 2.0 — Legal

## Desktop 2.0 is a shell

A note on scope, because it shapes how each document below is written:

Desktop 2.0 is a **shell** for installing and managing ComfyUI environments. The Desktop App's distributed binary is what these legal docs govern. **ComfyUI itself, custom nodes, and AI models are installed on your machine at runtime — they are not part of the Desktop App's binary** and are governed by their own licenses, not ours.

In practical terms:

- **In the Desktop binary:** Electron, Vue, telemetry SDKs, electron-updater, ToDesktop runtime, bootstrap-python, our own UI code, etc. → covered by [`EULA.md`](./EULA.md) and [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).
- **Installed by Desktop at runtime, not bundled:** ComfyUI core, custom nodes, AI models, full Python environments → governed by their own licenses, which apply directly between you and the respective authors.

## What's here

| File | Purpose | Covers |
|------|---------|--------|
| [`EULA.md`](./EULA.md) | End-User License Agreement | The technical license for the **Desktop App's distributed binary** (license grant, restrictions, auto-update, warranty disclaimer, liability cap). The Desktop App's source code is separately licensed under MIT (see `/LICENSE`); the EULA layers on top for the compiled binary. |
| [`TOS.md`](./TOS.md) | Terms of Service | The usage rules for the Desktop App (acceptable use, content policy, your responsibilities, dispute resolution). The EULA covers the license; the ToS covers how you use what's licensed. |
| [`PRIVACY_POLICY.md`](./PRIVACY_POLICY.md) | Privacy Policy | What data Comfy Desktop 2.0 collects, why, who processes it, and how you can opt out, access, or delete. Long-form version of the in-product policy at `src/renderer/src/lib/privacyPolicy.ts`. |
| [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) | Open-source attributions | Licenses and copyright notices for components **bundled in the Desktop App's binary**. Components Desktop installs at runtime (ComfyUI, custom nodes, models) are noted but not redistributed by us. |

## What's NOT here, and why

### comfy.org Terms of Service (separate from the Desktop ToS)

The broader **comfy.org Terms of Service** (covering the website, accounts, and Comfy Cloud) lives at [comfy.org/terms](https://comfy.org/terms) — when you sign in to Comfy Cloud from Desktop, you're agreeing to those terms separately from the Desktop ToS in this folder.

### Acceptable Use Policy (AUP)

The Desktop app runs locally and generates content based on what you prompt for. We don't host, process, or moderate the outputs. AUP-style restrictions on what you can generate are governed by the model licenses (Stable Diffusion, FLUX, etc.) and Comfy Cloud's terms — not by us.

### Cookie Policy

Desktop is not a website. The embedded Comfy Cloud sign-in flow may use cookies in the standard browser sense, which is covered by the Privacy Policy.

### Licenses for ComfyUI, custom nodes, and AI models

The Desktop App installs ComfyUI, custom nodes, and AI models at your direction at runtime; it does not bundle or redistribute them. Each component carries its own license, which applies directly between you and the respective author. We are not a party to those agreements, and we don't restate their terms here. Check each component's repository or distribution page for its license.

## Authoring notes

These documents try to be:

- **Specific.** Generic boilerplate is replaced with what Comfy Desktop actually does. If a section doesn't apply to us, it's not there.
- **Honest.** Where there is nuance — e.g. usage data is keyed by a local device ID before sign-in and linked to your Comfy account after sign-in — the documents say so plainly rather than overclaiming anonymity.

## When to update

- **Privacy Policy:** any time we add a new data-collection point, change a third-party processor, or change retention. Update both this file AND `src/renderer/src/lib/privacyPolicy.ts` together. The in-product version is the consent-screen excerpt; this file is the full version.
- **EULA:** when we change the license model, add new restrictions, or modify auto-update behavior.
- **Third-Party Notices:** when adding/removing significant dependencies. Should ideally be auto-generated as part of the build pipeline before GA.

## Effective dates and acceptance flow

| Doc | Current Effective Date | How it's accepted in-product |
|-----|------------------------|------------------------------|
| EULA | See `EULA.md` | First-launch consent screen: required "Accept the terms" checkbox opens this doc via the EULA link on that row. |
| Terms of Service | See `TOS.md` | First-launch consent screen: required "Accept the terms" checkbox opens this doc via the Terms of Service link on the same row (two separate links, two separate docs). |
| Privacy Policy | See `PRIVACY_POLICY.md` | First-launch consent screen: optional telemetry checkbox opens this doc via the Learn more link on that row. Settings → Telemetry exposes the same toggle. |
| Third-Party Notices | See `THIRD_PARTY_NOTICES.md` | Reachable from Settings → About; the in-product structured copy is `THIRD_PARTY_NOTICES` in `src/renderer/src/lib/privacyPolicy.ts`. |

## Contact

- Privacy questions / data requests: **privacy@comfy.org**
- Legal / commercial: **legal@comfy.org** *(set up before GA if not already)*

---

*Last updated: 2026-05-19*
