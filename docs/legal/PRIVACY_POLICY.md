# Privacy Policy

**Effective date:** 2026-05-05
**Last updated:** 2026-05-08
**Applies to:** ComfyUI Desktop 2.0
**Data controller:** Comfy Org

---

## TL;DR (Plain-English summary)

ComfyUI Desktop 2.0 runs locally on your computer. Your workflows, prompts, models, and generated outputs **stay on your machine**. We don't see them, we don't upload them, and we have no copy of them.

The only data that leaves your computer is **anonymous product analytics** (which features get used, how often the app launches, what version + OS you're on) and **crash reports**. You can turn both off in Settings at any time.

If you sign in to **Comfy Cloud**, that's a separate flow with its own terms — this policy doesn't cover the cloud service.

---

## 1. About this policy

This is the **full long-form Privacy Policy** for the ComfyUI Desktop 2.0 application. A shorter, consent-screen version is shown to you on first launch and is also viewable inside the app at any time — that version is excerpted from this one and they are kept in sync.

In-product source of truth: [`src/renderer/src/lib/privacyPolicy.ts`](../../src/renderer/src/lib/privacyPolicy.ts).

If anything in this policy is unclear, please email **privacy@comfy.org** and we'll do our best to explain.

## 2. Who we are

**Comfy Org** is the legal entity that publishes and operates ComfyUI Desktop 2.0 and is the "data controller" for the limited data described in this policy.

*[REVIEW: confirm legal entity name, registered address, and any required local representative (e.g. EU Article 27 representative, UK GDPR representative) before GA. Add registered address here.]*

For privacy questions or to exercise the rights described below, contact **privacy@comfy.org**.

## 3. What this policy covers — and what it doesn't

**This policy covers:**
- Telemetry and crash reports collected by the Desktop App when you have telemetry enabled.
- Local data the Desktop App stores on your machine (which is not shared with us, but we describe it here so you know what exists).
- Your interactions with our update servers (e.g. version checks).

**This policy does NOT cover:**
- **Comfy Cloud** sign-in or use. When you sign in to Comfy Cloud, your activity is governed by the [Comfy Org Terms of Service](https://comfy.org/terms) and a separate Comfy Cloud privacy notice.
- The [comfy.org](https://comfy.org) website itself.
- Any third-party AI partner APIs you may access from within the Desktop App (e.g. Google Gemini, OpenAI, Anthropic, Black Forest Labs). Those are governed by each provider's own terms and privacy policies.
- AI models you download or install — those are distributed by their respective creators, and what data the models themselves expose is outside our control. Models run locally on your machine.

## 4. What we collect

### 4.1 Anonymous usage analytics (via PostHog)

Sent **only if you have analytics enabled** (toggle on the first-launch consent screen + in Settings).

We collect:

- App version and platform (e.g. "Desktop 2.0.1, macOS 14.4 ARM")
- An **anonymous device ID** generated locally on first run and stored in a file inside your app's config directory (`device-id.txt`). This ID is not derived from any hardware identifier we can reverse-engineer, and it is not tied to your name, email, or any cloud account. Uninstalling the Desktop App removes this file.
- Feature events with non-identifying metadata, such as:
  - `install completed` (with platform info)
  - `workflow opened`
  - `settings panel opened`
  - `update CTA clicked`
- System info attached as person-profile properties: OS distro/release, GPU vendor/model, total memory, CPU core count, Electron version. (Used to triage compatibility issues; not tied to your identity.)
- Approximate timing of those events.

We do **not** collect:

- Workflow content
- Prompts you write
- Generated images, videos, or audio
- File paths or filenames
- Model names or weights
- Network activity outside the Desktop App
- Browsing history, files on your disk, or any system content outside the Desktop App's own operation

### 4.2 Crash and error reports (via Datadog RUM)

Sent **only if you have analytics enabled**.

We collect:

- Stack traces and error messages from crashes
- App version and platform
- The same anonymous device ID
- Performance metrics (long tasks, resource timing, user-interaction-driven event latency) — used to find slow paths in the UI

Before sending error messages, we strip:

- User home directories (`C:\Users\<name>`, `/Users/<name>`, `/home/<name>` → `[REDACTED]`)
- API keys (OpenAI `sk-...`, Hugging Face `hf_...`, Bearer tokens, URL basic-auth, environment-variable-style `API_KEY=...`)

Session replay (recording the user's interaction frame-by-frame) is **disabled** by configuration in both providers. It cannot be silently re-enabled.

### 4.3 Update server requests

When the Desktop App checks for updates or downloads a new version, our update server sees:

- Your IP address (necessary for HTTPS routing)
- The version and platform you're running

We use these only to deliver updates correctly. We do not log them as long-term identifiers.

### 4.4 What stays on your machine, always

- Your workflow files
- Your installed AI models
- Your generated outputs (images, videos, audio)
- The list of installations you've created in the Desktop App
- Your local settings, preferences, and snapshots

None of these are uploaded, indexed, or accessible to Comfy Org.

## 5. Why we collect what we do (purposes of processing)

| Purpose | Data used |
|---------|-----------|
| Improve the product (understand which features people use, where they get stuck, what to build next) | Usage analytics (Section 4.1) |
| Find and fix bugs faster | Crash and error reports (Section 4.2) |
| Deliver software updates and verify install integrity | Update server requests (Section 4.3) |
| Diagnose hardware-compatibility issues | System info from Section 4.1 |

We do **not** sell your data. We do not share it with advertising networks. We do not use it for advertising of any kind.

## 6. Lawful basis for processing (for EU/UK/EEA users)

We process the data described in this policy on the following GDPR lawful bases:

- **Your consent** (Article 6(1)(a)) for usage analytics and crash reports. You give consent via the first-launch toggle and can withdraw it at any time in Settings.
- **Legitimate interests** (Article 6(1)(f)) for update server requests — necessary to deliver software updates and security fixes. Our legitimate interest is in maintaining a functional, secure product; we balance this against your privacy rights and believe the impact is minimal because we don't use the request data beyond serving the update.

You have the right to object to processing based on legitimate interests; see Section 9.

## 7. Third-party processors

We use the following processors to handle the data described above:

| Processor | What they process | Where |
|-----------|-------------------|-------|
| **PostHog** ([posthog.com](https://posthog.com)) | Product analytics events | EU (default region) |
| **Datadog** ([datadoghq.com](https://datadoghq.com)) | Crash reports, performance telemetry, application logs | US (`us5.datadoghq.com`) |
| **ClickHouse** ([clickhouse.com](https://clickhouse.com)) | Long-term analytics storage | *[REVIEW: confirm region]* |
| **ToDesktop** ([todesktop.com](https://todesktop.com)) | Application distribution and auto-update | US |

Each processor handles data on our behalf under standard data processing agreements.

If you are in the EU/EEA/UK and your data is transferred to processors outside your jurisdiction, those transfers rely on **Standard Contractual Clauses (SCCs)** or equivalent transfer mechanisms required by GDPR/UK GDPR.

*[REVIEW: confirm SCC status with each processor and update transfer mechanism disclosures before GA.]*

## 8. Retention

| Data | Retention |
|------|-----------|
| Anonymous usage analytics (PostHog) | Up to **24 months** rolling, then anonymized further or deleted |
| Crash reports (Datadog) | Up to **15 days** at full fidelity, then sampled or aggregated |
| Long-term analytics (ClickHouse) | Up to **36 months** in aggregated form |
| Update server logs | Up to **90 days** |
| Anonymous device ID (on your machine) | Until you uninstall the Desktop App |

*[REVIEW: confirm actual retention periods with engineering before GA. The numbers above are reasonable defaults; align them with what's truly configured.]*

## 9. Your rights

You have rights over your data. The specifics depend on where you live, but the easiest path for everyone is:

### 9.1 Turn off data collection going forward

Open the Desktop App → **Settings → Telemetry** → toggle off. Future events stop immediately; any pending in-flight requests already on the wire may still complete.

### 9.2 Delete past data

Email **privacy@comfy.org** with your approximate install date, platform, and version. We'll do a best-effort match against our analytics, crash report, and long-term storage and remove associated records within 30 days.

*[VERIFY: replace this with the in-app device ID lookup once the "Copy device ID" affordance ships — tracked separately. Without that surface we can't ask anonymous users for an identifier they cannot retrieve.]*

### 9.3 Access, rectification, portability (GDPR/UK GDPR)

If you're in the EU, UK, or EEA, you have the right to:

- **Access** the data we have associated with your device ID
- **Rectify** any inaccurate data (though most of what we hold is event counters, so this rarely applies)
- **Erase** your data (Section 9.2 above)
- **Restrict** processing
- **Object** to processing based on legitimate interests
- **Data portability** — receive your data in a machine-readable format

Email **privacy@comfy.org** with your approximate install date, platform, and version (until the in-app device ID lookup ships).

### 9.4 California rights (CCPA/CPRA)

If you're a California resident, you have the right to:

- **Know** what personal information we collect (described in Section 4)
- **Delete** personal information (Section 9.2)
- **Correct** inaccurate personal information
- **Opt out of sale or sharing** — we do not sell or share your personal information, but you can confirm this in writing on request
- **Limit use of sensitive personal information** — we do not collect sensitive personal information as defined by CPRA

You may also designate an authorized agent to make a request on your behalf, subject to verification.

### 9.5 Right to complain

If you believe we have mishandled your data, you have the right to lodge a complaint with your local data protection authority:

- **EU:** your country's supervisory authority (list: [edpb.europa.eu](https://edpb.europa.eu/about-edpb/about-edpb/members_en))
- **UK:** the Information Commissioner's Office ([ico.org.uk](https://ico.org.uk))
- **California:** the California Privacy Protection Agency ([cppa.ca.gov](https://cppa.ca.gov))

We'd appreciate the chance to address your concern first — email **privacy@comfy.org**.

### 9.6 Stop using the app

Uninstalling the Desktop App ends data collection. The local device ID file is removed along with the app. We don't keep tracking IDs after uninstall, so you'll be treated as a new device if you reinstall.

### 9.7 How we verify identity for data requests

Because the Desktop App doesn't require an account, you are anonymous to us by default. We identify your data through an **anonymous device ID** held locally on your machine.

For deletion or access requests, tell us your approximate install date, platform, version, and the type of activity you remember — we'll do a best-effort match against our records. Once the in-app device ID lookup ships, include that ID for an exact match.

We will **not** ask you for any additional identifying information (e.g. government ID) to process a request, because the data we hold is anonymous and we have no reliable way to match it to a real-world identity. Requests for data we don't hold will be answered with "we don't hold that data."

## 10. Automated decision-making

We do **not** use your data for automated decision-making or profiling that produces legal or similarly significant effects (as defined under Article 22 GDPR). We do not score users, generate ratings, target advertising, or feed your data into models that make decisions about you.

The analytics we collect are aggregated to inform product roadmap decisions (which features to build, which bugs to fix). They are not used to make individual decisions about specific users.

## 11. Security

We protect the data we collect using industry-standard practices:

- **In transit:** all telemetry and crash report traffic is sent over HTTPS (TLS 1.2 or higher).
- **At rest:** our processors (PostHog, Datadog, ClickHouse) encrypt data at rest under their standard security programs.
- **Access:** access to telemetry data inside Comfy Org is limited to engineering and product staff who need it, under role-based access controls.
- **PII scrubbing:** we strip known PII patterns (home directories, API keys, bearer tokens) before sending error messages to processors. The scrubber is a single source of truth in code so adding a pattern updates all call sites.
- **Session replay is disabled** and cannot be enabled without a deliberate code change in a release.

No system is perfectly secure; we make no warranty that data will never be exposed, but we treat it seriously.

## 12. Children

ComfyUI Desktop 2.0 is **not intended for users under 13**. We do not knowingly collect data from children under 13. If you believe a child has used the Desktop App, contact **privacy@comfy.org** and we'll remove related records.

## 13. International users

If you're using ComfyUI Desktop 2.0 from outside the country where our processors store data, your data may be transferred to and processed in jurisdictions with different data protection laws than your home jurisdiction (notably the United States and the European Union).

We rely on **Standard Contractual Clauses** or equivalent legal mechanisms for transfers from the EU/UK/EEA to processors outside those jurisdictions. You can request a copy of the relevant SCCs by emailing **privacy@comfy.org**.

## 14. Changes to this policy

We'll update this document as the product evolves. The **Effective date** at the top changes when we revise.

- **Minor clarifications** (rewording, fixing typos, adding examples): we'll just update the policy and note it in the "Last updated" date.
- **Material changes** (adding a new data point, a new processor, a new purpose, or shortening a retention period to something more permissive): we'll re-prompt you for fresh acceptance in the Desktop App and surface a notice for at least 30 days before the change takes effect.

During the beta period (before GA in June 2026), we may iterate on this policy without re-prompting you for fresh acceptance for each minor change. At GA, we'll prompt for a fresh acceptance of the final policy.

## 15. Contact

For any privacy-related question, request, or complaint:

**Email:** privacy@comfy.org
**General contact:** [comfy.org](https://comfy.org)

*[REVIEW: add registered postal address before GA. Some jurisdictions require it in a privacy notice.]*

---

*This document is an AI-drafted starting point and should be reviewed by qualified counsel before public use. Items marked `[REVIEW]` flag sections where review is particularly important.*
