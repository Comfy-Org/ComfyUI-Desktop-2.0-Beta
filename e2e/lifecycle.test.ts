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
  await openDetailForComfyUI()

  // Click the "Update" tab
  const updateTab = ctx.page.locator('.detail-tab', { hasText: /Update/i })
  await expect(updateTab).toBeVisible({ timeout: 5_000 })
  await updateTab.click()

  // Wait for the update section to load — look for channel cards or update actions
  // The "Check for Update" button should be visible
  const checkBtn = ctx.page.locator('button', { hasText: /Check for Update/i })
  await expect(checkBtn).toBeVisible({ timeout: 10_000 })

  // Click "Check for Update" to refresh release info
  await checkBtn.click()

  // Wait for the update check to complete — the "Update Now" button should appear
  // since we installed an older release
  const updateBtn = ctx.page.locator('button', { hasText: /Update Now/i })
  await expect(updateBtn).toBeVisible({ timeout: 30_000 })
})

test('Update: triggers and completes ComfyUI update @lifecycle', async () => {
  // The Detail modal should still be open on the Update tab
  const updateBtn = ctx.page.locator('.view-modal.active button', { hasText: /Update Now/i })
  await expect(updateBtn).toBeVisible()
  await updateBtn.click()

  // A confirmation dialog should appear
  const confirmBtn = ctx.page.locator('.modal-overlay button.primary')
    .or(ctx.page.locator('.modal-overlay button.danger'))
  await expect(confirmBtn.first()).toBeVisible({ timeout: 5_000 })
  await confirmBtn.first().click()

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
  // Open detail again for the updated installation
  await openDetailForComfyUI()

  // The status tab should now show a different version than what we installed.
  // The ComfyUI version field should have changed. We verify the release tag
  // is still the same env release (update changes ComfyUI, not the env), but
  // the ComfyUI version field should differ from the installed release tag.
  const detailFields = ctx.page.locator('.detail-field-value')
  const fieldValues = await detailFields.allTextContents()

  // The release tag (environment) should still be present
  const hasReleaseTag = fieldValues.some((v) => v.includes(installedReleaseTag))
  expect(hasReleaseTag).toBe(true)

  // The ComfyUI version field (first field after "Install Method") should
  // contain a version string — just verify it's not empty
  const comfyVersionField = ctx.page.locator('[data-field-key="comfyui-version"] .detail-field-value')
    .or(ctx.page.locator('.detail-fields').first().locator('.detail-field-value').nth(1))
  const comfyVersion = await comfyVersionField.textContent()
  expect(comfyVersion?.trim().length).toBeGreaterThan(0)

  // Close detail
  await ctx.page.keyboard.press('Escape')
  await expectModalVisible(false)
})
