/**
 * Pop-out terminal window. A small standalone Electron BrowserWindow that
 * runs the same xterm renderer as the inline injection but is decoupled
 * from the ComfyUI frontend's bottom panel. Uses the same per-install
 * shared shell as the inline view (`terminal-*` IPC handlers in
 * `registerTerminalHandlers.ts`), so output stays in lockstep between the
 * pop-out and any other surface still subscribed to the same install.
 *
 * Why a dedicated module instead of reusing `comfyTerminalContentScript`:
 * the inline script registers itself as a ComfyUI extension and renders
 * into a bottom-panel tab container. A pop-out has no extension system —
 * the xterm has to mount directly onto `document.body`. The render logic
 * is essentially identical; only the host + dedupe and the explicit
 * installationId passing differ.
 */

import { BrowserWindow } from 'electron'
import path from 'path'
import { readFileSync } from 'fs'
import { createRequire } from 'module'
import { COMFY_BG } from './theme'
import * as installations from '../installations'

const require = createRequire(__filename)

let cachedScript: string | null = null

function readPackageFile(id: string): string {
  return readFileSync(require.resolve(id), 'utf8')
}

function stripSourceMapComment(source: string): string {
  return source.replace(/\n?\/\/# sourceMappingURL=.*$/u, '')
}

/**
 * Build the standalone xterm bootstrap script for the pop-out window.
 * Memoised — the UMD payloads are large and never change at runtime.
 * The injected `INSTALLATION_ID` literal is substituted per window.
 */
function buildPopoutScript(installationId: string): string {
  if (!cachedScript) {
    const xtermJs = stripSourceMapComment(readPackageFile('@xterm/xterm/lib/xterm.js'))
    const fitJs = stripSourceMapComment(readPackageFile('@xterm/addon-fit/lib/addon-fit.js'))
    const css = readPackageFile('@xterm/xterm/css/xterm.css')

    cachedScript =
      `(function () {\n` +
      `'use strict';\n` +
      `if (typeof window === 'undefined' || !window.__comfyDesktop2 || !window.__comfyDesktop2.Terminal) return;\n` +
      `if (window.__comfyDesktopTerminalPopoutMounted) return;\n` +
      `window.__comfyDesktopTerminalPopoutMounted = true;\n` +
      `var __xt = { exports: {} };\n` +
      `(function () { var module = __xt; var exports = __xt.exports;\n${xtermJs}\n}).call(window);\n` +
      `var __fit = { exports: {} };\n` +
      `(function () { var module = __fit; var exports = __fit.exports; var self = window;\n${fitJs}\n}).call(window);\n` +
      `var XTerm = __xt.exports && __xt.exports.Terminal;\n` +
      `var FitAddon = __fit.exports && __fit.exports.FitAddon;\n` +
      `if (!XTerm || !FitAddon) return;\n` +
      `(function () {\n` +
      `var s = document.getElementById('__comfyDesktopXtermCssPopout');\n` +
      `if (!s) { s = document.createElement('style'); s.id = '__comfyDesktopXtermCssPopout'; s.textContent = ${JSON.stringify(css)}; (document.head || document.documentElement).appendChild(s); }\n` +
      `})();\n` +
      POPOUT_MAIN_JS +
      `})();\n`
  }
  // installationId interpolation goes after the cached payload — keeps
  // the UMD bundle re-used across windows but lets each window target its
  // own installation. The bootstrap reads it from a top-level constant.
  return `window.__comfyDesktopPopoutInstallationId = ${JSON.stringify(installationId)};\n` + cachedScript
}

/**
 * Standalone xterm bootstrap. Subscribes to the shared shell of the
 * popout's bound install, wires data/output/exit, fits to the window,
 * and refits on every resize. Render mounts directly to the body — no
 * bottom-panel tab plumbing.
 */
const POPOUT_MAIN_JS = `
var INSTALL_ID = window.__comfyDesktopPopoutInstallationId;
var bridge = window.__comfyDesktop2.Terminal;
if (!INSTALL_ID || !bridge) return;

var root = document.body;
root.style.background = '#171717';
root.style.margin = '0';
root.style.padding = '6px';
root.style.height = '100vh';
root.style.boxSizing = 'border-box';
root.style.overflow = 'hidden';

var host = document.createElement('div');
host.style.position = 'relative';
host.style.width = '100%';
host.style.height = '100%';
host.style.overflow = 'hidden';
root.appendChild(host);

var banner = document.createElement('div');
banner.style.cssText = 'position:absolute;left:0;right:0;bottom:0;display:none;align-items:center;justify-content:space-between;gap:12px;padding:8px 12px;background:#262626;color:#e5e5e5;font-size:13px;';
var bannerText = document.createElement('span');
bannerText.textContent = 'This terminal session ended.';
var restartBtn = document.createElement('button');
restartBtn.textContent = 'Restart';
restartBtn.style.cssText = 'cursor:pointer;border:0;border-radius:6px;padding:4px 12px;background:#3b82f6;color:#fff;font-size:12px;';
banner.appendChild(bannerText);
banner.appendChild(restartBtn);
root.appendChild(banner);

var term = new XTerm({ convertEol: true, theme: { background: '#171717' } });
var fitAddon = new FitAddon();
term.loadAddon(fitAddon);
term.open(host);

var state = { disposed: false, exited: false, resizeTimer: 0 };

function updateBanner() { banner.style.display = state.exited ? 'flex' : 'none'; }

function doFit(forceReclaim) {
  if (state.disposed || !host.offsetParent) return;
  var dims = fitAddon.proposeDimensions();
  if (!dims || !dims.cols || !dims.rows) return;
  var changed = dims.cols !== term.cols || dims.rows !== term.rows;
  if (changed) term.resize(dims.cols, dims.rows);
  if (changed || forceReclaim) {
    try { bridge.resize(term.cols, term.rows, INSTALL_ID); } catch (e) {}
  }
}

function applyRestore(restore) {
  if (state.disposed || !restore) return;
  if (restore.buffer && restore.buffer.length) {
    term.resize(restore.size.cols, restore.size.rows);
    term.write(restore.buffer.join(''));
  }
  state.exited = !!restore.exited;
  updateBanner();
  window.requestAnimationFrame(function () { doFit(true); });
}

function doRestart() {
  if (state.disposed) return;
  term.reset();
  state.exited = false; updateBanner();
  bridge.restart(INSTALL_ID).then(applyRestore).catch(function () {});
}
restartBtn.addEventListener('click', doRestart);

term.onData(function (d) { try { bridge.write(d, INSTALL_ID); } catch (e) {} });
var offOutput = bridge.onOutput(function (msg) {
  if (state.disposed) return;
  if (state.exited) { state.exited = false; updateBanner(); }
  term.write(msg);
});
var offExited = bridge.onExited(function () {
  if (state.disposed) return;
  state.exited = true; updateBanner();
});

var ro = new ResizeObserver(function () {
  if (state.resizeTimer) clearTimeout(state.resizeTimer);
  state.resizeTimer = setTimeout(function () { doFit(false); }, 50);
});
ro.observe(root);

window.addEventListener('beforeunload', function () {
  state.disposed = true;
  try { offOutput && offOutput(); } catch (e) {}
  try { offExited && offExited(); } catch (e) {}
  try { ro.disconnect(); } catch (e) {}
  try { bridge.unsubscribe(INSTALL_ID); } catch (e) {}
  try { term.dispose(); } catch (e) {}
});

bridge.subscribe(INSTALL_ID).then(function (restore) {
  if (state.disposed) return;
  if (restore && restore.exited) doRestart();
  else applyRestore(restore);
  window.requestAnimationFrame(function () { doFit(true); });
}).catch(function () {});
`

// Track open pop-outs per installation so a second click on the inline
// button focuses the existing window instead of spawning a duplicate.
const popoutsByInstallation = new Map<string, BrowserWindow>()

export async function openTerminalPopout(installationId: string): Promise<void> {
  const existing = popoutsByInstallation.get(installationId)
  if (existing && !existing.isDestroyed()) {
    existing.focus()
    return
  }

  // Best-effort label using the install's user-facing name; falls back
  // to a generic title when the lookup fails. Lookup is async so the
  // IPC handler awaits this whole call.
  let label = 'Comfy Terminal'
  try {
    const inst = await installations.get(installationId)
    if (inst?.name) label = `Comfy Terminal — ${inst.name}`
  } catch {
    // installations registry not ready; keep the generic label
  }

  const win = new BrowserWindow({
    width: 800,
    height: 480,
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
