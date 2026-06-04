import { reactive, readonly } from 'vue'
import type { ModalDetailGroup, SnapshotDiffResult } from '../types/ipc'
import type { ActionSheetItem } from '../components/ui/BaseActionSheet.vue'

// Promise-based driver for the BaseModal-shell primitives, rendered by the
// singleton DialogHost.vue. Mirrors `useModal()`; `confirm` resolves to
// `'primary' | 'secondary' | false`. Runs parallel to `useModal`, which still
// owns confirmWithOptions and the rich migrate-flow confirms.

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
  tone?: 'primary' | 'danger'
  /** Middle action between Cancel and Primary. */
  secondaryLabel?: string
  secondaryTone?: 'primary' | 'danger' | 'default'
  showCancel?: boolean
  /** Header ✕ dismiss affordance; mutually exclusive with `showCancel`. */
  showCloseIcon?: boolean
  /** Recessed sub-blocks (release notes, change summaries). */
  messageDetails?: ModalDetailGroup[]
  /** Collapsible snapshot diff below the message (restore-confirm flow). */
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

// Cancel resolves a kind-specific falsy value (null / undefined / false), so
// callers checking one shape don't fall through on another.
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
    submitPrompt: (value: string) => settle(value),
    selectActionSheet: (value: string) => settle(value),
    acknowledgeAlert: () => settle(undefined),
    confirmPrimary: () => settle('primary' satisfies ConfirmResult),
    confirmSecondary: () => settle('secondary' satisfies ConfirmResult),
    cancel: () => settle(cancelValueForKind(state.kind))
  }
}
