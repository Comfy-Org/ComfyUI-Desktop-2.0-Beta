import type { ActionDef, DetailFieldOption, DetailSection } from '../types/ipc'

/**
 * Locate an action by id across both surfaces it can live in: top-level
 * `section.actions[]` and nested `section.fields[].options[].data.actions[]`
 * (channel-card options). With `currentChannelValue`, a nested match on that
 * channel is preferred. Returns null when nothing matches.
 */
export function findActionById(
  sections: DetailSection[],
  actionId: string,
  currentChannelValue?: string | null,
): ActionDef | null {
  for (const section of sections) {
    const match = section.actions?.find((a) => a.id === actionId)
    if (match) return match
  }

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
