import { EventEmitter } from 'node:events'

// Fires when any input to the Global Settings popup snapshot changes;
// titlePopup.ts subscribes to rebroadcast (JSON-deduped) to open popups.
export const globalSettingsEvents = new EventEmitter()
