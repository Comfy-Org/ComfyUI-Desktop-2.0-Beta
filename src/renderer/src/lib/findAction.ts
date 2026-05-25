import type { ActionDef, DetailFieldOption, DetailSection } from '../types/ipc'

/**
 * Locate an action by id inside a `DetailSection[]` payload.
 *
 * Walks two surfaces because actions live in two distinct places:
 *
 *   1. `section.actions[]` — top-level section action rows (e.g.
 *      `check-update`, `launch`, `delete`).
 *   2. `section.fields[].options[].data.actions[]` — actions nested
 *      INSIDE channel-card field options (the per-channel `Update Now`,
 *      `Copy & Update`, `Switch Channel` buttons produced by
 *      `standalone/updateSections.ts`).
 *
 * Both shapes carry real, dispatchable `ActionDef` payloads. Callers
 * that only check `section.actions` will silently fail to resolve any
 * channel-card action — that was the regression that made the
 * title-bar install-update pill's deep-link autoAction a no-op
 * (issue #582). Returns `null` when no match is found.
 *
 * When a `currentChannelValue` is given AND a match is found inside a
 * channel-card option, prefer the option matching that channel value
 * (so e.g. the Update Now for the currently-selected channel wins
 * over a different channel's same-id action).
 */
export function findActionById(
  sections: DetailSection[],
  actionId: string,
  currentChannelValue?: string | null,
): ActionDef | null {
  // 1. Top-level section actions.
  for (const section of sections) {
    const match = section.actions?.find((a) => a.id === actionId)
    if (match) return match
  }

  // 2. Nested per-option actions (channel-cards today; the loop is
  // general so any future option-nested action surface is covered).
  let firstMatch: ActionDef | null = null
  for (const section of sections) {
    for (const field of section.fields ?? []) {
      for (const option of (field.options ?? []) as DetailFieldOption[]) {
        const nestedActions = (option.data?.actions ?? []) as ActionDef[]
        const match = nestedActions.find((a) => a?.id === actionId)
        if (!match) continue
        if (currentChannelValue != null && option.value === currentChannelValue) {
          return match
        }
        if (!firstMatch) firstMatch = match
      }
    }
  }
  return firstMatch
}
