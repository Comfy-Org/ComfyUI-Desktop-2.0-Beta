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
pnpm install
```

### Run in development

**Windows / macOS:**
```bash
pnpm run dev
```

**Linux:**
```bash
./linux-dev.sh
```

### Type checking

```bash
pnpm run typecheck          # both main + renderer
pnpm run typecheck:node     # main process only
pnpm run typecheck:web      # renderer only
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
pnpm test               # run all unit tests
pnpm run test:watch     # run in watch mode
```

### Build for distribution

```bash
# Platform-specific
pnpm run build:win      # Windows (NSIS installer)
pnpm run build:mac      # macOS (DMG)
pnpm run build:linux    # Linux (AppImage, .deb)
```

Build output is written to the `dist/` directory.

## Releasing

Pushing a version tag to `main` triggers the **ToDesktop Build & Release** workflow. It runs a ToDesktop cloud build and creates a draft GitHub Release with platform download links. The workflow enforces that the tag matches the `version` in `package.json`.

### Release steps

1. **Bump the version** — create a branch, update the `version` field in `package.json` (e.g. `0.4.4` → `0.4.5`), and open a PR:

   ```bash
   git checkout main && git pull origin main
   git checkout -b release/v0.4.5
   # Edit package.json "version": "0.4.5"
   git add package.json
   git commit -m "chore: bump version to 0.4.5"
   git push origin release/v0.4.5
   # Open a PR targeting main
   ```

2. **Merge the PR** — once CI passes and the PR is approved, merge it into `main`.

3. **Tag and push** — pull the merged `main`, create the tag, and push it to trigger the build:

   ```bash
   git checkout main && git pull origin main
   git tag v0.4.5
   git push origin v0.4.5
   ```

4. **Publish** — once the build finishes, go to the [Releases](../../releases) page to review and publish the draft.

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
