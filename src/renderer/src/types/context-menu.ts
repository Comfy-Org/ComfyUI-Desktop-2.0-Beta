export interface ContextMenuItem {
  id: string
  label: string
  icon?: string
  disabled?: boolean
  /** Hover tooltip, typically the reason a disabled item can't be used. */
  title?: string
  separator?: boolean
  style?: 'default' | 'danger'
}
