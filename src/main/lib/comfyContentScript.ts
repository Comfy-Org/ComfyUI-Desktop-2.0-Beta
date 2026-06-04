/**
 * Returns a self-contained JavaScript string to be injected into ComfyUI
 * webview pages via webContents.executeJavaScript().
 *
 * The script intercepts model downloads triggered by the "Missing Models"
 * dialog or the right side panel Errors tab and routes them through the
 * Launcher's download manager (exposed as window.__comfyDesktop2 by
 * comfyPreload.ts) so that model files land in the correct shared-models
 * subdirectory.
 *
 * It supports the legacy dialog (PrimeVue Listbox with class
 * "comfy-missing-models"), the newer redesigned dialog, and the right side
 * panel's Missing Models error section.
 *
 * Download progress is surfaced via the title-bar downloads tray (see
 * `comfyTitleBarPreload.ts` / `TitleBarApp.vue` /
 * `comfyTitlePopup/DownloadsView.vue`) so the affordance lives in
 * Launcher chrome rather than inside ComfyUI's page surface. What
 * stays here is exactly what must run inside the ComfyUI page:
 *   - Missing-models dialog / errors-tab scraping (we need to read
 *     the dialog DOM to know which model directory each download
 *     should land in).
 *   - The `<a>.click()` interception that re-routes the download
 *     through `window.__comfyDesktop2.downloadModel` (the
 *     `directory` hint comes from the scraped cache).
 *   - The remote/cloud WebSocket auto-download intercept (workflow
 *     outputs from a remote ComfyUI server are downloaded to the
 *     local output dir without user action).
 */
export function getModelDownloadContentScript(): string {
  return `(function() {
  'use strict';
  if (window.__comfyDesktop2Injected || typeof window.__comfyDesktop2 === 'undefined') return;
  window.__comfyDesktop2Injected = true;

  var modelCache = {};
  var modelNameCache = {};

  // ---- Badge-text → directory reverse map (new dialog) ----
  var BADGE_TO_DIR = {
    'VAE': 'vae',
    'DIFFUSION': 'diffusion_models',
    'TEXT ENCODER': 'text_encoders',
    'LORA': 'loras',
    'CHECKPOINT': 'checkpoints'
  };

  function reverseBadge(text) {
    return BADGE_TO_DIR[text] || text.toLowerCase().replace(/\\s+/g, '_');
  }

  // ---- Scrape the legacy dialog (.comfy-missing-models) ----
  function scrapeLegacyDialog() {
    var items = document.querySelectorAll('.comfy-missing-models .p-listbox-option');
    for (var i = 0; i < items.length; i++) {
      var span = items[i].querySelector('span[title]');
      if (!span) continue;
      var url = span.getAttribute('title');
      if (!url || url.indexOf('http') !== 0) continue;
      var text = span.textContent.trim();
      var sep = text.indexOf(' / ');
      if (sep === -1) continue;
      var directory = text.substring(0, sep).trim();
      modelCache[url] = directory;
    }
  }

  // ---- Scrape the redesigned dialog (badge-based) ----
  function scrapeNewDialog() {
    var dialog = document.querySelector(
      '[aria-labelledby="global-missing-models-warning"]'
    );
    if (!dialog) return;

    // Strategy 1: per-model buttons with URL in title (older frontend versions)
    var buttons = dialog.querySelectorAll('button[title]');
    for (var i = 0; i < buttons.length; i++) {
      var url = buttons[i].getAttribute('title');
      if (!url || url.indexOf('http') !== 0) continue;
      if (modelCache[url]) continue;
      var row =
        buttons[i].closest('[class*="justify-between"]') ||
        buttons[i].closest('[class*="items-center"]');
      if (!row) continue;
      var badge = row.querySelector('[class*="rounded-full"]');
      if (badge) {
        modelCache[url] = reverseBadge(badge.textContent.trim());
      }
    }

    // Strategy 2: model name spans paired with badges (newer frontend versions
    // that may only have a "Download all" button instead of per-model buttons)
    var rows = dialog.querySelectorAll('[class*="justify-between"]');
    for (var r = 0; r < rows.length; r++) {
      var nameSpan = rows[r].querySelector('span[title]');
      var badge2 = rows[r].querySelector('[class*="rounded-full"]');
      if (!nameSpan || !badge2) continue;
      var name = nameSpan.getAttribute('title');
      if (!name) continue;
      var dir = reverseBadge(badge2.textContent.trim().toUpperCase());
      if (dir) {
        modelNameCache[name] = dir;
      }
    }
  }

  // ---- Scrape the right side panel Errors tab (Missing Models section) ----
  function scrapeErrorsTab() {
    var panel = document.querySelector('[data-testid="properties-panel"]');
    if (!panel) return;

    // Find category containers: each holds a directory header + model rows.
    // MissingModelCard.vue renders these with a distinctive class set.
    var categories = panel.querySelectorAll(
      '.flex.w-full.flex-col.border-t.border-interface-stroke.py-2,' +
      '.flex.w-full.flex-col.border-t.border-interface-stroke.py-2.first\\\\:border-t-0'
    );
    // Fallback: also match first category which has first:border-t-0 first:pt-0
    if (categories.length === 0) {
      categories = panel.querySelectorAll(
        '[class*="flex"][class*="w-full"][class*="flex-col"][class*="border-t"][class*="py-2"]'
      );
    }

    for (var c = 0; c < categories.length; c++) {
      var cat = categories[c];
      // Extract directory name from the category header span
      // e.g. "clip_vision (1)" → "clip_vision"
      var headerSpan = cat.querySelector('p[class*="text-destructive-background-hover"] span');
      if (!headerSpan) continue;
      var headerText = headerSpan.textContent.trim();
      // Strip the trailing count e.g. " (1)" or " (3)"
      var dirMatch = headerText.match(/^(.+?)\\s*\\(\\d+\\)\\s*$/);
      var directory = dirMatch ? dirMatch[1].trim() : headerText;
      if (!directory) continue;

      // Find all model name elements within this category
      var modelNames = cat.querySelectorAll('p[title][class*="text-foreground"]');
      for (var m = 0; m < modelNames.length; m++) {
        var name = modelNames[m].getAttribute('title');
        if (name && !modelNameCache[name]) {
          modelNameCache[name] = directory;
        }
      }
    }
  }

  var dialogWasOpen = false;
  var errorsTabWasOpen = false;

  function updateMissingModelsCache() {
    var legacyOpen = !!document.querySelector('.comfy-missing-models');
    var newOpen = !!document.querySelector('[aria-labelledby="global-missing-models-warning"]');
    var isOpen = legacyOpen || newOpen;

    // Check if the right side panel Errors tab has missing models
    var panel = document.querySelector('[data-testid="properties-panel"]');
    var errorsTabOpen = false;
    if (panel) {
      // The Missing Models section title contains "Missing Models" in a
      // span with the destructive-background-hover style, but we need a
      // more specific check: look for a download button with aria-label
      // starting with "Download " inside the panel, which only appears in
      // the missing models section.
      var downloadBtns = panel.querySelectorAll('button[aria-label^="Download "]');
      errorsTabOpen = downloadBtns.length > 0;
    }

    if (isOpen) {
      dialogWasOpen = true;
      if (legacyOpen) scrapeLegacyDialog();
      scrapeNewDialog();
    } else if (dialogWasOpen) {
      // Dialog just closed — clear dialog-sourced cache entries
      dialogWasOpen = false;
      modelCache = {};
      // Only clear modelNameCache if errors tab is also not providing data
      if (!errorsTabOpen) {
        modelNameCache = {};
      }
    }

    if (errorsTabOpen) {
      errorsTabWasOpen = true;
      scrapeErrorsTab();
    } else if (errorsTabWasOpen) {
      errorsTabWasOpen = false;
      // Only clear modelNameCache if dialog is also not providing data
      if (!dialogWasOpen) {
        modelNameCache = {};
      }
    }
  }

  // ---- MutationObserver: populate cache when the dialog or errors tab appears ----
  function startObserver() {
    var target = document.body || document.documentElement;
    var observer = new MutationObserver(function() { updateMissingModelsCache(); });
    observer.observe(target, { childList: true, subtree: true });
  }

  // Only observe missing models UI and intercept downloads for local sessions
  if (!window.__comfyDesktop2Remote) {
    if (document.body) {
      startObserver();
    } else {
      document.addEventListener('DOMContentLoaded', startObserver);
    }
  }

  // ---- Override document.createElement to intercept <a>.click() ----
  // For remote/cloud sessions model downloads should not be captured (no local models dir).
  var origCreate = document.createElement.bind(document);
  if (!window.__comfyDesktop2Remote) {
    document.createElement = function(tag, options) {
      var el = origCreate(tag, options);
      if (typeof tag === 'string' && tag.toLowerCase() === 'a' &&
          (Object.keys(modelCache).length > 0 || Object.keys(modelNameCache).length > 0)) {
        var origClick = el.click;
        el.click = function() {
          if (this.download && this.href && window.__comfyDesktop2) {
            var cleanName = this.download.split('?')[0];
            var directory = modelCache[this.href] || modelNameCache[cleanName];
            if (directory) {
              window.__comfyDesktop2.downloadModel(
                this.href,
                cleanName,
                directory
              ).catch(function() {});
              return;
            }
          }
          return origClick.call(this);
        };
      }
      return el;
    };
  }

  // ---- Auto-download outputs for remote/cloud sessions ----
  // Intercept WebSocket messages to detect completed workflow outputs.
  // The auth token (if any) is passed to the main process which resolves
  // authenticated redirects server-side, avoiding renderer memory issues.
  if (window.__comfyDesktop2Remote && window.__comfyDesktop2 && window.__comfyDesktop2.downloadAsset) {

    function _buildViewUrl(baseUrl, item) {
      var params = 'filename=' + encodeURIComponent(item.filename);
      if (item.subfolder) params += '&subfolder=' + encodeURIComponent(item.subfolder);
      if (item.type) params += '&type=' + encodeURIComponent(item.type);
      return baseUrl + '/api/view?' + params;
    }

    function _withSubfolder(subfolder, name) {
      if (!subfolder) return name;
      // Avoid duplicating if name already starts with the subfolder
      if (name.indexOf(subfolder + '/') === 0) return name;
      return subfolder + '/' + name;
    }

    function _downloadItem(baseUrl, authToken, item) {
      if (!item || !item.filename) return;
      // Skip temporary preview outputs (PreviewImage, etc.)
      if (item.type === 'temp') return;
      var preferredName = item.display_name || null;
      var saveName = _withSubfolder(item.subfolder, preferredName || item.filename);
      var viewUrl = _buildViewUrl(baseUrl, item);
      window.__comfyDesktop2.downloadAsset(viewUrl, saveName, authToken || '').catch(function() {});
    }

    var OrigWebSocket = window.WebSocket;
    window.WebSocket = function(url, protocols) {
      var ws = protocols !== undefined ? new OrigWebSocket(url, protocols) : new OrigWebSocket(url);
      var wsUrl = typeof url === 'string' ? url : url.toString();
      var httpBase = wsUrl.replace(/^ws(s?):/, 'http$1:').replace(/\\/ws(\\?.*)?$/, '');
      // Extract auth token from WebSocket URL query params (cloud passes ?token=...)
      var _authToken = null;
      try {
        var urlObj = new URL(wsUrl);
        _authToken = urlObj.searchParams.get('token');
      } catch(e) {}

      ws.addEventListener('message', function(event) {
        if (typeof event.data !== 'string') return;
        try {
          var msg = JSON.parse(event.data);
          if (msg.type !== 'executed' || !msg.data || !msg.data.output) return;
          var output = msg.data.output;
          // Process all known output arrays: images, gifs, audio, video, 3d (SaveGLB)
          var keys = ['images', 'gifs', 'audio', 'video', '3d'];
          for (var k = 0; k < keys.length; k++) {
            var items = output[keys[k]];
            if (!items || !items.length) continue;
            for (var i = 0; i < items.length; i++) {
              _downloadItem(httpBase, _authToken, items[i]);
            }
          }
        } catch(e) {}
      });

      return ws;
    };
    window.WebSocket.prototype = OrigWebSocket.prototype;
    window.WebSocket.CONNECTING = OrigWebSocket.CONNECTING;
    window.WebSocket.OPEN = OrigWebSocket.OPEN;
    window.WebSocket.CLOSING = OrigWebSocket.CLOSING;
    window.WebSocket.CLOSED = OrigWebSocket.CLOSED;
  }
})();`
}
