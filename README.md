# ComfyUI Desktop 2.0

[![Latest Release](https://img.shields.io/github/v/release/Comfy-Org/ComfyUI-Desktop-2.0-Beta?style=for-the-badge&display_name=tag)](https://github.com/Comfy-Org/ComfyUI-Desktop-2.0-Beta/releases/latest)
[![CI](https://img.shields.io/github/actions/workflow/status/Comfy-Org/ComfyUI-Desktop-2.0-Beta/ci.yml?branch=main&style=for-the-badge&label=CI)](https://github.com/Comfy-Org/ComfyUI-Desktop-2.0-Beta/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/Comfy-Org/ComfyUI-Desktop-2.0-Beta?style=for-the-badge)](https://github.com/Comfy-Org/ComfyUI-Desktop-2.0-Beta/blob/main/LICENSE)

An Electron app for managing multiple ComfyUI installations.

## Related Repositories

- [ComfyUI-Standalone-Environments](https://github.com/Comfy-Org/ComfyUI-Standalone-Environments) — Standalone environment definitions used by this app to provision Python environments for ComfyUI installations.

## Downloads

### Windows

[![Windows x64](https://img.shields.io/badge/Windows-x64-0078D6?style=for-the-badge&logo=windows&logoColor=white)](https://dl.todesktop.com/241130tqe9q3y/windows/nsis/x64)
[![Windows ARM64](https://img.shields.io/badge/Windows-ARM64-0078D6?style=for-the-badge&logo=windows&logoColor=white)](https://dl.todesktop.com/241130tqe9q3y/windows/nsis/arm64)

### macOS

[![macOS Apple Silicon](https://img.shields.io/badge/macOS-Apple%20Silicon-000000?style=for-the-badge&logo=apple&logoColor=white)](https://dl.todesktop.com/241130tqe9q3y/mac/dmg/arm64)

## Running

### Windows

Run the NSIS installer (`.exe`) and launch from the Start Menu or desktop shortcut.

### macOS

Open the `.dmg`, drag ComfyUI Desktop 2.0 to Applications, and launch from there.

### Linux

**`.deb` (Debian/Ubuntu):**
```bash
sudo apt install ./ComfyUI-Desktop-2.0-*.deb
```
Then launch from your application menu.

**AppImage:**
```bash
chmod +x ComfyUI-Desktop-2.0-*.AppImage
./ComfyUI-Desktop-2.0-*.AppImage --no-sandbox
```

## Development

### Prerequisites

- [Node.js](https://nodejs.org/) **v22 LTS** or later
- [pnpm](https://pnpm.io/) **v10** or later (via Corepack recommended)

We recommend using [nvm](https://github.com/nvm-sh/nvm) (or [nvm-windows](https://github.com/coreybutler/nvm-windows)) to manage Node versions:

```bash
# Install and use Node 22
nvm install 22
nvm use 22

# Verify
node --version   # should print v22.x.x

# Enable pnpm via Corepack (bundled with Node)
corepack enable
pnpm --version
```

### Stack

- **Build tool:** [electron-vite](https://electron-vite.org/)
- **Renderer:** [Vue 3](https://vuejs.org/) (Composition API) + [TypeScript](https://www.typescriptlang.org/)
- **State:** [Pinia](https://pinia.vuejs.org/)
- **i18n:** [vue-i18n](https://vue-i18n.intlify.dev/) (locale files in `locales/`)
- **Styling:** [Tailwind CSS v4](https://tailwindcss.com/)
- **Icons:** [Lucide](https://lucide.dev/)
- **Main process:** TypeScript (`src/main/`)
- **Linting:** [ESLint](https://eslint.org/) (flat config) + [Prettier](https://prettier.io/)
- **Testing:** [Vitest](https://vitest.dev/) + [Vue Test Utils](https://test-utils.vuejs.org/)

### Project structure

```
src/
  main/          # Electron main process (TypeScript)
  preload/       # Preload scripts (context bridge)
  renderer/src/  # Vue 3 renderer
    components/  # Reusable UI components
    composables/ # Vue composables (useModal, useTheme, …)
    stores/      # Pinia stores (session, installation)
    views/       # Top-level views and modal views
    types/       # Renderer-side type re-exports
  types/         # Shared IPC types (single source of truth)
locales/         # i18n translation files
sources/         # Installation source plugins
```

### Setup

```bash
git clone https://github.com/Comfy-Org/ComfyUI-Desktop-2.0-Beta.git
cd ComfyUI-Desktop-2.0-Beta
pnpm run init
```

`pnpm run init` is the recommended one-shot for a fresh clone. It runs `pnpm install` (which also fires the `postinstall` hook and husky `prepare`), then `pnpm run bootstrap` to build the **bootstrap Python** environment described below.

#### Bootstrap Python

The app ships a minimal (~15–20 MB) standalone Python with `pygit2` baked in, under `bootstrap-python/<platform>/`. It provides git operations (clone, fetch, ls-remote) before any standalone ComfyUI environment has been provisioned, so the app works on machines without system `git` installed.

| Command | What it does |
|---|---|
| `pnpm run bootstrap` | Build locally via `scripts/build-bootstrap-python.py` (requires Python 3.13). Downloads `python-build-standalone`, installs `pygit2`, strips test/idle/tkinter junk. Auto-detects the host platform; pass `--platform win-x64\|mac-arm64\|linux-x64` to build a different one. |
| `pnpm run bootstrap:fetch` | Download a prebuilt archive from the [`bootstrap-v1`](https://github.com/Comfy-Org/ComfyUI-Desktop-2.0-Beta/releases/tag/bootstrap-v1) release (faster, no local Python needed). Pass `--tag <name>` to use a different release. Set `GITHUB_TOKEN` to authenticate. |

Both targets write to `bootstrap-python/{win-x64,mac-arm64,linux-x64}/` (gitignored). The directory must exist before running `pnpm run dev` or `pnpm run build:*` — `pnpm run predev` prints a yellow warning if it's missing.

At runtime the main process picks a git backend in priority order ([`src/main/lib/ipc/index.ts`](src/main/lib/ipc/index.ts)): bootstrap pygit2 → standalone-install pygit2 → system `git`. Set `COMFY_FORCE_BOOTSTRAP_GIT=1` to disable the fallbacks (used by `pnpm run dev:bootstrap` to verify the bootstrap path that ships to users without git).

### Run in development

**Windows / macOS:**
```bash
pnpm run dev               # standard dev mode
pnpm run dev:bootstrap     # force COMFY_FORCE_BOOTSTRAP_GIT=1; auto-builds bootstrap python if missing
```

**Linux:**
```bash
./linux-dev.sh
```

### Type checking

```bash
pnpm run typecheck                # node + web + e2e + integration
pnpm run typecheck:node           # main process only
pnpm run typecheck:web            # renderer only
pnpm run typecheck:e2e            # Playwright suite
pnpm run typecheck:integration    # vitest integration suite
```

### Linting

```bash
pnpm run lint           # check for lint errors
pnpm run lint:fix       # auto-fix lint errors
pnpm run format         # format with Prettier
pnpm run format:check   # check formatting without writing
```

### Testing

```bash
pnpm test                  # all unit tests (vitest)
pnpm run test:watch        # vitest watch mode
pnpm run test:integration  # integration suite (vitest.integration.config.ts)
pnpm run test:e2e          # Playwright e2e (use :macos / :windows / :linux to scope)
```

### Build for distribution

```bash
# Platform-specific (electron-builder, local install/dev artifacts)
pnpm run build:win      # Windows (NSIS installer)
pnpm run build:mac      # macOS (DMG)
pnpm run build:linux    # Linux (AppImage, .deb)
```

Output is written to `dist/`. These targets require `bootstrap-python/<platform>/` to exist — run `pnpm run bootstrap` (or `pnpm run bootstrap:fetch`) first.

> Production releases are **not** built locally — they go through ToDesktop in CI (see [Releasing](#releasing)). The ToDesktop pipeline calls `scripts/todesktop-beforeBuild.cjs`, which runs `fetch-bootstrap-python.mjs` to pull the prebuilt bootstrap python for the target platform.

## Releasing

The release pipeline is fully automated via three workflows in [`.github/workflows/`](.github/workflows/):

| Workflow | Trigger | Role |
|---|---|---|
| [`version-bump.yml`](.github/workflows/version-bump.yml) | manual (`workflow_dispatch`) | Opens a `chore: bump version to vX.Y.Z` PR with the `Release` label. |
| [`release-from-pr-label.yml`](.github/workflows/release-from-pr-label.yml) | `pull_request_target: closed` | When a `Release`-labeled PR merges, creates the `vX.Y.Z` tag on the merge commit and dispatches the build workflow. |
| [`build-release.yml`](.github/workflows/build-release.yml) | `push` of `v*` tag (or manual) | Runs `pnpm run build`, uploads Datadog sourcemaps, runs `todesktop build`, parses the build log, uploads `release-assets.json`, and creates a **draft** GitHub Release with auto-generated notes. |

```diagram
╭──────────────────────────╮  workflow_dispatch   ╭──────────────────────────╮
│ Version Bump PR          │─────────────────────▶│ PR opened with           │
│ (version-bump.yml)       │                      │ "Release" label          │
╰──────────────────────────╯                      ╰────────────┬─────────────╯
                                                               │ merge
                                                               ▼
╭──────────────────────────╮  on: pull_request_target  ╭───────────────────╮
│ Release From Version PR  │◀──────────────────────────│ closed PR (merged)│
│ (release-from-pr-label)  │                           ╰───────────────────╯
│   • detects version bump │
│   • creates v{x.y.z} tag │
│   • dispatches build     │
╰────────┬─────────────────╯
         │ workflow dispatch on tag
         ▼
╭──────────────────────────╮
│ ToDesktop Build & Release│  • pnpm run build
│ (build-release.yml)      │  • Datadog sourcemap upload
│                          │  • todesktop build --ephemeral
│                          │  • parse log → release-assets.json
│                          │  • gh release create --draft --generate-notes
╰──────────────────────────╯
```

### Recommended (automated) flow

1. **Trigger `Version Bump PR`** from the Actions tab (or via CLI):
   ```bash
   gh workflow run version-bump.yml -f bump=patch -f release=true
   ```
   This opens a `chore: bump version to vX.Y.Z` PR on a branch like `automation/version-bump/main/v0.5.1`, with the `Release` label applied. `bump` accepts `patch | minor | major`.
2. **Review & merge** that PR. After it merges, the `release-from-pr-label.yml` workflow notices the `Release` label, creates and pushes the `vX.Y.Z` tag on the merge commit, and dispatches `build-release.yml` for that tag.
3. **Publish the draft** — `build-release.yml` produces a draft GitHub Release. Review it on the [Releases](../../releases) page and hit **Publish**.

### Manual fallback

If automation is unavailable, follow the manual flow:

```bash
git checkout main && git pull origin main
git checkout -b release/v0.5.1
# Edit package.json "version": "0.5.1"
git add package.json
git commit -m "chore: bump version to 0.5.1"
git push origin release/v0.5.1
# Open + merge a PR targeting main
git checkout main && git pull origin main
git tag v0.5.1
git push origin v0.5.1   # triggers build-release.yml
```

`build-release.yml` enforces that the tag matches `package.json`'s `version`; the automated flow handles this for you.

### Required secrets

`build-release.yml` and `version-bump.yml` rely on these GitHub Actions secrets:

| Secret | Used by | Purpose |
|---|---|---|
| `TODESKTOP_ACCESS_TOKEN` | build-release | Auth for the ToDesktop CLI |
| `TODESKTOP_EMAIL` | build-release | ToDesktop account email |
| `DATADOG_API_KEY` | build-release | Upload renderer sourcemaps to Datadog (US5) for RUM symbolication |
| `BEN_PAT` | version-bump | PAT used to open/edit the version-bump PR (so it triggers CI checks that the default `GITHUB_TOKEN` would skip) |

### Bootstrap python in releases

The `bootstrap-v1` GitHub release stores prebuilt `bootstrap-python-{win-x64,mac-arm64,linux-x64}.tar.gz` archives produced by [`build-bootstrap-python.yml`](.github/workflows/build-bootstrap-python.yml). During a ToDesktop build, [`scripts/todesktop-beforeBuild.cjs`](scripts/todesktop-beforeBuild.cjs) runs `fetch-bootstrap-python.mjs` to download the archive matching the build's target platform and extract it into `bootstrap-python/<platform>/` so it's bundled into the installer. To rebuild and publish a new bootstrap release, dispatch the bootstrap workflow and update the `--tag` argument if you change the release name.

## Data Locations

On **Windows** and **macOS**, all app data lives under the standard Electron `userData` path.

> **Dev vs. production path difference:** Electron derives the `userData` directory name from the app's name. In development (`pnpm run dev`), it uses the `name` field from `package.json` (`comfyui-desktop-2`), while packaged builds use the `productName` from `electron-builder.yml` (`ComfyUI Desktop 2.0`). This means the two environments use separate data directories:
>
> | | Windows | macOS | Linux |
> |---|---|---|---|
> | **Dev** | `%APPDATA%\comfyui-desktop-2` | `~/Library/Application Support/comfyui-desktop-2` | `~/.config/comfyui-desktop-2` |
> | **Production** | `%APPDATA%\ComfyUI Desktop 2.0` | `~/Library/Application Support/ComfyUI Desktop 2.0` | `~/.config/ComfyUI Desktop 2.0` |

On **Linux**, the app follows the [XDG Base Directory Specification](https://wiki.archlinux.org/title/XDG_Base_Directory):

| Purpose | Linux Path |
|---------|------------|
| Config (`settings.json`) | `$XDG_CONFIG_HOME/comfyui-desktop-2` (default `~/.config/comfyui-desktop-2`) |
| Data (`installations.json`) | `$XDG_DATA_HOME/comfyui-desktop-2` (default `~/.local/share/comfyui-desktop-2`) |
| Cache (`download-cache/`) | `$XDG_CACHE_HOME/comfyui-desktop-2` (default `~/.cache/comfyui-desktop-2`) |
| State (`port-locks/`) | `$XDG_STATE_HOME/comfyui-desktop-2` (default `~/.local/state/comfyui-desktop-2`) |
| Default install dir | `~/ComfyUI-Installs` |

Existing files at the old `~/.config/comfyui-desktop-2` location are automatically migrated on first launch.

### Reset / clean install

If a manual update leaves the app in a broken state (no styling, no i18n, dead dropdowns, etc. — usually caused by a stale Chromium profile from a prior beta version), the [`scripts/reset-*`](scripts/) helpers wipe every known data location for the current build **and** the older beta names (`ComfyUI Launcher`, `comfyui-launcher`, `com.kosinkadink.comfyui-launcher`, `org.comfy.comfyui-launcher`). They prompt before deleting anything and **do not touch** `~/ComfyUI-Installs` (Windows: `%USERPROFILE%\ComfyUI-Installs`).

Quit the app first, then:

**macOS:**
```sh
curl -fsSLO https://raw.githubusercontent.com/Comfy-Org/ComfyUI-Desktop-2.0-Beta/main/scripts/reset-mac.sh
bash reset-mac.sh
```

**Linux:**
```sh
curl -fsSLO https://raw.githubusercontent.com/Comfy-Org/ComfyUI-Desktop-2.0-Beta/main/scripts/reset-linux.sh
bash reset-linux.sh
```

**Windows (PowerShell):**
```powershell
iwr -useb https://raw.githubusercontent.com/Comfy-Org/ComfyUI-Desktop-2.0-Beta/main/scripts/reset-windows.ps1 -OutFile reset-windows.ps1
powershell -ExecutionPolicy Bypass -File .\reset-windows.ps1
```

Pass `--yes` (or `-Yes` on Windows) to skip the confirmation prompt. After cleanup, reinstall from the latest release and launch — the app should come up with a clean profile. You may need to re-add existing installations via **"Add existing installation"** since `installations.json` is wiped too.
