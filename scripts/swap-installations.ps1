<#
.SYNOPSIS
  Manipulate the launcher's installations.json / settings.json for QA.

.DESCRIPTION
  One tool covers three needs:

    1. Snapshot profiles (save / load / list / delete)
         Stored under "<data>\test-profiles\" so you can flip between
         configurations (multi-install, primary-only, etc.).

    2. First-use takeover scenarios (first-use <scenario>)
         Flips firstUseCompleted in settings.json and optionally seeds
         installations.json so the takeover re-runs in a chosen state.
         firstUseDetection reads installations.json to compute
         { skipPick, hasLegacyDesktop }:

           skipPick = true  - ANY install present beyond Cloud / Legacy
                              Desktop. T&C accept skips the cloud-vs-local
                              fork and emits 'complete-skip' (bug #476
                              was Cloud being auto-launched here).
           skipPick = false - Only Cloud / Legacy Desktop. T&C accept
                              advances to the cloud-vs-local pick step.
           hasLegacyDesktop - A sourceId='desktop' install was auto-
                              tracked. Picking Local opens the migrate-
                              vs-install-new sub-step.

    3. Recover after testing (restore / merge / list-backups)
         Every mutating action drops timestamped .bak files. Plus a
         legacy installations.json.bak / settings.json.bak that is
         only written the first time, so the very first/original
         snapshot is preserved across repeat runs.

  Close the app before any mutating action - the launcher will
  overwrite settings.json / installations.json on its own save cycle.

.PARAMETER Action
  save          - Copy installations.json into a named profile.
  load          - Replace installations.json with a named profile.
  empty         - Replace installations.json with [] (fresh-user state).
  primary-only  - Keep only the current primary install (drop the rest).
  list          - List saved profiles.
  delete        - Delete a saved profile.
  first-use     - Reproduce a first-use takeover scenario (see -Name).
  restore       - Restore installations.json + settings.json from a .bak.
  merge         - Union the current installations.json with a backup
                  (entries unique by id; current wins on collisions).
  list-backups  - Show available .bak snapshots for both files.

.PARAMETER Name
  - save / load / delete: profile name.
  - first-use: scenario (status | reset | fresh | returning | legacy | complete).
  - restore / merge: optional - timestamp (yyyyMMdd-HHmmss) or 'latest'.
                     Omitted = use the original .bak (first one created).

.EXAMPLE
  # Snapshot the current real config before doing anything destructive
  .\swap-installations.ps1 save real-config

  # Reproduce first-use scenarios
  .\swap-installations.ps1 first-use status
  .\swap-installations.ps1 first-use fresh        # cloud-vs-local pick path
  .\swap-installations.ps1 first-use returning    # bug #476 scenario
  .\swap-installations.ps1 first-use legacy       # migrate sub-step path
  .\swap-installations.ps1 first-use complete     # clear the takeover

  # Recover
  .\swap-installations.ps1 list-backups
  .\swap-installations.ps1 restore                # original snapshot
  .\swap-installations.ps1 restore latest         # most recent .bak
  .\swap-installations.ps1 restore 20260601-153012
  .\swap-installations.ps1 merge                  # union original .bak into current
  .\swap-installations.ps1 load real-config       # or just swap back to a saved profile
#>

param(
  [Parameter(Mandatory, Position = 0)]
  [ValidateSet("save", "load", "empty", "primary-only", "list", "delete",
               "first-use", "restore", "merge", "list-backups")]
  [string]$Action,

  [Parameter(Position = 1)]
  [string]$Name
)

$ErrorActionPreference = "Stop"

$dataDir = Join-Path $env:APPDATA "comfyui-desktop-2"
$installationsFile = Join-Path $dataDir "installations.json"
$settingsFile = Join-Path $dataDir "settings.json"
$profilesDir = Join-Path $dataDir "test-profiles"

# Sentinel marker stamped on installs we add ourselves so subsequent
# runs can recognise + reuse them rather than stacking duplicates.
$SentinelKey = "_firstUseHelperSentinel"
$ReturningSentinel = "returning"
$LegacySentinel = "legacy"

# --- Running-app guard ----------------------------------------------------
$readOnlyActions = @("list", "list-backups")
$isMutating = -not ($readOnlyActions -contains $Action)
# 'first-use status' is also read-only - we defer that check to the handler.
if ($isMutating -and $Action -ne "first-use") {
  $appProc = Get-Process -Name "ComfyUI*" -ErrorAction SilentlyContinue
  if ($appProc) {
    Write-Warning "ComfyUI Launcher appears to be running. Close it before mutating data files."
    $reply = Read-Host "Continue anyway? (y/N)"
    if ($reply -notin @("y", "Y")) { exit 0 }
  }
}

# --- JSON helpers ---------------------------------------------------------
function Read-Json {
  param([string]$Path, $Default)
  if (-not (Test-Path $Path)) { return $Default }
  try {
    $raw = Get-Content $Path -Raw
    if ([string]::IsNullOrWhiteSpace($raw)) { return $Default }
    return $raw | ConvertFrom-Json
  } catch {
    Write-Warning "Failed to parse ${Path}: $_"
    return $Default
  }
}

function Write-Json {
  param([string]$Path, $Value)
  $dir = Split-Path -Parent $Path
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $json = ConvertTo-Json $Value -Depth 20
  [System.IO.File]::WriteAllText($Path, $json, [System.Text.UTF8Encoding]::new($false))
}

function Get-Installations {
  $data = Read-Json $installationsFile @()
  if ($null -eq $data) { return @() }
  if ($data -isnot [System.Collections.IEnumerable] -or $data -is [string]) { return @($data) }
  return @($data)
}

# --- Backup / restore plumbing -------------------------------------------
# Timestamped backups so repeat runs never clobber the previous snapshot.
# The plain `.bak` is created only the first time, so it always points at
# the genuine pre-script original even after many runs.
function Backup-File {
  param([string]$Path)
  if (-not (Test-Path $Path)) { return }
  $stamp = (Get-Date).ToString("yyyyMMdd-HHmmss")
  $stamped = "$Path.$stamp.bak"
  Copy-Item $Path $stamped -Force
  $legacy = "$Path.bak"
  if (-not (Test-Path $legacy)) { Copy-Item $Path $legacy -Force }
  Write-Host "Backed up $([System.IO.Path]::GetFileName($Path)) -> $([System.IO.Path]::GetFileName($stamped))"
}

function Get-Backups {
  param([string]$Path)
  $name = [System.IO.Path]::GetFileName($Path)
  if (-not (Test-Path $dataDir)) { return @() }
  $stamped = Get-ChildItem $dataDir -Filter "$name.*.bak" -ErrorAction SilentlyContinue |
             Sort-Object LastWriteTime
  return @($stamped)
}

# Resolve a backup file for a given live path + name selector.
#   $null / '' / 'original' -> the plain `<file>.bak` (very first snapshot)
#   'latest'                -> the newest timestamped .bak
#   yyyyMMdd-HHmmss         -> that specific timestamped .bak
function Resolve-Backup {
  param([string]$Path, [string]$Selector)
  $sel = if ([string]::IsNullOrWhiteSpace($Selector)) { '' } else { $Selector.Trim() }
  if ($sel -eq '' -or $sel -ieq 'original') {
    $legacy = "$Path.bak"
    if (Test-Path $legacy) { return $legacy } else { return $null }
  }
  if ($sel -ieq 'latest') {
    $backups = Get-Backups $Path
    if ($backups.Count -gt 0) { return $backups[-1].FullName } else { return $null }
  }
  $candidate = "$Path.$sel.bak"
  if (Test-Path $candidate) { return $candidate } else { return $null }
}

# --- First-use helpers ---------------------------------------------------
function Set-FirstUseCompleted {
  param([bool]$Value)
  $settings = Read-Json $settingsFile ([ordered]@{})
  if ($null -eq $settings) { $settings = [ordered]@{} }
  Backup-File $settingsFile
  # ConvertFrom-Json returns a PSCustomObject; rebuild as ordered
  # hashtable so we can re-serialise predictably.
  $bag = [ordered]@{}
  if ($settings -is [System.Collections.IDictionary]) {
    foreach ($key in $settings.Keys) { $bag[$key] = $settings[$key] }
  } else {
    foreach ($prop in $settings.PSObject.Properties) { $bag[$prop.Name] = $prop.Value }
  }
  $bag['firstUseCompleted'] = $Value
  Write-Json $settingsFile $bag
  Write-Host "Set firstUseCompleted = $Value"
}

function Categorise-Installs {
  param($Installs)
  $arr = @($Installs)
  $skipPick = $false
  $hasLegacyDesktop = $false
  $cloud = 0; $desktop = 0; $other = 0
  foreach ($inst in $arr) {
    switch ($inst.sourceId) {
      'cloud'   { $cloud++ }
      'desktop' { $desktop++; $hasLegacyDesktop = $true }
      default   { $other++; $skipPick = $true }
    }
  }
  return [pscustomobject]@{
    SkipPick = $skipPick; HasLegacyDesktop = $hasLegacyDesktop
    Cloud = $cloud; Desktop = $desktop; Other = $other; Total = $arr.Count
  }
}

function Save-Installs {
  param($Installs)
  Backup-File $installationsFile
  Write-Json $installationsFile @($Installs)
}

function New-FakeStandaloneInstall {
  $stamp = [DateTimeOffset]::UtcNow.ToString("o")
  $idSuffix = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $stubDir = Join-Path $dataDir "first-use-helper-fake-standalone"
  if (-not (Test-Path $stubDir)) {
    New-Item -ItemType Directory -Path $stubDir -Force | Out-Null
    # Sentinel file so the launcher's startup empty-dir sweep keeps the entry.
    Set-Content -Path (Join-Path $stubDir ".first-use-helper-sentinel") -Value "fake install seeded by swap-installations.ps1"
  }
  return [ordered]@{
    id = "inst-firstuse-helper-$idSuffix"
    name = "First-Use Helper Standalone"
    createdAt = $stamp
    sourceId = "standalone"
    installPath = $stubDir
    status = "installed"
    $SentinelKey = $ReturningSentinel
  }
}

function New-FakeDesktopInstall {
  $stamp = [DateTimeOffset]::UtcNow.ToString("o")
  $idSuffix = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $stubDir = Join-Path $dataDir "first-use-helper-fake-desktop"
  if (-not (Test-Path $stubDir)) {
    New-Item -ItemType Directory -Path $stubDir -Force | Out-Null
    Set-Content -Path (Join-Path $stubDir ".first-use-helper-sentinel") -Value "fake desktop install seeded by swap-installations.ps1"
  }
  return [ordered]@{
    id = "inst-firstuse-helper-desktop-$idSuffix"
    name = "ComfyUI Legacy Desktop (helper)"
    createdAt = $stamp
    sourceId = "desktop"
    installPath = $stubDir
    launchMode = "external"
    status = "installed"
    $SentinelKey = $LegacySentinel
  }
}

function Has-HelperSentinel {
  param($Inst, [string]$Kind)
  if ($null -eq $Inst) { return $false }
  $val = $Inst.PSObject.Properties[$SentinelKey]
  if ($null -eq $val) { return $false }
  return $val.Value -eq $Kind
}

function Invoke-FirstUse {
  param([string]$Scenario)
  $valid = @("status", "reset", "fresh", "returning", "legacy", "complete")
  if (-not $Scenario -or $valid -notcontains $Scenario) {
    Write-Error "first-use requires a scenario: $($valid -join ' | ')"
    exit 1
  }

  if ($Scenario -ne "status") {
    $appProc = Get-Process -Name "ComfyUI*" -ErrorAction SilentlyContinue
    if ($appProc) {
      Write-Warning "ComfyUI Launcher appears to be running. Close it first - settings.json will be overwritten on the app's next save."
      $reply = Read-Host "Continue anyway? (y/N)"
      if ($reply -notin @("y", "Y")) { exit 0 }
    }
  }

  switch ($Scenario) {
    "status" {
      $settings = Read-Json $settingsFile ([pscustomobject]@{})
      $completed = $settings.firstUseCompleted
      $cat = Categorise-Installs (Get-Installations)
      Write-Host "settings.json:        $settingsFile"
      Write-Host "  firstUseCompleted = $completed"
      Write-Host "installations.json:   $installationsFile"
      Write-Host "  total           = $($cat.Total)"
      Write-Host "  cloud           = $($cat.Cloud)"
      Write-Host "  desktop         = $($cat.Desktop)"
      Write-Host "  other (local .) = $($cat.Other)"
      Write-Host ""
      Write-Host "On next launch the takeover would receive:"
      Write-Host "  skipPick         = $($cat.SkipPick)"
      Write-Host "  hasLegacyDesktop = $($cat.HasLegacyDesktop)"
      if (-not $completed) {
        Write-Host ""
        if ($cat.SkipPick) {
          Write-Host "Takeover WILL fire and Accept TOS will emit 'complete-skip' (bug #476 scenario - must drop into chooser, NOT auto-launch Cloud)." -ForegroundColor Yellow
        } else {
          Write-Host "Takeover WILL fire and Accept TOS will advance to the cloud-vs-local pick step." -ForegroundColor Cyan
        }
      } else {
        Write-Host ""
        Write-Host "Takeover will NOT fire (firstUseCompleted=true). Use 'reset' / 'fresh' / 'returning' / 'legacy' to re-trigger." -ForegroundColor DarkGray
      }
    }

    "reset" {
      Set-FirstUseCompleted $false
      Write-Host "Done. Next launch will re-run the first-use takeover with current installs."
    }

    "fresh" {
      $kept = @((Get-Installations) | Where-Object {
        $_.sourceId -in @('cloud', 'desktop') -and -not (Has-HelperSentinel $_ $LegacySentinel)
      })
      Save-Installs $kept
      Write-Host "Filtered installations.json down to $($kept.Count) entry/entries (cloud / non-helper desktop only)."
      Set-FirstUseCompleted $false
      $cat = Categorise-Installs $kept
      Write-Host "Resulting state: skipPick=$($cat.SkipPick), hasLegacyDesktop=$($cat.HasLegacyDesktop). Cloud-vs-local pick will show."
    }

    "returning" {
      $installs = Get-Installations
      $hasOther = @($installs | Where-Object { $_.sourceId -ne 'cloud' -and $_.sourceId -ne 'desktop' }).Count -gt 0
      if (-not $hasOther) {
        $installs = @($installs) + @((New-FakeStandaloneInstall))
        Save-Installs $installs
        Write-Host "Added a sentinel standalone install (sourceId=standalone) so skipPick=true."
      } else {
        Write-Host "A non-cloud, non-desktop install is already present - skipPick will already be true. No edit needed."
      }
      Set-FirstUseCompleted $false
      Write-Host "Bug #476 scenario armed: Accept TOS should drop into the chooser without auto-launching Cloud."
    }

    "legacy" {
      $installs = Get-Installations
      $hasDesktop = @($installs | Where-Object { $_.sourceId -eq 'desktop' }).Count -gt 0
      if (-not $hasDesktop) {
        $installs = @($installs) + @((New-FakeDesktopInstall))
        Save-Installs $installs
        Write-Host "Added a sentinel desktop install (sourceId=desktop) so hasLegacyDesktop=true."
      } else {
        Write-Host "A desktop install is already present - hasLegacyDesktop will already be true. No edit needed."
      }
      Set-FirstUseCompleted $false
      Write-Host "Pick Local in the takeover to surface the migrate-vs-install-new sub-step."
    }

    "complete" {
      Set-FirstUseCompleted $true
      Write-Host "Done. First-use takeover will NOT fire on next launch."
    }
  }
}

# --- Profile / lifecycle handlers ----------------------------------------
function Require-Name {
  if (-not $Name) {
    Write-Error "Profile name is required for '$Action'."
    exit 1
  }
}

function Get-ProfilePath {
  param([string]$ProfileName)
  return Join-Path $profilesDir "$ProfileName.json"
}

function Restore-FromBackup {
  param([string]$Path, [string]$Selector, [bool]$RequireExists)
  $backup = Resolve-Backup -Path $Path -Selector $Selector
  $label = [System.IO.Path]::GetFileName($Path)
  if (-not $backup) {
    if ($RequireExists) {
      Write-Error "No backup found for $label (selector: '$Selector')."
      exit 1
    }
    Write-Host "Skipping $label (no backup found for selector '$Selector')." -ForegroundColor DarkGray
    return $false
  }
  Copy-Item $backup $Path -Force
  Write-Host "Restored $label from $([System.IO.Path]::GetFileName($backup))" -ForegroundColor Green
  return $true
}

function Format-BackupRow {
  param($File)
  $size = "{0,7:N0}" -f $File.Length
  $stamp = $File.LastWriteTime.ToString("yyyy-MM-dd HH:mm:ss")
  return "  $stamp  $size B  $($File.Name)"
}

switch ($Action) {
  "save" {
    Require-Name
    if (-not (Test-Path $installationsFile)) {
      Write-Error "No installations.json found at $installationsFile"; exit 1
    }
    if (-not (Test-Path $profilesDir)) { New-Item -ItemType Directory -Path $profilesDir -Force | Out-Null }
    Copy-Item $installationsFile (Get-ProfilePath $Name) -Force
    Write-Host "Saved current installations.json as profile '$Name'"
  }

  "empty" {
    Backup-File $installationsFile
    [System.IO.File]::WriteAllText($installationsFile, "[]", [System.Text.UTF8Encoding]::new($false))
    Write-Host "Replaced installations.json with empty array (fresh state)"
  }

  "primary-only" {
    if (-not (Test-Path $installationsFile)) {
      Write-Error "No installations.json found at $installationsFile"; exit 1
    }
    $primaryId = $null
    if (Test-Path $settingsFile) {
      $settings = Get-Content $settingsFile -Raw | ConvertFrom-Json
      $primaryId = $settings.primaryInstallId
    }
    $installs = Get-Installations
    $primary = $null
    if ($primaryId -and $primaryId -ne '') {
      $primary = $installs | Where-Object { $_.id -eq $primaryId }
    }
    if (-not $primary) {
      $primary = $installs | Where-Object { $_.sourceId -ne 'desktop' -and $_.sourceId -ne 'cloud' } | Select-Object -First 1
    }
    if (-not $primary) { Write-Error "No eligible primary installation found."; exit 1 }
    Backup-File $installationsFile
    # Make sure the install dir exists and isn't considered empty by the
    # startup sweep, which would otherwise drop our single entry.
    $instPath = $primary.installPath
    if ($instPath -and -not (Test-Path $instPath)) {
      New-Item -ItemType Directory -Path $instPath -Force | Out-Null
      Set-Content -Path (Join-Path $instPath ".swap-test-sentinel") -Value "created by swap-installations script"
      Write-Host "Created stub directory at $instPath"
    }
    Write-Json $installationsFile @($primary)
    Write-Host "Kept only primary installation: $($primary.name) ($($primary.id))"
  }

  "load" {
    Require-Name
    $src = Get-ProfilePath $Name
    if (-not (Test-Path $src)) {
      Write-Error "Profile '$Name' not found. Use 'list' to see available profiles."; exit 1
    }
    Backup-File $installationsFile
    Copy-Item $src $installationsFile -Force
    Write-Host "Loaded profile '$Name' as installations.json"
  }

  "list" {
    if (-not (Test-Path $profilesDir)) { Write-Host "No profiles saved yet."; return }
    $profiles = Get-ChildItem $profilesDir -Filter "*.json" | Sort-Object Name
    if ($profiles.Count -eq 0) { Write-Host "No profiles saved yet."; return }
    Write-Host "Saved profiles:"
    foreach ($p in $profiles) {
      $entries = (Get-Content $p.FullName -Raw | ConvertFrom-Json).Count
      Write-Host "  $($p.BaseName) ($entries installations)"
    }
  }

  "delete" {
    Require-Name
    $target = Get-ProfilePath $Name
    if (-not (Test-Path $target)) { Write-Error "Profile '$Name' not found."; exit 1 }
    Remove-Item $target -Force
    Write-Host "Deleted profile '$Name'"
  }

  "first-use" { Invoke-FirstUse $Name }

  "restore" {
    # restore both installations.json and settings.json from the chosen
    # selector. Missing-backup is fatal for installations.json (it's the
    # primary target) but only a soft skip for settings.json - some
    # actions (e.g. profile load) never touch settings.
    $selector = if ($Name) { $Name } else { '' }
    $shown = if ($selector) { $selector } else { 'original' }
    Write-Host "Restoring from backup selector: '$shown'" -ForegroundColor Cyan
    Restore-FromBackup -Path $installationsFile -Selector $selector -RequireExists $true | Out-Null
    Restore-FromBackup -Path $settingsFile -Selector $selector -RequireExists $false | Out-Null
  }

  "merge" {
    $selector = if ($Name) { $Name } else { '' }
    $backupPath = Resolve-Backup -Path $installationsFile -Selector $selector
    if (-not $backupPath) {
      Write-Error "No installations.json backup found for selector '$selector'."; exit 1
    }
    $current = @(Get-Installations)
    $backup = @(Read-Json $backupPath @())
    $currentIds = @{}
    foreach ($c in $current) { if ($c.id) { $currentIds[$c.id] = $true } }
    $added = 0
    $merged = @($current)
    foreach ($b in $backup) {
      if (-not $b.id) { continue }
      if (-not $currentIds.ContainsKey($b.id)) {
        $merged += $b
        $added++
      }
    }
    Backup-File $installationsFile
    Write-Json $installationsFile $merged
    Write-Host "Merged $([System.IO.Path]::GetFileName($backupPath)) into installations.json: added $added entry/entries (current values kept on id collisions)." -ForegroundColor Green
  }

  "list-backups" {
    foreach ($p in @($installationsFile, $settingsFile)) {
      $name = [System.IO.Path]::GetFileName($p)
      Write-Host "$name backups in $dataDir :"
      $backups = Get-Backups $p
      $legacy = "$p.bak"
      if (Test-Path $legacy) {
        $f = Get-Item $legacy
        Write-Host (Format-BackupRow $f) -ForegroundColor DarkCyan
      }
      if ($backups.Count -eq 0 -and -not (Test-Path $legacy)) {
        Write-Host "  (none)" -ForegroundColor DarkGray
      } else {
        foreach ($f in $backups) { Write-Host (Format-BackupRow $f) }
      }
      Write-Host ""
    }
  }
}
