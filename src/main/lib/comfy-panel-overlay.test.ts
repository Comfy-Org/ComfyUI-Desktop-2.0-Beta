/**
 * Issue #523 — guard test for the title-bar → panel-renderer IPC
 * channels owned by `comfy-panel-overlay.ts`.
 *
 * The two channels (`'panel-trigger-overlay'` and
 * `'comfy-panel:open-feedback'`) carry the lazy-panelView /
 * `did-finish-load` deferral invariant the helper module enforces.
 * Any other call site that sends these channels directly would
 * silently re-introduce the regression PR #508 and this issue's fix
 * landed (the freshly-constructed lazy panelView's renderer hasn't
 * subscribed yet, so the IPC drops on the floor).
 *
 * This test scans every `.ts` file under `src/main/` and asserts the
 * helper module is the ONLY one referencing either literal in a
 * `webContents.send(...)` argument. Comments / docstrings that
 * mention the channel name are allowed via the deliberate matching:
 * we only flag literal strings inside parentheses preceded by
 * `.send(` or `.send (`.
 *
 * If you're tempted to add a new caller for either channel: add a
 * helper to `comfy-panel-overlay.ts` instead and route through it.
 */

import { describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import path from 'path'

const MAIN_SRC_DIR = path.resolve(__dirname, '..')
const HELPER_BASENAME = 'comfy-panel-overlay.ts'

const CHANNELS = [
  'panel-trigger-overlay',
  'comfy-panel:open-feedback',
] as const

async function* walkTsFiles(dir: string): AsyncGenerator<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* walkTsFiles(full)
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      yield full
    }
  }
}

/** Match `.send('channel'…)` and `.send("channel"…)` (any whitespace). */
function findRawSendsForChannel(source: string, channel: string): number[] {
  const pattern = new RegExp(
    `\\.send\\s*\\(\\s*['"\`]${channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`,
    'g',
  )
  const lines = source.split('\n')
  const hits: number[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue
    pattern.lastIndex = 0
    if (pattern.test(line)) hits.push(i + 1)
  }
  return hits
}

describe('comfy-panel-overlay channel guard (issue #523)', () => {
  for (const channel of CHANNELS) {
    it(`channel '${channel}' is only sent from the helper module`, async () => {
      const offenders: { file: string; lines: number[] }[] = []
      for await (const file of walkTsFiles(MAIN_SRC_DIR)) {
        if (path.basename(file) === HELPER_BASENAME) continue
        // The guard test itself contains the literal in test data — skip.
        if (path.basename(file) === path.basename(__filename)) continue
        const source = await fs.readFile(file, 'utf8')
        const hits = findRawSendsForChannel(source, channel)
        if (hits.length > 0) offenders.push({ file: path.relative(MAIN_SRC_DIR, file), lines: hits })
      }
      expect(
        offenders,
        `Found raw \`webContents.send('${channel}', ...)\` calls outside the helper module.\n`
          + `Route the send through \`triggerPanelOverlay\` / \`triggerOpenFeedback\` in \`src/main/lib/${HELPER_BASENAME}\` instead so the lazy-panelView and did-finish-load invariants are preserved.\n`
          + `Offenders:\n${offenders.map((o) => `  ${o.file}: lines ${o.lines.join(', ')}`).join('\n')}`,
      ).toEqual([])
    })
  }
})
