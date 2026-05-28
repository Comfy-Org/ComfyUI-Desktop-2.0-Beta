export interface ContextMenuItem {
  id: string
  label: string
  icon?: string
  disabled?: boolean
  separator?: boolean
  /** Visual variant. `danger` paints the item with the `--danger` /
   *  `--danger-hover` tokens for destructive actions. Mirrors the
   *  picker's `MoreMenu` action shape. */
  style?: 'default' | 'danger'
}
