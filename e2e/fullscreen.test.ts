/**
 * E2E tests for fullscreen view mode.
 *
 * Tests each modal view in both modal (baseline) and fullscreen modes
 * to verify the Phase 3 per-view migration.
 *
 * Run: pnpm run build && pnpm run test:e2e:windows
 */

import { test, expect } from '@playwright/test'
import { launchApp, type AppContext } from './launchApp'

let ctx: AppContext

test.beforeAll(async () => {
  ctx = await launchApp({
    installations: [{ name: 'Fullscreen Test Install' }],
  })
})

test.afterAll(async () => {
  await ctx.cleanup()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function clickTab(label: string): Promise<void> {
  await ctx.page.locator('.sidebar-item', { hasText: label }).click()
}

async function expectActiveTab(label: string): Promise<void> {
  const activeItem = ctx.page.locator('.sidebar-item.active')
  await expect(activeItem).toContainText(label)
}

/** Assert a modal overlay is visible (or not). */
async function expectModalVisible(visible: boolean): Promise<void> {
  const modal = ctx.page.locator('.view-modal.active')
  if (visible) {
    await expect(modal.first()).toBeVisible()
  } else {
    await expect(modal).toHaveCount(0)
  }
}

/** Assert a fullscreen overlay is visible (or not). */
async function expectFullscreenVisible(visible: boolean): Promise<void> {
  const fs = ctx.page.locator('.view-fullscreen')
  if (visible) {
    await expect(fs.first()).toBeVisible()
  } else {
    await expect(fs).toHaveCount(0)
  }
}

/** Open a view in fullscreen mode via the E2E nav bridge. */
async function presentFullscreen(key: string, props: Record<string, unknown> = {}): Promise<void> {
  await ctx.page.evaluate(
    ([k, p]: [string, Record<string, unknown>]) => {
      // @ts-expect-error -- browser context: __E2E_NAV__ is injected at runtime
      const nav = globalThis.__E2E_NAV__
      nav.present(k, p, { mode: 'fullscreen' })
    },
    [key, props] as [string, Record<string, unknown>],
  )
}

/** Present an overlay in modal mode via the E2E nav bridge. */
async function presentModal(key: string, props: Record<string, unknown> = {}): Promise<void> {
  await ctx.page.evaluate(
    ([k, p]: [string, Record<string, unknown>]) => {
      // @ts-expect-error -- browser context
      const nav = globalThis.__E2E_NAV__
      nav.present(k, p, { mode: 'modal' })
    },
    [key, props] as [string, Record<string, unknown>],
  )
}

/** Dismiss all overlays via the E2E nav bridge. */
async function dismissAll(): Promise<void> {
  await ctx.page.evaluate(() => {
    // @ts-expect-error -- browser context
    const nav = globalThis.__E2E_NAV__
    nav.dismissAll()
  })
}

// ---------------------------------------------------------------------------
// Settings — baseline tab tests @windows
// ---------------------------------------------------------------------------

test('Settings tab shows content @windows', async () => {
  await clickTab('Settings')
  await expectActiveTab('Settings')
  // Settings breadcrumb should be visible (use text filter to disambiguate from other tab breadcrumbs)
  await expect(ctx.page.locator('.breadcrumb-current', { hasText: 'Settings' })).toBeVisible({ timeout: 10_000 })
})

test('Settings tab persists across tab switches @windows', async () => {
  await clickTab('Dashboard')
  await clickTab('Settings')
  await expectActiveTab('Settings')
  await expect(ctx.page.locator('.breadcrumb-current', { hasText: 'Settings' })).toBeVisible({ timeout: 10_000 })
})

// ---------------------------------------------------------------------------
// NewInstallModal — baseline modal tests @windows
// ---------------------------------------------------------------------------

test('NewInstallModal opens in modal mode with correct structure @windows', async () => {
  await clickTab('Installs')
  const btn = ctx.page.locator('button', { hasText: /New Install/i }).first()
  if (!(await btn.isVisible())) return
  await btn.click()
  await expectModalVisible(true)

  // Should have modal overlay with backdrop
  const overlay = ctx.page.locator('.view-modal.active[data-overlay-key="new-install"]')
  await expect(overlay).toBeVisible()
  await expect(overlay).toHaveAttribute('data-overlay-mode', 'modal')

  // Should have content, header, close button
  await expect(overlay.locator('.view-modal-content')).toBeVisible()
  await expect(overlay.locator('.view-modal-close')).toBeVisible()

  await ctx.page.keyboard.press('Escape')
  await expectModalVisible(false)
})

// ---------------------------------------------------------------------------
// NewInstallModal — fullscreen tests @windows
// ---------------------------------------------------------------------------

test('NewInstallModal opens in fullscreen mode @windows', async () => {
  await presentFullscreen('new-install')
  await expectFullscreenVisible(true)
  await expectModalVisible(false) // No modal backdrop

  const overlay = ctx.page.locator('.view-fullscreen[data-overlay-key="new-install"]')
  await expect(overlay).toBeVisible()
  await expect(overlay).toHaveAttribute('data-overlay-mode', 'fullscreen')

  // Content should fill the view
  await expect(overlay.locator('.view-modal-content')).toBeVisible()
  await expect(overlay.locator('.view-modal-close')).toBeVisible()

  await dismissAll()
  await expectFullscreenVisible(false)
})

test('NewInstallModal fullscreen closes on Escape @windows', async () => {
  await presentFullscreen('new-install')
  await expectFullscreenVisible(true)

  await ctx.page.keyboard.press('Escape')
  await expectFullscreenVisible(false)
})

test('NewInstallModal fullscreen preserves tab state @windows', async () => {
  await clickTab('Settings')
  await expectActiveTab('Settings')

  await presentFullscreen('new-install')
  await expectFullscreenVisible(true)

  await ctx.page.keyboard.press('Escape')
  await expectFullscreenVisible(false)

  // Tab should still be Settings
  await expectActiveTab('Settings')
})

// ---------------------------------------------------------------------------
// QuickInstallModal — baseline modal tests @windows
// ---------------------------------------------------------------------------

test('QuickInstallModal opens in modal mode @windows', async () => {
  await clickTab('Dashboard')
  const btn = ctx.page.locator('button', { hasText: /Quick Install/i }).first()
  if (!(await btn.isVisible())) return
  await btn.click()
  await expectModalVisible(true)

  const overlay = ctx.page.locator('.view-modal.active[data-overlay-key="quick-install"]')
  await expect(overlay).toBeVisible()

  await ctx.page.keyboard.press('Escape')
  await expectModalVisible(false)
})

// ---------------------------------------------------------------------------
// QuickInstallModal — fullscreen tests @windows
// ---------------------------------------------------------------------------

test('QuickInstallModal opens in fullscreen mode @windows', async () => {
  await presentFullscreen('quick-install')
  await expectFullscreenVisible(true)

  const overlay = ctx.page.locator('.view-fullscreen[data-overlay-key="quick-install"]')
  await expect(overlay).toBeVisible()
  await expect(overlay.locator('.view-modal-content')).toBeVisible()

  await dismissAll()
  await expectFullscreenVisible(false)
})

// ---------------------------------------------------------------------------
// TrackModal — baseline modal tests @windows
// ---------------------------------------------------------------------------

test('TrackModal opens in modal mode @windows', async () => {
  await clickTab('Installs')
  const btn = ctx.page.locator('button', { hasText: /Track Existing/i })
  if (!(await btn.isVisible())) return
  await btn.click()
  await expectModalVisible(true)

  const overlay = ctx.page.locator('.view-modal.active[data-overlay-key="track"]')
  await expect(overlay).toBeVisible()

  await ctx.page.keyboard.press('Escape')
  await expectModalVisible(false)
})

// ---------------------------------------------------------------------------
// TrackModal — fullscreen tests @windows
// ---------------------------------------------------------------------------

test('TrackModal opens in fullscreen mode @windows', async () => {
  await presentFullscreen('track')
  await expectFullscreenVisible(true)

  const overlay = ctx.page.locator('.view-fullscreen[data-overlay-key="track"]')
  await expect(overlay).toBeVisible()
  await expect(overlay.locator('.view-modal-content')).toBeVisible()
  await expect(overlay.locator('.view-modal-title')).toContainText('Track')

  await dismissAll()
  await expectFullscreenVisible(false)
})

// ---------------------------------------------------------------------------
// LoadSnapshotModal — baseline modal tests @windows
// ---------------------------------------------------------------------------

test('LoadSnapshotModal opens in modal mode @windows', async () => {
  await clickTab('Installs')
  const btn = ctx.page.locator('button', { hasText: /Load Snapshot/i })
  if (!(await btn.isVisible())) return
  await btn.click()
  await expectModalVisible(true)

  const overlay = ctx.page.locator('.view-modal.active[data-overlay-key="load-snapshot"]')
  await expect(overlay).toBeVisible()

  await ctx.page.keyboard.press('Escape')
  await expectModalVisible(false)
})

// ---------------------------------------------------------------------------
// LoadSnapshotModal — fullscreen tests @windows
// ---------------------------------------------------------------------------

test('LoadSnapshotModal opens in fullscreen mode @windows', async () => {
  await presentFullscreen('load-snapshot')
  await expectFullscreenVisible(true)

  const overlay = ctx.page.locator('.view-fullscreen[data-overlay-key="load-snapshot"]')
  await expect(overlay).toBeVisible()
  await expect(overlay.locator('.view-modal-content')).toBeVisible()

  await dismissAll()
  await expectFullscreenVisible(false)
})

// ---------------------------------------------------------------------------
// DetailModal — baseline modal tests @windows
// ---------------------------------------------------------------------------

test('DetailModal opens in modal mode via Manage @windows', async () => {
  await clickTab('Installs')
  const card = ctx.page.locator('.instance-card', { hasText: 'Fullscreen Test Install' })
  await card.first().locator('button', { hasText: /Manage/i }).click()
  await expectModalVisible(true)

  const overlay = ctx.page.locator('.view-modal.active[data-overlay-key="detail"]')
  await expect(overlay).toBeVisible()
  await expect(overlay.locator('.view-modal-content')).toBeVisible()

  await ctx.page.keyboard.press('Escape')
  await expectModalVisible(false)
})

// ---------------------------------------------------------------------------
// DetailModal — fullscreen tests @windows
// ---------------------------------------------------------------------------

test('DetailModal opens in fullscreen mode @windows', async () => {
  // Present detail in fullscreen via the nav bridge with a mock installation
  await presentFullscreen('detail', {
    installation: { id: 'inst-test-0', name: 'Fullscreen Test Install', sourceCategory: 'standalone' },
    initialTab: 'status',
    autoAction: null,
  })

  await expectFullscreenVisible(true)
  const overlay = ctx.page.locator('.view-fullscreen[data-overlay-key="detail"]')
  await expect(overlay).toBeVisible()
  await expect(overlay.locator('.view-modal-content')).toBeVisible()

  await dismissAll()
  await expectFullscreenVisible(false)
})

// ---------------------------------------------------------------------------
// ConsoleModal — fullscreen tests @windows
// ---------------------------------------------------------------------------

test('ConsoleModal opens in fullscreen mode @windows', async () => {
  await presentFullscreen('console', { installationId: 'inst-test-0' })
  await expectFullscreenVisible(true)

  const overlay = ctx.page.locator('.view-fullscreen[data-overlay-key="console"]')
  await expect(overlay).toBeVisible()

  await dismissAll()
  await expectFullscreenVisible(false)
})

// ---------------------------------------------------------------------------
// ProgressModal — fullscreen tests @windows
// ---------------------------------------------------------------------------

test('ProgressModal opens in fullscreen mode @windows', async () => {
  await presentFullscreen('progress', { installationId: 'inst-test-0' })
  await expectFullscreenVisible(true)

  const overlay = ctx.page.locator('.view-fullscreen[data-overlay-key="progress"]')
  await expect(overlay).toBeVisible()

  await dismissAll()
  await expectFullscreenVisible(false)
})

// ---------------------------------------------------------------------------
// Fullscreen does not show backdrop @windows
// ---------------------------------------------------------------------------

test('fullscreen overlay has no backdrop overlay @windows', async () => {
  await presentFullscreen('new-install')
  await expectFullscreenVisible(true)

  // No .view-modal backdrop should exist
  await expectModalVisible(false)

  await dismissAll()
})

// ---------------------------------------------------------------------------
// Mixed modal + fullscreen stacking @windows
// ---------------------------------------------------------------------------

test('modal on top of fullscreen stacks correctly @windows', async () => {
  // Open fullscreen first
  await presentFullscreen('new-install')
  await expectFullscreenVisible(true)

  // Open a modal on top
  await presentModal('track')

  await expectModalVisible(true)
  await expectFullscreenVisible(true)

  // Escape closes only the top (modal Track)
  await ctx.page.keyboard.press('Escape')
  await expectModalVisible(false)
  await expectFullscreenVisible(true)

  // Escape again closes the fullscreen
  await ctx.page.keyboard.press('Escape')
  await expectFullscreenVisible(false)
})
