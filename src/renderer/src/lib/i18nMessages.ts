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
    back: 'Back',
    browse: 'Browse…',
    learnMore: 'Learn more'
  },
  /** Global Settings view (rendered inside the title-popup process via
   *  `comfyTitlePopup/GlobalSettingsView.vue`). The corresponding keys
   *  live in `locales/en.json` for the main panel renderer; mirror the
   *  subset used by the popup's DirCard / SettingField / SettingsSections
   *  here because this catalog is the only source the popup webContents
   *  can resolve against. */
  settings: {
    open: 'Open',
    general: 'General',
    preferences: 'Preferences',
    privacy: 'Privacy',
    community: 'Community',
    cache: 'Cache',
    advanced: 'Advanced',
    platform: 'Platform',
    storageTab: 'Storage',
    sharedDirectories: 'Shared Directories',
    models: 'Shared Models',
    updatesTab: 'Updates',
    checkForUpdates: 'Check for updates',
    checkingForUpdates: 'Checking…'
  },
  /** Keys consumed by the picker-side Storage tab (StoragePane.vue),
   *  duplicated here so the popup-scoped i18n catalog used in tests
   *  resolves them too. Source of truth for the live app is
   *  `locales/en.json`. */
  comfyUISettings: {
    tabStorage: 'Storage',
    storageGlobalNote: 'Changes here apply to all of your ComfyUI instances.',
    storageRestartNote:
      'Restart the application (or close and reopen) for these changes to take effect.'
  },
  models: {
    addDir: 'Add directory',
    removeDir: 'Remove',
    removeDirTitle: 'Remove shared models directory?',
    removeDirConfirm:
      "This won't delete any files. You can re-add the directory later from this list.",
    primary: 'Primary',
    default: 'Default',
    makePrimary: 'Make primary',
    moreActions: 'More actions'
  },
  tooltips: {
    sharedModels:
      "Folders shared across all installations so models aren't downloaded twice. Newly downloaded models go to the primary folder. The system default folder is always kept and can't be removed, and the primary folder can't be removed while it's in use — pick a different primary first.",
    modelsPrimary:
      'The primary directory is where ComfyUI saves newly downloaded models by default.',
    modelsDefault:
      'The system default directory. This path is created automatically and cannot be removed.'
  },
  /** Top-level so the dotted keys returned by `installTypeMetaFor`
   *  (`installType.standalone`, …) map directly without a prefix. */
  installType: {
    standalone: 'Standalone',
    cloud: 'Cloud',
    legacyDesktop: 'Legacy Desktop',
    remote: 'Remote',
    unknown: 'Unknown'
  },
  titleBar: {
    menu: 'Menu',
    feedback: 'Feedback',
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
    desktopUpdateAvailable: 'Desktop Update',
    desktopUpdateDownloading: 'Downloading update…',
    desktopUpdateReady: 'Desktop Update Ready',
    desktopUpdateWithVersion: '{label} (v{version})',
    installUpdateAvailable: 'ComfyUI Update',
    installUpdateVersion: 'ComfyUI {version}',
    installUpdateShort: 'Update'
  },
  fileMenu: {
    newWindow: 'New Window',
    newInstall: 'New Install',
    addExistingInstall: 'Add Existing Install',
    loadSnapshot: 'Load Snapshot',
    globalSettings: 'Desktop Settings',
    sendFeedback: 'Send Beta Feedback',
    returnToDashboard: 'Return to Dashboard',
    closeAllWindows: 'Close All Windows',
    exitWindow: 'Close Window',
    exitAllWindows: 'Quit ComfyUI',
    skipOnboarding: 'Skip Onboarding'
    /* Reset Zoom carries a dynamic percentage in the label and is
     * built main-side without going through this catalog — kept as a
     * raw `label` on the menu item rather than `labelKey`. */
  },
  downloadsPopup: {
    title: 'Downloads',
    empty: 'No downloads yet',
    pause: 'Pause',
    resume: 'Resume',
    cancel: 'Cancel',
    showInFolder: 'Show in Finder',
    remove: 'Remove from list',
    viewAllInSettings: 'View All Downloads',
    completed: 'Completed'
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
    filterErrored: 'Failed',
    filterAriaLabel: 'Status filter'
  },
  settingsModal: {
    title: 'Settings',
    tabComfy: 'ComfyUI Settings',
    tabDirectories: 'Directories',
    tabDownloads: 'Downloads',
    tabGlobal: 'Desktop Settings'
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
    moreActions: 'More actions',
    menuRevealInFolder: 'Open Folder',
    menuDelete: 'Uninstall…'
  },
  /** Picker-only install-action menu labels. The corresponding keys
   *  live under `actions.*` in `locales/en.json` for the panel
   *  renderer; this picker bundle has no main-side locale merge, so
   *  the keys are mirrored here. */
  actions: {
    copyInstallation: 'Copy Install',
    untrack: 'Forget'
  },
  /** Cloud-card copy used by ChooserView's empty cloud CTA AND the
   *  instance-picker popover's empty cloud row. Mirrored from the
   *  panel-side `locales/en.json` `cloud.*` namespace so the popup
   *  process (which doesn't merge from there) can resolve them. */
  cloud: {
    label: 'Cloud',
    desc: 'Connect to Comfy Cloud for remote GPU-powered workflows.'
  },
  firstUse: {
    localModeLabel: 'Local install mode',
    localModeExpressLabel: 'Quick',
    localModeConfigureLabel: 'Configure',
    localDescRecommended:
      'Fast install with **recommended settings** — skips optional setup steps.',
    localDescRecommendedGpu:
      "Fast install tuned for **{gpu}** with recommended settings. Pick **Configure** if that's not your hardware."
  },
  /** Shared relative-time labels used by both ChooserView (via the
   *  panel renderer's merged `locales/en.json`) and the title-bar
   *  instance picker popover (via this same catalog). The popup has
   *  no main-side locale merge, so the keys must be available here. */
  dashboard: {
    launchedAgo: 'Launched {time}',
    neverLaunched: 'Not launched yet'
  },
  /** Picker-only strings (right pane + section titles + a11y labels).
   *  Strings used by BOTH surfaces live under `chooser.*` above. */
  instancePicker: {
    instances: 'Instances',
    newInstance: 'New Instance',
    latestOnGithub: 'Latest on GitHub',
    open: 'Open',
    restart: 'Restart',
    restartConfirmTitle: 'Restart this instance?',
    restartConfirmDetail:
      'Restarting will stop the running session. Any unsaved work in the workflow will be lost.',
    restartConfirmAction: 'Restart',
    more: 'More',
    settings: 'Settings',
    snapshots: 'Snapshots',
    manage: 'Manage',
    running: 'Running',
    empty: 'Select an instance',
    /** Inline background-op progress strings (cross-instance Update etc.) */
    progressCancel: 'Cancel',
    progressDone: 'Done',
    progressOpenInstance: 'Open Instance',
    progressRetry: 'Try Again',
    progressDismiss: 'Dismiss',
    progressSuccessRunning: 'Updated & relaunched',
    progressSuccessStopped: 'Update complete',
    progressSuccessSubtext: 'is ready to launch.',
    progressSuccessCountdown: 'Returning to settings in {n}…',
    progressUpdating: 'Updating…',
    progressDowngrading: 'Downgrading…',
    progressDowngraded: 'Downgrade complete',
    progressWorking: 'Working…',
    progressError: 'Something went wrong',
    progressCancelled: 'Cancelled',
  },
  /** Snapshot strings consumed by `SnapshotRow` + `formatRelative` +
   *  `triggerLabel` + `changeSummary` in the popup process. Mirrors
   *  the corresponding keys in `locales/en.json` (the panel
   *  process's catalog merged via `loadLocale()`); the popup process
   *  can only see THIS catalog so missing keys here render as raw
   *  dotted strings ("snapshots.timeHoursAgo" appearing in the UI). */
  snapshots: {
    createSnapshot: 'Create Snapshot',
    restore: 'Restore',
    delete: 'Delete',
    empty: 'No snapshots yet. Snapshots are captured automatically when ComfyUI starts.',
    current: 'Current',
    deleteConfirm: 'Delete this snapshot?',
    restoreConfirm:
      'Are you sure you want to restore this snapshot? Your current install state will be replaced.',
    // Trigger labels — `triggerLabel(trigger, t)` resolves these.
    triggerBoot: 'Boot',
    triggerRestart: 'Manager',
    triggerManual: 'Manual',
    triggerPreUpdate: 'Update',
    triggerPostUpdate: 'Updated',
    triggerPostRestore: 'Restored',
    // Relative-time strings — `formatRelative(iso, t)` resolves these.
    timeJustNow: 'Just now',
    timeMinutesAgo: '{count}m ago',
    timeHoursAgo: '{count}h ago',
    timeDaysAgo: '{count}d ago',
    // Row meta + chips.
    nodesCount: '{count} nodes',
    packagesCount: '{count} packages',
    nodeChanges: '{count} node changes',
    pipChanges: '{count} pkg changes',
    comfyuiUpdated: 'ComfyUI updated',
    channelChanged: 'Channel changed',
    added: 'Added',
    removed: 'Removed',
    changed: 'Changed'
  },
  channelCards: {
    lastChecked: 'Last checked',
    latestVersion: 'Latest',
    updateAvailable: 'Update available',
    upToDate: 'Up to date'
  },
  appUpdate: {
    download: 'Download',
    downloading: 'Downloading…',
    restartNow: 'Restart & update',
    readyBadge: 'Ready to restart',
    sectionTitle: 'Desktop updates',
    fallbackVersion: 'this update',
    panelIdleTitle: 'ComfyUI Desktop is up to date',
    panelAvailableTitle: 'Update {version} available',
    panelReadyTitle: 'Update {version} ready to install',
    panelDownloadingTitle: 'Downloading update {version}…',
    installedLabel: 'Installed {version}',
    lastCheckedLabel: 'Last checked {time}',
    latestLabel: 'Latest {version}',
    systemManagedNote: 'Updates for this install are delivered through your system package manager.'
  },
  update: {
    debManagedShort: 'System-managed updates'
  }
}

export type AppLocale = typeof en
