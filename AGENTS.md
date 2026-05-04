# Agent Guidelines

## Pre-commit checks

Run typecheck, lint, build, and tests before every commit and push:

```sh
pnpm run typecheck
pnpm run lint
pnpm run build
pnpm run test
```

Typecheck and lint are enforced automatically by a husky pre-commit hook.

## Fix all issues found by checks

Any errors or warnings surfaced by typecheck, lint, audit, or tests are **our responsibility to fix** — even if they appear to be pre-existing. Do not skip, ignore, or work around them with `--no-verify`. If a pre-commit hook fails, fix the underlying issues before committing.

## Flaky tests

Flaky tests are **not acceptable** — they must be fixed immediately when discovered. A test that intermittently fails erodes CI trust and masks real regressions. Common causes:

- **Timing assertions** (e.g., `expect(elapsed).toBeLessThan(X)`) — use generous thresholds or assert behavior instead of timing.
- **Process lifecycle races** — add explicit readiness signals (e.g., IPC `ready` messages) instead of relying on timing.
- **Platform-specific quirks** — Windows `taskkill` and PowerShell Restart Manager can be slow; account for this in timeouts and assertions.

If you encounter a flaky test during a run, investigate and fix it before continuing with other work.

## Post-change review: deduplication

After creating or modifying code, check for duplicated logic before committing:

- Look for repeated filter predicates, conditions, or expressions that could be extracted into a shared variable, computed property, or helper.
- If two call sites must stay in sync (e.g., a visibility check and the action it guards), extract the shared logic so they cannot diverge.
