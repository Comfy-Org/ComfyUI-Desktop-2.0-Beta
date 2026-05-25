/**
 * Re-export the production `TID` registry so e2e selectors are
 * type-checked against the same constants the Vue components render.
 *
 * Tests should `import { TID, byTestId } from './support/testIds'` and
 * never type a raw `data-testid` literal. Renaming a production id
 * becomes a typecheck error here instead of a silent runtime miss.
 */

export { TID } from '../../src/shared/testIds'
export type { TestIdKey } from '../../src/shared/testIds'

/** CSS selector for a given test id. Use inside `WebContentsPage`
 *  helpers: `page.click(byTestId(TID.modalConfirm))`. */
export function byTestId(id: string): string {
  // CSS attribute selector — values from `TID` are kebab-case ascii
  // so no escaping is needed.
  return `[data-testid="${id}"]`
}
