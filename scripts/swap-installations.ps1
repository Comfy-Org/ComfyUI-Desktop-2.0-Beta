<#
.SYNOPSIS
  Swap the active installations.json with a named profile for testing.

.DESCRIPTION
  Saves/restores installations.json profiles in a "test-profiles" folder
  next to the live data file. Useful for testing different installation
  configurations (e.g. single install, multiple installs, desktop-only).

  The app should be closed before swapping.

.PARAMETER Action
  save   - Copy the current installations.json into a named profile.
  load   - Replace the current installations.json with a named profile.
  empty        - Replace installations.json with an empty array (fresh/new-user state).
  primary-only - Keep only the current primary installation (remove all others).
  list         - List all saved profiles.
  delete       - Delete a saved profile.

.PARAMETER Name
  Profile name (required for save, load, delete).

.EXAMPLE
  .\swap-installations.ps1 save single-standalone
  .\swap-installations.ps1 load single-standalone
  .\swap-installations.ps1 empty
  .\swap-installations.ps1 primary-only
  .\swap-installations.ps1 list
  .\swap-installations.ps1 delete single-standalone
#>

param(
  [Parameter(Mandatory, Position = 0)]
  [ValidateSet("save", "load", "empty", "primary-only", "list", "delete")]
  [string]$Action,

  [Parameter(Position = 1)]
  [string]$Name
)

$ErrorActionPreference = "Stop"

$dataDir = Join-Path $env:APPDATA "comfyui-desktop-2"
$installationsFile = Join-Path $dataDir "installations.json"
$profilesDir = Join-Path $dataDir "test-profiles"

# Warn if the app is running (it will overwrite changes on its own save cycle)
$appProc = Get-Process -Name "ComfyUI*" -ErrorAction SilentlyContinue
if ($appProc -and $Action -ne "list") {
  Write-Warning "ComfyUI Launcher appears to be running. Close it before swapping to avoid the app overwriting your changes."
  $reply = Read-Host "Continue anyway? (y/N)"
  if ($reply -notin @("y", "Y")) { exit 0 }
}

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

switch ($Action) {
  "save" {
    Require-Name
    if (-not (Test-Path $installationsFile)) {
      Write-Error "No installations.json found at $installationsFile"
      exit 1
    }
    if (-not (Test-Path $profilesDir)) {
      New-Item -ItemType Directory -Path $profilesDir -Force | Out-Null
    }
    $dest = Get-ProfilePath $Name
    Copy-Item $installationsFile $dest -Force
    Write-Host "Saved current installations.json as profile '$Name'"
  }

  "empty" {
    if (Test-Path $installationsFile) {
      $backup = Join-Path $dataDir "installations.json.bak"
      Copy-Item $installationsFile $backup -Force
      Write-Host "Backed up current installations.json to installations.json.bak"
    }
    [System.IO.File]::WriteAllText($installationsFile, "[]", [System.Text.UTF8Encoding]::new($false))
    Write-Host "Replaced installations.json with empty array (fresh state)"
  }

  "primary-only" {
    if (-not (Test-Path $installationsFile)) {
      Write-Error "No installations.json found at $installationsFile"
      exit 1
    }
    $settingsFile = Join-Path $dataDir "settings.json"
    $primaryId = $null
    if (Test-Path $settingsFile) {
      $settings = Get-Content $settingsFile -Raw | ConvertFrom-Json
      $primaryId = $settings.primaryInstallId
    }
    $installs = Get-Content $installationsFile -Raw | ConvertFrom-Json
    $primary = $null
    if ($primaryId -and $primaryId -ne '') {
      $primary = $installs | Where-Object { $_.id -eq $primaryId }
    }
    if (-not $primary) {
      $primary = $installs | Where-Object { $_.sourceId -ne 'desktop' -and $_.sourceId -ne 'cloud' } | Select-Object -First 1
    }
    if (-not $primary) {
      Write-Error "No eligible primary installation found."
      exit 1
    }
    $backup = Join-Path $dataDir "installations.json.bak"
    Copy-Item $installationsFile $backup -Force
    Write-Host "Backed up current installations.json to installations.json.bak"
    # Ensure the install path exists and isn't considered empty by the app's
    # startup sweep (which deletes entries whose installPath is missing/empty).
    $instPath = $primary.installPath
    if ($instPath -and -not (Test-Path $instPath)) {
      New-Item -ItemType Directory -Path $instPath -Force | Out-Null
      # Add a sentinel file so isEffectivelyEmptyInstallDir returns false
      Set-Content -Path (Join-Path $instPath ".swap-test-sentinel") -Value "created by swap-installations script"
      Write-Host "Created stub directory at $instPath"
    }
    $json = ConvertTo-Json @($primary) -Depth 10
    [System.IO.File]::WriteAllText($installationsFile, $json, [System.Text.UTF8Encoding]::new($false))
    Write-Host "Kept only primary installation: $($primary.name) ($($primary.id))"
  }

  "load" {
    Require-Name
    $src = Get-ProfilePath $Name
    if (-not (Test-Path $src)) {
      Write-Error "Profile '$Name' not found. Use 'list' to see available profiles."
      exit 1
    }
    if (Test-Path $installationsFile) {
      $backup = Join-Path $dataDir "installations.json.bak"
      Copy-Item $installationsFile $backup -Force
      Write-Host "Backed up current installations.json to installations.json.bak"
    }
    Copy-Item $src $installationsFile -Force
    Write-Host "Loaded profile '$Name' as installations.json"
  }

  "list" {
    if (-not (Test-Path $profilesDir)) {
      Write-Host "No profiles saved yet."
      return
    }
    $profiles = Get-ChildItem $profilesDir -Filter "*.json" | Sort-Object Name
    if ($profiles.Count -eq 0) {
      Write-Host "No profiles saved yet."
      return
    }
    Write-Host "Saved profiles:"
    foreach ($p in $profiles) {
      $entries = (Get-Content $p.FullName -Raw | ConvertFrom-Json).Count
      Write-Host "  $($p.BaseName) ($entries installations)"
    }
  }

  "delete" {
    Require-Name
    $target = Get-ProfilePath $Name
    if (-not (Test-Path $target)) {
      Write-Error "Profile '$Name' not found."
      exit 1
    }
    Remove-Item $target -Force
    Write-Host "Deleted profile '$Name'"
  }
}
