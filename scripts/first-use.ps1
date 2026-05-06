<#
.SYNOPSIS
  Trigger the first-use takeover in specific scenarios for QA.

.DESCRIPTION
  Flips `firstUseCompleted` in settings.json (and optionally edits
  installations.json) so the next launcher start re-runs the first-use
  takeover in a chosen state. The `firstUseDetection` module reads
  installations.json to compute `{ skipPick, hasLegacyDesktop }`:

    skipPick = true  ⇨ ANY install present beyond Cloud / Legacy Desktop.
                       T&C accept skips the cloud-vs-local fork and emits
                       `complete-skip` (drops user on the chooser body —
                       bug #476 was Cloud being auto-launched here).
    skipPick = false ⇨ Only Cloud / Legacy Desktop. T&C accept advances to
                       the cloud-vs-local pick step.
    hasLegacyDesktop ⇨ A `sourceId: 'desktop'` install was auto-tracked.
                       Picking Local opens the migrate-vs-install-new
                       sub-step.

  The app should be closed before running these — settings.json gets
  rewritten in-flight by the running app and would clobber any change.

.PARAMETER Action
  status     - Print firstUseCompleted, the install categorisation, and
               the resulting (skipPick, hasLegacyDesktop) the takeover
               would receive on next launch.
  reset      - Set firstUseCompleted=false. Leaves installs untouched.
  fresh      - Set firstUseCompleted=false AND back up + filter
               installations.json down to Cloud / Legacy Desktop only,
               so skipPick=false and the cloud-vs-local fork is shown.
  returning  - Set firstUseCompleted=false AND ensure a non-cloud,
               non-desktop install is present so skipPick=true. This
               reproduces the bug #476 scenario — Accept TOS should
               drop into the chooser, NOT auto-launch Cloud.
  legacy     - Set firstUseCompleted=false AND ensure a fake
               sourceId='desktop' install is present so
               hasLegacyDesktop=true. Picking Local should reveal the
               migrate-vs-install-new sub-step.
  complete   - Set firstUseCompleted=true. Clears the takeover.

.EXAMPLE
  .\first-use.ps1 status
  .\first-use.ps1 fresh
  .\first-use.ps1 returning
  .\first-use.ps1 legacy
  .\first-use.ps1 reset
  .\first-use.ps1 complete
#>

param(
  [Parameter(Mandatory, Position = 0)]
  [ValidateSet("status", "reset", "fresh", "returning", "legacy", "complete")]
  [string]$Action
)

$ErrorActionPreference = "Stop"

$dataDir = Join-Path $env:APPDATA "comfyui-desktop-2"
$installationsFile = Join-Path $dataDir "installations.json"
$settingsFile = Join-Path $dataDir "settings.json"

# Sentinel marker we stamp on installs we add ourselves so subsequent
# runs can recognise + reuse them rather than stacking duplicates.
$SentinelKey = "_firstUseHelperSentinel"
$ReturningSentinel = "returning"
$LegacySentinel = "legacy"

if ($Action -ne "status") {
  $appProc = Get-Process -Name "ComfyUI*" -ErrorAction SilentlyContinue
  if ($appProc) {
    Write-Warning "ComfyUI Launcher appears to be running. Close it first — settings.json will be overwritten on the app's next save."
    $reply = Read-Host "Continue anyway? (y/N)"
    if ($reply -notin @("y", "Y")) { exit 0 }
  }
}

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

function Backup-File {
  param([string]$Path)
  if (Test-Path $Path) {
    $backup = "$Path.bak"
    Copy-Item $Path $backup -Force
    Write-Host "Backed up $([System.IO.Path]::GetFileName($Path)) to $([System.IO.Path]::GetFileName($backup))"
  }
}

function Get-Installations {
  $data = Read-Json $installationsFile @()
  if ($null -eq $data) { return @() }
  if ($data -isnot [System.Collections.IEnumerable] -or $data -is [string]) { return @($data) }
  return @($data)
}

function Set-FirstUseCompleted {
  param([bool]$Value)
  $settings = Read-Json $settingsFile ([ordered]@{})
  if ($null -eq $settings) { $settings = [ordered]@{} }
  Backup-File $settingsFile
  # ConvertFrom-Json hands back a PSCustomObject; rebuild as ordered hashtable
  # so we can re-serialise predictably (key set + nested values preserved).
  $bag = [ordered]@{}
  foreach ($prop in $settings.PSObject.Properties) { $bag[$prop.Name] = $prop.Value }
  $bag['firstUseCompleted'] = $Value
  Write-Json $settingsFile $bag
  Write-Host "Set firstUseCompleted = $Value"
}

function Categorise-Installs {
  param($Installs)
  $skipPick = $false
  $hasLegacyDesktop = $false
  $cloud = 0
  $desktop = 0
  $other = 0
  foreach ($inst in $Installs) {
    switch ($inst.sourceId) {
      'cloud'   { $cloud++ }
      'desktop' { $desktop++; $hasLegacyDesktop = $true }
      default   { $other++; $skipPick = $true }
    }
  }
  return [pscustomobject]@{
    SkipPick         = $skipPick
    HasLegacyDesktop = $hasLegacyDesktop
    Cloud            = $cloud
    Desktop          = $desktop
    Other            = $other
    Total            = $Installs.Count
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
    Set-Content -Path (Join-Path $stubDir ".first-use-helper-sentinel") -Value "fake install seeded by first-use.ps1"
  }
  return [ordered]@{
    id              = "inst-firstuse-helper-$idSuffix"
    name            = "First-Use Helper Standalone"
    createdAt       = $stamp
    sourceId        = "standalone"
    installPath     = $stubDir
    status          = "installed"
    $SentinelKey    = $ReturningSentinel
  }
}

function New-FakeDesktopInstall {
  $stamp = [DateTimeOffset]::UtcNow.ToString("o")
  $idSuffix = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $stubDir = Join-Path $dataDir "first-use-helper-fake-desktop"
  if (-not (Test-Path $stubDir)) {
    New-Item -ItemType Directory -Path $stubDir -Force | Out-Null
    Set-Content -Path (Join-Path $stubDir ".first-use-helper-sentinel") -Value "fake desktop install seeded by first-use.ps1"
  }
  return [ordered]@{
    id              = "inst-firstuse-helper-desktop-$idSuffix"
    name            = "ComfyUI Legacy Desktop (helper)"
    createdAt       = $stamp
    sourceId        = "desktop"
    installPath     = $stubDir
    launchMode      = "external"
    status          = "installed"
    $SentinelKey    = $LegacySentinel
  }
}

function Has-HelperSentinel {
  param($Inst, [string]$Kind)
  if ($null -eq $Inst) { return $false }
  $val = $Inst.PSObject.Properties[$SentinelKey]
  if ($null -eq $val) { return $false }
  return $val.Value -eq $Kind
}

switch ($Action) {

  "status" {
    $settings = Read-Json $settingsFile ([pscustomobject]@{})
    $completed = $settings.firstUseCompleted
    $installs = Get-Installations
    $cat = Categorise-Installs $installs
    Write-Host "settings.json:        $settingsFile"
    Write-Host "  firstUseCompleted = $completed"
    Write-Host "installations.json:   $installationsFile"
    Write-Host "  total           = $($cat.Total)"
    Write-Host "  cloud           = $($cat.Cloud)"
    Write-Host "  desktop         = $($cat.Desktop)"
    Write-Host "  other (local …) = $($cat.Other)"
    Write-Host ""
    Write-Host "On next launch the takeover would receive:"
    Write-Host "  skipPick         = $($cat.SkipPick)"
    Write-Host "  hasLegacyDesktop = $($cat.HasLegacyDesktop)"
    if (-not $completed) {
      Write-Host ""
      if ($cat.SkipPick) {
        Write-Host "Takeover WILL fire and Accept TOS will emit 'complete-skip' (bug #476 scenario — must drop into chooser, NOT auto-launch Cloud)." -ForegroundColor Yellow
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
    $installs = Get-Installations
    # Strip helper sentinels and any non-cloud, non-desktop installs so
    # skipPick computes false and the cloud-vs-local fork is shown.
    $kept = @($installs | Where-Object { $_.sourceId -in @('cloud', 'desktop') -and -not (Has-HelperSentinel $_ $LegacySentinel) })
    Save-Installs $kept
    Write-Host "Filtered installations.json down to $($kept.Count) entry/entries (cloud / non-helper desktop only)."
    Set-FirstUseCompleted $false
    $cat = Categorise-Installs $kept
    Write-Host "Resulting state: skipPick=$($cat.SkipPick), hasLegacyDesktop=$($cat.HasLegacyDesktop). Cloud-vs-local pick will show."
  }

  "returning" {
    $installs = Get-Installations
    $hasNonCloudNonDesktop = @($installs | Where-Object { $_.sourceId -ne 'cloud' -and $_.sourceId -ne 'desktop' }).Count -gt 0
    if (-not $hasNonCloudNonDesktop) {
      $installs = @($installs) + @((New-FakeStandaloneInstall))
      Save-Installs $installs
      Write-Host "Added a sentinel standalone install (sourceId=standalone) so skipPick=true."
    } else {
      Write-Host "A non-cloud, non-desktop install is already present — skipPick will already be true. No edit needed."
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
      Write-Host "A desktop install is already present — hasLegacyDesktop will already be true. No edit needed."
    }
    Set-FirstUseCompleted $false
    Write-Host "Pick Local in the takeover to surface the migrate-vs-install-new sub-step."
  }

  "complete" {
    Set-FirstUseCompleted $true
    Write-Host "Done. First-use takeover will NOT fire on next launch."
  }
}
