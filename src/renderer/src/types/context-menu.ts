export interface ContextMenuItem {
  id: string
  label: string
  icon?: string
  disabled?: boolean
  /** Hover tooltip — typically the reason a disabled item can't be used
   *  (e.g. "Stop the running instance first"). */
  title?: string
  separator?: boolean
  /** Visual variant. `danger` paints the item with the `--danger` /
   *  `--danger-hover` tokens for destructive actions. Mirrors the
   *  picker's `MoreMenu` action shape. */
  style?: 'default' | 'danger'
}
