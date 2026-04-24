/**
 * Helper for interacting with the ComfyUI window spawned by the Launcher.
 *
 * The ComfyUI window uses a split layout:
 *   BrowserWindow (comfyWindow)
 *     ├── WebContentsView (titleBarView)  — custom title bar
 *     └── WebContentsView (comfyView)     — the actual ComfyUI frontend
 *
 * Playwright's `app.windows()` / `on('window')` only expose BrowserWindow
 * main webContents, NOT child WebContentsView webContents (see Playwright
 * issue #39427).  The ComfyUI frontend lives in the child comfyView, so we
 * cannot get a native Playwright Page for it directly.
 *
 * This module provides two access layers:
 *
 * 1. **CDP bridge** (`getComfyPage`) — connects to the ComfyUI webContents
 *    via Chrome DevTools Protocol, yielding a *real* Playwright `Page` with
 *    full locator / auto-wait / assertion support.  Requires the Electron
 *    app to be launched with `--remote-debugging-port=<N>` (the harness does
 *    this automatically).
 *
 * 2. **Eval bridge** (`comfyEval`, `comfyClick`, etc.) — lightweight helpers
 *    that run `executeJavaScript` on the ComfyUI webContents from the main
 *    process via `app.evaluate()`.  No Playwright auto-waiting, but zero
 *    extra connection overhead.
 *
 * Prefer the CDP bridge when you need rich interaction (clicking, typing,
 * waiting for elements).  Use the eval bridge for quick value reads.
 */

import { chromium, type ElectronApplication, type Page, type Browser } from 'playwright'

// ---------------------------------------------------------------------------
// Shared: ComfyUI webContents finder (used by both bridges)
// ---------------------------------------------------------------------------

/** Evaluate expression that finds the ComfyUI webContents ID. Shared by all eval-bridge helpers. */
function _findComfyId(app: ElectronApplication): Promise<number | null> {
  return app.evaluate(({ webContents }) => {
    for (const wc of webContents.getAllWebContents()) {
      const url = wc.getURL()
      if (url.startsWith('http://127.0.0.1:') || url.startsWith('http://localhost:')) {
        return wc.id
      }
    }
    return null
  })
}

// ---------------------------------------------------------------------------
// CDP bridge — real Playwright Page
// ---------------------------------------------------------------------------

/** State for a CDP-backed connection to the ComfyUI webContents. */
export interface ComfyCdpHandle {
  browser: Browser
  page: Page
}

/**
 * Get a real Playwright `Page` backed by the ComfyUI webContents.
 *
 * Connects via CDP to the Electron remote-debugging port and finds the
 * target whose URL points to localhost (the ComfyUI frontend).
 *
 * The returned Page supports locators, auto-waiting, screenshots, etc.
 * The caller owns the returned handle and must call `handle.browser.close()`
 * when done (typically in afterAll).
 *
 * @param cdpPort — the remote-debugging port (from `AppContext.cdpPort`)
 */
export async function getComfyPage(
  cdpPort: number,
  options?: { timeout?: number },
): Promise<ComfyCdpHandle> {
  const timeout = options?.timeout ?? 120_000
  const start = Date.now()

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`)

  // Poll until the ComfyUI target appears (the window may not exist yet).
  while (Date.now() - start < timeout) {
    for (const ctx of browser.contexts()) {
      for (const page of ctx.pages()) {
        const url = page.url()
        if (url.startsWith('http://127.0.0.1:') || url.startsWith('http://localhost:')) {
          return { browser, page }
        }
      }
    }
    await new Promise((r) => setTimeout(r, 500))
  }

  await browser.close().catch(() => {})
  throw new Error(`ComfyUI page not found via CDP within ${timeout}ms`)
}

// ---------------------------------------------------------------------------
// Eval bridge — lightweight, no extra connection
// ---------------------------------------------------------------------------

/**
 * Find the webContents ID of the ComfyUI view.
 * Returns the ID, or null if no ComfyUI webContents exists.
 */
export const getComfyWebContentsId = _findComfyId

/**
 * Execute JavaScript in the ComfyUI webContents and return the result.
 * Throws if no ComfyUI webContents is found.
 */
export async function comfyEval(app: ElectronApplication, expression: string): Promise<unknown> {
  const wcId = await _findComfyId(app)
  if (wcId === null) throw new Error('ComfyUI webContents not found')
  return app.evaluate(async ({ webContents }, { id, expr }) => {
    const wc = webContents.fromId(id)
    if (!wc || wc.isDestroyed()) throw new Error('ComfyUI webContents destroyed')
    return wc.executeJavaScript(expr)
  }, { id: wcId, expr: expression })
}

/** Query the ComfyUI DOM via executeJavaScript. */
export async function comfyQuerySelector(
  app: ElectronApplication,
  selector: string,
  property?: string,
): Promise<unknown> {
  const expr = property
    ? `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.${property} : null })()`
    : `!!document.querySelector(${JSON.stringify(selector)})`
  return comfyEval(app, expr)
}

/** Wait for the ComfyUI frontend to load in its webContents. */
export async function waitForComfyReady(
  app: ElectronApplication,
  options?: { timeout?: number },
): Promise<void> {
  const timeout = options?.timeout ?? 120_000
  const start = Date.now()

  while (Date.now() - start < timeout) {
    const id = await _findComfyId(app)
    if (id !== null) {
      const loaded = await app.evaluate(async ({ webContents }, wcId) => {
        const wc = webContents.fromId(wcId)
        if (!wc || wc.isDestroyed()) return false
        return !wc.isLoading()
      }, id)
      if (loaded) return
    }
    await new Promise((r) => setTimeout(r, 1_000))
  }
  throw new Error(`ComfyUI webContents did not become ready within ${timeout}ms`)
}

/** Get the current URL loaded in the ComfyUI webContents. */
export async function getComfyUrl(app: ElectronApplication): Promise<string | null> {
  const id = await _findComfyId(app)
  if (id === null) return null
  return app.evaluate(({ webContents }, wcId) => {
    const wc = webContents.fromId(wcId)
    return wc && !wc.isDestroyed() ? wc.getURL() : null
  }, id)
}

/** Click an element in the ComfyUI webContents by selector. */
export async function comfyClick(app: ElectronApplication, selector: string): Promise<boolean> {
  return comfyEval(app, `
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return false
      el.click()
      return true
    })()
  `) as Promise<boolean>
}

/** Query all matching elements and return an array of property values. */
export async function comfyQuerySelectorAll(
  app: ElectronApplication,
  selector: string,
  property: string,
): Promise<unknown[]> {
  return comfyEval(app, `
    Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
      .map(el => el.${property})
  `) as Promise<unknown[]>
}
