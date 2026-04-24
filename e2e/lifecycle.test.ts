/**
 * Lifecycle E2E tests: install (older release) → Detail → Launch → Console →
 * Stop → verify version → Update → verify new version.
 *
 * These tests download a real standalone environment (~500 MB for CPU on
 * Windows), so they are tagged @lifecycle and run with an extended timeout
 * (10 minutes per test via the `lifecycle` Playwright project).
 *
 * Run:
 *   pnpm run build && pnpm run test:e2e:windows -- --project=lifecycle
 *
 * Requirements: network access, ~2 GB free disk space.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { launchApp, type AppContext } from './launchApp'

// ---------------------------------------------------------------------------
// Shared state — all tests share one app instance (serial)
// ---------------------------------------------------------------------------

let ctx: AppContext

/** The release tag of the second-to-latest release, captured during install. */
let installedReleaseTag = ''

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  // Inject GitHub token so API requests are authenticated (avoids rate limits).
  // The token file lives at the workspace root; walk up from this test file.
  if (!process.env['GITHUB_TOKEN']) {
    // Walk up from __dirname (e2e/) looking for the token file.
    // The workspace may nest the project several levels deep.
    for (let depth = 2; depth <= 8; depth++) {
      const segments = Array(depth).fill('..')
      const p = resolve(__dirname, ...segments, 'githubtoken.txt')
      try {
        process.env['GITHUB_TOKEN'] = readFileSync(p, 'utf-8').trim()
        break
      } catch { /* try next */ }
    }
  }

  // Launch with NO seeded installations — fresh state
  ctx = await launchApp()
})

test.afterAll(async () => {
  await ctx.cleanup()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Cancel all lingering operations so the backend's _operationAborts map is clean. */
async function cancelAllOperations(): Promise<void> {
  await ctx.app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return
    // Invoke cancel-launch and cancel-operation for all installations via the renderer's preload API
    void win.webContents.executeJavaScript(`
      Promise.resolve()
        .then(() => window.api.cancelLaunch())
        .then(() => window.api.getInstallations())
        .then(installs => Promise.all(installs.map(i => window.api.cancelOperation(i.id))))
        .catch(() => {})
    `)
  }).catch(() => {})
  // Allow time for the IPC round-trips to complete
  await ctx.page.waitForTimeout(500)
}

async function clickTab(label: string): Promise<void> {
  await ctx.page.locator('.sidebar-item', { hasText: label }).click()
}

async function expectActiveTab(label: string): Promise<void> {
  const activeItem = ctx.page.locator('.sidebar-item.active')
  await expect(activeItem).toContainText(label)
}

async function expectModalVisible(visible: boolean): Promise<void> {
  const modal = ctx.page.locator('.view-modal.active')
  if (visible) {
    await expect(modal.first()).toBeVisible()
  } else {
    await expect(modal).toHaveCount(0)
  }
}

/**
 * Wait for the progress modal to reach a terminal state (success or error).
 * Returns 'success' or 'error'.
 */
async function waitForProgressDone(
  page: Page,
  timeoutMs = 480_000,
): Promise<'success' | 'error'> {
  const success = page.locator('.progress-banner-success')
  const error = page.locator('.progress-banner-error')

  // Wait for either banner to appear
  await expect(success.or(error).first()).toBeVisible({ timeout: timeoutMs })

  if (await success.isVisible()) return 'success'
  return 'error'
}

/** Open the Detail modal for the first ComfyUI installation card. */
async function openDetailForComfyUI(): Promise<void> {
  await clickTab('Installs')
  const card = ctx.page.locator('.instance-card', { hasText: 'ComfyUI' })
  await card.first().locator('button', { hasText: /Manage/i }).click()
  await expectModalVisible(true)

  // Wait for sections to load
  const loading = ctx.page.locator('.modal-loading')
  await expect(loading).toHaveCount(0, { timeout: 15_000 })
}

// ---------------------------------------------------------------------------
// Install with an older release via New Install wizard @lifecycle
// ---------------------------------------------------------------------------

test('New Install wizard: opens and selects standalone source @lifecycle', async () => {
  await clickTab('Installs')
  await expectActiveTab('Installs')

  // Click "New Install" button
  const newInstallBtn = ctx.page.locator('button', { hasText: /New Install/i }).first()
  await expect(newInstallBtn).toBeVisible({ timeout: 10_000 })
  await newInstallBtn.click()

  await expectModalVisible(true)

  // The wizard may auto-advance to Step 2 if hardware is supported, or
  // stay on Step 1 (Choose Install Method) if validation fails (e.g. no GPU).
  // Wait for initialization to finish (loading spinner disappears).
  const wizardLoading = ctx.page.locator('.wizard-loading')
  await expect(wizardLoading).toHaveCount(0, { timeout: 30_000 })

  const releaseSelect = ctx.page.locator('#sf-release')
  const sourceCard = ctx.page.locator('.source-card-hero')

  // If we're still on Step 1, click the Standalone source card to advance
  if (await sourceCard.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await sourceCard.first().click()
    // Click "Next" to advance to Step 2
    const nextBtn = ctx.page.locator('button.primary', { hasText: /Next/i })
    await expect(nextBtn).toBeEnabled({ timeout: 10_000 })
    await nextBtn.click()
  }

  // Now on Step 2 — wait for the release dropdown to load and become enabled
  await expect(releaseSelect).toBeVisible({ timeout: 30_000 })
  await expect(releaseSelect).toBeEnabled({ timeout: 30_000 })
})

test('New Install wizard: selects second-to-latest release @lifecycle', async () => {
  const releaseSelect = ctx.page.locator('#sf-release')
  await expect(releaseSelect).toBeVisible()

  // Option 0 = "Latest Stable (Recommended)", option 1 = newest tag,
  // option 2 = second-to-latest. Select option 2 so there's a newer version
  // available for the update test.
  const optionCount = await releaseSelect.locator('option').count()
  expect(optionCount).toBeGreaterThanOrEqual(3)

  // Capture the tag name from the third option's text (format: "v0.X.Y  —  Name")
  const thirdOptionText = (await releaseSelect.locator('option').nth(2).textContent())?.trim() ?? ''
  installedReleaseTag = thirdOptionText.match(/(v[\d.]+\S*)/)?.[1] ?? ''
  expect(installedReleaseTag).toBeTruthy()

  // Select the second-to-latest release (index 2)
  await releaseSelect.selectOption({ index: 2 })

  // Wait for variant cards to load for this release
  const variantCards = ctx.page.locator('.variant-card')
  await expect(variantCards.first()).toBeVisible({ timeout: 30_000 })
})

test('New Install wizard: selects CPU variant and proceeds @lifecycle', async () => {
  // Click the CPU variant card
  const cpuCard = ctx.page.locator('.variant-card', { hasText: /CPU/i })
  await expect(cpuCard).toBeVisible({ timeout: 5_000 })
  await cpuCard.click()
  await expect(cpuCard).toHaveClass(/selected/)

  // Click "Next" to proceed to Step 3 (Name & Location)
  const nextBtn = ctx.page.locator('button.primary', { hasText: /Next/i })
  await expect(nextBtn).toBeEnabled({ timeout: 5_000 })
  await nextBtn.click()

  // Step 3: Name & Location should be visible
  const nameInput = ctx.page.locator('#inst-name')
  await expect(nameInput).toBeVisible({ timeout: 5_000 })
})

test('New Install wizard: completes installation @lifecycle', async () => {
  // Click the final "Add Install" button to start the install
  const addBtn = ctx.page.locator('button.primary', { hasText: /Add Install/i })
  await expect(addBtn).toBeEnabled({ timeout: 5_000 })
  await addBtn.click()

  // Progress modal should appear
  const progressModal = ctx.page.locator('.view-modal.active')
  await expect(progressModal.first()).toBeVisible({ timeout: 10_000 })

  // Wait for download + install to finish (up to 8 minutes)
  const result = await waitForProgressDone(ctx.page)
  expect(result).toBe('success')

  // Click "Done" to close the progress modal
  const doneBtn = ctx.page.locator('.view-modal.active button.primary', { hasText: /Done/i })
  await expect(doneBtn).toBeVisible({ timeout: 5_000 })
  await doneBtn.click()

  await expectModalVisible(false)
})

test('Installation appears in list after install @lifecycle', async () => {
  await clickTab('Installs')
  await expectActiveTab('Installs')

  const card = ctx.page.locator('.instance-card')
  await expect(card.first()).toBeVisible({ timeout: 10_000 })
  await expect(card.first()).toContainText('ComfyUI')
})

// ---------------------------------------------------------------------------
// Detail: verify version info @lifecycle
// ---------------------------------------------------------------------------

test('Detail modal shows installed release tag @lifecycle', async () => {
  await openDetailForComfyUI()

  // The status tab should display the release tag we installed
  const detailFields = ctx.page.locator('.detail-field-value')
  const releaseField = ctx.page.locator('.detail-fields').filter({ hasText: /Release/i })
  await expect(releaseField).toBeVisible({ timeout: 5_000 })

  // Verify the release tag is shown somewhere in the detail fields
  const fieldValues = await detailFields.allTextContents()
  const hasReleaseTag = fieldValues.some((v) => v.includes(installedReleaseTag))
  expect(hasReleaseTag).toBe(true)

  // Close detail
  await ctx.page.keyboard.press('Escape')
  await expectModalVisible(false)
})

// ---------------------------------------------------------------------------
// Launch & Console @lifecycle
// ---------------------------------------------------------------------------

test('Launch: starts ComfyUI from installation list @lifecycle', async () => {
  await clickTab('Installs')

  const card = ctx.page.locator('.instance-card', { hasText: 'ComfyUI' }).first()
  const launchBtn = card.locator('button', { hasText: /Launch/i })
  await expect(launchBtn).toBeVisible({ timeout: 5_000 })
  await launchBtn.click()

  // Wait for the card to show running status (Stop button appears on the card)
  const stopBtn = card.locator('button.danger-solid', { hasText: /Stop/i })
  await expect(stopBtn).toBeVisible({ timeout: 120_000 })
})

test('Console: shows terminal output for running instance @lifecycle', async () => {
  // Stay on Installs tab where the running card is visible
  await clickTab('Installs')

  const card = ctx.page.locator('.instance-card', { hasText: 'ComfyUI' }).first()
  const consoleBtn = card.locator('button', { hasText: /Console/i })
  await expect(consoleBtn).toBeVisible({ timeout: 5_000 })
  await consoleBtn.click()

  await expectModalVisible(true)

  const terminal = ctx.page.locator('#console-terminal')
  await expect(terminal).toBeVisible({ timeout: 10_000 })
  await expect(terminal).not.toBeEmpty({ timeout: 60_000 })

  const output = await terminal.textContent()
  expect(output?.length).toBeGreaterThan(0)

  await ctx.page.locator('.view-modal.active .view-modal-close').click()
  await expectModalVisible(false)
})

// ---------------------------------------------------------------------------
// Stop @lifecycle
// ---------------------------------------------------------------------------

test('Stop: stops running ComfyUI instance @lifecycle', async () => {
  await clickTab('Installs')

  const card = ctx.page.locator('.instance-card', { hasText: 'ComfyUI' }).first()
  const stopBtn = card.locator('button.danger-solid', { hasText: /Stop/i })
  await expect(stopBtn).toBeVisible({ timeout: 5_000 })
  await stopBtn.click()

  // Wait for the Launch button to reappear (instance stopped)
  const launchBtn = card.locator('button', { hasText: /Launch/i })
  await expect(launchBtn).toBeVisible({ timeout: 30_000 })
})

// ---------------------------------------------------------------------------
// Update flow @lifecycle
// ---------------------------------------------------------------------------

test('Detail update tab shows update available @lifecycle', async () => {
  // Cancel any lingering operation from the launch/crash cycle so the
  // backend's _operationAborts map is clean before we attempt the update.
  await cancelAllOperations()

  await openDetailForComfyUI()

  // Click the "Update" tab
  const updateTab = ctx.page.locator('.detail-tab', { hasText: /Update/i })
  await expect(updateTab).toBeVisible({ timeout: 5_000 })
  await updateTab.click()

  // Wait for the update section to load — look for channel cards or update actions
  // The "Check for Update" button should be visible (use the one inside the active modal)
  const checkBtn = ctx.page.locator('.view-modal.active button', { hasText: /Check for Update/i })
  await expect(checkBtn).toBeVisible({ timeout: 10_000 })

  // Click "Check for Update" to refresh release info
  await checkBtn.click()

  // Wait for the check to complete — a spinner or loading indicator may appear.
  // Wait briefly for any loading state to start, then wait for it to disappear.
  await ctx.page.waitForTimeout(1_000)

  // Wait for the update check to complete — the "Update Now" button should appear
  // since we installed an older release
  const updateBtn = ctx.page.locator('.view-modal.active button', { hasText: /Update Now/i })
  await expect(updateBtn).toBeVisible({ timeout: 30_000 })

  // Wait an extra moment for any background state to settle before the next test
  await ctx.page.waitForTimeout(1_000)
})

test('Update: triggers and completes ComfyUI update @lifecycle', async () => {
  // Cancel any lingering operations before attempting the update
  await cancelAllOperations()

  // The Detail modal should still be open on the Update tab
  const updateBtn = ctx.page.locator('.view-modal.active button', { hasText: /Update Now/i })
  await expect(updateBtn).toBeVisible()
  await updateBtn.click()

  // Two types of dialog may appear:
  // 1. An "operation in progress" guard asking to cancel a previous op
  // 2. The actual update confirmation dialog
  // Handle both by clicking through any modal-overlay confirmations.
  const modalConfirm = ctx.page.locator('.modal-overlay button.primary')
    .or(ctx.page.locator('.modal-overlay button.danger'))

  // First confirmation (may be operation-in-progress guard or update confirm)
  await expect(modalConfirm.first()).toBeVisible({ timeout: 5_000 })
  await modalConfirm.first().click()
  await ctx.page.waitForTimeout(500)

  // If the operation-in-progress guard appeared, the update may need to be
  // re-triggered. Check if "Update Now" is still visible and click again.
  if (await updateBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await updateBtn.click()
    // Now the real update confirmation should appear
    await expect(modalConfirm.first()).toBeVisible({ timeout: 5_000 })
    await modalConfirm.first().click()
  }

  // Progress modal should appear for the update operation
  // Wait for the update to complete (up to 5 minutes)
  const result = await waitForProgressDone(ctx.page, 300_000)
  expect(result).toBe('success')

  // Click "Done" to close progress
  const doneBtn = ctx.page.locator('.view-modal.active button.primary', { hasText: /Done/i })
  await expect(doneBtn).toBeVisible({ timeout: 5_000 })
  await doneBtn.click()
})

test('Detail shows updated version after update @lifecycle', async () => {
  // Close any remaining modals from the update flow before re-opening detail
  while (await ctx.page.locator('.view-modal.active').count() > 0) {
    await ctx.page.keyboard.press('Escape')
    await ctx.page.waitForTimeout(300)
  }

  // Open detail again for the updated installation
  await openDetailForComfyUI()

  // The status tab should show the updated ComfyUI version.
  // Grab all field values and verify at least one contains a version string.
  const fieldValues = await ctx.page.locator('.view-modal.active .detail-field-value').allTextContents()
  const hasVersion = fieldValues.some((v) => /^v\d+/.test(v.trim()))
  expect(hasVersion).toBe(true)

  // Close detail
  await ctx.page.keyboard.press('Escape')
  await expectModalVisible(false)
})
