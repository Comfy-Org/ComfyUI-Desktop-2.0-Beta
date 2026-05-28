import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  // Two tag axes:
  //   tier axis  — @ci (required on every PR) | @real (real lifecycle,
  //                opt-in / nightly only). Exactly one per test.
  //   OS axis    — @ci tests default to all three CI projects. Opt-out
  //                with @windows-only / @macos-only / @linux-only for
  //                genuinely platform-specific behavior.
  // See e2e/AGENTS.md for the @real contract (no seeds, no __e2e writes,
  // user-input-only) and the @ci contract (seeded harness OK).
  projects: [
    { name: 'macos',   grep: /@ci/,   grepInvert: /@(windows|linux)-only/ },
    { name: 'windows', grep: /@ci/,   grepInvert: /@(macos|linux)-only/   },
    { name: 'linux',   grep: /@ci/,   grepInvert: /@(macos|windows)-only/ },
    { name: 'real',    grep: /@real/, timeout: 600_000 },
  ],
})
