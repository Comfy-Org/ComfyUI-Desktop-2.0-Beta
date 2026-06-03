#!/usr/bin/env bash
# ComfyUI Desktop 2.0 -- Linux reset script
#
# Wipes app settings, caches, and the Chromium profile for the current build
# AND for the older beta names (ComfyUI Launcher / comfyui-launcher), in case
# leftovers from a previous version are breaking the UI (no styles, no i18n,
# dropdowns not working, etc.) after a manual update.
#
# Does NOT touch your actual ComfyUI installs at ~/ComfyUI-Installs. The
# script DOES remove installations.json (the registry), so you may need to
# re-add existing installs via "Add existing installation" on first launch.
#
# Usage:
#   bash reset-linux.sh         # asks for confirmation
#   bash reset-linux.sh --yes   # skip confirmation

set -u

YES=0
for arg in "$@"; do
  case "$arg" in
    -y|--yes) YES=1 ;;
    -h|--help)
      sed -n '2,17p' "$0"
      exit 0
      ;;
  esac
done

if [ "$(uname -s)" != "Linux" ]; then
  echo "This script is for Linux only." >&2
  exit 1
fi

# Refuse to run while the app is open (includes the upcoming post-rename
# "ComfyUI Desktop" display name)
if pgrep -f "comfyui-desktop-2|ComfyUI Desktop 2.0|ComfyUI Desktop|comfyui-launcher|ComfyUI Launcher" >/dev/null 2>&1; then
  echo "ComfyUI Desktop / Launcher is running. Please quit it first,"
  echo "then re-run this script."
  exit 1
fi

# XDG base directories (with fallbacks per the XDG Base Directory Spec)
XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
XDG_CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}"
XDG_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
XDG_STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}"

# Every historical app/package name. The userData folder on Linux is named
# after the package.json "name" field (NOT productName). "ComfyUI Desktop"
# is included for the upcoming post-rename productName. "ComfyUI" covers
# the legacy v1.x desktop app (productName "ComfyUI") whose state can
# survive an upgrade to the 2.0 beta and break a clean install (mirrors
# #679's macOS findings).
APP_NAMES=(
  "comfyui-desktop-2"
  "comfyui-launcher"
  "ComfyUI"
  "ComfyUI Desktop"
  "ComfyUI Desktop 2.0"
  "ComfyUI Launcher"
)

TARGETS=()

for name in "${APP_NAMES[@]}"; do
  TARGETS+=(
    "$XDG_CONFIG_HOME/$name"             # userData / settings.json / Chromium profile
    "$XDG_CACHE_HOME/$name"              # download-cache (after XDG migration)
    "$XDG_CACHE_HOME/${name}-updater"    # electron-updater pending update cache
    "$XDG_DATA_HOME/$name"               # installations.json, shared_model_paths.yaml
    "$XDG_STATE_HOME/$name"              # port-locks
  )
done

EXISTING=()
for t in "${TARGETS[@]}"; do
  if [ -e "$t" ]; then
    EXISTING+=("$t")
  fi
done

if [ ${#EXISTING[@]} -eq 0 ]; then
  echo "Nothing to remove. No ComfyUI Desktop 2.0 / Launcher data found."
  exit 0
fi

echo "The following will be permanently deleted:"
echo
for t in "${EXISTING[@]}"; do
  echo "  $t"
done
echo
echo "Your ComfyUI installs at ~/ComfyUI-Installs will NOT be touched."
echo "(You may need to re-add them via 'Add existing installation' on first launch.)"
echo

if [ "$YES" -ne 1 ]; then
  printf "Proceed? [y/N] "
  read -r reply
  case "$reply" in
    y|Y|yes|YES) ;;
    *) echo "Aborted."; exit 1 ;;
  esac
fi

for t in "${EXISTING[@]}"; do
  echo "Removing: $t"
  rm -rf -- "$t"
done

echo
echo "Done. Reinstall ComfyUI Desktop 2.0 from the latest .AppImage or .deb"
echo "if you haven't already, then launch it. The app should come up with a"
echo "clean profile."
