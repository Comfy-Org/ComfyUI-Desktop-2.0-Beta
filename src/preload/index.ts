import { contextBridge } from 'electron'
import { buildElectronApi } from './api'

const api = buildElectronApi()

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('api', api)
} else {
  (globalThis as Record<string, unknown>).api = api
}
