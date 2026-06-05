<div align="center">

<img src="assets/Comfy_Logo_x512.png" alt="Comfy Desktop" width="128" />

# Comfy Desktop

**Install, run, and manage [ComfyUI](https://github.com/Comfy-Org/ComfyUI) from one app — no dependency hell.**

[![Release](https://img.shields.io/github/v/release/Comfy-Org/Comfy-Desktop?display_name=tag&style=flat&label=release&color=4f46e5)](https://github.com/Comfy-Org/Comfy-Desktop/releases/latest)
[![CI](https://img.shields.io/github/actions/workflow/status/Comfy-Org/Comfy-Desktop/ci.yml?branch=main&style=flat&label=CI)](https://github.com/Comfy-Org/Comfy-Desktop/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/Comfy-Org/Comfy-Desktop?style=flat&color=blue)](LICENSE)
[![Stars](https://img.shields.io/github/stars/Comfy-Org/Comfy-Desktop?style=flat&logo=github&color=f5c518)](https://github.com/Comfy-Org/Comfy-Desktop/stargazers)
[![Discord](https://img.shields.io/badge/Discord-comfy.org-5865F2?style=flat&logo=discord&logoColor=white)](https://www.comfy.org/discord)
![Platforms](https://img.shields.io/badge/platforms-Windows%20·%20macOS-555?style=flat)

[**Download**](#download) · [**Getting Started**](#getting-started) · [**Contributing**](#development) · [**Discord**](https://www.comfy.org/discord)

</div>

---

Comfy Desktop is the official desktop application for **ComfyUI**, the node-based engine for generative AI. It installs ComfyUI into a self-contained, GPU-ready environment, lets you run **multiple independent setups side by side**, and keeps them updated — so you spend your time building workflows instead of fighting Python, CUDA, and pip.

<div align="center">
  <img src="assets/hero.png" alt="Comfy Desktop — run multiple ComfyUI installs side by side from one app" width="820" />
</div>

## Features

- 🧩 **Multiple installs, side by side** — run as many independent ComfyUI setups as you like, each with its own version, models, and custom nodes. Switch between them without conflicts.
- 📦 **Isolated, GPU-ready environments** — each install ships a relocatable Python with PyTorch and GPU wheels prebuilt. No pip/uv failures, no CUDA roulette at install time.
- 🔄 **One-click updates** — update ComfyUI (and custom nodes) to the latest version in place. No terminal, no git, no re-downloading the multi-gigabyte environment.
- 📸 **Snapshots & rollback** — back up an install and restore it if an update or a custom node breaks something.
- 📥 **Bring your existing setup** — adopt and migrate existing ComfyUI installations (portable, git, or a previous desktop install) in place.
- 🖥️ **Cross-platform** — Windows, macOS, and Linux.
- ⬆️ **Built-in auto-updates** — the app keeps itself current.
- 🛠️ **Works without system Git** — bundles a tiny Python + `pygit2` bootstrap so clones work on a clean machine.

## Download

<div align="center">

[![Download Comfy Desktop](https://img.shields.io/badge/⬇%20Download%20Comfy%20Desktop-Windows%20·%20macOS-4f46e5?style=for-the-badge)](https://dl.todesktop.com/241130tqe9q3y)

**[dl.todesktop.com/241130tqe9q3y](https://dl.todesktop.com/241130tqe9q3y)** — one link, auto-detects your platform.

</div>

> **New to ComfyUI?** Just download, install, and open the app — it walks you through creating your first setup. No terminal required.

**Requirements:** Windows, macOS (Apple Silicon), or Linux. A dedicated GPU (NVIDIA / AMD) or Apple Silicon is recommended for good performance, but not required.

<details>
<summary><b>Install instructions per platform</b></summary>

**Windows** — run the NSIS installer (`.exe`) and launch from the Start Menu or desktop shortcut.

**macOS** — open the `.dmg`, drag **Comfy Desktop** to Applications, and launch from there.

**Linux** — `.deb` (Debian/Ubuntu), from the directory you downloaded it to:
```bash
sudo apt install ./*.deb
```
AppImage:
```bash
chmod +x ./*.AppImage
./*.AppImage --no-sandbox
```
Then launch from your application menu.

</details>

## Getting Started

1. **Download and install** Comfy Desktop for your OS (above).
2. **Launch the app.**
3. **Create a new install** — pick a standalone, GPU-ready environment and Comfy Desktop downloads and provisions it for you. (Already have a ComfyUI install? Import it instead.)
4. **Hit launch** — the app starts ComfyUI and opens it, ready to build.

From there you can add more installs, take snapshots before risky changes, and update ComfyUI or its custom nodes per install.

## Development

Contributions are welcome. The app is an [Electron](https://www.electronjs.org/) + [Vue 3](https://vuejs.org/) + [TypeScript](https://www.typescriptlang.org/) project built with [electron-vite](https://electron-vite.org/).

### Prerequisites

- [**Node.js**](https://nodejs.org/) v22 LTS or later
- [**pnpm**](https://pnpm.io/) v10 or later (via Corepack)

```bash
nvm install 22 && nvm use 22   # recommended — https://github.com/nvm-sh/nvm
corepack enable                # enables pnpm (bundled with Node)
```

### Setup

```bash
git clone https://github.com/Comfy-Org/Comfy-Desktop.git
cd Comfy-Desktop
pnpm run init
```

`pnpm run init` is the one-shot for a fresh clone: it runs `pnpm install` (with the `postinstall` + husky hooks) and `pnpm run bootstrap` to build the bundled bootstrap Python (see below).

### Run in development

```bash
pnpm run dev               # Windows / macOS
./linux-dev.sh             # Linux
```

### Common tasks

| Command | Description |
|---|---|
| `pnpm run dev` | Start the app in dev mode |
| `pnpm test` | Unit tests ([Vitest](https://vitest.dev/)) |
| `pnpm run test:integration` | Integration suite |
| `pnpm run test:e2e` | End-to-end tests ([Playwright](https://playwright.dev/)) |
| `pnpm run typecheck` | Type-check (node + web + e2e + integration) |
| `pnpm run lint` / `lint:fix` | Lint (ESLint) |
| `pnpm run format` | Format (Prettier) |
| `pnpm run build:{win,mac,linux}` | Build local distributables → `dist/` |

### Project structure

```
src/
  main/          # Electron main process (TypeScript)
    sources/     # Install-method plugins (standalone, portable, git, …)
    lib/         # Shared main-process logic + IPC
  preload/       # Context-bridge preload scripts
  renderer/src/  # Vue 3 renderer (components, composables, stores, views)
  types/         # Shared IPC types (single source of truth)
locales/         # i18n translations
```

<details>
<summary><b>Bootstrap Python</b> (the bundled Git backend)</summary>

The app ships a minimal (~15–20 MB) standalone Python with `pygit2` baked in, under `bootstrap-python/<platform>/`. It provides git operations (clone, fetch, ls-remote) before any standalone ComfyUI environment is provisioned, so the app works on machines without system `git`.

| Command | What it does |
|---|---|
| `pnpm run bootstrap` | Build locally via `scripts/build-bootstrap-python.py` (requires Python 3.13). Auto-detects the host platform; pass `--platform win-x64\|mac-arm64\|linux-x64` for another. |
| `pnpm run bootstrap:fetch` | Download a prebuilt archive from the [`bootstrap-v1`](https://github.com/Comfy-Org/Comfy-Desktop/releases/tag/bootstrap-v1) release (faster; no local Python needed). Set `GITHUB_TOKEN` to authenticate. |

Both write to `bootstrap-python/{win-x64,mac-arm64,linux-x64}/` (gitignored). The directory must exist before `pnpm run dev` or `pnpm run build:*`.

At runtime the main process picks a git backend in priority order ([`src/main/lib/ipc/index.ts`](src/main/lib/ipc/index.ts)): bootstrap pygit2 → standalone-install pygit2 → system `git`. Set `COMFY_FORCE_BOOTSTRAP_GIT=1` (or `pnpm run dev:bootstrap`) to verify the bundled path that ships to users without git.

</details>

## Releasing

> Production builds are **not** built locally — they go through [ToDesktop](https://www.todesktop.com/) in CI.

<details>
<summary><b>Release pipeline &amp; required secrets</b></summary>

Three workflows in [`.github/workflows/`](.github/workflows/):

| Workflow | Trigger | Role |
|---|---|---|
| `version-bump.yml` | manual | Opens a `chore: bump version to vX.Y.Z` PR with the `Release` label. |
| `release-from-pr-label.yml` | `pull_request_target: closed` | On merge of a `Release`-labeled PR, tags `vX.Y.Z` and dispatches the build. |
| `build-release.yml` | push of `v*` tag | Runs `pnpm run build`, uploads Datadog sourcemaps, runs `todesktop build`, and creates a **draft** GitHub Release. |

**Recommended flow:**
```bash
gh workflow run version-bump.yml -f bump=patch -f release=true
```
Review &amp; merge the resulting PR; the tag + build are then automatic. Finally, publish the draft Release from the [Releases](../../releases) page.

**Required GitHub Actions secrets:** `TODESKTOP_ACCESS_TOKEN`, `TODESKTOP_EMAIL` (ToDesktop CLI), `DATADOG_API_KEY` (RUM sourcemaps), `BEN_PAT` (version-bump PR).

</details>

## Data &amp; Troubleshooting

<details>
<summary><b>Data locations</b></summary>

On Windows/macOS, app data lives under the standard Electron `userData` path. Dev and production use **separate** directories because Electron derives the name from `package.json` `name` (`comfyui-desktop-2`) in dev vs `productName` (`Comfy Desktop`) in packaged builds:

| | Windows | macOS | Linux |
|---|---|---|---|
| **Dev** | `%APPDATA%\comfyui-desktop-2` | `~/Library/Application Support/comfyui-desktop-2` | `~/.config/comfyui-desktop-2` |
| **Production** | `%APPDATA%\Comfy Desktop` | `~/Library/Application Support/Comfy Desktop` | `~/.config/Comfy Desktop` |

On Linux the app follows the [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir-spec/latest/) for config, data, cache, and state. The default install directory is `~/ComfyUI-Installs`.

</details>

<details>
<summary><b>Reset / clean install</b></summary>

If a manual update leaves the app broken (no styling, dead dropdowns — usually a stale Chromium profile), the [`scripts/reset-*`](scripts/) helpers wipe every known data location. They **prompt before deleting** and **do not touch** your `~/ComfyUI-Installs`.

Quit the app first, then:

```powershell
# Windows (PowerShell)
iwr -useb https://raw.githubusercontent.com/Comfy-Org/Comfy-Desktop/main/scripts/reset-windows.ps1 -OutFile reset-windows.ps1
powershell -ExecutionPolicy Bypass -File .\reset-windows.ps1
```
```sh
# macOS
curl -fsSLO https://raw.githubusercontent.com/Comfy-Org/Comfy-Desktop/main/scripts/reset-mac.sh && bash reset-mac.sh
# Linux
curl -fsSLO https://raw.githubusercontent.com/Comfy-Org/Comfy-Desktop/main/scripts/reset-linux.sh && bash reset-linux.sh
```

Pass `--yes` (or `-Yes` on Windows) to skip the prompt. After cleanup, reinstall from the latest release. You may need to re-add installations via **"Add existing installation"** since `installations.json` is wiped too.

</details>

## Contributing

Issues and pull requests are welcome. Before opening a PR, please run `pnpm run typecheck`, `pnpm run lint`, and `pnpm test` locally — see [Development](#development). For coding conventions, see [`AGENTS.md`](AGENTS.md).

## Community

- 💬 **Discord** — [comfy.org/discord](https://www.comfy.org/discord)
- 🌐 **Website** — [comfy.org](https://www.comfy.org)
- 🐛 **Issues** — [GitHub Issues](https://github.com/Comfy-Org/Comfy-Desktop/issues)
- 🧠 **ComfyUI** — [github.com/Comfy-Org/ComfyUI](https://github.com/Comfy-Org/ComfyUI)
- 📦 **Standalone Environments** — [ComfyUI-Standalone-Environments](https://github.com/Comfy-Org/ComfyUI-Standalone-Environments)

## License

Released under the [MIT License](LICENSE). © Comfy Org.
