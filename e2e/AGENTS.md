# e2e — test tier contract

Every Playwright test in this directory MUST carry exactly one tier tag.
No exceptions, no untagged tests.

## Tier tags

### `@ci` — every-PR matrix

Runs on Windows + macOS + Linux on every PR. Allowed to:

- Seed installations via `launchApp({ installations, settings, ... })`.
- Stage fixtures on disk (`writeFileSync`, `mkdirSync`, `execFileSync git`, etc.).
- Use the `__e2e` backdoor (`seedDownloads`, `setInstallUpdate`, `setAppUpdateState`,
  `seedRunningSession`, `ageReleaseCache`, IPC invocation spies, …).
- Invoke `window.api.*` directly via the eval bridge.
- Send synthetic IPC into the renderer (`wc.send(...)`).

In short: `@ci` is the seeded-harness tier. Fast, loud, deterministic,
covers renderer + IPC contracts.

### `@real` — real lifecycle

Run only via `pnpm run test:e2e:real` (single project, single OS, nightly /
manual). The contract:

> A `@real` test must behave as if a human had booted the app and clicked
> through the UI. Nothing outside the start or end of the test may change
> state except via DOM clicks and keyboard input dispatched through the
> visible webContents.

Concretely, **forbidden** in `@real`:

- Passing `installations`, `settings`, or any other seed to `launchApp(...)`.
- Calls into `__e2e.*` that **mutate** state (`seedDownloads`,
  `setInstallUpdate`, `setAppUpdateState`, `seedRunningSession`,
  `ageReleaseCache`, …).
- Calls into `window.api.*` from test code (use button clicks / typing).
- Sending synthetic IPC via `webContents.send(...)`.
- Pre-staging fake install directories with `writeFile` / `mkdir` to skip
  a real install.

**Allowed** in `@real` (read-only observation only):

- `__e2e.getIpcInvocations`, `__e2e.getRunningSessionSnapshot`,
  `__e2e.getReleaseCacheCheckedAt` — observing live state never affects it.
- `app.evaluate(({ BrowserWindow }) => ...)` for inspecting window /
  webContents state.
- `execFileSync('git', ['rev-parse', 'HEAD'], …)` for asserting against
  on-disk state the app actually produced.
- DOM-driven flows through `panel.click(...)`, `panel.fill(...)`,
  `panel.pressKey(...)`.

Prerequisite paths (consent → pick local → install → launch, etc.) that a
test isn't itself asserting belong in `e2e/support/realPrereqs.ts`. Drive
them with real clicks; never short-circuit with `window.api`.

## OS axis (independent of tier)

`@ci` tests default to running on **all three** OSes. Genuinely
platform-specific behavior gets an opt-out tag:

| Tag | Effect |
|---|---|
| `@windows-only` | excluded from `macos` + `linux` projects |
| `@macos-only`   | excluded from `windows` + `linux` projects |
| `@linux-only`   | excluded from `windows` + `macos` projects |

Example: `quit-flow.spec.ts` is `@ci @macos-only` because tray-close mode
only exists on macOS.

`@real` runs on a single OS by configuration; OS opt-out tags don't apply.

## Playwright projects

```ts
{ name: 'macos',   grep: /@ci/,   grepInvert: /@(windows|linux)-only/ }
{ name: 'windows', grep: /@ci/,   grepInvert: /@(macos|linux)-only/   }
{ name: 'linux',   grep: /@ci/,   grepInvert: /@(macos|windows)-only/ }
{ name: 'real',    grep: /@real/, timeout: 600_000 }
```

## Commands

| Command | Runs |
|---|---|
| `pnpm run test:e2e:windows` | `@ci` minus `@macos-only` / `@linux-only` |
| `pnpm run test:e2e:macos`   | `@ci` minus `@windows-only` / `@linux-only` |
| `pnpm run test:e2e:linux`   | `@ci` minus `@macos-only` / `@windows-only` |
| `pnpm run test:e2e:real`    | `@real` only (real lifecycle suite) |

When the user says "run the lifecycle tests" or "validate the lifecycle
tests", they mean `pnpm run test:e2e:real`. That is the only suite that
proves the app still works for a real user.

## Skipping a broken test

Don't silently delete a failing test. Choose one:

- `test.skip(...)` with a `// TODO(#NNN): …` comment naming the issue.
- `test.fail(...)` when the test correctly asserts a contract the product
  is currently violating (known product bug). `test.fail` flips green
  when the product is fixed, alerting the team to remove the marker.

Every skip / fail must link to an issue. Stale skips rot — they're
not "passing" tests.
