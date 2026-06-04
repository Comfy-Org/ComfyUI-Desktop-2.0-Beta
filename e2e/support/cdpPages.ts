/**
 * Eval-bridge helpers for asserting against renderer DOM in WebContentsViews.
 * `connectOverCDP` hangs here: the host BrowserWindow has no DOM and child
 * WebContentsView targets aren't exposed as Pages, so we run
 * `executeJavaScript` against each webContents via `app.evaluate()` instead.
 */
import type { ElectronApplication } from '@playwright/test'
import { expect } from '@playwright/test'
import { evalWithRetry } from './evalRetry'

export function findWebContentsId(
  app: ElectronApplication,
  marker: string,
): Promise<number | null> {
  return evalWithRetry(() => app.evaluate(({ webContents }, m) => {
    for (const wc of webContents.getAllWebContents()) {
      if (wc.getURL().includes(m)) return wc.id
    }
    return null
  }, marker))
}

/** Wait until a webContents whose URL contains `marker` exists. */
export async function waitForWebContents(
  app: ElectronApplication,
  marker: string,
  timeoutMs = 30_000,
): Promise<number> {
  let id: number | null = null
  await expect.poll(
    async () => {
      id = await findWebContentsId(app, marker)
      return id !== null
    },
    { timeout: timeoutMs, intervals: [250, 500, 1000] },
  ).toBe(true)
  return id!
}

/**
 * Page-like façade over a WebContentsView's webContents. Re-resolves the
 * webContents id each call so it survives reloads while the URL marker matches.
 */
export class WebContentsPage {
  constructor(
    private readonly app: ElectronApplication,
    private readonly marker: string,
  ) {}

  private async wcEval<T>(expr: string): Promise<T> {
    return this.evaluate<T>(expr)
  }

  /** Evaluate an arbitrary JS expression in the matching webContents. */
  async evaluate<T>(expr: string): Promise<T> {
    const id = await findWebContentsId(this.app, this.marker)
    if (id === null) throw new Error(`webContents not found (marker=${this.marker})`)
    return evalWithRetry(() => this.app.evaluate(async ({ webContents }, payload) => {
      const wc = webContents.fromId(payload.id)
      if (!wc || wc.isDestroyed()) throw new Error('webContents destroyed')
      return wc.executeJavaScript(payload.expr) as Promise<unknown>
    }, { id, expr })) as Promise<T>
  }

  url(): Promise<string> {
    return this.wcEval<string>('location.href')
  }

  /** True iff at least one element matches the CSS selector. */
  exists(selector: string): Promise<boolean> {
    return this.wcEval<boolean>(`!!document.querySelector(${JSON.stringify(selector)})`)
  }

  /** Element count matching the selector. */
  count(selector: string): Promise<number> {
    return this.wcEval<number>(`document.querySelectorAll(${JSON.stringify(selector)}).length`)
  }

  /** Text content of the first matching element, or null if none. */
  textOf(selector: string): Promise<string | null> {
    return this.wcEval<string | null>(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? (el.textContent || '').trim() : null })()`,
    )
  }

  /** All text contents matching the selector. */
  allText(selector: string): Promise<string[]> {
    return this.wcEval<string[]>(
      `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).map(el => (el.textContent || '').trim())`,
    )
  }

  /** True iff the first match is visible (display + size > 0, opacity > 0). */
  isVisible(selector: string): Promise<boolean> {
    return this.wcEval<boolean>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return false
      const style = getComputedStyle(el)
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false
      const rect = el.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    })()`)
  }

  /** Click the first matching element. Returns false if not found. */
  click(selector: string): Promise<boolean> {
    return this.wcEval<boolean>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return false
      el.click()
      return true
    })()`)
  }

  /**
   * Click the first element matching `selector` whose textContent contains
   * `textSubstring` (case-insensitive). Returns false if no match.
   */
  clickByText(selector: string, textSubstring: string): Promise<boolean> {
    return this.wcEval<boolean>(`(() => {
      const needle = ${JSON.stringify(textSubstring.toLowerCase())}
      const els = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
      const match = els.find(el => (el.textContent || '').toLowerCase().includes(needle))
      if (!match) return false
      match.click()
      return true
    })()`)
  }

  /** Press a key by dispatching a KeyboardEvent (limited; for Escape/Enter and similar). */
  pressKey(key: string): Promise<void> {
    return this.wcEval<void>(`(() => {
      const ev = new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true })
      document.dispatchEvent(ev)
    })()`)
  }

  /** Wait until `pred` returns true, polling the webContents. */
  async waitFor(
    pred: () => Promise<boolean> | boolean,
    opts: { timeout?: number; message?: string } = {},
  ): Promise<void> {
    await expect.poll(async () => pred(), {
      timeout: opts.timeout ?? 15_000,
      intervals: [200, 400, 800],
      message: opts.message,
    }).toBe(true)
  }

  /** Wait until at least one element matches `selector`. */
  waitForSelector(selector: string, opts: { timeout?: number } = {}): Promise<void> {
    return this.waitFor(() => this.exists(selector), {
      timeout: opts.timeout,
      message: `selector ${selector} did not appear`,
    })
  }

  /** Wait until at least one element is visible (display + size > 0). */
  waitForVisible(selector: string, opts: { timeout?: number } = {}): Promise<void> {
    return this.waitFor(() => this.isVisible(selector), {
      timeout: opts.timeout,
      message: `selector ${selector} did not become visible`,
    })
  }
}

/** WebContentsPage for the chooser/lifecycle/etc panel body. */
export function panelPage(app: ElectronApplication): WebContentsPage {
  return new WebContentsPage(app, 'panel.html')
}

/** WebContentsPage for the host's native title bar. */
export function titleBarPage(app: ElectronApplication): WebContentsPage {
  return new WebContentsPage(app, 'comfyTitleBar.html')
}

/** WebContentsPage for the title-bar dropdown popup (waffle / downloads). */
export function titlePopupPage(app: ElectronApplication): WebContentsPage {
  return new WebContentsPage(app, 'comfyTitlePopup.html')
}

/** WebContentsPage for the shell-level system-modal popup. */
export function systemModalPage(app: ElectronApplication): WebContentsPage {
  return new WebContentsPage(app, 'comfySystemModal.html')
}

/**
 * True iff the WebContentsView matching `marker` is `setVisible(true)` and
 * has non-zero bounds — the EmbeddedPopupView contract for "shown to user".
 */
export function isPopupVisible(
  app: ElectronApplication,
  marker: string,
): Promise<boolean> {
  return app.evaluate(({ BrowserWindow, WebContentsView }, m) => {
    for (const win of BrowserWindow.getAllWindows()) {
      for (const child of win.contentView.children) {
        if (!(child instanceof WebContentsView)) continue
        if (!child.webContents.getURL().includes(m)) continue
        if (!child.getVisible()) return false
        const b = child.getBounds()
        return b.width > 0 && b.height > 0
      }
    }
    return false
  }, marker)
}

/** Force-close the title popup via its bridge if it is currently visible. */
export async function closeTitlePopupIfOpen(app: ElectronApplication): Promise<void> {
  const id = await findWebContentsId(app, 'comfyTitlePopup.html')
  if (id === null) return
  if (!(await isPopupVisible(app, 'comfyTitlePopup.html'))) return
  await app.evaluate(({ webContents }) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().includes('comfyTitlePopup.html'))
    if (!wc) return
    return wc.executeJavaScript(`(window).__comfyTitlePopup.close()`)
  })
  await expect.poll(
    () => isPopupVisible(app, 'comfyTitlePopup.html'),
    { timeout: 3_000, intervals: [100, 200] },
  ).toBe(false)
}

/** Wait past the title bar's 100ms reopen-suppression debounce; padded
 *  so CI timer drift can't push the wait under the suppression window. */
export const TITLE_REOPEN_SUPPRESSION_MS = 300
