/**
 * Pop-out logs window. Standalone BrowserWindow that shows the live
 * stdout/stderr stream of a ComfyUI install. Subscribes to the same
 * per-install broadcast as the inline Logs panel, so it stays in
 * lockstep with the launching window.
 *
 * Unlike the terminal pop-out (full interactive PTY via xterm), this
 * is a read-only auto-scrolling text view. The append-only model lets
 * us avoid xterm entirely — text wraps natively and the browser handles
 * selection/copy.
 *
 * Auto-scroll is sticky: if the user scrolls up to inspect, we stop
 * pinning to the bottom. If they scroll back to within a few pixels of
 * the bottom, sticky-mode re-engages.
 */

import { BrowserWindow } from 'electron'
import path from 'path'
import { COMFY_BG } from './theme'
import * as installations from '../installations'

/**
 * The standalone bootstrap that the pop-out window executes in its
 * renderer. The launcher inserts `__comfyDesktopLogsPopoutInstallationId`
 * before this script runs.
 */
const POPOUT_MAIN_JS = `
(function () {
  'use strict';
  if (window.__comfyDesktopLogsPopoutMounted) return;
  window.__comfyDesktopLogsPopoutMounted = true;
  var INSTALL_ID = window.__comfyDesktopLogsPopoutInstallationId;
  var bridge = window.__comfyDesktop2 && window.__comfyDesktop2.Logs;
  if (!INSTALL_ID || !bridge) return;

  var root = document.body;
  root.style.background = '#171717';
  root.style.margin = '0';
  root.style.padding = '0';
  root.style.height = '100vh';
  root.style.boxSizing = 'border-box';
  root.style.overflow = 'hidden';
  root.style.display = 'flex';
  root.style.flexDirection = 'column';

  var toolbar = document.createElement('div');
  toolbar.style.cssText = 'flex:0 0 auto;display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:6px 12px;background:#0f0f0f;border-bottom:1px solid #2a2a2a;color:#a3a3a3;font-size:12px;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;';
  var stickyChip = document.createElement('span');
  stickyChip.textContent = 'Auto-scroll on';
  stickyChip.style.cssText = 'opacity:0.7;';
  var clearBtn = document.createElement('button');
  clearBtn.textContent = 'Clear';
  clearBtn.style.cssText = 'cursor:pointer;border:1px solid #2a2a2a;border-radius:6px;padding:2px 10px;background:#171717;color:#e5e5e5;font-size:12px;';
  toolbar.appendChild(stickyChip);
  toolbar.appendChild(clearBtn);
  root.appendChild(toolbar);

  var view = document.createElement('pre');
  view.style.cssText = 'flex:1 1 auto;margin:0;padding:8px 12px;overflow:auto;white-space:pre-wrap;word-break:break-word;color:#e5e5e5;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,Liberation Mono,Courier New,monospace;font-size:12px;line-height:1.45;background:#171717;';
  root.appendChild(view);

  var state = { sticky: true, disposed: false };

  function isAtBottom() {
    return view.scrollHeight - view.clientHeight - view.scrollTop < 8;
  }

  function append(text) {
    if (!text) return;
    view.appendChild(document.createTextNode(text));
    if (state.sticky) view.scrollTop = view.scrollHeight;
  }

  view.addEventListener('scroll', function () {
    var atBottom = isAtBottom();
    if (atBottom !== state.sticky) {
      state.sticky = atBottom;
      stickyChip.textContent = state.sticky ? 'Auto-scroll on' : 'Auto-scroll paused';
    }
  });

  clearBtn.addEventListener('click', function () {
    view.textContent = '';
    state.sticky = true;
    stickyChip.textContent = 'Auto-scroll on';
  });

  var offOutput = bridge.onOutput(function (msg) {
    if (state.disposed) return;
    if (!msg || msg.installationId !== INSTALL_ID) return;
    append(msg.text);
  });

  window.addEventListener('beforeunload', function () {
    state.disposed = true;
    try { offOutput && offOutput(); } catch (e) {}
    try { bridge.unsubscribe(INSTALL_ID); } catch (e) {}
  });

  bridge.subscribe(INSTALL_ID).then(function (restore) {
    if (state.disposed || !restore || !restore.buffer) return;
    append(restore.buffer.join(''));
  }).catch(function () {});
})();
`

function buildPopoutScript(installationId: string): string {
  return (
    `window.__comfyDesktopLogsPopoutInstallationId = ${JSON.stringify(installationId)};\n` +
    POPOUT_MAIN_JS
  )
}

// One pop-out per install — second click on the inline Logs button
// focuses the existing window instead of spawning a duplicate.
const popoutsByInstallation = new Map<string, BrowserWindow>()

export async function openLogsPopout(installationId: string): Promise<void> {
  const existing = popoutsByInstallation.get(installationId)
  if (existing && !existing.isDestroyed()) {
    existing.focus()
    return
  }

  let label = 'Comfy Logs'
  try {
    const inst = await installations.get(installationId)
    if (inst?.name) label = `Comfy Logs — ${inst.name}`
  } catch {
    // installations registry not ready; keep the generic label
  }

  const win = new BrowserWindow({
    width: 880,
    height: 520,
    title: label,
    backgroundColor: COMFY_BG,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/comfyPreload.js'),
      contextIsolation: true,
      sandbox: false,
    },
  })

  popoutsByInstallation.set(installationId, win)
  win.on('closed', () => {
    const cur = popoutsByInstallation.get(installationId)
    if (cur === win) popoutsByInstallation.delete(installationId)
  })

  const html =
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${label}</title>` +
    `<style>html,body{margin:0;padding:0;height:100%;background:${COMFY_BG};}</style>` +
    `</head><body></body></html>`
  void win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))

  win.webContents.once('did-finish-load', () => {
    void win.webContents.executeJavaScript(buildPopoutScript(installationId)).catch(() => {})
  })
}
