# Post-unification code review — `feat/unified-window-titlebar-panels` vs `origin/main`

Reviewer: codereview pass.
Branch under review: `feat/unified-window-titlebar-panels` (modal-unification
M-1…M-7 + window-mode unification W-1…W-5 plus the broader Phase-3 work).
Baseline: `origin/main`.

Surface size: **104 changed files, +16,028 / −4,367 LOC**, with the bulk in
`src/main/index.ts` (+2,979) and the new `panel/PanelApp.vue`,
`comfyTitleBar/TitleBarApp.vue`, and `views/ChooserView.vue` renderer entries.

This pass surfaces issues only — no fixes are landed. Triage and ask for
follow-up commits.

## Status

Findings are surfaced in the report below; tracking which have been
fixed vs. left for follow-up here so the doc stays useful as a
reference.

| ID  | Severity | Status |
|-----|----------|--------|
| —   | Critical | **Fixed** — install-backed wrapper threw on every fresh launch (createHostWindow seeded `entry.installationId` from opts, then `attachInstall` immediately threw on its already-attached guard). Discovered while implementing the W-track findings; this was the user-visible "in-place switching does not even work" error. |
| F1  | Critical | **Fixed** — `entry.constructedPartition` + `expectedPartitionFor()` + claim acceptance checks partition equality. |
| F2  | High     | **Fixed** — close handler GC's `pendingAttachClaims` for entries pointing at the dying `windowKey`. |
| F3  | High?    | **Fixed** — `claim-attach-host` refuses duplicates and prunes stale claims. |
| F7  | High     | **Fixed** — `_installCleanup` aborts `_operationAborts.get(id)` before `stopRunning`. |
| F4  | Medium   | Deferred — design call; see finding for prompt-vs-document trade-off. |
| F5  | Medium   | Deferred — depends on `sessionStore.isRunning` semantics audit. |
| F6  | Medium   | Deferred — covered by F12 test follow-up. |
| F8  | Medium   | **Fixed** — `_installCleanup` `comfyContents.off('will-navigate', state.navBlocker)` before `relaunchStates.delete(id)`. |
| F9  | Medium   | **Fixed** — F2's GC + F3's duplicate refuse jointly close the stale-claim consumption hole. |
| F11 | Low      | **Fixed** — `attachInstall` returns `boolean`; throws replaced with telemetry + early return; both call sites handle the failure. |
| F12 | Medium   | Deferred — test follow-up. |
| F13 | Low      | **Fixed** — silent Tier 3 → Tier 3 swap fires `cur.onCancel?.()`. |
| F14 | Low      | **Fixed** — settings load drops legacy `onAppClose: 'tray'` (preserves explicit `'quit'`). |
| F15 | Low      | **Fixed** — `will-prevent-unload` gates on `entry.installationId !== null` at runtime. |
| F16 | Medium   | Deferred — covered by F12 test follow-up. |
| F17 | Low      | **Fixed** — `performChooserLaunch` extracted; `handleChooserPick` and `launchInstallationAfterFirstUse` collapse to one helper. |
| F18 | Low      | Subsumed by F5. |
| F19 | Nit      | **Fixed** — `_detachInstallImpl` doc-block updated to reference the F1 resolution. |
| F20 | Nit      | Deferred — cosmetic. |

## Severity legend

- **Critical** — data loss, persistent partition / session leak, broken UX
  with no workaround.
- **High** — observable correctness bug or rollback hole; user can hit it on
  a normal path.
- **Medium** — narrow / racy bug, surprising behaviour, or design hole that
  isn't user-blocking.
- **Low** — code-smell, brittle invariant, weak documentation.
- **Nit** — micro polish.

---

## Findings

### F1 — Cross-install partition leak after detach + chooser-pick (Critical)

**Files:** [src/main/index.ts#L1425-L1457](file:///f%3A/workspaces/station1/stations/station5/ComfyUI-Launcher/src/main/index.ts#L1425-L1457),
[src/main/index.ts#L1838-L1890](file:///f%3A/workspaces/station1/stations/station5/ComfyUI-Launcher/src/main/index.ts#L1838-L1890),
[src/main/index.ts#L1473-L1491](file:///f%3A/workspaces/station1/stations/station5/ComfyUI-Launcher/src/main/index.ts#L1473-L1491)

**What's wrong:** `comfyView`'s `partition` is pinned at `WebContentsView`
construction time — there's no API to change a partition after construction
without destroying the view. The W-4b claim path checks
`wantsUniquePartition` for the **incoming** install (line 1440-1446) but
never inspects the **host's existing partition**:

```ts
const wantsUniquePartition =
  (installation.browserPartition as string | undefined) === 'unique'
if (
  claimed &&
  !claimed.window.isDestroyed() &&
  claimed.installationId === null &&
  !wantsUniquePartition
) {
  attachInstall(claimed, ...)
}
```

This is fine for a **fresh** chooser host (built with `persist:shared` on
line 2040) but breaks for a host that was previously install-backed by a
unique-partition install (`standalone` and `portable` both default to
`browserPartition: 'unique'` — see `sources/standalone/index.ts:113` and
`sources/portable.ts:101`).

Reproducer:
1. Launch a Standalone install A → fresh window built with
   `partition: 'persist:A.id'`.
2. File → Return to Dashboard → `entry.detachInstall()` flips the host
   in-place to install-less. The `comfyView` keeps `persist:A.id`.
3. From the chooser, pick a `git`-source install B (partition `'shared'`).
4. `claimAttachHost(B)` returns `true` (host is install-less and B isn't
   unique-partition); `attachInstall(claimed, B, ...)` runs and loads B's
   URL — but the load goes through session **`persist:A.id`**.

Effect: B's cookies, IndexedDB, Service Worker registrations, localStorage,
and any cached auth all land in A's persisted session bucket. On the next
launch of A this looks like A inherited B's logged-in state; on the next
launch of B from a fresh window the state vanishes.

**Suggested fix:** In the claim-acceptance branch, also reject when the
host's `comfyView` partition doesn't match what the new install needs.
Pre-W-1 this couldn't happen because chooser hosts were a separate
construction path; now they can be either fresh (`persist:shared`) or
"recycled" install-backed (`persist:${prev.id}`). Two reasonable shapes:

- Tag the entry with the partition it was constructed with (e.g.
  `entry.constructedPartition: string`), and reject the claim unless
  `entry.constructedPartition === expectedPartitionFor(installation)`.
- Or destroy + rebuild `comfyView` inside `_detachInstallImpl` whenever
  the previous install was unique-partition. Heavier but eliminates the
  whole class of mismatch.

---

### F2 — `pendingAttachClaims` never garbage-collected on host close (High)

**Files:** [src/main/index.ts#L380](file:///f%3A/workspaces/station1/stations/station5/ComfyUI-Launcher/src/main/index.ts#L380),
[src/main/index.ts#L3109-L3118](file:///f%3A/workspaces/station1/stations/station5/ComfyUI-Launcher/src/main/index.ts#L3109-L3118),
[src/main/index.ts#L1354-L1360](file:///f%3A/workspaces/station1/stations/station5/ComfyUI-Launcher/src/main/index.ts#L1354-L1360)

**What's wrong:** A claim is consumed by `onLaunch()` only when its
matching launch event arrives. If the chooser host that owns the claim is
closed (or its target install never launches because the user changed
their mind), the claim sits in the map indefinitely:

- Window close handler unregisters the entry from `comfyWindows` /
  `installationIdToWindowKey` (line 1359) but does NOT walk
  `pendingAttachClaims` to drop entries pointing at the dying
  `windowKey`.
- A re-pick of the same install elsewhere overwrites the stale claim,
  but **only that install's claim**. Stale claims for other installs
  ride along forever.

Although the consumer in `onLaunch()` (line 1442-1446) safely rejects
stale entries (`!claimed.window.isDestroyed() && claimed.installationId
=== null`), the map itself grows over the app's lifetime. Worse, a stale
claim can be **silently consumed** by a launch the user never associated
with the original chooser host — `pendingAttachClaims.delete(installationId)`
fires on every `onLaunch()` for an install whose claim is in the map,
even when the launch was triggered from the dashboard with no chooser
intent. That delete is benign because the claim then fails the validation,
but it's a side-effect a maintainer wouldn't expect from reading
`onLaunch()`.

**Suggested fix:** In the `closed` handler (line 1354-1360), after
`unregisterHostEntry(closedEntry)`, walk `pendingAttachClaims` and delete
any entry whose value equals `closedEntry.windowKey`. Keep the map small
and the consumer side easier to reason about.

---

### F3 — "Last-write-wins" claim collision silently misdirects attach (Medium)

**Files:** [src/main/index.ts#L3109-L3118](file:///f%3A/workspaces/station1/stations/station5/ComfyUI-Launcher/src/main/index.ts#L3109-L3118),
[src/renderer/src/panel/PanelApp.vue#L646-L666](file:///f%3A/workspaces/station1/stations/station5/ComfyUI-Launcher/src/renderer/src/panel/PanelApp.vue#L646-L666)

**What's wrong:** `pendingAttachClaims` is keyed by `installationId`. Two
chooser hosts (A and B) that try to launch the same install in quick
succession both call `claimAttachHost(id)`; main happily accepts both —
the second overwrites the first.

What follows depends on launch ordering:
- Second `handleLaunch(id)` call hits `_operationAborts.has(installationId)`
  or `_runningSessions.has(installationId)` at the top of `launch.ts`
  (lines 52-57) and returns `errors.alreadyRunning`.
- The first launch eventually fires `onLaunch()`. The claim is read as
  "the SECOND host's `windowKey`" because B overwrote A.
- A user perceives "I picked install X in window A, but window B became
  the install — my chooser context (A) still shows the chooser".

The window-mode-unification plan (lines 188-193) calls this "last claim
wins" by design but the design assumes both clicks are the same user
making the same decision. In a multi-window setup the first claim is
actually the canonical intent — the second is a duplicate that the
launch action itself rejected.

**Suggested fix:** In `claim-attach-host`, refuse a claim when one is
already pending for the same `installationId`:

```ts
if (pendingAttachClaims.has(installationId)) return false
```

The renderer falls back to the legacy `transferHostBoundsToInstall +
closeHostWindow` swap, which is also the right outcome when the second
launch is going to be rejected with `errors.alreadyRunning` anyway.
A nicer surface would have the renderer detect `errors.alreadyRunning`
and fall back to focusing the existing window, but that's separate work.

---

### F4 — `returnToDashboard` kills the running ComfyUI process with no consult when no overlay is mounted (Medium)

**Files:** [src/main/index.ts#L774-L785](file:///f%3A/workspaces/station1/stations/station5/ComfyUI-Launcher/src/main/index.ts#L774-L785),
[src/main/index.ts#L1774-L1796](file:///f%3A/workspaces/station1/stations/station5/ComfyUI-Launcher/src/main/index.ts#L1774-L1796),
[src/renderer/src/panel/PanelApp.vue#L755-L760](file:///f%3A/workspaces/station1/stations/station5/ComfyUI-Launcher/src/renderer/src/panel/PanelApp.vue#L755-L760)

**What's wrong:** `consultPanelRendererClose` only triggers a confirm
prompt when there's a Tier 2/3 overlay mounted (`closeOverlay` returns
`true` silently for `currentOverlay === null`). For the common case —
user is actively running ComfyUI with no modal open — clicking
File → Return to Dashboard runs `entry.detachInstall()` → `_installCleanup`
→ `ipc.stopRunning(id)` → `killProcessTree(session.proc)`.

The user's running ComfyUI session (potentially with unsaved workflow
graph state in the renderer) is force-killed with no confirmation. ComfyUI
itself doesn't have a "save before close" prompt at the WebContents level
because `comfyContents.on('will-prevent-unload')` calls `e.preventDefault()`
unconditionally (line 1209-1211) — by design for the X close button, but
"Return to Dashboard" is more of a "I want to switch installs" gesture
than a "I'm shutting down" one.

This is consistent with the existing window-close behaviour, but the
`returnToDashboard` docstring (line 752-773) suggests a more graceful
in-place flip. Worth making the policy explicit one way or the other.

**Suggested fix:** Either:
1. Document the kill explicitly in the File-menu copy ("Return to Dashboard
   (stop install)") so the user knows it's a stop-then-flip; or
2. Add an unconditional confirm when the install is currently running
   (regardless of overlay state), e.g. surface the same "in-progress
   operations" detail that `confirmAndCloseAllHostWindows` collects via
   `ipc.getActiveDetails()`.

Either choice should be documented in the modal-unification plan so the
next maintainer knows the semantics are intentional.

---

### F5 — `_runningSessions.has(installationId)` race in chooser already-running branch (Low/Medium)

**Files:** [src/renderer/src/panel/PanelApp.vue#L668-L699](file:///f%3A/workspaces/station1/stations/station5/ComfyUI-Launcher/src/renderer/src/panel/PanelApp.vue#L668-L699),
[src/renderer/src/panel/PanelApp.vue#L512-L530](file:///f%3A/workspaces/station1/stations/station5/ComfyUI-Launcher/src/renderer/src/panel/PanelApp.vue#L512-L530)

**What's wrong:** `handleChooserPick` (and `launchInstallationAfterFirstUse`)
both branch on `sessionStore.isRunning(installation.id)`:

```ts
if (sessionStore.isRunning(installation.id)) {
  await window.api.focusComfyWindow(installation.id)
  return
}
```

`sessionStore` is updated by main's `instance-launching` /
`instance-started` / `instance-stopped` broadcasts. If the user clicks a
tile **between** an `instance-launching` event and the matching
`instance-started`, the renderer-side `isRunning()` check could miss the
in-flight launch (depending on what `isRunning` actually counts —
`launching` vs `started`). The in-flight launch then races with the
`prepareChooserHostHandoff` claim that this branch never sets.

**Suggested fix:** Audit `sessionStore.isRunning` and explicitly treat
the launching state as "already in flight" so the branch above also
covers the launch-in-progress case (focus the window even if the launch
hasn't finished). Alternatively, route through `getRunningInstances()`
from main as the source of truth.

---

### F6 — `installationIdToWindowKey` race window after `attachInstall()` (Medium)

**Files:** [src/main/index.ts#L1571-L1576](file:///f%3A/workspaces/station1/stations/station5/ComfyUI-Launcher/src/main/index.ts#L1571-L1576),
[src/main/index.ts#L1409-L1423](file:///f%3A/workspaces/station1/stations/station5/ComfyUI-Launcher/src/main/index.ts#L1409-L1423)

**What's wrong:** `attachInstall` mutates `entry.installationId` and the
secondary index synchronously (lines 1571-1576), then `comfyContents.loadURL`
kicks off the async load (line 1768). If a second `onLaunch()` for the
same install arrives between attachInstall returning and the URL load
completing — e.g. the user double-clicked a tile fast enough that two
launch events make it through to main — `getEntryByInstallationId(id)`
on line 1409 resolves the first attach, takes the "existing entry" branch
(lines 1410-1423), and re-issues `loadURL(comfyUrl)` against the still-
loading view. Electron will cancel the in-flight load and start the new
one; benign, but worth noting.

More problematic: the same race also catches a **launch-then-detach-
then-launch** where the second launch hits `getEntryByInstallationId` and
returns the now-detached entry IF detach hasn't yet run synchronously.
Detach runs `installationIdToWindowKey.delete(id)` inside `_installCleanup`
(line 1792); since both attach and detach are synchronous up to the
point of mutation this is probably tight enough — but the contract isn't
asserted anywhere.

**Suggested fix:** Document the synchronous-mutation contract on
`attachInstall` / `_installCleanup` (the existing Stage W-3b doc-block
talks about idempotency but not about ordering vs `getEntryByInstallationId`).
Consider asserting in dev/test mode that any `attachInstall` reachable
state has a matching index entry.

---

### F7 — `_installCleanup` doesn't cancel in-flight install/migrate/snapshot operations (High)

**Files:** [src/main/index.ts#L1774-L1796](file:///f%3A/workspaces/station1/stations/station5/ComfyUI-Launcher/src/main/index.ts#L1774-L1796),
[src/main/lib/ipc/registerSessionHandlers.ts#L41-L47](file:///f%3A/workspaces/station1/stations/station5/ComfyUI-Launcher/src/main/lib/ipc/registerSessionHandlers.ts#L41-L47),
[src/renderer/src/composables/useOverlay.ts#L268-L283](file:///f%3A/workspaces/station1/stations/station5/ComfyUI-Launcher/src/renderer/src/composables/useOverlay.ts#L268-L283)

**What's wrong:** `_installCleanup` only stops the running ComfyUI session
(`ipc.stopRunning(id)`). It does NOT cancel in-flight operations tracked
in `_operationAborts` (install / migrate / quick-install / update-while-
running / copy / snapshot). The cancel matrix in modal-unification was
supposed to plug this through Tier 2 progress overlay's `onCancel`
hook — which does fire when the user confirms the cancel-prompt during
window close — but only when:

1. There IS a Tier 2/3 overlay mounted at consult time, AND
2. The user confirms the cancel-prompt (defaults to "Cancel").

If a long-running install op is in flight but the renderer for whatever
reason has no overlay mounted (e.g. the window was opened mid-op via
some extra surface, or the overlay state desync'd), the consult returns
`cleared: true` immediately, `_installCleanup` runs, the window is
destroyed, and the operation continues running orphaned in main —
chewing CPU/disk, eventually broadcasting completion to a destroyed
WebContents (silently swallowed), and never releasing its
`_operationAborts` slot until the op completes.

The "Window/process ownership" section of the review checklist explicitly
calls this risk out. The current wiring relies entirely on the renderer
having mounted the right overlay; main has no fallback.

**Suggested fix:** In `_installCleanup`, before clearing maps, also call
`ipc.cancelOperation(id)` (or the equivalent main-side abort fan-out) so
any in-flight op for the install gets `abort.abort()`'d. Renderer-side
overlays continue to drive the prompt UX; main becomes the safety net
when the renderer side fails.

---

### F8 — `_installCleanup`'s `relaunchStates.delete(id)` doesn't run the navBlocker `off()` (Medium)

**Files:** [src/main/index.ts#L1791](file:///f%3A/workspaces/station1/stations/station5/ComfyUI-Launcher/src/main/index.ts#L1791),
[src/main/index.ts#L857-L1041](file:///f%3A/workspaces/station1/stations/station5/ComfyUI-Launcher/src/main/index.ts#L857-L1041) (relaunch state machinery)

**What's wrong:** `relaunchStates` holds a `navBlocker` callback that's
attached to `comfyContents.on('will-navigate', blockNav)` in
`onModelFolderRelaunch`. `_installCleanup` (line 1791) calls
`relaunchStates.delete(id)` — clearing the map entry — but never runs
`comfyContents.off('will-navigate', prev.navBlocker)`.

Effect: a window that detaches mid-relaunch leaves the navBlocker
attached to the comfyContents. After a subsequent attach, the blocker
fires (preventDefault on every will-navigate) until the comfyContents
itself is destroyed. The user sees "click did nothing" navigations.
Same hazard for `comfyFailRetryTimerCancels` if a timer is somehow not
the one cancelled (cancelFailRetry is correct in this respect).

**Suggested fix:** In `_installCleanup`, before
`relaunchStates.delete(id)`, look up the existing relaunch state and
explicitly `comfyContents.off('will-navigate', state.navBlocker)`.

---

### F9 — `_runningSessions.has` check in `handleLaunch` raced by claim path (Medium)

**Files:** [src/main/lib/ipc/sessionActions/launch.ts#L52-L57](file:///f%3A/workspaces/station1/stations/station5/ComfyUI-Launcher/src/main/lib/ipc/sessionActions/launch.ts#L52-L57),
[src/main/index.ts#L1409-L1423](file:///f%3A/workspaces/station1/stations/station5/ComfyUI-Launcher/src/main/index.ts#L1409-L1423)

**What's wrong:** `handleLaunch` rejects the second concurrent launch
(`alreadyRunning`). But the renderer-side `prepareChooserHostHandoff`
runs `claimAttachHost` BEFORE `executeChooserAction`, so even when the
launch action itself is rejected, the claim is set. Combined with **F2**
(no claim GC) and **F3** (last-write-wins), this means the rejected
launch leaves a stale claim that can still be honoured by a later
**unrelated** `onLaunch()` for the same install.

Concretely: user picks install X in chooser A (claim X→A.windowKey).
Race: claimed but launch rejected because X just started running from
elsewhere. Stale claim sits in the map. Later, user stops X and
re-launches X via the dashboard tile (no chooser involved, no
`prepareChooserHostHandoff`). `onLaunch` finds the stale X→A claim;
A.windowKey is still alive and install-less; partition matches; the
dashboard launch attaches X to A. The user sees A become X without
having clicked a tile in A.

**Suggested fix:** Either F2's GC fix covers this, or
`prepareChooserHostHandoff` could roll the claim back when the
subsequent launch returns an error (not just on success). The first
fix is simpler and addresses the underlying invariant ("claims belong
to live host windows").

---

### F10 — `entry.detachInstall = () => {}` placeholder before re-binding (Low)

**Files:** [src/main/index.ts#L1378-L1386](file:///f%3A/workspaces/station1/stations/station5/ComfyUI-Launcher/src/main/index.ts#L1378-L1386)

**What's wrong:** `entry` is constructed with a no-op
`detachInstall: () => {}`, then immediately rebound on the next line.
Anyone reading the `ComfyWindowEntry` literal sees a no-op as the
default and has to scroll to confirm the rebind happens before the entry
is registered. There's no other consumer in the same scope, but
asserting via `as` would make the contract clearer:

```ts
const entry: ComfyWindowEntry = {
  ...,
  // bound below — must run before registerHostEntry
  detachInstall: undefined as unknown as () => void,
}
entry.detachInstall = () => _detachInstallImpl(entry)
registerHostEntry(entry)
```

Or restructure to construct entry with `detachInstall` already wired via
a small helper that takes the entry by closure. Cosmetic.

---

### F11 — `attachInstall` throws on already-attached but no caller defends (Low)

**Files:** [src/main/index.ts#L1554-L1560](file:///f%3A/workspaces/station1/stations/station5/ComfyUI-Launcher/src/main/index.ts#L1554-L1560)

**What's wrong:** The throw is unguarded — if any future call site
forgets the `claimed.installationId === null` check, the throw bubbles
through `onLaunch` (which has no try/catch), out of the IPC dispatch,
and surfaces as an "uncaught exception" in main. Current call sites
(line 1448, 1499) both gate correctly, so this is hypothetical, but
the cost of "throw vs. early return + log" is asymmetric: a missed
guard takes down the launch flow rather than degrading gracefully.

**Suggested fix:** Replace the throw with an early return + `console.error`
+ telemetry forward, OR wrap the throw site in a try/catch in `onLaunch`
that falls back to the legacy fresh-window path on attach failure.

---

### F12 — Test coverage gap for attach/detach/re-attach lifecycle (Medium)

**Files:** none (gap)

**What's wrong:** Window-mode-unification plan §214-216 explicitly calls
out the need for a main-process integration test that walks
`construct → attach → detach → re-attach` and asserts
`comfyWindows` map shape after each step. No such test exists in the
diff (`installations.test.ts` covers the installations module, not the
window-state machine). All five W-track findings above (F1, F2, F3, F6,
F8) would be caught by even a minimal harness that mocks
`BrowserWindow` / `WebContentsView` enough to exercise the entry's
state transitions.

**Suggested fix:** Land the integration test the W-3 plan asked for as
a follow-up. Cover at minimum:
- attach → detach → re-attach to same install: assert one entry, one
  install-id index entry, comfyView listeners not duplicated.
- attach (unique partition A) → detach → claim from chooser (non-unique
  install B): assert claim accepted xor host's partition matches B
  (covers F1).
- close window with stale claim: assert `pendingAttachClaims` has no
  entries pointing at the closed `windowKey` (covers F2).

---

### F13 — `useOverlay.confirmCancelCurrent` doesn't pre-empt for Tier 2 → Tier 3 silent transitions (Low)

**Files:** [src/renderer/src/composables/useOverlay.ts#L268-L283](file:///f%3A/workspaces/station1/stations/station5/ComfyUI-Launcher/src/renderer/src/composables/useOverlay.ts#L268-L283)

**What's wrong:** The cancel-prompt rule fires when:
- `cur?.kind === 'progress' && nextTier >= 2` (Tier 2 progress → any Tier 2/3)
- `next === null && (cur?.kind === 'progress' || cur?.kind === 'takeover')` (close)

A Tier 1 → Tier 3 (e.g. opening the install-flow takeover from a manage
modal) silently replaces the manage modal — fine. But a Tier 3 →
**different** Tier 3 (chain-local first-use → new-install) also silently
replaces, even when the displaced takeover has `onCancel` set — meaning
the displaced takeover's `onCancel` is **never fired**. The plan calls
this out as "rare — used by the multi-step first-use flow" (line 47-49)
but it's a foot-gun: if a future Tier 3 with a real cancel callback is
chained into another Tier 3 by accident, the rollback is lost silently.

**Suggested fix:** Either fire `cur.onCancel?.()` on the silent Tier 3 →
Tier 3 swap too (preserves the rollback contract), or add an explicit
`pre-empt: 'silent'` opt-in on the Tier 3 takeover so first-use can
keep its current behaviour but generic Tier 3 swaps default to the
prompt.

---

### F14 — Settings shape change drops `primaryInstallId`, `pinnedInstallIds` cleanly but `onAppClose: 'tray'` lingers (Low)

**Files:** [src/main/settings.ts#L181-L191](file:///f%3A/workspaces/station1/stations/station5/ComfyUI-Launcher/src/main/settings.ts#L181-L191),
[src/main/settings.ts#L82-L97](file:///f%3A/workspaces/station1/stations/station5/ComfyUI-Launcher/src/main/settings.ts#L82-L97)

**What's wrong:** The settings load path explicitly drops
`primaryInstallId` and `pinnedInstallIds` for upgraders. The default for
`onAppClose` flipped from `'tray'` → `'quit'` because docking-to-tray
is disabled, but the persisted value is **not** scrubbed. Existing
users with `onAppClose: 'tray'` carry that value forward; nothing reads
it at runtime today (the setting field is hidden in the settings UI
per `registerSettingsHandlers.ts:32-36`), so it's inert — but if/when
the docking-to-tray flow comes back the legacy value would silently
take effect for a subset of users without their consent (they may have
set it long enough ago to forget).

**Suggested fix:** Either add the same drop-on-load for `onAppClose`
that `primaryInstallId` / `pinnedInstallIds` got, OR document in
`settings.ts` that the docking-to-tray restoration must ALSO migrate
the persisted `'tray'` value to the new (re-enabled) default to avoid
auto-trayifying users who were on `'quit'` semantics for the duration
of the disabled phase.

---

### F15 — `comfyContents.on('will-prevent-unload', e => e.preventDefault())` unconditional override is install-keyed and now generic (Low)

**Files:** [src/main/index.ts#L1209-L1211](file:///f%3A/workspaces/station1/stations/station5/ComfyUI-Launcher/src/main/index.ts#L1209-L1211)

**What's wrong:** Pre-W-2 this listener lived inline in the install-
backed constructor; W-2 moved it to `createHostWindow` so it survives
attach/detach. Side effect: it now also runs on **chooser-host** comfy
views (which are `about:blank` / unloaded by default). Harmless today
(nothing on the chooser host fires `beforeunload`), but if the chooser
host ever loads anything that wants to confirm-on-unload, the listener
silently swallows it.

**Suggested fix:** Either gate on `entry.installationId !== null` inside
the handler, or document that the chooser's comfyView is contractually
"never loaded with anything that uses beforeunload" (Service Worker
registrations on `persist:shared` could theoretically trigger one).

---

### F16 — `_detachInstallImpl` doesn't unsubscribe from `_runningSessions` consumers (Medium)

**Files:** [src/main/index.ts#L1838-L1890](file:///f%3A/workspaces/station1/stations/station5/ComfyUI-Launcher/src/main/index.ts#L1838-L1890),
[src/main/index.ts#L848-L855](file:///f%3A/workspaces/station1/stations/station5/ComfyUI-Launcher/src/main/index.ts#L848-L855)

**What's wrong:** `onComfyExited` calls `refreshComfyTabBody(installationId)`,
which calls `getEntryByInstallationId(installationId)` and short-circuits
if there's no entry. After detach, the install no longer has an entry
in the secondary index, so this path is safe. **But** there's a window
where the install's process is exiting at the same time as detach is
running:

1. Detach starts → `_installCleanup` calls `ipc.stopRunning(id)` →
   `killProcessTree(session.proc)`.
2. Process exit fires `onComfyExited({ installationId })`.
3. `refreshComfyTabBody(id)` → `getEntryByInstallationId(id)` returns
   undefined (already cleared by `_installCleanup`).

Nothing user-visible, but the `instance-stopped` broadcast that
`stopRunning` fires (via `_broadcastToRenderer('instance-stopped',
{ installationId })`) goes out to a renderer that's about to swap to
chooser body. The chooser renderer (`ChooserView.vue`) reads
`sessionStore` which subscribes to that broadcast — fine.

The bigger concern: tests for this transition don't exist (see F12). The
order-of-events here is fragile and easy to break with a future refactor.

**Suggested fix:** Land the integration test from F12 to lock the
ordering in.

---

### F17 — Code duplication: in-place tile-click branch copy-pasted between `handleChooserPick` and `launchInstallationAfterFirstUse` (Low)

**Files:** [src/renderer/src/panel/PanelApp.vue#L668-L699](file:///f%3A/workspaces/station1/stations/station5/ComfyUI-Launcher/src/renderer/src/panel/PanelApp.vue#L668-L699),
[src/renderer/src/panel/PanelApp.vue#L512-L530](file:///f%3A/workspaces/station1/stations/station5/ComfyUI-Launcher/src/renderer/src/panel/PanelApp.vue#L512-L530)

**What's wrong:** Both functions implement the same shape: check
`isRunning` → focus and return; otherwise resolve `launchAction` →
`prepareChooserHostHandoff` → `executeChooserAction`. The only
difference is the `actions = await window.api.getListActions(...)` wrapper
and the missing-action fallback (`handleChooserPick` falls through to
`switchPanel('new-install')`; `launchInstallationAfterFirstUse` returns
silently). Per AGENTS.md "post-change deduplication", these should
collapse to one helper:

```ts
async function performChooserLaunch(
  installation: Installation,
  onMissingLaunchAction: () => void = () => {},
): Promise<void> { ... }
```

…with the two callers passing different fallbacks.

**Suggested fix:** Extract the shared body. Keeps the W-5 dedupe
behaviour (focus existing window, leave chooser host alive) in one
place so a future change can't regress one branch but not the other.

---

### F18 — `_runningSessions` consumed via store but no main-side authority on "is running" for `handleChooserPick` (Low)

**Files:** [src/renderer/src/panel/PanelApp.vue#L668-L679](file:///f%3A/workspaces/station1/stations/station5/ComfyUI-Launcher/src/renderer/src/panel/PanelApp.vue#L668-L679)

See F5. Left as separate finding because the dedupe in F17 makes the
fix slightly different (one place to add the "or launching" check).

---

### F19 — Doc comments reference deleted patterns (Nit)

**Files:** [src/main/index.ts#L228-L232](file:///f%3A/workspaces/station1/stations/station5/ComfyUI-Launcher/src/main/index.ts#L228-L232),
[src/main/index.ts#L1850-L1853](file:///f%3A/workspaces/station1/stations/station5/ComfyUI-Launcher/src/main/index.ts#L1850-L1853)

The Stage W-1 docstring on `windowKey` calls out
`comfyWindows.get(installationId)` as the legacy pattern (good — explains
the change), but the 1850-1853 docstring on `_detachInstallImpl`
mentions "needs visual review in W-4" for the unique-partition case,
which is now stale (W-4 has shipped). Update the docstring to either
reference W-4's resolution (and link to F1 if accepted) or strike the
TODO entirely.

---

### F20 — `closingInFlight` re-entry guard nests `void (async () => …)()` instead of using a Promise field (Nit)

**Files:** [src/main/index.ts#L1324-L1352](file:///f%3A/workspaces/station1/stations/station5/ComfyUI-Launcher/src/main/index.ts#L1324-L1352)

The `closingInFlight` boolean + `void (async IIFE)()` pattern works but
is hard to test — the rapid-double-close path can't easily be asserted
in a unit test without spying on `consultPanelRendererClose`. Stashing
the in-flight Promise on the entry would let a second `close` await
the first instead of being silently dropped, and would make the test
shape obvious. Cosmetic; safe as-is.

---

## Out-of-scope observations

- **`useInstallContextMenu.ts`** — the hotspot called out in the review
  checklist looks well-factored: one composable, one source of truth for
  REQUIRES_STOPPED gating, one dispatch path through `onManage`. No
  significant duplication issues. The kebab-vs-context menu unification
  is clean.
- **IPC handler patterns** — the title-bar IPC chokepoint
  (`findEntryByTitleBarSender`) is a clean pattern, well-documented
  with the security contract about aux popups. The `claim-attach-host`
  / `transfer-host-bounds-to-install` / `close-host-window` /
  `close-current-panel` family all follow the same "walk
  `comfyWindows` and match against `event.sender`" shape — slight
  duplication but the iterations are short and the resolution semantics
  differ enough that pulling it into a helper would cost more clarity
  than it saves. Leave as-is.
- **Per-source-category branching** — `sourceCategory` reads in
  `attachInstall`, `installContextMenu`, and `ChooserView` look
  consistent; nothing screamed out as needing extraction.

## Summary

| Severity | Count | IDs |
|----------|-------|-----|
| Critical | 1 | F1 |
| High     | 2 | F2, F7 |
| Medium   | 6 | F3, F4, F6, F8, F9, F12, F16 |
| Low      | 6 | F5, F10, F11, F13, F14, F15, F17, F18 |
| Nit      | 2 | F19, F20 |

**Top three by impact:**

1. **F1** — partition leak. Real data hazard for users who flip between
   unique-partition (Standalone / Portable) and non-unique installs in
   the same window. Fix before users notice.
2. **F7** — operation-cancel rollback hole. Renderer-side overlay
   coverage is the only safety net today; main needs to be the
   authority. Easy fix (`ipc.cancelOperation(id)` inside
   `_installCleanup`) but verify it doesn't double-cancel when the
   overlay's `onCancel` already fired.
3. **F2** — stale claims. Memory leak today; combined with F3 / F9 it
   becomes a correctness bug. Fix is one closed-handler walk over the
   claims map.

After triage, F12's integration-test follow-up should land alongside
the F1/F2/F7 fixes so the W-track machinery has the regression net the
plan asked for.
