/**
 * Stopgap injection of an interactive "Terminal" bottom-panel tab into the
 * served ComfyUI frontend, for the window between our frontend/backend terminal
 * PRs landing and a stable release shipping them.
 *
 * It is injected (via `webContents.executeJavaScript`) only for STANDALONE
 * installs whose ComfyUI does not yet advertise the `supports_terminal` feature
 * flag — i.e. exactly when the real, flag-gated frontend tab cannot appear, so
 * there is never a duplicate. Delete this module (and its call site in
 * `attach.ts`) once stable ships the official tab.
 *
 * The transport is the already-injected `window.__comfyDesktop2.Terminal`
 * bridge (see `comfyPreload.ts`). xterm isn't exposed on `window.comfyAPI`, so
 * we inline the installed `@xterm/xterm` + `@xterm/addon-fit` UMD builds (read
 * from node_modules at runtime; works in dev and inside asar) and register a
 * `type: 'custom'` tab that renders a vanilla xterm view mirroring the real
 * CommandTerminal behavior (focus-reclaims the shared PTY size, restart banner,
 * clear-on-output revives the session, refit-after-restore).
 */

import { createRequire } from 'module'
import { readFileSync } from 'fs'

// The main bundle is CommonJS, so `__filename` is the right anchor for
// require.resolve (import.meta.url is unavailable there).
const require = createRequire(__filename)

let cachedScript: string | null = null

function readPackageFile(id: string): string {
  return readFileSync(require.resolve(id), 'utf8')
}

function stripSourceMapComment(source: string): string {
  return source.replace(/\n?\/\/# sourceMappingURL=.*$/u, '')
}

/**
 * Vanilla browser code that registers and renders the stopgap terminal tab.
 * Runs in the ComfyUI page main world; `XTerm` and `FitAddon` are the UMD
 * exports captured above it, and `window.__comfyDesktop2.Terminal` is the host
 * bridge. Kept as a string (not a stringified function) to stay consistent with
 * the other injected scripts and to avoid bundler/`toString` surprises.
 */
const TERMINAL_TAB_MAIN_JS = `
var STATE = window.__comfyDesktopTerminalStopgap;
var mounted = null;

function destroyTerminal() {
  if (!mounted) return;
  var m = mounted;
  mounted = null;
  m.disposed = true;
  try { if (m.onData) m.onData.dispose(); } catch (e) {}
  try { if (m.offOutput) m.offOutput(); } catch (e) {}
  try { if (m.offExited) m.offExited(); } catch (e) {}
  try { if (m.host && m.onFocus) m.host.removeEventListener('focusin', m.onFocus); } catch (e) {}
  try { if (m.ro) m.ro.disconnect(); } catch (e) {}
  if (m.resizeTimer) { clearTimeout(m.resizeTimer); }
  try { window.__comfyDesktop2.Terminal.unsubscribe(); } catch (e) {}
  try { if (m.term) m.term.dispose(); } catch (e) {}
  try { if (m.container) m.container.innerHTML = ''; } catch (e) {}
}

function renderTerminal(container) {
  destroyTerminal();
  var bridge = window.__comfyDesktop2 && window.__comfyDesktop2.Terminal;
  if (!bridge) return;

  container.style.position = 'relative';
  container.style.width = '100%';
  container.style.height = '100%';
  container.style.minWidth = '0';
  container.style.overflow = 'hidden';
  container.style.background = '#171717';

  var host = document.createElement('div');
  host.style.position = 'absolute';
  host.style.inset = '0';
  host.style.padding = '8px';
  container.appendChild(host);

  var banner = document.createElement('div');
  banner.style.cssText = 'position:absolute;left:0;right:0;bottom:0;display:none;align-items:center;justify-content:space-between;gap:12px;padding:8px 12px;background:#262626;color:#e5e5e5;font-size:13px;';
  var bannerText = document.createElement('span');
  bannerText.textContent = 'This terminal session ended.';
  var restartBtn = document.createElement('button');
  restartBtn.textContent = 'Restart';
  restartBtn.style.cssText = 'cursor:pointer;border:0;border-radius:6px;padding:4px 12px;background:#3b82f6;color:#fff;font-size:12px;';
  banner.appendChild(bannerText);
  banner.appendChild(restartBtn);
  container.appendChild(banner);

  var term = new XTerm({ convertEol: true, theme: { background: '#171717' } });
  var fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(host);

  var m = {
    disposed: false, container: container, host: host, term: term,
    fitAddon: fitAddon, exited: false, resizeTimer: 0,
    onData: null, offOutput: null, offExited: null, onFocus: null, ro: null
  };
  mounted = m;

  function updateBanner() { banner.style.display = m.exited ? 'flex' : 'none'; }

  // Re-fit to our own container and (re)claim the shared PTY size. forceReclaim
  // pushes even when our dims are unchanged, because the launcher settings
  // console may have resized the one PTY out from under us.
  function doFit(forceReclaim) {
    if (m.disposed || !host.offsetParent) return;
    var dims = fitAddon.proposeDimensions();
    if (!dims || !dims.cols || !dims.rows) return;
    var changed = dims.cols !== term.cols || dims.rows !== term.rows;
    if (changed) term.resize(dims.cols, dims.rows);
    if (changed || forceReclaim) { try { bridge.resize(term.cols, term.rows); } catch (e) {} }
  }

  function applyRestore(restore) {
    if (m.disposed || !restore) return;
    if (restore.buffer && restore.buffer.length) {
      term.resize(restore.size.cols, restore.size.rows);
      term.write(restore.buffer.join(''));
    }
    m.exited = !!restore.exited;
    updateBanner();
    window.requestAnimationFrame(function () { doFit(true); });
  }

  m.onData = term.onData(function (d) { try { bridge.write(d); } catch (e) {} });
  m.offOutput = bridge.onOutput(function (msg) {
    if (m.disposed) return;
    if (m.exited) { m.exited = false; updateBanner(); }
    term.write(msg);
  });
  m.offExited = bridge.onExited(function () {
    if (m.disposed) return;
    m.exited = true; updateBanner();
  });
  m.onFocus = function () { doFit(true); };
  host.addEventListener('focusin', m.onFocus);

  m.ro = new ResizeObserver(function () {
    if (m.resizeTimer) clearTimeout(m.resizeTimer);
    m.resizeTimer = setTimeout(function () { doFit(false); }, 50);
  });
  m.ro.observe(container);

  function doRestart() {
    if (m.disposed) return;
    term.reset();
    m.exited = false; updateBanner();
    bridge.restart().then(applyRestore).catch(function () {});
  }
  restartBtn.addEventListener('click', doRestart);

  bridge.subscribe().then(function (restore) {
    if (m.disposed) return;
    if (restore && restore.exited) doRestart();
    else applyRestore(restore);
    // Force an immediate fit; ResizeObserver may not fire on first mount if
    // the container's layout was already settled before we attached. Decides
    // whether the user sees a 0×0 invisible xterm or an actual 80×24 prompt.
    window.requestAnimationFrame(function () { doFit(true); });
  }).catch(function () {});
}

// Dedupe guard. The frontend ships a native flag-gated 'command-terminal'
// bottom-panel tab via the companion ComfyUI_frontend PR; when that lands
// it registers itself before we tick. Bail out if we see it so the user
// never gets two tabs with the same id. Defensive over both shapes that
// ComfyUI exposes (an extensions array, and a future-proof tab registry).
function alreadyHasTerminalTab(app) {
  try {
    var exts = (app && app.extensions) || [];
    for (var i = 0; i < exts.length; i++) {
      var ext = exts[i] || {};
      if (ext.name === 'Comfy.Desktop.TerminalStopgap') continue;
      var tabs = ext.bottomPanelTabs || [];
      for (var j = 0; j < tabs.length; j++) {
        if (tabs[j] && tabs[j].id === 'command-terminal') return true;
      }
    }
  } catch (e) {}
  try {
    var registry =
      app && (app.bottomPanelTabRegistry || (app.workbench && app.workbench.bottomPanelTabRegistry));
    if (registry && typeof registry.get === 'function' && registry.get('command-terminal')) return true;
  } catch (e) {}
  return false;
}

function waitForRegister(timeoutMs) {
  var startedAt = Date.now();
  (function tick() {
    if (STATE.registered) return;
    var app = window.comfyAPI && window.comfyAPI.app && window.comfyAPI.app.app;
    var reg = app && app.registerExtension;
    if (typeof reg === 'function') {
      // Native frontend tab already mounted — leave it alone.
      if (alreadyHasTerminalTab(app)) {
        STATE.registered = true;
        return;
      }
      try {
        reg.call(app, {
          name: 'Comfy.Desktop.TerminalStopgap',
          bottomPanelTabs: [{
            id: 'command-terminal',
            title: 'Terminal',
            type: 'custom',
            render: renderTerminal,
            destroy: destroyTerminal
          }]
        });
        STATE.registered = true;
        startTerminalTabPopoutInjector();
      } catch (e) {}
      return;
    }
    if (Date.now() - startedAt > timeoutMs) return;
    setTimeout(tick, 100);
  })();
}

// Inject a small ↗ "open in new window" button onto the Terminal tab's
// header (the bottom-panel tab strip), positioned right after the
// "Terminal" label. Vue re-renders that strip on tab switches, so we
// keep a MutationObserver running for the page's lifetime and re-add
// the button whenever the previous one disappears. Idempotent: each
// pass checks for our existing button before re-injecting.
function startTerminalTabPopoutInjector() {
  if (STATE.tabBarInjectorStarted) return;
  STATE.tabBarInjectorStarted = true;

  // Find the bottom-panel header strip — the row that contains both
  // "Terminal" and "Logs" tab labels. Lock onto its close (✕) button
  // (the only unique landmark with a stable accessibility label), then
  // walk up to the smallest ancestor that ALSO has both tabs as leaf
  // descendants. From there we can enumerate the tab buttons.
  function findBottomPanelHeader() {
    var closes = document.querySelectorAll(
      'button[aria-label="Close"], [role="button"][aria-label="Close"], button[title="Close"]'
    );
    for (var i = 0; i < closes.length; i++) {
      var close = closes[i];
      if (!close) continue;
      if (close.classList && close.classList.contains('__comfy-desktop-popout-btn')) continue;
      var testid = (close.getAttribute && close.getAttribute('data-testid')) || '';
      if (/minimap/i.test(testid)) continue;
      var anc = close.parentElement;
      for (var depth = 0; depth < 6 && anc; depth++) {
        if (containsLeafText(anc, 'Terminal') && containsLeafText(anc, 'Logs')) {
          return anc;
        }
        anc = anc.parentElement;
      }
    }
    return null;
  }

  function containsLeafText(root, target) {
    if (!root || !root.querySelectorAll) return false;
    var leaves = root.querySelectorAll('*');
    var pattern = new RegExp('^' + target + '$', 'i');
    for (var i = 0; i < leaves.length; i++) {
      var e = leaves[i];
      if (!e || e.children.length > 0) continue;
      var txt = (e.textContent || '').trim();
      if (pattern.test(txt)) return true;
    }
    return false;
  }

  // Inside the bottom-panel header, find each tab BUTTON by walking up
  // from the leaf that holds the label text. We want the smallest
  // interactive ancestor (button / role=tab / clickable div) so the
  // popout icon sits in the same row as the label without disrupting
  // the tab's own hit area.
  function findTabButton(headerRoot, labelText) {
    if (!headerRoot) return null;
    var leaves = headerRoot.querySelectorAll('*');
    var pattern = new RegExp('^' + labelText + '$', 'i');
    for (var i = 0; i < leaves.length; i++) {
      var leaf = leaves[i];
      if (!leaf || leaf.children.length > 0) continue;
      if (leaf.classList && leaf.classList.contains('__comfy-desktop-popout-btn')) continue;
      var txt = (leaf.textContent || '').trim();
      if (!pattern.test(txt)) continue;
      var cur = leaf;
      for (var d = 0; d < 6 && cur && cur.parentElement; d++) {
        var p = cur.parentElement;
        if (p === headerRoot) break;
        var role = p.getAttribute && p.getAttribute('role');
        var tag = (p.tagName || '').toLowerCase();
        var cls = (p.className && p.className.baseVal != null ? p.className.baseVal : p.className) || '';
        if (role === 'tab' || tag === 'button' || tag === 'a' || /tab/i.test(String(cls))) {
          return p;
        }
        cur = p;
      }
      // Fall back to the leaf's parent — better than nothing.
      return leaf.parentElement || leaf;
    }
    return null;
  }

  function findInsertionPoint() {
    var close = findCloseButtonNearTerminalAndLogs();
    if (close && close.parentElement) {
      return { parent: close.parentElement, before: close };
    }
    return null;
  }

  function makePopoutButton(kind) {
    var btn = document.createElement('button');
    btn.className = '__comfy-desktop-popout-btn';
    btn.setAttribute('data-popout-kind', kind);
    btn.type = 'button';
    var ariaLabel = kind === 'terminal'
      ? 'Open terminal in a new window'
      : 'Open logs in a new window';
    btn.title = 'Open in a new window';
    btn.setAttribute('aria-label', ariaLabel);
    btn.style.cssText =
      'display:inline-flex;align-items:center;justify-content:center;' +
      'width:18px;height:18px;margin-left:6px;padding:0;border:0;' +
      'background:transparent;color:currentColor;cursor:pointer;' +
      'opacity:0.55;border-radius:4px;transition:opacity 120ms ease, background 120ms ease;' +
      'vertical-align:middle;';
    btn.innerHTML =
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2.4" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M14 3h7v7"/><path d="M21 3l-9 9"/>' +
      '<path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>' +
      '</svg>';
    btn.addEventListener('mouseenter', function () {
      btn.style.opacity = '1';
      btn.style.background = 'rgba(255,255,255,0.08)';
    });
    btn.addEventListener('mouseleave', function () {
      btn.style.opacity = '0.55';
      btn.style.background = 'transparent';
    });
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (kind === 'terminal') {
        try { window.__comfyDesktop2.Terminal.openPopout(); } catch (err) {}
      } else {
        try { window.__comfyDesktop2.Logs.openPopout(); } catch (err) {}
      }
    });
    return btn;
  }

  function injectIntoTab(headerRoot, label, kind) {
    var tab = findTabButton(headerRoot, label);
    if (!tab) return false;
    // Don't double-inject if our previous pass already added a button.
    var existing = tab.querySelector('.__comfy-desktop-popout-btn[data-popout-kind="' + kind + '"]');
    if (existing) return true;
    tab.appendChild(makePopoutButton(kind));
    return true;
  }

  function tryInject() {
    var header = findBottomPanelHeader();
    if (!header) return;
    injectIntoTab(header, 'Terminal', 'terminal');
    injectIntoTab(header, 'Logs', 'logs');
  }

  // Initial attempt + periodic retry while the page is settling.
  tryInject();
  var settleTries = 0;
  var settleInterval = setInterval(function () {
    settleTries++;
    tryInject();
    if (settleTries > 50) clearInterval(settleInterval);
  }, 200);

  // Persistent observer — re-add the button whenever Vue re-renders
  // the tab strip. Throttled by re-checking inside tryInject().
  var observer = new MutationObserver(function () { tryInject(); });
  observer.observe(document.body, { childList: true, subtree: true });
}

waitForRegister(30000);
`

/**
 * Build the self-contained injection script. Memoized: the UMD payloads are
 * large and never change at runtime.
 */
export function getComfyTerminalContentScript(): string {
  if (cachedScript) return cachedScript

  const xtermJs = stripSourceMapComment(readPackageFile('@xterm/xterm/lib/xterm.js'))
  const fitJs = stripSourceMapComment(readPackageFile('@xterm/addon-fit/lib/addon-fit.js'))
  const css = readPackageFile('@xterm/xterm/css/xterm.css')

  cachedScript =
    `(function () {\n` +
    `'use strict';\n` +
    `if (typeof window === 'undefined' || !window.__comfyDesktop2 || !window.__comfyDesktop2.Terminal) return;\n` +
    `if (window.__comfyDesktopTerminalStopgap) return;\n` +
    `window.__comfyDesktopTerminalStopgap = { started: true, registered: false, tabBarInjectorStarted: false };\n` +
    // Capture the UMD modules into locals so we never touch window.Terminal.
    `var __xt = { exports: {} };\n` +
    `(function () { var module = __xt; var exports = __xt.exports;\n${xtermJs}\n}).call(window);\n` +
    `var __fit = { exports: {} };\n` +
    `(function () { var module = __fit; var exports = __fit.exports; var self = window;\n${fitJs}\n}).call(window);\n` +
    `var XTerm = __xt.exports && __xt.exports.Terminal;\n` +
    `var FitAddon = __fit.exports && __fit.exports.FitAddon;\n` +
    `if (!XTerm || !FitAddon) return;\n` +
    `(function () {\n` +
    `var s = document.getElementById('__comfyDesktopXtermCss');\n` +
    `if (!s) { s = document.createElement('style'); s.id = '__comfyDesktopXtermCss'; s.textContent = ${JSON.stringify(css)}; (document.head || document.documentElement).appendChild(s); }\n` +
    `})();\n` +
    TERMINAL_TAB_MAIN_JS +
    `})();\n`

  return cachedScript
}
