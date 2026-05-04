/**
 * Shared Playwright helpers for E2E navigation tests.
 *
 * All helpers operate on a `page` parameter so they work across different
 * test suites that each launch their own AppContext.
 */

import { expect, type Page } from '@playwright/test'

/** Click a sidebar tab by visible label text. */
export async function clickTab(page: Page, label: string): Promise<void> {
  await page.locator('.sidebar-item', { hasText: label }).click()
}

/** Assert which sidebar tab is active. */
export async function expectActiveTab(page: Page, label: string): Promise<void> {
  const activeItem = page.locator('.sidebar-item.active')
  await expect(activeItem).toContainText(label)
}

/** Assert a modal overlay (.view-modal.active) is visible (or not). */
export async function expectModalVisible(page: Page, visible: boolean): Promise<void> {
  const modal = page.locator('.view-modal.active')
  if (visible) {
    await expect(modal.first()).toBeVisible()
  } else {
    await expect(modal).toHaveCount(0)
  }
}

/** Assert a fullscreen overlay (.view-fullscreen) is visible (or not). */
export async function expectFullscreenVisible(page: Page, visible: boolean): Promise<void> {
  const fs = page.locator('.view-fullscreen')
  if (visible) {
    await expect(fs.first()).toBeVisible()
  } else {
    await expect(fs).toHaveCount(0)
  }
}

/** Open a view in fullscreen mode via the E2E nav bridge. */
export async function presentFullscreen(page: Page, key: string, props: Record<string, unknown> = {}): Promise<void> {
  await page.evaluate(
    ([k, p]: [string, Record<string, unknown>]) => {
      // @ts-expect-error -- browser context: __E2E_NAV__ is injected at runtime
      const nav = globalThis.__E2E_NAV__
      nav.present(k, p, { mode: 'fullscreen' })
    },
    [key, props] as [string, Record<string, unknown>],
  )
}

/** Present an overlay in modal mode via the E2E nav bridge. */
export async function presentModal(page: Page, key: string, props: Record<string, unknown> = {}): Promise<void> {
  await page.evaluate(
    ([k, p]: [string, Record<string, unknown>]) => {
      // @ts-expect-error -- browser context
      const nav = globalThis.__E2E_NAV__
      nav.present(k, p, { mode: 'modal' })
    },
    [key, props] as [string, Record<string, unknown>],
  )
}

/** Dismiss all overlays via the E2E nav bridge. */
export async function dismissAll(page: Page): Promise<void> {
  await page.evaluate(() => {
    // @ts-expect-error -- browser context
    const nav = globalThis.__E2E_NAV__
    nav.dismissAll()
  })
}
