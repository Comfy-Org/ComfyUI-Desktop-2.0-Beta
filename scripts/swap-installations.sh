#!/usr/bin/env bash
#
# Manipulate the launcher's installations.json / settings.json for QA.
#
# One tool covers three needs:
#
#   1. Snapshot profiles (save / load / list / delete)
#        Stored under "<data>/test-profiles/" so you can flip between
#        configurations (multi-install, primary-only, etc.).
#
#   2. First-use takeover scenarios (first-use <scenario>)
#        Flips firstUseCompleted in settings.json and optionally seeds
#        installations.json so the takeover re-runs in a chosen state.
#        firstUseDetection reads installations.json to compute
#        { skipPick, hasLegacyDesktop }:
#
#          skipPick = true  - ANY install present beyond Cloud / Legacy
#                             Desktop. T&C accept skips the cloud-vs-local
#                             fork and emits 'complete-skip' (bug #476
#                             was Cloud being auto-launched here).
#          skipPick = false - Only Cloud / Legacy Desktop. T&C accept
#                             advances to the cloud-vs-local pick step.
#          hasLegacyDesktop - A sourceId='desktop' install was auto-
#                             tracked. Picking Local opens the migrate-
#                             vs-install-new sub-step.
#
#   3. Recover after testing (restore / merge / list-backups)
#        Every mutating action drops timestamped .bak files. Plus a
#        legacy installations.json.bak / settings.json.bak that is
#        only written the first time, so the very first/original
#        snapshot is preserved across repeat runs.
#
# Close the app before any mutating action - the launcher will
# overwrite settings.json / installations.json on its own save cycle.
#
# Usage:
#   ./swap-installations.sh save <name>
#   ./swap-installations.sh load <name>
#   ./swap-installations.sh empty
#   ./swap-installations.sh primary-only
#   ./swap-installations.sh list
#   ./swap-installations.sh delete <name>
#   ./swap-installations.sh first-use {status|reset|fresh|returning|legacy|complete}
#   ./swap-installations.sh restore [<timestamp>|latest]   # default = original
#   ./swap-installations.sh merge   [<timestamp>|latest]   # default = original
#   ./swap-installations.sh list-backups

set -euo pipefail

# --- Resolve data + config directories (matches paths.ts logic) ---
if [[ "$(uname)" == "Darwin" ]]; then
  DATA_DIR="${HOME}/Library/Application Support/comfyui-desktop-2"
  CONFIG_DIR="$DATA_DIR"
else
  DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/comfyui-desktop-2"
  CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/comfyui-desktop-2"
fi

INSTALLATIONS_FILE="$DATA_DIR/installations.json"
SETTINGS_FILE="$CONFIG_DIR/settings.json"
PROFILES_DIR="$DATA_DIR/test-profiles"

# Sentinel marker stamped on installs the script adds itself, so repeat
# runs reuse the entry rather than stacking duplicates.
SENTINEL_KEY="_firstUseHelperSentinel"
RETURNING_SENTINEL="returning"
LEGACY_SENTINEL="legacy"

ACTION="${1:-}"
NAME="${2:-}"

if [[ -z "$ACTION" ]]; then
  echo "Usage: $0 {save|load|empty|primary-only|list|delete|first-use|restore|merge|list-backups} [name]" >&2
  exit 1
fi

# --- Running-app guard (skip read-only actions) ---
is_read_only=false
case "$ACTION" in
  list|list-backups) is_read_only=true ;;
  first-use)
    # 'first-use status' is read-only; defer to the handler.
    is_read_only=true
    ;;
esac

if [[ "$is_read_only" == false ]]; then
  if pgrep -if "comfyui" > /dev/null 2>&1; then
    echo "WARNING: ComfyUI Launcher appears to be running. Close it before mutating data files."
    read -rp "Continue anyway? (y/N) " reply
    [[ "$reply" =~ ^[Yy]$ ]] || exit 0
  fi
fi

require_name() {
  if [[ -z "$NAME" ]]; then
    echo "Error: Profile name is required for '$ACTION'." >&2
    exit 1
  fi
}

profile_path() { echo "$PROFILES_DIR/$1.json"; }

# Backup helper - timestamped + legacy single-slot (created only once).
backup_file() {
  local path="$1"
  [[ -f "$path" ]] || return 0
  local stamp; stamp="$(date -u +%Y%m%d-%H%M%S)"
  local stamped="${path}.${stamp}.bak"
  cp "$path" "$stamped"
  echo "Backed up $(basename "$path") -> $(basename "$stamped")"
  local legacy="${path}.bak"
  if [[ ! -f "$legacy" ]]; then
    cp "$path" "$legacy"
    echo "Also created original snapshot at $(basename "$legacy")"
  fi
}

# Resolve a backup file:
#   ''/'original'           -> <path>.bak
#   'latest'                -> newest timestamped .bak
#   <yyyyMMdd-HHmmss>       -> that specific timestamped .bak
resolve_backup() {
  local path="$1"
  local selector="${2:-}"
  if [[ -z "$selector" || "$selector" == "original" ]]; then
    [[ -f "${path}.bak" ]] && { echo "${path}.bak"; return 0; }
    return 1
  fi
  if [[ "$selector" == "latest" ]]; then
    local newest
    newest=$(ls -1t "${path}".*.bak 2>/dev/null | head -n 1 || true)
    [[ -n "$newest" ]] && { echo "$newest"; return 0; }
    return 1
  fi
  local candidate="${path}.${selector}.bak"
  [[ -f "$candidate" ]] && { echo "$candidate"; return 0; }
  return 1
}

restore_from_backup() {
  local path="$1"
  local selector="${2:-}"
  local require="${3:-true}"
  local backup
  if ! backup=$(resolve_backup "$path" "$selector"); then
    if [[ "$require" == true ]]; then
      echo "Error: No backup found for $(basename "$path") (selector: '${selector:-original}')." >&2
      exit 1
    fi
    echo "Skipping $(basename "$path") (no backup found for selector '${selector:-original}')."
    return 0
  fi
  cp "$backup" "$path"
  echo "Restored $(basename "$path") from $(basename "$backup")"
}

# --- First-use scenarios -------------------------------------------------

set_first_use_completed() {
  local value="$1"
  mkdir -p "$CONFIG_DIR"
  backup_file "$SETTINGS_FILE"
  python3 - "$SETTINGS_FILE" "$value" <<'PY'
import json, os, sys
path, value = sys.argv[1], sys.argv[2]
data = {}
if os.path.exists(path):
    try:
        with open(path) as f:
            raw = f.read().strip()
        if raw:
            data = json.loads(raw)
    except Exception as exc:
        print(f"WARN: failed to parse {path}: {exc}", file=sys.stderr)
        data = {}
if not isinstance(data, dict):
    data = {}
data['firstUseCompleted'] = (value == 'true')
with open(path, 'w') as f:
    json.dump(data, f, indent=2)
print(f"Set firstUseCompleted = {value}")
PY
}

print_first_use_status() {
  python3 - "$SETTINGS_FILE" "$INSTALLATIONS_FILE" <<'PY'
import json, os, sys
settings_path, installs_path = sys.argv[1], sys.argv[2]

settings = {}
if os.path.exists(settings_path):
    try:
        with open(settings_path) as f:
            raw = f.read().strip()
        if raw:
            settings = json.loads(raw)
    except Exception:
        pass

installs = []
if os.path.exists(installs_path):
    try:
        with open(installs_path) as f:
            raw = f.read().strip()
        if raw:
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                installs = parsed
    except Exception:
        pass

cloud = sum(1 for i in installs if i.get('sourceId') == 'cloud')
desktop = sum(1 for i in installs if i.get('sourceId') == 'desktop')
other = sum(1 for i in installs if i.get('sourceId') not in ('cloud', 'desktop'))
skip_pick = other > 0
has_legacy = desktop > 0
completed = settings.get('firstUseCompleted')

print(f"settings.json:        {settings_path}")
print(f"  firstUseCompleted = {completed}")
print(f"installations.json:   {installs_path}")
print(f"  total           = {len(installs)}")
print(f"  cloud           = {cloud}")
print(f"  desktop         = {desktop}")
print(f"  other (local .) = {other}")
print()
print("On next launch the takeover would receive:")
print(f"  skipPick         = {skip_pick}")
print(f"  hasLegacyDesktop = {has_legacy}")
print()
if not completed:
    if skip_pick:
        print("Takeover WILL fire and Accept TOS will emit 'complete-skip' "
              "(bug #476 scenario - must drop into chooser, NOT auto-launch Cloud).")
    else:
        print("Takeover WILL fire and Accept TOS will advance to the cloud-vs-local pick step.")
else:
    print("Takeover will NOT fire (firstUseCompleted=true). "
          "Use 'reset' / 'fresh' / 'returning' / 'legacy' to re-trigger.")
PY
}

mutate_installs_filter_to_cloud_desktop_only() {
  mkdir -p "$DATA_DIR"
  backup_file "$INSTALLATIONS_FILE"
  python3 - "$INSTALLATIONS_FILE" "$SENTINEL_KEY" "$LEGACY_SENTINEL" <<'PY'
import json, os, sys
path, key, legacy_sentinel = sys.argv[1], sys.argv[2], sys.argv[3]
installs = []
if os.path.exists(path):
    try:
        with open(path) as f:
            raw = f.read().strip()
        if raw:
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                installs = parsed
    except Exception:
        pass
kept = [
    i for i in installs
    if i.get('sourceId') in ('cloud', 'desktop') and i.get(key) != legacy_sentinel
]
with open(path, 'w') as f:
    json.dump(kept, f, indent=2)
print(f"Filtered installations.json down to {len(kept)} entry/entries (cloud / non-helper desktop only).")
PY
}

mutate_installs_ensure_standalone() {
  mkdir -p "$DATA_DIR"
  local stub_dir="$DATA_DIR/first-use-helper-fake-standalone"
  mkdir -p "$stub_dir"
  echo "fake install seeded by swap-installations.sh" > "$stub_dir/.first-use-helper-sentinel"
  backup_file "$INSTALLATIONS_FILE"
  python3 - "$INSTALLATIONS_FILE" "$SENTINEL_KEY" "$RETURNING_SENTINEL" "$stub_dir" <<'PY'
import json, os, sys, time
path, key, sentinel, stub_dir = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
installs = []
if os.path.exists(path):
    try:
        with open(path) as f:
            raw = f.read().strip()
        if raw:
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                installs = parsed
    except Exception:
        pass
has_other = any(
    i.get('sourceId') not in ('cloud', 'desktop')
    for i in installs
)
if has_other:
    print("A non-cloud, non-desktop install is already present - skipPick will already be true. No edit needed.")
else:
    ms = int(time.time() * 1000)
    fake = {
        "id": f"inst-firstuse-helper-{ms}",
        "name": "First-Use Helper Standalone",
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
        "sourceId": "standalone",
        "installPath": stub_dir,
        "status": "installed",
        key: sentinel,
    }
    installs.append(fake)
    with open(path, 'w') as f:
        json.dump(installs, f, indent=2)
    print("Added a sentinel standalone install (sourceId=standalone) so skipPick=true.")
PY
}

mutate_installs_ensure_desktop() {
  mkdir -p "$DATA_DIR"
  local stub_dir="$DATA_DIR/first-use-helper-fake-desktop"
  mkdir -p "$stub_dir"
  echo "fake desktop install seeded by swap-installations.sh" > "$stub_dir/.first-use-helper-sentinel"
  backup_file "$INSTALLATIONS_FILE"
  python3 - "$INSTALLATIONS_FILE" "$SENTINEL_KEY" "$LEGACY_SENTINEL" "$stub_dir" <<'PY'
import json, os, sys, time
path, key, sentinel, stub_dir = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
installs = []
if os.path.exists(path):
    try:
        with open(path) as f:
            raw = f.read().strip()
        if raw:
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                installs = parsed
    except Exception:
        pass
has_desktop = any(i.get('sourceId') == 'desktop' for i in installs)
if has_desktop:
    print("A desktop install is already present - hasLegacyDesktop will already be true. No edit needed.")
else:
    ms = int(time.time() * 1000)
    fake = {
        "id": f"inst-firstuse-helper-desktop-{ms}",
        "name": "ComfyUI Legacy Desktop (helper)",
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
        "sourceId": "desktop",
        "installPath": stub_dir,
        "launchMode": "external",
        "status": "installed",
        key: sentinel,
    }
    installs.append(fake)
    with open(path, 'w') as f:
        json.dump(installs, f, indent=2)
    print("Added a sentinel desktop install (sourceId=desktop) so hasLegacyDesktop=true.")
PY
}

invoke_first_use() {
  local scenario="${1:-}"
  case "$scenario" in
    status|reset|fresh|returning|legacy|complete) ;;
    *)
      echo "Error: first-use requires a scenario: status|reset|fresh|returning|legacy|complete" >&2
      exit 1
      ;;
  esac

  if [[ "$scenario" != "status" ]]; then
    if pgrep -if "comfyui" > /dev/null 2>&1; then
      echo "WARNING: ComfyUI Launcher appears to be running. Close it first - settings.json will be overwritten on the app's next save."
      read -rp "Continue anyway? (y/N) " reply
      [[ "$reply" =~ ^[Yy]$ ]] || exit 0
    fi
  fi

  case "$scenario" in
    status) print_first_use_status ;;
    reset)
      set_first_use_completed false
      echo "Done. Next launch will re-run the first-use takeover with current installs."
      ;;
    fresh)
      mutate_installs_filter_to_cloud_desktop_only
      set_first_use_completed false
      echo "Resulting state: skipPick=false. Cloud-vs-local pick will show."
      ;;
    returning)
      mutate_installs_ensure_standalone
      set_first_use_completed false
      echo "Bug #476 scenario armed: Accept TOS should drop into the chooser without auto-launching Cloud."
      ;;
    legacy)
      mutate_installs_ensure_desktop
      set_first_use_completed false
      echo "Pick Local in the takeover to surface the migrate-vs-install-new sub-step."
      ;;
    complete)
      set_first_use_completed true
      echo "Done. First-use takeover will NOT fire on next launch."
      ;;
  esac
}

# --- Dispatcher ----------------------------------------------------------
case "$ACTION" in
  save)
    require_name
    [[ -f "$INSTALLATIONS_FILE" ]] || { echo "Error: No installations.json found at $INSTALLATIONS_FILE" >&2; exit 1; }
    mkdir -p "$PROFILES_DIR"
    cp "$INSTALLATIONS_FILE" "$(profile_path "$NAME")"
    echo "Saved current installations.json as profile '$NAME'"
    ;;

  empty)
    backup_file "$INSTALLATIONS_FILE"
    printf '[]' > "$INSTALLATIONS_FILE"
    echo "Replaced installations.json with empty array (fresh state)"
    ;;

  primary-only)
    [[ -f "$INSTALLATIONS_FILE" ]] || { echo "Error: No installations.json found at $INSTALLATIONS_FILE" >&2; exit 1; }
    PRIMARY_ID=""
    if [[ -f "$SETTINGS_FILE" ]]; then
      PRIMARY_ID=$(python3 -c "
import json
with open('$SETTINGS_FILE') as f:
    s = json.load(f)
print(s.get('primaryInstallId', '') or '')
" 2>/dev/null || true)
    fi
    backup_file "$INSTALLATIONS_FILE"
    python3 - "$INSTALLATIONS_FILE" "$PRIMARY_ID" <<'PY'
import json, os, sys
path, primary_id = sys.argv[1], sys.argv[2]
with open(path) as f:
    installs = json.load(f)
primary = None
if primary_id:
    matches = [i for i in installs if i.get('id') == primary_id]
    if matches:
        primary = matches[0]
if not primary:
    eligible = [i for i in installs if i.get('sourceId') not in ('desktop', 'cloud')]
    if eligible:
        primary = eligible[0]
if not primary:
    print('Error: No eligible primary installation found.', file=sys.stderr)
    sys.exit(1)
install_path = primary.get('installPath', '')
if install_path and not os.path.exists(install_path):
    os.makedirs(install_path, exist_ok=True)
    sentinel = os.path.join(install_path, '.swap-test-sentinel')
    with open(sentinel, 'w') as sf:
        sf.write('created by swap-installations script')
    print(f'Created stub directory at {install_path}')
with open(path, 'w') as f:
    json.dump([primary], f, indent=2)
print(f"Kept only primary installation: {primary['name']} ({primary['id']})")
PY
    ;;

  load)
    require_name
    src="$(profile_path "$NAME")"
    [[ -f "$src" ]] || { echo "Error: Profile '$NAME' not found. Use 'list' to see available profiles." >&2; exit 1; }
    backup_file "$INSTALLATIONS_FILE"
    cp "$src" "$INSTALLATIONS_FILE"
    echo "Loaded profile '$NAME' as installations.json"
    ;;

  list)
    [[ -d "$PROFILES_DIR" ]] || { echo "No profiles saved yet."; exit 0; }
    shopt -s nullglob
    profiles=("$PROFILES_DIR"/*.json)
    shopt -u nullglob
    if [[ ${#profiles[@]} -eq 0 ]]; then echo "No profiles saved yet."; exit 0; fi
    echo "Saved profiles:"
    for p in "${profiles[@]}"; do
      name="$(basename "$p" .json)"
      count=$(python3 -c "import json; print(len(json.load(open('$p'))))" 2>/dev/null || echo "?")
      echo "  $name ($count installations)"
    done
    ;;

  delete)
    require_name
    target="$(profile_path "$NAME")"
    [[ -f "$target" ]] || { echo "Error: Profile '$NAME' not found." >&2; exit 1; }
    rm "$target"
    echo "Deleted profile '$NAME'"
    ;;

  first-use)
    invoke_first_use "$NAME"
    ;;

  restore)
    selector="${NAME:-}"
    shown="${selector:-original}"
    echo "Restoring from backup selector: '$shown'"
    restore_from_backup "$INSTALLATIONS_FILE" "$selector" true
    restore_from_backup "$SETTINGS_FILE" "$selector" false
    ;;

  merge)
    selector="${NAME:-}"
    if ! backup=$(resolve_backup "$INSTALLATIONS_FILE" "$selector"); then
      echo "Error: No installations.json backup found for selector '${selector:-original}'." >&2
      exit 1
    fi
    backup_file "$INSTALLATIONS_FILE"
    python3 - "$INSTALLATIONS_FILE" "$backup" <<'PY'
import json, sys
current_path, backup_path = sys.argv[1], sys.argv[2]
def load_list(p):
    try:
        with open(p) as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except Exception:
        return []
current = load_list(current_path)
backup = load_list(backup_path)
current_ids = {c.get('id') for c in current if c.get('id')}
added = 0
for b in backup:
    bid = b.get('id')
    if not bid or bid in current_ids:
        continue
    current.append(b)
    current_ids.add(bid)
    added += 1
with open(current_path, 'w') as f:
    json.dump(current, f, indent=2)
import os
print(f"Merged {os.path.basename(backup_path)} into installations.json: added {added} entry/entries (current values kept on id collisions).")
PY
    ;;

  list-backups)
    for p in "$INSTALLATIONS_FILE" "$SETTINGS_FILE"; do
      name="$(basename "$p")"
      echo "$name backups in $(dirname "$p") :"
      legacy="${p}.bak"
      shopt -s nullglob
      backups=( "${p}".*.bak )
      shopt -u nullglob
      printed=false
      if [[ -f "$legacy" ]]; then
        if stat --version >/dev/null 2>&1; then
          info=$(stat -c '  %y  %7s B  %n' "$legacy")
        else
          info=$(stat -f '  %Sm  %z B  %N' "$legacy")
        fi
        echo "$info"
        printed=true
      fi
      if [[ ${#backups[@]} -gt 0 ]]; then
        for b in $(ls -1t "${backups[@]}" 2>/dev/null | tac); do
          if stat --version >/dev/null 2>&1; then
            stat -c '  %y  %7s B  %n' "$b"
          else
            stat -f '  %Sm  %z B  %N' "$b"
          fi
        done
        printed=true
      fi
      if [[ "$printed" == false ]]; then echo "  (none)"; fi
      echo ""
    done
    ;;

  *)
    echo "Unknown action: $ACTION" >&2
    echo "Usage: $0 {save|load|empty|primary-only|list|delete|first-use|restore|merge|list-backups} [name]" >&2
    exit 1
    ;;
esac
