/**
 * E2E tests for navigation: tab switching, modal open/close, cross-modal transitions.
 *
 * Run: pnpm run build && pnpm run test:e2e:windows
 */

import { test, expect } from '@playwright/test'
import { launchApp, type AppContext } from './launchApp'

let ctx: AppContext

test.beforeAll(async () => {
  ctx = await launchApp({
    installations: [{ name: 'E2E Test Install' }],
  })
})

test.afterAll(async () => {
  await ctx.cleanup()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Click a sidebar tab by its translation key content. */
async function clickTab(label: string): Promise<void> {
  await ctx.page.locator('.sidebar-item', { hasText: label }).click()
}

/** Assert which sidebar tab is active. */
async function expectActiveTab(label: string): Promise<void> {
  const activeItem = ctx.page.locator('.sidebar-item.active')
  await expect(activeItem).toContainText(label)
}

/** Assert a view-modal overlay is visible (or not). */
async function expectModalVisible(visible: boolean): Promise<void> {
  const modal = ctx.page.locator('.view-modal.active')
  if (visible) {
    await expect(modal.first()).toBeVisible()
  } else {
    await expect(modal).toHaveCount(0)
  }
}

// ---------------------------------------------------------------------------
// Tab switching @windows
// ---------------------------------------------------------------------------

test('app launches on dashboard tab @windows', async () => {
  await expectActiveTab('Dashboard')
})

test('tab switching — all tabs @windows', async () => {
  const tabs = ['Installs', 'Running', 'Models', 'Media', 'Settings']
  for (const tab of tabs) {
    await clickTab(tab)
    await expectActiveTab(tab)
  }
  // Return to dashboard
  await clickTab('Dashboard')
  await expectActiveTab('Dashboard')
})

// ---------------------------------------------------------------------------
// Installation list actions @windows
// ---------------------------------------------------------------------------

test('New Installation modal opens and closes @windows', async () => {
  await clickTab('Installs')
  await expectActiveTab('Installs')

  // Find and click the "New Installation" button (first match — header button)
  const newInstallBtn = ctx.page.locator('button', { hasText: /New Install/i }).first()
  if (await newInstallBtn.isVisible()) {
    await newInstallBtn.click()
    await expectModalVisible(true)

    // Close via the ✕ button
    await ctx.page.locator('.view-modal.active .view-modal-close').click()
    await expectModalVisible(false)
  }
})

test('Track Existing modal opens and closes @windows', async () => {
  await clickTab('Installs')

  const trackBtn = ctx.page.locator('button', { hasText: /Track Existing/i })
  if (await trackBtn.isVisible()) {
    await trackBtn.click()
    await expectModalVisible(true)

    await ctx.page.locator('.view-modal.active .view-modal-close').click()
    await expectModalVisible(false)
  }
})

test('Load Snapshot modal opens and closes @windows', async () => {
  await clickTab('Installs')

  const loadBtn = ctx.page.locator('button', { hasText: /Load Snapshot/i })
  if (await loadBtn.isVisible()) {
    await loadBtn.click()
    await expectModalVisible(true)

    await ctx.page.locator('.view-modal.active .view-modal-close').click()
    await expectModalVisible(false)
  }
})

// ---------------------------------------------------------------------------
// Modal dismiss via Escape @windows
// ---------------------------------------------------------------------------

test('modals close on Escape key @windows', async () => {
  await clickTab('Installs')

  const newInstallBtn = ctx.page.locator('button', { hasText: /New Install/i }).first()
  if (await newInstallBtn.isVisible()) {
    await newInstallBtn.click()
    await expectModalVisible(true)

    await ctx.page.keyboard.press('Escape')
    await expectModalVisible(false)
  }
})

// ---------------------------------------------------------------------------
// Tab state persists across modal open/close @windows
// ---------------------------------------------------------------------------

test('tab state persists after opening and closing a modal @windows', async () => {
  await clickTab('Settings')
  await expectActiveTab('Settings')

  // If we can open a modal, do so and verify tab is still Settings after close
  await clickTab('Installs')
  const newInstallBtn = ctx.page.locator('button', { hasText: /New Install/i }).first()
  if (await newInstallBtn.isVisible()) {
    await newInstallBtn.click()
    await expectModalVisible(true)
    await ctx.page.keyboard.press('Escape')
    await expectModalVisible(false)
  }

  // Tab should still be Installs (the last tab we switched to)
  await expectActiveTab('Installs')
})

// ---------------------------------------------------------------------------
// No console errors @windows
// ---------------------------------------------------------------------------

test('no console errors during navigation @windows', async () => {
  const errors: string[] = []
  ctx.page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text())
  })

  // Exercise all tabs
  for (const tab of ['Dashboard', 'Installs', 'Running', 'Models', 'Media', 'Settings']) {
    await clickTab(tab)
    await ctx.page.waitForTimeout(200)
  }

  // Filter out known benign errors (e.g. network requests failing in test env)
  const realErrors = errors.filter((e) =>
    !e.includes('net::ERR_') &&
    !e.includes('Failed to fetch') &&
    !e.includes('favicon')
  )
  expect(realErrors).toEqual([])
})

// ---------------------------------------------------------------------------
// Detail modal (requires seeded installation) @windows
// ---------------------------------------------------------------------------

/** Click the "Manage" button on the seeded installation card to open Detail. */
async function openSeededDetail(): Promise<void> {
  await clickTab('Installs')
  const card = ctx.page.locator('.instance-card', { hasText: 'E2E Test Install' })
  await card.first().locator('button', { hasText: /Manage/i }).click()
  await expectModalVisible(true)
}

test('Detail modal opens via Manage button @windows', async () => {
  await openSeededDetail()

  // Close via ✕
  await ctx.page.locator('.view-modal.active .view-modal-close').click()
  await expectModalVisible(false)
})

test('Detail modal closes on Escape @windows', async () => {
  await openSeededDetail()

  await ctx.page.keyboard.press('Escape')
  await expectModalVisible(false)
})

test('Detail modal closes on backdrop click @windows', async () => {
  await openSeededDetail()

  // Click the overlay backdrop (the .view-modal element itself, not its content)
  const overlay = ctx.page.locator('.view-modal.active')
  await overlay.click({ position: { x: 10, y: 10 } })
  await expectModalVisible(false)
})
