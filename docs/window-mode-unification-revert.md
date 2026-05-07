# Window-mode unification — tactical revert

This document captures findings from the
`feat/unified-window-titlebar-panels` work and explains why we
disabled the in-place attach/detach behaviour while keeping the
underlying infrastructure intact.

## What was attempted

Stages W-1 through W-5 (commits `2a902aa..43b9dcc`, plus follow-ups
`4ab161a`, `0897e97`, `021dd31`, `d4a205c`) replaced the legacy
"close window, open new window" swap with an in-place flip:

- `comfyWindows` keyed by a stable monotonic numeric `windowKey`
  instead of `installationId` / `chooser:N` (the latter rotated with
  the install identity, blocking in-place transform between modes).
- `attachInstall(entry, opts)` / `detachInstall(entry)` operations
  on a single host window, swapping the install backing without
  destroying the BrowserWindow.
- A `claimAttachHost` IPC the chooser-host renderer fired pre-launch
  so `onLaunch()` would attach to the same window instead of
  constructing a fresh one.
- `returnToDashboard` flipped the host in place via
  `entry.detachInstall()` (same window, comfyView navigates to
  `about:blank`, panel re-renders chooser body).

## Why we reverted (for now)

In production the in-place attach hits edge cases that close the
only remaining window without opening a replacement, leaving the
app with no windows and triggering quit:

- **Partition mismatches** — Standalone / Portable installs need a
  fresh `partition:` value on the comfyView. The host already has a
  different partition stamped at construction. `rebuildComfyViewIfNeeded`
  was added to handle this, but the rebuild lifecycle has races
  with the active session pipeline (commit `021dd31`).
- **Window destruction mid-attach** — if the user clicks the chooser
  tile, then closes the window before `onLaunch()` fires, the claim
  goes stale and the install spins up with no window to attach to.
  The fallback was supposed to construct a fresh window, but the
  cleanup path sometimes skipped it.
- **Stuck takeovers on detach** — `detachInstall` was leaving the
  panel renderer with stale takeover state (commit `0897e97`
  rebuilt the panelView to clear it, but that's a heavy hammer).
- **Cancel-prompt funnel** — `consultPanelRendererClose` on the
  in-place detach path was not always firing the same cancel-prompt
  flow as the close-handler path; some Tier 2/3 ops slipped past.

The legacy close+open swap pays a visible flicker (one frame of
overlap as the chooser window opens and the install window closes)
but exercises the original close-handler teardown that has been
solid since main.

## What this revert does

Two surgical changes in `src/main/index.ts`:

1. `claim-attach-host` IPC handler: always returns `false` so the
   renderer falls back to its existing legacy swap path
   (`transferHostBoundsToInstall` + `closeHostWindow` on
   `instance-started`).
2. `returnToDashboard`: replaced `entry.detachInstall()` with the
   pre-W-4 sequence — capture bounds, `openChooserHostWindow()`,
   restore bounds on the new window, dispatch `entry.window.close()`.

Plus a one-line cleanup in `src/renderer/src/views/DetailModal.vue`:
removed the `await window.api.claimAttachHost(instId)` pre-launch
call (no-op now that the handler returns false, but pruning it
removes the dead code path).

## What we KEPT

The infrastructure is still in the codebase:

- `comfyWindows` map keyed by `windowKey`.
- `installationIdToWindowKey` secondary index +
  `getEntryByInstallationId(id)`.
- `attachInstall` / `detachInstall` methods on the entry.
- `pendingAttachClaims` map (no longer populated; consumer in
  `onLaunch()` still drains it as defence in depth).
- `nextWindowKey()` / `_nextWindowKeyValue`.

Removing this infra would be a much larger change touching every
host-window construction path. Leaving it dormant lets us re-enable
the in-place flip later (one-line change in `claim-attach-host` to
restore the original logic) once the underlying lifecycle bugs are
fixed.

## Findings worth keeping in mind

These came up during the unified-window work and would still apply
to a future re-enable attempt:

1. **Partition is set at host construction.** The comfyView's
   `partition:` value can't be mutated post-construction; it requires
   `webContents.session` rewiring or a full view rebuild. Any
   in-place attach across different partition installs needs the
   rebuild path, and that rebuild needs to happen BEFORE the
   `loadURL` fires. See `rebuildComfyViewIfNeeded` (commit `021dd31`).

2. **The chooser host has eager `panelView` setup
   (`ensurePanelView('chooser')`).** Install-backed hosts lazy-load.
   When attach flips an install-less host to install-backed, the
   eager-loaded panel needs to switch panel keys cleanly without
   leaving stale chooser state. The current PanelApp.vue
   `switchPanel` machinery handles this for forward switches but
   the reverse (detach → chooser) hits stale takeover state from
   the install side.

3. **Cancel prompts must funnel through one place.** In-place flip
   bypasses the close handler, so any "this op is in progress, cancel
   it?" prompt that lives in the close handler is silently skipped.
   The fix is to have `detachInstall` consult the same
   `getActiveOperations` / `consultPanelRendererClose` pair the
   close handler does, with the same prompt copy.

4. **`onLaunch` is the only place a host window gets its install
   identity.** The claim consumption in `onLaunch` was new; it
   needs the same destroyed-check / panelView-refresh discipline
   that `createHostWindow` does for fresh windows. Several W-4
   follow-up fixes (`d4a205c`, `4ab161a`) were patching this seam.

5. **The chooser host's `onInstanceStarted` close-on-event
   subscription is a brittle race.** If `instance-started` fires
   before the subscription lands, the chooser host stays open and
   the user has two windows. The W-4 in-place flip avoided this
   class of bug entirely. With the revert we're back to the race;
   `prepareChooserHostHandoff` subscribes BEFORE kicking off the
   launch action, so it should hold, but watch for it.

6. **`useOverlay` is a module-level singleton.** Tests had to be
   updated to reset it in `beforeEach` (commit `313eecb`). Any
   future tests that mount components reading `useOverlay()` need
   the same reset, otherwise overlay state leaks between tests.

## Re-enable path

When the lifecycle bugs above are resolved, re-enable in-place
attach by restoring the original `claim-attach-host` body (see git
blame on this file for the W-4 implementation) and reverting
`returnToDashboard` to call `entry.detachInstall()`. The
infrastructure is unchanged, so the surface is just those two
functions plus restoring the `claimAttachHost` call in DetailModal.
