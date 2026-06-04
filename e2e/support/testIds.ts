/**
 * Re-export the production `TID` registry so e2e selectors type-check against
 * the same constants the components render — never type a raw `data-testid`.
 */

export { TID } from '../../src/shared/testIds'
export type { TestIdKey } from '../../src/shared/testIds'

/** CSS selector for a given test id. */
export function byTestId(id: string): string {
  // `TID` values are kebab-case ascii, so no escaping is needed.
  return `[data-testid="${id}"]`
}
