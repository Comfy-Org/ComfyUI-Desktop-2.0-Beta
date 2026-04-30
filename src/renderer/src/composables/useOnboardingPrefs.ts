import { ref } from 'vue'
import { emitTelemetryAction } from '../lib/telemetry'

// Module-level shared state so all consumers see the same values
const completed = ref(false)
const eulaAccepted = ref(false)
const eulaAcceptedAt = ref<number | null>(null)
const telemetryEnabled = ref(true)
const lastUsedMode = ref<'cloud' | 'local' | null>(null)
const loaded = ref(false)
let loadPromise: Promise<void> | null = null

export function useOnboardingPrefs() {
  async function loadPrefs(): Promise<void> {
    if (loadPromise) return loadPromise
    loadPromise = (async () => {
      const [completedVal, eulaVal, eulaAtVal, telemetryVal, modeVal] = await Promise.all([
        window.api.getSetting('onboardingCompleted') as Promise<boolean | undefined>,
        window.api.getSetting('eulaAccepted') as Promise<boolean | undefined>,
        window.api.getSetting('eulaAcceptedAt') as Promise<number | undefined>,
        window.api.getSetting('telemetryEnabled') as Promise<boolean | undefined>,
        window.api.getSetting('lastUsedMode') as Promise<'cloud' | 'local' | undefined>,
      ])
      completed.value = completedVal === true
      eulaAccepted.value = eulaVal === true
      eulaAcceptedAt.value = typeof eulaAtVal === 'number' ? eulaAtVal : null
      // Telemetry defaults to ON if unset
      telemetryEnabled.value = telemetryVal !== false
      lastUsedMode.value = modeVal === 'cloud' || modeVal === 'local' ? modeVal : null
      loaded.value = true
    })()
    return loadPromise
  }

  async function setTelemetry(enabled: boolean): Promise<void> {
    telemetryEnabled.value = enabled
    await window.api.setSetting('telemetryEnabled', enabled)
  }

  async function setEulaAccepted(accepted: boolean): Promise<void> {
    eulaAccepted.value = accepted
    if (accepted) {
      const ts = Date.now()
      eulaAcceptedAt.value = ts
      await Promise.all([
        window.api.setSetting('eulaAccepted', true),
        window.api.setSetting('eulaAcceptedAt', ts),
      ])
    } else {
      eulaAcceptedAt.value = null
      // `eulaAcceptedAt` is declared non-nullable in the settings schema, so
      // pass `undefined` to delete the key rather than writing `null`. The
      // settings layer already treats `undefined` as "unset" and removes the
      // entry on disk.
      await Promise.all([
        window.api.setSetting('eulaAccepted', false),
        window.api.setSetting('eulaAcceptedAt', undefined),
      ])
    }
  }

  async function complete(reason: 'template' | 'migrate' | 'manual'): Promise<void> {
    completed.value = true
    await window.api.setSetting('onboardingCompleted', true)
    emitTelemetryAction('onboarding.completed', {
      reason,
      telemetry_enabled: telemetryEnabled.value,
    })
  }

  async function setLastUsedMode(mode: 'cloud' | 'local'): Promise<void> {
    lastUsedMode.value = mode
    await window.api.setSetting('lastUsedMode', mode)
  }

  return {
    completed,
    eulaAccepted,
    eulaAcceptedAt,
    telemetryEnabled,
    lastUsedMode,
    loaded,
    loadPrefs,
    setTelemetry,
    setEulaAccepted,
    setLastUsedMode,
    complete,
  }
}
