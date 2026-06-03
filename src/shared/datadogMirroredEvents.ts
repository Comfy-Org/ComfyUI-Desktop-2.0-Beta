/**
 * Allow-list of telemetry event names that mirror to Datadog RUM.
 *
 * Rule ():
 *
 * - Product / funnel / feature event -> PostHog only.
 * - Failure / crash / error event -> both. PostHog for "what % fails"
 * analysis, Datadog for "alert me
 * when failure rate spikes."
 * - Nothing else goes to Datadog.
 *
 * Datadog is not a product-analytics tool; it is the alerting / monitoring
 * tool. Mirroring every event to both doubles RUM volume for no monitor
 * benefit. Mirroring only failures gives ops the alerting surface they need
 * and keeps Datadog cost / noise bounded.
 *
 * Lives in `src/shared/` so main and renderer use the same predicate. Used by
 * `mainTelemetry.forwardToRenderer` (main-side gate before IPC send) and by
 * `rendererBootstrap.trackTelemetryAction` (renderer-side gate before
 * `datadogRum.addAction`).
 *
 * Errors captured via `datadogRum.addError` (window.error,
 * unhandledrejection, main-process forwarded errors) are NOT controlled by
 * this list — they are unconditional. This list governs *Actions only*.
 *
 * Adding a name here is a deliberate ops decision: it means "I want a
 * Datadog monitor on this event." Keep the list tight.
 */

export const DATADOG_MIRRORED_EVENT_NAMES: ReadonlySet<string> = new Set([
  // ComfyUI execution failures — alert on execution error rate per release
  // and per gpu_tier.
  'desktop2.execution.error',
  // ComfyUI process exit — properties carry `crashed: boolean`; monitor
  // filters on crashed=true for the crash-rate signal.
  'desktop2.comfyui.exited',
  // App-update failure — monitors catch update-channel regressions.
  'desktop2.app_update.error',
  // Install pipeline failures — monitors the install funnel's bottom step.
  'desktop2.install.standalone.error',
  'desktop2.install.post_install.error',
  // Migration pipeline failures (Desktop-1 -> standalone).
  'desktop2.migrate.flow.error',
  'desktop2.migrate.user_files.error',
  'desktop2.migrate.input.error',
  'desktop2.migrate.output.error',
  'desktop2.migrate.models.error',
  // Snapshot restore failures — partial restores are a known pain point.
  'desktop2.snapshot.restore_comfyui_version.error',
  'desktop2.snapshot.restore_custom_nodes.error',
  'desktop2.snapshot.restore_pip_packages.error',
  // Operational signal for the identity migration rollout.
  'desktop2.identity.migrated',
  // Sign-in failures — alert if a provider's auth bridge breaks (OAuth
  // config drift, IdP outage, loopback-port contention).
  'desktop2.auth.sign_in_failed',
  // SDK-level volume guards — Datadog should alert if either fires
  // because the call site is misbehaving (loop, missing dedup, etc.)
  // and the SDK had to step in. One emit per process per event-name.
  'desktop2.telemetry.rate_limited',
  'desktop2.telemetry.session_cap_hit',
  // pygit2 reliability — spike here means a release broke the bundled
  // Python env for a population of users (signing / quarantine /
  // bootstrap-python copy drift). probe_failed = single-user state;
  // circuit_broken = stop-the-bleeding guard tripped.
  'desktop2.pygit2.probe_failed',
  'desktop2.pygit2.circuit_broken'
])

export function isDatadogMirroredEvent(eventName: string): boolean {
  return DATADOG_MIRRORED_EVENT_NAMES.has(eventName)
}
