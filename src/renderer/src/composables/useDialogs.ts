import { reactive, readonly } from 'vue'
import type { ModalDetailGroup, SnapshotDiffResult } from '../types/ipc'
import type { ActionSheetItem } from '../components/ui/BaseActionSheet.vue'

/**
 * Promise-based driver for the BaseModal-shell primitives
 * (`BasePrompt`, `BaseActionSheet`, `BaseAlert`). Mirrors the shape
 * of `useModal()` so action chains can `await dialogs.prompt({...})` /
 * `await dialogs.confirm({...})` / `await dialogs.alert({...})` /
 * `await dialogs.actionSheet({...})` without juggling local refs.
 *
 * Rendered by the singleton `DialogHost.vue`, mounted next to
 * `<ModalDialog />` in `PanelApp.vue` + `TitlePopupApp.vue`.
 *
 * `confirm` resolves to a string union — `'primary' | 'secondary' |
 * false` — so a single resolved value covers all three outcomes
 * (primary, optional secondary, cancel/ESC/backdrop). Cleaner than
 * juggling a boolean plus an extra callback when the dialog has two
 * non-cancel actions (e.g. "Launch" + "Close & Launch").
 *
 * Why parallel to `useModal()` rather than replacing it: the legacy
 * `ModalDialog.vue` host still owns `confirmWithOptions` and rich
 * confirms with `snapshotPreview` / `variantCards` / `updateConfirm`
 * mutation (migrate flow). Those keep working unchanged on `useModal`
 * until they get their own primitives. `useModal` is kept as
 * reference, untouched.
 */

export interface PromptOpts {
  title: string
  message?: string
  placeholder?: string
  defaultValue?: string
  confirmLabel?: string
  cancelLabel?: string
  inputLabel?: string
  required?: boolean | string
  messageDetails?: ModalDetailGroup[]
  size?: 'sm' | 'md' | 'lg' | 'xl'
}

export interface ActionSheetOpts {
  title: string
  message?: string
  items: ActionSheetItem[]
  cancelLabel?: string
  size?: 'sm' | 'md' | 'lg' | 'xl'
}

export interface AlertOpts {
  title: string
  message?: string
  buttonLabel?: string
  /** Tone for the single OK button. Default `'primary'`. */
  tone?: 'primary' | 'danger'
  /** Recessed sub-blocks rendered below the message. */
  messageDetails?: ModalDetailGroup[]
}

export interface ConfirmOpts {
  title: string
  message?: string
  confirmLabel?: string
  cancelLabel?: string
  /** Tone for the primary action. Default `'primary'`. */
  tone?: 'primary' | 'danger'
  /** Optional secondary action sitting between Cancel and Primary.
   *  When `secondaryLabel` is set, the footer renders the secondary
   *  button. Pair with `showCloseIcon: true` when you want the
   *  secondary to replace Cancel in the footer (header ✕ carries
   *  the dismiss affordance instead). */
  secondaryLabel?: string
  secondaryTone?: 'primary' | 'danger' | 'default'
  /** Render Cancel in the footer. Default `true`. Set `false` when
   *  the footer holds two non-cancel actions and `showCloseIcon`
   *  carries the dismiss affordance. */
  showCancel?: boolean
  /** Render the header ✕ icon as the dismiss affordance. Use when
   *  the footer is full of action buttons. Mutually exclusive with
   *  `showCancel`. Default `false`. */
  showCloseIcon?: boolean
  /** Recessed sub-blocks (release notes, change summaries). Gives
   *  rich confirms (e.g. Restore Snapshot) parity with the legacy
   *  `useModal.confirm` `messageDetails` field. */
  messageDetails?: ModalDetailGroup[]
  /** Snapshot diff rendered as a collapsible SnapshotDiffView below the
   *  message (restore-confirm flow). Reuses the same component the
   *  Snapshots tab uses so the "what restoring changes" preview is
   *  identical in both places. */
  restoreDiff?: SnapshotDiffResult | null
}

export type ConfirmResult = 'primary' | 'secondary' | false

export type DialogKind = 'prompt' | 'actionSheet' | 'alert' | 'confirm' | 'none'

export interface PromptState {
  title: string
  message: string
  placeholder: string
  defaultValue: string
  confirmLabel?: string
  cancelLabel?: string
  inputLabel?: string
  required: boolean | string
  messageDetails: ModalDetailGroup[]
  size: 'sm' | 'md' | 'lg' | 'xl'
}

export interface ActionSheetState {
  title: string
  message: string
  items: ActionSheetItem[]
  cancelLabel?: string
  size: 'sm' | 'md' | 'lg' | 'xl'
}

export interface AlertState {
  title: string
  message: string
  buttonLabel?: string
  tone: 'primary' | 'danger'
  messageDetails: ModalDetailGroup[]
}

export interface ConfirmState {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  tone: 'primary' | 'danger'
  secondaryLabel?: string
  secondaryTone: 'primary' | 'danger' | 'default'
  showCancel: boolean
  showCloseIcon: boolean
  messageDetails: ModalDetailGroup[]
  restoreDiff: SnapshotDiffResult | null
}

export interface DialogState {
  kind: DialogKind
  open: boolean
  prompt: PromptState
  actionSheet: ActionSheetState
  alert: AlertState
  confirm: ConfirmState
  resolve: ((value: unknown) => void) | null
}

const state = reactive<DialogState>({
  kind: 'none',
  open: false,
  prompt: {
    title: '',
    message: '',
    placeholder: '',
    defaultValue: '',
    confirmLabel: undefined,
    cancelLabel: undefined,
    inputLabel: undefined,
    required: false,
    messageDetails: [],
    size: 'sm'
  },
  actionSheet: {
    title: '',
    message: '',
    items: [],
    cancelLabel: undefined,
    size: 'sm'
  },
  alert: {
    title: '',
    message: '',
    buttonLabel: undefined,
    tone: 'primary',
    messageDetails: []
  },
  confirm: {
    title: '',
    message: '',
    confirmLabel: undefined,
    cancelLabel: undefined,
    tone: 'primary',
    secondaryLabel: undefined,
    secondaryTone: 'default',
    showCancel: true,
    showCloseIcon: false,
    messageDetails: [],
    restoreDiff: null
  },
  resolve: null
})

function cloneDetails(d?: ModalDetailGroup[]): ModalDetailGroup[] {
  return (d ?? []).map((g) => ({ ...g, items: [...g.items] }))
}

function settle(value: unknown): void {
  const resolve = state.resolve
  state.open = false
  state.kind = 'none'
  state.resolve = null
  if (resolve) resolve(value)
}

/** Cancel value per dialog kind. The four `dialogs.*` methods promise
 *  different shapes (`Promise<string | null>` for prompt/actionSheet,
 *  `Promise<void>` for alert, `Promise<ConfirmResult>` for confirm).
 *  A single shared `cancel()` that always resolved `false` would lie
 *  about prompt/actionSheet's return type and cause callers checking
 *  `=== null` to fall through. Resolve the right falsy value for the
 *  current kind. */
function cancelValueForKind(kind: DialogKind): unknown {
  switch (kind) {
    case 'prompt':
    case 'actionSheet':
      return null
    case 'alert':
      return undefined
    case 'confirm':
      return false satisfies ConfirmResult
    default:
      return null
  }
}

export function useDialogs() {
  function prompt(opts: PromptOpts): Promise<string | null> {
    return new Promise((resolve) => {
      if (state.resolve) state.resolve(cancelValueForKind(state.kind))
      state.prompt = {
        title: opts.title,
        message: opts.message ?? '',
        placeholder: opts.placeholder ?? '',
        defaultValue: opts.defaultValue ?? '',
        confirmLabel: opts.confirmLabel,
        cancelLabel: opts.cancelLabel,
        inputLabel: opts.inputLabel,
        required: opts.required ?? false,
        messageDetails: cloneDetails(opts.messageDetails),
        size: opts.size ?? 'sm'
      }
      state.kind = 'prompt'
      state.open = true
      state.resolve = resolve as (value: unknown) => void
    })
  }

  function actionSheet(opts: ActionSheetOpts): Promise<string | null> {
    return new Promise((resolve) => {
      if (state.resolve) state.resolve(cancelValueForKind(state.kind))
      state.actionSheet = {
        title: opts.title,
        message: opts.message ?? '',
        items: opts.items.map((i) => ({ ...i })),
        cancelLabel: opts.cancelLabel,
        size: opts.size ?? 'sm'
      }
      state.kind = 'actionSheet'
      state.open = true
      state.resolve = resolve as (value: unknown) => void
    })
  }

  function alert(opts: AlertOpts): Promise<void> {
    return new Promise((resolve) => {
      if (state.resolve) state.resolve(cancelValueForKind(state.kind))
      state.alert = {
        title: opts.title,
        message: opts.message ?? '',
        buttonLabel: opts.buttonLabel,
        tone: opts.tone ?? 'primary',
        messageDetails: cloneDetails(opts.messageDetails)
      }
      state.kind = 'alert'
      state.open = true
      state.resolve = (() => resolve()) as (value: unknown) => void
    })
  }

  function confirm(opts: ConfirmOpts): Promise<ConfirmResult> {
    return new Promise((resolve) => {
      if (state.resolve) state.resolve(cancelValueForKind(state.kind))
      const hasSecondary = !!opts.secondaryLabel
      // Default: show Cancel unless caller explicitly hides it. When
      // caller hides Cancel and wants a dismiss path, they pass
      // showCloseIcon: true. We don't auto-flip these — leaving it
      // explicit catches mis-wired call sites in code review.
      state.confirm = {
        title: opts.title,
        message: opts.message ?? '',
        confirmLabel: opts.confirmLabel,
        cancelLabel: opts.cancelLabel,
        tone: opts.tone ?? 'primary',
        secondaryLabel: opts.secondaryLabel,
        secondaryTone: opts.secondaryTone ?? 'default',
        showCancel: opts.showCancel ?? !hasSecondary,
        showCloseIcon: opts.showCloseIcon ?? hasSecondary,
        messageDetails: cloneDetails(opts.messageDetails),
        restoreDiff: opts.restoreDiff ?? null
      }
      state.kind = 'confirm'
      state.open = true
      state.resolve = resolve as (value: unknown) => void
    })
  }

  return {
    state: readonly(state) as DialogState,
    prompt,
    actionSheet,
    alert,
    confirm,
    /** Host calls this when the user submits a prompt value. */
    submitPrompt: (value: string) => settle(value),
    /** Host calls this when the user picks an action-sheet item. */
    selectActionSheet: (value: string) => settle(value),
    /** Host calls this when the alert OK button fires (resolves void). */
    acknowledgeAlert: () => settle(undefined),
    /** Host calls this when the confirm primary action fires. */
    confirmPrimary: () => settle('primary' satisfies ConfirmResult),
    /** Host calls this when the confirm secondary action fires. */
    confirmSecondary: () => settle('secondary' satisfies ConfirmResult),
    /** Host calls this on cancel / ESC / backdrop / close icon.
     *  Resolves the in-flight promise with the kind-appropriate
     *  falsy value (`null` for prompt/actionSheet, `undefined` for
     *  alert, `false` for confirm). */
    cancel: () => settle(cancelValueForKind(state.kind))
  }
}
