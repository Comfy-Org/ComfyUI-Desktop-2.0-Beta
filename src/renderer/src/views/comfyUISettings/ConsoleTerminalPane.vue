<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useDebounceFn } from '@vueuse/core'
import { useI18n } from 'vue-i18n'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type { TerminalRestore } from '../../../../types/ipc'
import { TID } from '../../../../shared/testIds'

/** Interactive per-install console. The shell lives in main (one PTY per
 *  installation, shared across windows) and survives ComfyUI being stopped,
 *  so this pane is purely a view onto it. Typing `exit` ends the session;
 *  the restart banner respawns a fresh shell. */

interface Props {
  installationId: string | null
}

const props = defineProps<Props>()

const { t } = useI18n()
const api = window.api

const paneRef = ref<HTMLDivElement | null>(null)
const hostRef = ref<HTMLDivElement | null>(null)
const exited = ref(false)

let terminal: Terminal | null = null
let fitAddon: FitAddon | null = null
let resizeObserver: ResizeObserver | null = null
const disposers: Array<() => void> = []

function teardown(): void {
  for (const dispose of disposers.splice(0)) dispose()
  resizeObserver?.disconnect()
  resizeObserver = null
  const id = currentId
  if (id) void api.terminalUnsubscribe(id)
  terminal?.dispose()
  terminal = null
  fitAddon = null
  currentId = null
}

let currentId: string | null = null

function applyRestore(restore: TerminalRestore): void {
  if (!terminal) return
  if (restore.size.cols > 0 && restore.size.rows > 0) {
    terminal.resize(restore.size.cols, restore.size.rows)
  }
  if (restore.buffer.length) terminal.write(restore.buffer.join(''))
  exited.value = restore.exited
}

function pushSize(): void {
  if (!terminal || !fitAddon || !currentId) return
  if (!hostRef.value?.offsetParent) return
  const dims = fitAddon.proposeDimensions()
  if (!dims || !dims.cols || !dims.rows) return
  if (dims.cols === terminal.cols && dims.rows === terminal.rows) return
  terminal.resize(dims.cols, dims.rows)
  void api.terminalResize(currentId, dims.cols, dims.rows)
}

/** Force the shared PTY to this view's size. Unlike {@link pushSize}, this skips
 *  the "local dims unchanged" guard: another window may have resized the PTY out
 *  from under us, so on focus we must re-assert our size even if our own xterm
 *  hasn't changed, or the shell's cursor stays misaligned. */
function reclaimPtySize(): void {
  if (!terminal || !currentId) return
  if (!hostRef.value?.offsetParent) return
  void api.terminalResize(currentId, terminal.cols, terminal.rows)
}

const debouncedPushSize = useDebounceFn(pushSize, 50)

async function attach(id: string): Promise<void> {
  if (!hostRef.value) return
  currentId = id

  terminal = new Terminal({ convertEol: true, theme: { background: '#171717' } })
  fitAddon = new FitAddon()
  terminal.loadAddon(fitAddon)
  terminal.open(hostRef.value)

  disposers.push(terminal.onData((data) => void api.terminalWrite(id, data)).dispose)
  disposers.push(
    api.onTerminalOutput((payload) => {
      if (payload.installationId !== id) return
      // Output only flows from a live shell, so a restart triggered from
      // another window (no exit/start event reaches us) revives the session:
      // clear the "session ended" banner so input works again.
      if (exited.value) exited.value = false
      terminal?.write(payload.data)
    })
  )
  // The PTY is shared with the ComfyUI window's terminal and holds one size.
  // Reclaim it for this view on focus so the shell's cursor matches what we
  // render here.
  terminal.element?.addEventListener('focusin', reclaimPtySize)
  disposers.push(() =>
    terminal?.element?.removeEventListener('focusin', reclaimPtySize)
  )
  disposers.push(
    api.onTerminalExited((payload) => {
      if (payload.installationId === id) exited.value = true
    })
  )

  resizeObserver = new ResizeObserver(() => void debouncedPushSize())
  if (paneRef.value) resizeObserver.observe(paneRef.value)

  pushSize()
  applyRestore(await api.terminalSubscribe(id))
  requestAnimationFrame(pushSize)
}

async function restart(): Promise<void> {
  if (!currentId || !terminal) return
  terminal.reset()
  exited.value = false
  applyRestore(await api.terminalRestart(currentId))
  pushSize()
}

onMounted(() => {
  if (props.installationId) void attach(props.installationId)
})

watch(
  () => props.installationId,
  (next) => {
    teardown()
    exited.value = false
    if (next) void attach(next)
  }
)

onBeforeUnmount(teardown)
</script>

<template>
  <div ref="paneRef" class="console-pane">
    <div ref="hostRef" class="console-host" :data-testid="TID.consoleTerminal" />
    <div
      v-if="exited"
      class="console-ended"
      role="status"
      :data-testid="TID.consoleSessionEnded"
    >
      <span class="console-ended-text">{{ t('console.sessionEnded') }}</span>
      <button
        type="button"
        class="accent console-ended-restart"
        :data-testid="TID.consoleRestart"
        @click="restart"
      >
        {{ t('console.restartSession') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.console-pane {
  position: relative;
  width: 100%;
  /* Without min-width:0 the xterm host's intrinsic ~80-col width propagates up
   * the flex chain and blows out the settings pane (overflowing buttons, broken
   * tab strip). */
  min-width: 0;
  flex: 1 1 auto;
  min-height: 240px;
  background: #171717;
  border-radius: 8px;
  overflow: hidden;
}

/* Absolutely positioned so xterm's content size never contributes to the
 * layout's intrinsic width — the pane is sized by the flex container only. */
.console-host {
  position: absolute;
  inset: 0;
  padding: 8px;
  overflow: hidden;
}

/* xterm injects its own DOM at runtime, outside Vue's scoped templates, so
 * `:deep()` is required to reach it. Without clamping these layers they
 * overflow the host and capture pointer events across the settings window,
 * which reads as the whole UI freezing. */
.console-host :deep(.xterm) {
  overflow: hidden;
}

.console-host :deep(.xterm-screen) {
  overflow: hidden;
  background-color: #171717;
}

.console-ended {
  position: absolute;
  inset-inline: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  background: var(--modal-surface-bg, #1f1f1f);
  border-top: 1px solid var(--chooser-surface-border, rgba(255, 255, 255, 0.1));
}

.console-ended-text {
  font-size: 13px;
  color: var(--text-muted, var(--neutral-100));
}

.console-ended-restart {
  height: 30px;
  padding: 0 14px;
  font-size: 12px;
  font-weight: 500;
  flex-shrink: 0;
}
</style>
