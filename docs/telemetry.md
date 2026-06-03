# Telemetry

> ⚠️ **This document is drifted from the code.** Specific event names,
> properties, and file paths in the catalogue below are stale; some
> events documented here no longer fire and some events that DO fire
> are not listed. The architectural notes (providers, identity model,
> scrubbing, consent) are broadly accurate.
>
> A full rewrite ships after the in-flight telemetry rework lands in
> production. Until then: trust the code, not this doc.

Comfy Desktop emits telemetry through **two providers** that share a
single event bus:

- **Datadog RUM** (renderer-only) — reliability, errors, performance,
  long tasks, and user-interaction tracking.
- **PostHog** — the canonical product-analytics sink. Runs in **two
  SDKs**:
  - `posthog-node` in the **main process** — captures things the
    renderer cannot see (app start/quit, install/migrate sub-steps,
    ComfyUI execution events parsed from stdout/stderr).
  - `posthog-js` in the **renderer** — UI-originated events, user
    identify + person profile, feature flags.

Session replay is intentionally **not** captured by either provider.
The PostHog recorder is blocked at the CSP layer and PostHog JS is
configured with `disable_session_recording: true`. Datadog RUM omits
`sessionReplaySampleRate` so it defaults to off. Reintroducing replay
on either side requires a deliberate code change in a release.

Both providers receive **the same event name and the same context**
for almost every event. The split below is therefore not _which events_
they see but _which provider owns originating them_ and what extra
behaviour each provides.

## Event flow

```diagram
╭───────────────╮     ╭────────────────────╮     ╭──────────────────╮
│ Vue/composab. │────▶│ emitTelemetry-     │────▶│  trackTelemetry- │
│ (renderer)    │     │ Action(name, ctx)  │     │  Action(name,ctx)│
╰───────────────╯     ╰────────────────────╯     │  ┌──────────────┐│
                                                 │  │ Datadog RUM  ││
╭───────────────╮     ╭────────────────────╮     │  │ addAction()  ││
│ Main process  │────▶│ telemetry.emit()   │────▶│  └──────────────┘│
│ (executionTap,│     │ = capture (PH-Node)│     │  ┌──────────────┐│
│  trackedStep, │     │ + forwardToRender. │     │  │ PostHog JS   ││
│  registerApp) │     ╰────────────────────╯     │  │ capture()    ││
╰───────────────╯                                │  └──────────────┘│
                                                 ╰──────────────────╯
```

The renderer's `trackTelemetryAction()`
([src/renderer/src/main.ts](../src/renderer/src/main.ts)) is the single
fan-out point. Every event that reaches it is dispatched to **both**
Datadog (`datadogRum.addAction`) and PostHog
(`capturePostHog`/`posthog.capture`).

Main-process events go through `mainTelemetry.emit()`
([src/main/lib/telemetry.ts](../src/main/lib/telemetry.ts)) which:

1. `capture()`s the event into the PostHog Node client immediately, and
2. `forwardToRenderer()`s it via `telemetry-action-from-main` IPC so the
   renderer can mirror it into Datadog (and PostHog JS) too.

## Provider responsibilities

| Concern | Datadog RUM (renderer) | PostHog Node (main) | PostHog JS (renderer) |
|---|---|---|---|
| **Purpose** | Reliability, errors, performance | Lifecycle / install / migrate / execution events outside the renderer | UI funnel + identify + feature flags |
| **App lifecycle (`session.started` / `session.ended`)** | mirrors `session.started` via bridge | **owns** both events | mirrors `session.started` |
| **Install / migrate pipeline (`*.start` / `.end` / `.error`)** | mirrors via bridge | **owns** (via `trackedStep`) | mirrors via bridge |
| **ComfyUI execution (`got prompt`, `Prompt executed in …`, tracebacks)** | mirrors via bridge | **owns** (via `executionTap`) | mirrors via bridge |
| **UI clicks / view-opened / install method+variant** | **owns** (originated in Vue) | mirrors via bridge | **owns** (originated in Vue) |
| **JS errors / unhandled rejection** | **owns** (`datadogRum.addError`) | — | mirrors as exception (`captureException`) unless `skipPostHog` |
| **Main-process errors** | mirrored to renderer → `addError` (with `skipPostHog: true`) | **owns** (`captureException`) | suppressed (`skipPostHog`) to avoid double counting |
| **Session replay** | not configured (field omitted, SDK default is off) | — | hard-disabled (no recorder script, no CSP allowance) |
| **Long tasks / resource timing / user interactions** | **owns** (`trackResources`, `trackLongTasks`, `trackUserInteractions: true`) | — | — |
| **Feature flags / kill switches** | — | none in this build (see _Remote feature flags_ below) | — |
| **Distinct id** | `datadogRum.setUser({ id })` | `client.identify({ distinctId })` | `posthog.identify(id, profileProps)` (sets person-profile props) |
| **Path normalisation on errors** | yes (`normalizeRumErrorEvent`) | PII + secret scrub via `scrubAll()` | `scrubAll()` already applied upstream |

## Event catalogue

### Lifecycle (main-process owned, fans out to both)

| Event | Properties | Notes |
|---|---|---|
| `desktop2.session.started` | `app_env`, `app_version`, `is_packaged`, `telemetry_effective_enabled` | Stashed at `initTelemetry()` and emitted once `identify()` binds the persistent device id, since `distinctId` isn't known yet at init. |
| `desktop2.session.system_info` | `platform`, `arch`, `os_distro`, `os_release`, `gpu_vendor`, `gpu_model`, `total_memory_gb`, `cpu_cores`, `electron_version`, `app_version` | Also promoted to PostHog person-profile properties via `identify` so they're queryable without joining against per-session events. |
| `desktop2.session.installation_started` | full installation context + `boot_time_ms` | Fires when an installation actually starts the ComfyUI process. |
| `desktop2.session.snapshot_history` | `installation_id`, `snapshot_diffs[]` | Sent to **both** providers but bypasses the typed bridge because of the array-of-objects payload. PostHog is the primary consumer. |
| `desktop2.session.ended` | `reason`, `uptime_ms`, `uptime_seconds` | PostHog-only — emitted from `shutdown()` during the `before-quit` drain. Datadog's session ends naturally when the renderer unloads. |

### Install / migrate (main-process `trackedStep`)

Each `trackedStep('<step>', ctx, fn)` emits **three** events:
`<step>.start`, `<step>.end` (with `duration_ms`), and on failure
`<step>.error` (with `duration_ms`, `error_bucket`, `error_message`).

| Step | Where |
|---|---|
| `desktop2.install.validation` | `src/main/lib/ipc/registerAppHandlers.ts` (one-shot, ad-hoc `mainTelemetry.emit`) |
| `desktop2.install.standalone` | `src/main/lib/standaloneMigration.ts` |
| `desktop2.install.post_install` | `src/main/lib/standaloneMigration.ts` |
| `desktop2.snapshot.restore_comfyui_version` | `src/main/lib/standaloneMigration.ts` |
| `desktop2.snapshot.restore_custom_nodes` | `src/main/lib/standaloneMigration.ts` |
| `desktop2.snapshot.restore_pip_packages` | `src/main/lib/standaloneMigration.ts` |
| `desktop2.migrate.flow` | `src/main/lib/ipc/sessionActions/migrate.ts` |
| `desktop2.migrate.user_files` | `src/main/lib/standaloneMigration.ts` |
| `desktop2.migrate.input` | `src/main/lib/standaloneMigration.ts` |
| `desktop2.migrate.output` | `src/main/lib/standaloneMigration.ts` |
| `desktop2.migrate.models` | `src/main/lib/standaloneMigration.ts` |

### ComfyUI execution (main-process `executionTap`)

Parses ComfyUI's stdout/stderr looking for `got prompt`,
`Prompt executed in N seconds`, validation failures, and Python
tracebacks. All events share `installation_id`, `variant`, `release`.

| Event | Extra properties |
|---|---|
| `desktop2.execution.started` | `started_count` |
| `desktop2.execution.completed` | `duration_seconds`, `wall_clock_ms`, `completed_count` |
| `desktop2.execution.first_completed` | `first_run_at` (one-shot per session) |
| `desktop2.execution.error` | `error_class`, `error_message` (scrubbed), `error_bucket`, `error_count`, `node_id?` |
| `desktop2.execution.session_summary` | `started_count`, `completed_count`, `error_count` (on flush) |

Execution telemetry is unconditional — there is no remote kill switch
or sample-rate dial (see _Remote feature flags_ below).

### ComfyUI process (main → renderer IPC → both)

| Event | Properties |
|---|---|
| `desktop2.comfyui.exited` | `installation_id`, `crashed`, `exit_code`, `last_stderr` |
| `desktop2.comfyui.boot_log` | `installation_id`, `boot_stderr` (capped to the last 50 lines of stderr by `lastNLines` in `sessionActions/launch.ts`) |

### UI / funnel (renderer `emitTelemetryAction`, both providers)

| Event | Source |
|---|---|
| `desktop2.view.opened` | `src/renderer/src/App.vue` |
| `desktop2.feedback.opened` | `src/renderer/src/App.vue` |
| `desktop2.install.flow.opened` | `src/renderer/src/App.vue` (4 entry points) |
| `desktop2.install.method.selected` | `views/NewInstallModal.vue`, `views/QuickInstallModal.vue` |
| `desktop2.install.variant.selected` | `views/NewInstallModal.vue`, `views/LoadSnapshotModal.vue`, `views/QuickInstallModal.vue` |
| `desktop2.install.guardrail.blocked` | `lib/installHelpers.ts` |
| `desktop2.install.disk_warning.response` | `lib/installHelpers.ts` |
| `desktop2.snapshot.flow` | `components/SnapshotTab.vue` (7 sub-states) |
| `desktop2.update.cta` | `components/UpdateBanner.vue` |
| `desktop2.action.invoked` / `desktop2.action.result` | `composables/useListAction.ts`, `views/DetailModal.vue` |
| `desktop2.settings.changed` | `components/SettingField.vue` |
| `desktop2.track_existing.saved` | `views/TrackModal.vue` |
| `desktop2.model_download.result` | `stores/downloadStore.ts` |

### Errors

- `window.error` and `window.unhandledrejection` → Datadog `addError` +
  PostHog `captureException` in the renderer.
- Main-process errors are forwarded to the renderer with
  `skipPostHog: true`. PostHog Node owns the capture in the main
  process; Datadog gets the renderer-only mirror. This avoids double
  counting exceptions.

## Consent

A single user-facing toggle, `telemetryEnabled`, controls every
provider:

- `window.api.onTelemetrySettingChanged` flips
  `datadogRum.setTrackingConsent('granted'|'not-granted')` and PostHog
  JS `opt_in_capturing()` / `opt_out_capturing()` simultaneously.
- The same setting is observed in the main process via
  `mainTelemetry.setConsent()`, which short-circuits `capture()` and
  `forwardToRenderer()` so already-suppressed events never even reach
  the IPC bridge.

PostHog **surveys** are bound to consent too, since PostHog's surveys
module ignores `opt_out_capturing()` outside cookieless mode. We mirror
consent into `disable_surveys` at init and on every consent change
(via `posthog.set_config({ disable_surveys: !enabled })`), and call
`posthog.surveys.loadIfEnabled()` when consent is regained so dashboard
surveys can appear without a relaunch. **Net effect:** surveys remain
remotely toggleable via the PostHog dashboard, but only ever appear for
users who have opted in to telemetry.

Re-evaluating consent flushes the PostHog Node queue best-effort
(`client.flush()`) so events queued while consent was true still go
out.

## Configuration

### PostHog

Defaults live in `src/shared/posthogConfig.ts` and are baked into the
build. Overrides:

| Process | Variable |
|---|---|
| Renderer | `VITE_POSTHOG_API_KEY`, `VITE_POSTHOG_HOST`, `VITE_POSTHOG_ENABLED` |
| Main | `POSTHOG_API_KEY`, `POSTHOG_HOST`, `POSTHOG_ENABLED` |

`POSTHOG_ENABLED=0|false|off` disables PostHog in that process.

### Datadog

Defaults in `src/renderer/src/main.ts`:

| Field | Default |
|---|---|
| `applicationId` | `74a97924-20d7-4890-8e55-0c2b87193373` |
| `clientToken` | `pub5b0afc7fe0411fcebad80bb87274d711` |
| `service` | `comfyui-desktop-2` |
| `env` | `prod-v2` |
| `site` | `us5.datadoghq.com` |
| `sessionSampleRate` | `100` |

Overridable via `VITE_DATADOG_RUM_*` environment variables at build
time. `VITE_DATADOG_RUM_ENABLED=0|false|off` disables Datadog.

### Remote feature flags

There are intentionally **no remote feature flags** in this build.

An earlier iteration shipped a small set (`desktop2.execution_telemetry.enabled`,
`desktop2.execution_telemetry.sample_rate`, `desktop2.disabled_events`,
`desktop2.boot_log_max_chars`) bootstrapped from PostHog at startup with
an on-disk cache. None of them had a live operational use case for the
launcher, and the bootstrap added startup latency plus state we did not
want to maintain. The whole system was removed: no `getFlag` calls, no
deferred session-start, no `<configDir>/telemetry-flags.json`. Execution
telemetry is now unconditionally on.

If a future need arises, the path to bring flags back is straightforward
(re-add the bootstrap + cache + a `getFlag` accessor and the call sites
that need it), but the default position is **no flags**.

## PII and secret scrubbing

`scrubAll()` in `src/main/lib/piiScrub.ts` is the single source of
truth. It is applied to:

- `forwardDatadogError` payloads (main-process error forwarder).
- Every `executionTap` traceback message.
- Any text routed through `scrubStderr()` (which delegates to
  `scrubAll`).

Patterns redacted:

| Kind | Pattern | Replacement |
|---|---|---|
| Windows home path | `C:\Users\<x>` | `C:\Users\[REDACTED]` |
| macOS home path | `/Users/<x>` | `/Users/[REDACTED]` |
| Linux home path | `/home/<x>` | `/home/[REDACTED]` |
| OpenAI key | `sk-…` (≥20 chars) | `[REDACTED]` |
| Hugging Face token | `hf_…` (≥20 chars) | `[REDACTED]` |
| Bearer token | `Bearer <token>` (≥20 chars) | `Bearer [REDACTED]` |
| URL basic-auth | `//user:pass@` | `//[REDACTED]@` |
| Env-style secret | `(API_KEY|TOKEN|SECRET|PASSWORD)=…` | `<NAME>=[REDACTED]` |

Adding a new pattern here updates every call site at once.

## Identifying users

The renderer calls `window.api.getDeviceId()` to obtain a stable
per-installation UUID stored in `<configDir>/device-id.txt` (created
with exclusive `wx` flags to avoid TOCTOU). It is then bound to:

- `datadogRum.setUser({ id })`,
- `client.identify({ distinctId })` in PostHog Node,
- `posthog.identify(id, profileProps)` in PostHog JS — system-info
  fields (platform, arch, GPU, app version, etc.) are written as
  person-profile properties so they are queryable across sessions
  without joining against per-session events.

There is no user account, email, or other personal identifier.

## Quit-time drain

PostHog Node uses an outbound queue, so `app.before-quit` is hooked to
drain it cleanly:

1. `event.preventDefault()` — keep Electron from exiting immediately.
2. `await shutdown()` — flushes the queue, with a 1.5 s overall
   timeout so a slow / dead network never blocks quit.
3. `app.exit(0)` — re-issues the quit. A one-shot guard prevents
   re-entering this branch on the second quit.

Datadog RUM sends events synchronously over `sendBeacon`/fetch and
does not need a drain step.
