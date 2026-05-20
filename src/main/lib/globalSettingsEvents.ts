import { EventEmitter } from 'node:events'

/** Fires whenever any input to the Global Settings popup snapshot
 *  changes — settings writes, updater state/progress, capability flips.
 *  `titlePopup.ts` subscribes to broadcast a fresh snapshot to open
 *  popups (JSON-deduped so identical snapshots don't trigger a
 *  resize). */
export const globalSettingsEvents = new EventEmitter()
