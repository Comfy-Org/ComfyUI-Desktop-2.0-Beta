// Shared en-locale catalog imported by every renderer's vue-i18n setup.
// The popup process can only resolve against THIS catalog, so keys it uses
// must be mirrored here from the panel's locales/en.json.

export const en = {
  common: {
    close: 'Close',
    cancel: 'Cancel',
    back: 'Back',
    browse: 'Browse…',
    learnMore: 'Learn more'
  },
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
    installLocation: 'Default Install Location',
    models: 'Shared Models',
    updatesTab: 'Updates',
    checkForUpdates: 'Check for updates',
    checkingForUpdates: 'Checking…'
  },
  comfyUISettings: {
    tabStorage: 'Storage',
    storageGlobalNote: 'Changes here apply to all of your ComfyUI instances.',
    storageRestartNote:
      'Restart the application (or close and reopen) for these changes to take effect.'
  },
  statusFactPanel: {
    editName: 'Edit installation name',
    editUrl: 'Edit connection URL',
    restartToApply: 'Restart to apply'
  },
  errors: {
    invalidUrl: 'Enter a valid URL (e.g. http://localhost:8188).'
  },
  models: {
    addDir: 'Add directory',
    removeDir: 'Remove',
    removeDirTitle: 'Remove shared models directory?',
    removeDirConfirm:
      "This won't delete any files. You can re-add the directory later from this list.",
    primary: 'Primary',
    makePrimary: 'Make primary',
    moreActions: 'More actions'
  },
  tooltips: {
    instances:
      'A separate ComfyUI installation with its own version, models, and settings.',
    snapshots:
      'A saved point-in-time state of an installation (versions + custom nodes) you can restore later.',
    sharedModels:
      "Folders shared across all installations so models aren't downloaded twice. Newly downloaded models go to the primary folder. The primary folder can't be removed while it's in use — pick a different primary first.",
    modelsPrimary:
      'The primary directory is where ComfyUI saves newly downloaded models by default.',
    installDir:
      "Default parent folder suggested when creating new installations. Existing installs aren't moved."
  },
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
    feedbackTooltip: 'Send Feedback',
    downloads: 'Downloads',
    /** vue-i18n plural rule: "no plural form | singular | plural". */
    downloadsInProgress:
      'no downloads in progress | {n} download in progress | {n} downloads in progress',
    downloadsCompleteUnseen:
      'no recent downloads | {n} download finished — click to review | {n} downloads finished — click to review',
    downloadsFailedUnseen:
      'no downloads failed | {n} download failed — click to review | {n} downloads failed — click to review',
    desktopUpdateAvailable: 'Desktop Update',
    desktopUpdateDownloading: 'Downloading update…',
    desktopUpdateReady: 'Desktop Update Ready',
    desktopUpdateWithVersion: '{label} (v{version})',
    installUpdateAvailable: 'ComfyUI Update',
    installUpdateVersion: 'ComfyUI {version}',
    installUpdateShort: 'Update',
    refreshInstanceTooltip: 'Refresh',
    resetZoomTooltip: 'Reset zoom to 100%',
    pillHintTitle: 'Switch & manage instances',
    pillHintBody: 'Click here to switch instances, start a new local install, or return to the dashboard.',
    pillHintDismiss: 'Got it'
  },
  fileMenu: {
    newWindow: 'New Window',
    newInstall: 'New Install',
    addExistingInstall: 'Add Existing Install',
    loadSnapshot: 'Load Snapshot',
    globalSettings: 'Desktop Settings',
    sendFeedback: 'Send Feedback',
    returnToDashboard: 'Return to Dashboard',
    closeAllWindows: 'Close All Windows',
    exitWindow: 'Close Window',
    exitAllWindows: 'Quit Desktop',
    skipOnboarding: 'Skip Onboarding'
    // Reset Zoom is built main-side with a dynamic percentage, not via this catalog.
  },
  downloadsPopup: {
    title: 'Downloads',
    empty: 'No downloads yet',
    pause: 'Pause',
    resume: 'Resume',
    cancel: 'Cancel',
    retry: 'Retry',
    showInFolder: 'Show in Finder',
    remove: 'Remove from list',
    viewAllInSettings: 'View All Downloads',
    completed: 'Completed',
    thumbnailAlt: 'Thumbnail of {name}'
  },
  downloadsTab: {
    title: 'Downloads',
    empty: 'No downloads yet',
    emptyHint: 'Downloads will appear here.',
    filterAll: 'All',
    filterActive: 'Active',
    filterCompleted: 'Completed',
    filterErrored: 'Failed',
    filterAriaLabel: 'Status filter',
    retry: 'Retry',
    badgeFailed: 'Failed',
    badgeCancelled: 'Cancelled',
    footerActive: '{n} active',
    footerCompleted: '{n} completed',
    clearFinished: 'Clear finished'
  },
  settingsModal: {
    title: 'Settings',
    tabComfy: 'ComfyUI Settings',
    tabDirectories: 'Directories',
    tabDownloads: 'Downloads',
    tabGlobal: 'Desktop Settings'
  },
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
  actions: {
    copyInstallation: 'Copy Install',
    untrack: 'Forget'
  },
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
  dashboard: {
    launchedAgo: 'Launched {time}',
    neverLaunched: 'Not launched yet'
  },
  instancePicker: {
    instances: 'Instances',
    newInstance: 'New Instance',
    openDashboard: 'Open Dashboard',
    openDashboardHint:
      'Opens the dashboard in a new window. Your running instance keeps running.',
    latestOnGithub: 'Latest on GitHub',
    open: 'Start',
    restart: 'Restart',
    switch: 'Switch',
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
    progressCopying: 'Copying…',
    progressCopied: 'Copy complete',
    progressCopyingUpdating: 'Copying & updating…',
    progressCopiedUpdated: 'Copy complete',
    progressDeleting: 'Deleting…',
    progressDeleted: 'Deleted',
    progressRestoring: 'Restoring snapshot…',
    progressRestored: 'Snapshot restored',
    progressSavingSnapshot: 'Saving snapshot…',
    progressSnapshotSaved: 'Snapshot saved',
    progressDeletingSnapshot: 'Deleting snapshot…',
    progressSnapshotDeleted: 'Snapshot deleted',
    progressMigrating: 'Migrating…',
    progressMigrated: 'Migration complete',
    progressWorking: 'Working…',
    progressError: 'Something went wrong',
    progressCancelled: 'Cancelled',
  },
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
    nodesLabel: 'nodes',
    pkgsLabel: 'pkgs',
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
    panelIdleTitle: 'Comfy Desktop is up to date',
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
