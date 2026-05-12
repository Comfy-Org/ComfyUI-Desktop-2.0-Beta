/**
 * Shared en-locale message catalog. Imported by every renderer's
 * vue-i18n setup so the launcher / panel / title-bar / title-popup
 * webContents resolve the same keys to the same strings without each
 * having to maintain its own copy.
 *
 * Structure mirrors the surface that owns each string (e.g. `titleBar.*`
 * for things rendered inside `TitleBarApp.vue`, `downloadsPopup.*` for
 * the title-bar popup's downloads view, `fileMenu.*` for the file-menu
 * items main pushes down to the popup over IPC). Keep keys in
 * dotted-namespace form so the translator and consumer code agree.
 */

export const en = {
  common: {
    close: 'Close',
    cancel: 'Cancel',
  },
  /** Top-level so the dotted keys returned by `installTypeMetaFor`
   *  (`installType.standalone`, …) map directly without a prefix. */
  installType: {
    standalone: 'Standalone',
    cloud: 'Cloud',
    legacyDesktop: 'Legacy Desktop',
    remote: 'Remote',
    unknown: 'Unknown',
  },
  titleBar: {
    menu: 'Menu',
    feedback: 'Beta Feedback',
    feedbackTooltip: 'Send Beta Feedback',
    downloads: 'Downloads',
    /** vue-i18n plural rule: "no plural form | singular | plural". */
    downloadsInProgress:
      'no downloads in progress | {n} download in progress | {n} downloads in progress',
    desktopUpdateAvailable: 'Desktop Update Available',
    desktopUpdateDownloading: 'Downloading update…',
    desktopUpdateReady: 'Desktop Update Ready',
    desktopUpdateWithVersion: '{label} (v{version})',
    installUpdateAvailable: 'Update available',
    installUpdateVersion: 'Update {version}',
  },
  fileMenu: {
    newWindow: 'New Window',
    newInstall: 'New Install',
    addExistingInstall: 'Add Existing Install',
    loadSnapshot: 'Load Snapshot',
    settings: 'Settings',
    sendFeedback: 'Send Beta Feedback',
    returnToDashboard: 'Return to Dashboard',
    closeAllWindows: 'Close All Windows',
    skipOnboarding: 'Skip Onboarding',
    /* Reset Zoom carries a dynamic percentage in the label and is
     * built main-side without going through this catalog — kept as a
     * raw `label` on the menu item rather than `labelKey`. */
  },
  downloadsPopup: {
    title: 'Downloads',
    clearFinished: 'Clear finished',
    clearFinishedTooltip:
      'Remove every completed, errored, or cancelled entry from the list',
    empty: 'No downloads yet',
    pause: 'Pause',
    resume: 'Resume',
    cancel: 'Cancel',
    showInFolder: 'Show in folder',
    remove: 'Remove from list',
    viewAllInSettings: 'View all in Settings…',
    completed: 'Completed',
  },
  /** Settings → Downloads tab — superset of the popup view with a
   *  status filter and a different empty placeholder. Action labels
   *  (pause / resume / cancel / show-in-folder / remove) are shared
   *  with `downloadsPopup.*`. */
  downloadsTab: {
    title: 'Downloads',
    empty: 'No downloads to show',
    filterAll: 'All',
    filterActive: 'Active',
    filterCompleted: 'Completed',
    filterErrored: 'Errored',
    filterAriaLabel: 'Status filter',
  },
  settingsModal: {
    title: 'Settings',
    tabComfy: 'ComfyUI Settings',
    tabDirectories: 'Directories',
    tabDownloads: 'Downloads',
    tabGlobal: 'Global Settings',
  },
}

export type AppLocale = typeof en
