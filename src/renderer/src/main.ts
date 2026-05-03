import './assets/main.css'

import { datadogRum, type RumBeforeSend } from '@datadog/browser-rum'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import App from './App.vue'
import { useNavigation } from './composables/useNavigation'
import { normalizeRumErrorEvent } from './lib/datadogPathNormalization'
import {
  TELEMETRY_ACTION_EVENT_NAME,
  type TelemetryActionEventDetail,
  type TelemetryContext,
} from './lib/telemetry'
import {
  capturePostHog,
  captureExceptionPostHog,
  identifyPostHog,
  initPostHog,
  isInitialized as isPostHogInitialized,
  isPostHogConfigured,
  setPostHogConsent,
} from './lib/posthogProvider'

function serializeUnknownError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      message: error.message || error.name || 'Error',
      stack: error.stack,
    }
  }
  if (typeof error === 'string') {
    return { message: error }
  }
  if (error === null || error === undefined) {
    return { message: 'Unknown error' }
  }
  try {
    return { message: JSON.stringify(error) }
  } catch {
    return { message: String(error) }
  }
}

function parseSampleRate(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(0, Math.min(100, parsed))
}

function isFlagDisabled(value: string | undefined): boolean {
  return ['0', 'false', 'off'].includes((value || '').trim().toLowerCase())
}

type DatadogTrackingConsent = 'granted' | 'not-granted'

const DEFAULT_DATADOG_APPLICATION_ID = '74a97924-20d7-4890-8e55-0c2b87193373'
const DEFAULT_DATADOG_CLIENT_TOKEN = 'pub5b0afc7fe0411fcebad80bb87274d711'
const DEFAULT_DATADOG_SERVICE = 'comfyui-desktop-2'

const datadogClientToken = (
  import.meta.env.VITE_DATADOG_RUM_CLIENT_TOKEN
  || DEFAULT_DATADOG_CLIENT_TOKEN
).trim()
const datadogApplicationId = (
  import.meta.env.VITE_DATADOG_RUM_APPLICATION_ID
  || DEFAULT_DATADOG_APPLICATION_ID
).trim()
const datadogSite = (import.meta.env.VITE_DATADOG_RUM_SITE || 'us5.datadoghq.com').trim()
const datadogService = (import.meta.env.VITE_DATADOG_RUM_SERVICE || DEFAULT_DATADOG_SERVICE).trim()
const datadogEnv = (import.meta.env.VITE_DATADOG_RUM_ENV || 'prod-v2').trim()
const datadogVersion = (import.meta.env.VITE_DATADOG_RUM_VERSION || '').trim()

const isDatadogConfigured = !isFlagDisabled(import.meta.env.VITE_DATADOG_RUM_ENABLED)
  && datadogClientToken.length > 0
  && datadogApplicationId.length > 0

let isDatadogInitialized = false

const datadogBeforeSend: RumBeforeSend = (event) => {
  if (event.type === 'error') {
    normalizeRumErrorEvent(event)
  }
  return true
}

function toDatadogTrackingConsent(enabled: boolean | undefined): DatadogTrackingConsent {
  return enabled === false ? 'not-granted' : 'granted'
}

async function getTelemetryEnabledSetting(): Promise<boolean | undefined> {
  try {
    return await window.api.getSetting('telemetryEnabled') as boolean | undefined
  } catch {
    return undefined
  }
}

function setDatadogTrackingConsent(consent: DatadogTrackingConsent): void {
  if (!isDatadogInitialized) return
  try {
    datadogRum.setTrackingConsent(consent)
  } catch {}
}

function trackTelemetryAction(actionName: string, context: TelemetryContext): void {
  if (isDatadogInitialized) {
    try { datadogRum.addAction(actionName, context) } catch {}
  }
  if (isPostHogInitialized()) {
    capturePostHog(actionName, context)
  }
}

function handleTelemetryActionBridgeEvent(event: Event): void {
  const detail = (event as CustomEvent<unknown>).detail as TelemetryActionEventDetail | undefined
  if (!detail || typeof detail !== 'object') return
  if (typeof detail.actionName !== 'string' || detail.actionName.length === 0) return
  const context = detail.context && typeof detail.context === 'object' ? detail.context : {}
  trackTelemetryAction(detail.actionName, context)
}


async function initializeProviders(): Promise<void> {
  const telemetryEnabled = await getTelemetryEnabledSetting()
  const consent = telemetryEnabled !== false
  const appVersion = datadogVersion || 'unknown'

  if (isDatadogConfigured) {
    try {
      datadogRum.init({
        applicationId: datadogApplicationId,
        clientToken: datadogClientToken,
        site: datadogSite,
        service: datadogService,
        env: datadogEnv,
        version: datadogVersion || undefined,
        trackingConsent: toDatadogTrackingConsent(telemetryEnabled),
        beforeSend: datadogBeforeSend,
        sessionSampleRate: parseSampleRate(import.meta.env.VITE_DATADOG_RUM_SESSION_SAMPLE_RATE, 100),
        // Session replay is intentionally not configured. Datadog defaults
        // to off when the field is omitted; reintroduce only as a deliberate
        // code change in a release.
        trackResources: true,
        trackLongTasks: true,
        trackUserInteractions: true,
      })
      isDatadogInitialized = true
    } catch {}
  }

  if (isPostHogConfigured()) {
    initPostHog({
      appVersion,
      appEnv: datadogEnv,
      isPackaged: !import.meta.env.DEV,
      consent,
    })
  }

  if (isDatadogInitialized || isPostHogInitialized()) {
    trackTelemetryAction('desktop2.session.started', {
      app_env: datadogEnv,
      app_version: appVersion,
      is_packaged: !import.meta.env.DEV,
      telemetry_effective_enabled: consent,
    })
    window.api.getDeviceId().then((id) => {
      if (isDatadogInitialized) {
        try { datadogRum.setUser({ id }) } catch {}
      }
      // For PostHog we'll merge in the system_info profile properties below.
      identifyPostHog(id)
    }).catch(() => {})
    window.api.getSystemInfo().then(async (info) => {
      const ctx = info as unknown as Record<string, string | number | boolean | null | undefined>
      trackTelemetryAction('desktop2.session.system_info', ctx)
      // Promote system info to PostHog profile properties so it's queryable
      // across sessions without joining against a per-session event.
      try {
        const id = await window.api.getDeviceId()
        identifyPostHog(id, {
          platform: ctx['platform'],
          arch: ctx['arch'],
          os_distro: ctx['os_distro'],
          os_release: ctx['os_release'],
          gpu_vendor: ctx['gpu_vendor'],
          gpu_model: ctx['gpu_model'],
          total_memory_gb: ctx['total_memory_gb'],
          cpu_cores: ctx['cpu_cores'],
          electron_version: ctx['electron_version'],
          app_version: appVersion,
        })
      } catch {}
    }).catch(() => {})
  }

}

window.api.onTelemetrySettingChanged((enabled) => {
  if (isDatadogConfigured) setDatadogTrackingConsent(toDatadogTrackingConsent(enabled))
  setPostHogConsent(enabled !== false)
})

window.addEventListener(TELEMETRY_ACTION_EVENT_NAME, handleTelemetryActionBridgeEvent)

// Events emitted from the main process land here and fan out to both providers.
window.api.onTelemetryActionFromMain((data) => {
  if (!data || typeof data.event !== 'string' || data.event.length === 0) return
  const ctx = (data.context && typeof data.context === 'object' ? data.context : {}) as TelemetryContext
  trackTelemetryAction(data.event, ctx)
})

void initializeProviders()

function reportRendererError(payload: {
  source: string
  message: string
  stack?: string
  context?: Record<string, unknown>
  /**
   * If true, the error has already been captured by main-process PostHog
   * Node and is being forwarded only so Datadog (renderer-only) sees it.
   * Suppresses the renderer-side PostHog mirror to avoid duplicates.
   */
  skipPostHog?: boolean
}): void {
  const error = new Error(payload.message || 'Unknown error')
  if (payload.stack) {
    error.stack = payload.stack
  }
  if (isDatadogInitialized) {
    try {
      datadogRum.addError(error, {
        source: 'custom',
        context: {
          origin: 'renderer',
          forwarded_source: payload.source,
          ...(payload.context || {}),
        },
      })
    } catch {}
  }
  if (!payload.skipPostHog && isPostHogInitialized()) {
    captureExceptionPostHog(error, {
      origin: 'renderer',
      forwarded_source: payload.source,
      ...(payload.context || {}),
    })
  }
}

window.addEventListener('error', (event) => {
  const serialized = serializeUnknownError(event.error || event.message)
  reportRendererError({
    source: 'renderer-window-error',
    message: serialized.message,
    stack: serialized.stack,
    context: {
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
    },
  })
})

window.addEventListener('unhandledrejection', (event) => {
  const serialized = serializeUnknownError(event.reason)
  reportRendererError({
    source: 'renderer-unhandled-rejection',
    message: serialized.message,
    stack: serialized.stack,
  })
})

window.api.onDatadogError((data) => {
  reportRendererError({
    source: data.source || 'main-forwarded-error',
    message: data.message || 'Unknown forwarded error',
    stack: data.stack,
    context: {
      origin: 'main-process',
      level: data.level,
      ...(data.context || {}),
    },
    skipPostHog: data.skipPostHog === true,
  })
})

window.api.onComfyExited((data) => {
  trackTelemetryAction('desktop2.comfyui.exited', {
    installation_id: data.installationId,
    crashed: data.crashed ?? false,
    exit_code: data.exitCode ?? null,
    last_stderr: data.lastStderr ?? null,
  })
})

window.api.onComfyBootLog((data) => {
  trackTelemetryAction('desktop2.comfyui.boot_log', {
    installation_id: data.installationId,
    boot_stderr: data.bootStderr,
  })
})

window.api.onInstanceStarted((data) => {
  const bootTimeMs = (data as unknown as Record<string, unknown>).bootTimeMs as number | undefined
  window.api.getInstallationDdContext(data.installationId).then((ctx) => {
    if (!ctx) return
    const { snapshot_diffs, ...metadata } = ctx
    trackTelemetryAction('desktop2.session.installation_started', {
      ...(metadata as unknown as Record<string, string | number | boolean | null | undefined>),
      boot_time_ms: bootTimeMs ?? null,
    })
    if (snapshot_diffs.length > 0) {
      // snapshot_diffs is an array of objects, which Datadog/PostHog handle
      // natively; bypass the typed bridge via a fresh call.
      if (isDatadogInitialized) {
        try { datadogRum.addAction('desktop2.session.snapshot_history', { installation_id: ctx.installation_id, snapshot_diffs }) } catch {}
      }
      if (isPostHogInitialized()) {
        capturePostHog('desktop2.session.snapshot_history', { installation_id: ctx.installation_id, snapshot_diffs } as unknown as TelemetryContext)
      }
    }
  }).catch(() => {})
})

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  fallbackLocale: 'en',
  messages: { en: {} },
  missingWarn: false,
  fallbackWarn: false,
})

const app = createApp(App)
app.use(createPinia())
app.use(i18n)
app.mount('#app')

// Expose navigation bridge for E2E tests.
// These methods only mirror what UI buttons already do (present/dismiss overlays,
// switch tabs) — no privilege escalation. The renderer's CSP and preload sandbox
// already restrict what scripts can execute in this context.
{
  const nav = useNavigation()
  ;(window as unknown as Record<string, unknown>).__E2E_NAV__ = {
    present: nav.present,
    dismiss: nav.dismiss,
    dismissAll: nav.dismissAll,
    switchTab: nav.switchTab,
  }
}

export { i18n }
