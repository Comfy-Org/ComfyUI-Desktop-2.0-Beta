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
    /** Tooltip used when the in-flight queue is empty but one or more
     *  downloads have finished since the user last opened the tray.
     *  The unseen indicator clears as soon as the popup is opened. */
    downloadsCompleteUnseen:
      'no recent downloads | {n} download finished — click to review | {n} downloads finished — click to review',
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
    clearFinished: 'Clear Finished',
    clearFinishedTooltip:
      'Remove every completed, errored, or cancelled entry from the list',
    empty: 'No downloads yet',
    pause: 'Pause',
    resume: 'Resume',
    cancel: 'Cancel',
    showInFolder: 'Show in Finder',
    remove: 'Remove from list',
    viewAllInSettings: 'View All Downloads',
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
  /** Strings shared by every install-listing surface (the dashboard
   *  grid in `ChooserView.vue` and the title-bar instance-picker
   *  popover). Keep all install-list strings here so the two surfaces
   *  literally share keys — when copy needs to change, it changes in
   *  one place. */
  chooser: {
    searchPlaceholder: 'Search for and open an instance',
    noMatches: 'No instances match',
    filterAll: 'All',
    filterLocal: 'Local',
    filterCloud: 'Cloud',
    filterRemote: 'Remote',
    newInstall: 'New Install',
  },
  /** Cloud-card copy used by ChooserView's empty cloud CTA AND the
   *  instance-picker popover's empty cloud row. Mirrored from the
   *  panel-side `locales/en.json` `cloud.*` namespace so the popup
   *  process (which doesn't merge from there) can resolve them. */
  cloud: {
    label: 'Cloud',
    desc: 'Connect to Comfy Cloud for remote GPU-powered workflows.',
  },
  /** Shared relative-time labels used by both ChooserView (via the
   *  panel renderer's merged `locales/en.json`) and the title-bar
   *  instance picker popover (via this same catalog). The popup has
   *  no main-side locale merge, so the keys must be available here. */
  dashboard: {
    launchedAgo: 'Launched {time}',
    neverLaunched: 'Not launched yet',
  },
  /** Picker-only strings (right pane + section titles + a11y labels).
   *  Strings used by BOTH surfaces live under `chooser.*` above. */
  instancePicker: {
    instances: 'Instances',
    newInstance: 'New Instance',
    latestOnGithub: 'Latest on GitHub',
    open: 'Open',
    more: 'More',
    settings: 'Settings',
    snapshots: 'Snapshots',
    empty: 'Select an instance',
  },
}

export type AppLocale = typeof en
