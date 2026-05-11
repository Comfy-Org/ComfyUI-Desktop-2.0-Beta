/**
 * Re-export of the shared PII / secret scrubber. The canonical
 * implementation lives in `src/shared/piiScrub.ts` so both main and
 * renderer call into the same code (renderer-side telemetry props
 * pass + main-side error / log forwarding). Keeping this shim around
 * means existing `from '../lib/piiScrub'` / `from './piiScrub'`
 * imports inside main don't need to be rewritten.
 */
export { scrubAll, scrubPII, scrubSecrets } from '../../shared/piiScrub'
