#!/usr/bin/env bash
# ComfyUI Desktop 2.0 -- macOS reset script
#
# Wipes app settings, caches, and the Chromium profile for the current build
# AND for the older beta names (ComfyUI Launcher / com.kosinkadink.* /
# org.comfy.comfyui-launcher), in case leftovers from a previous version are
# breaking the UI (no styles, no i18n, dropdowns not working, etc.) after a
# manual update.
#
# Does NOT touch your actual ComfyUI installs at ~/ComfyUI-Installs. The
# script DOES remove installations.json (the registry), so you may need to
# re-add existing installs via "Add existing installation" on first launch.
#
# Usage:
#   bash reset-mac.sh           # asks for confirmation
#   bash reset-mac.sh --yes     # skip confirmation

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

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This script is for macOS only." >&2
  exit 1
fi

# Refuse to run while the app is open
if pgrep -x "ComfyUI Desktop 2.0" >/dev/null 2>&1 \
   || pgrep -x "ComfyUI Launcher"  >/dev/null 2>&1; then
  echo "ComfyUI Desktop 2.0 / Launcher is running. Please quit it first (Cmd+Q),"
  echo "then re-run this script."
  exit 1
fi

PRODUCT_NAMES=(
  "ComfyUI Desktop 2.0"
  "ComfyUI Launcher"
)

BUNDLE_IDS=(
  "org.comfy.comfyui-desktop-2"
  "org.comfy.comfyui-launcher"
  "com.kosinkadink.comfyui-launcher"
)

TARGETS=()

for name in "${PRODUCT_NAMES[@]}"; do
  TARGETS+=(
    "$HOME/Library/Application Support/$name"
    "$HOME/Library/Logs/$name"
  )
done

for id in "${BUNDLE_IDS[@]}"; do
  TARGETS+=(
    "$HOME/Library/Preferences/${id}.plist"
    "$HOME/Library/Caches/${id}"
    "$HOME/Library/Saved Application State/${id}.savedState"
    "$HOME/Library/WebKit/${id}"
  )
  # HTTPStorages has both bare and ".binarycookies" variants
  for p in "$HOME/Library/HTTPStorages/${id}" \
           "$HOME/Library/HTTPStorages/${id}.binarycookies"; do
    TARGETS+=("$p")
  done
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
echo "Done. Reinstall ComfyUI Desktop 2.0 from the latest .dmg if you haven't already,"
echo "then launch it. The app should come up with a clean profile."
