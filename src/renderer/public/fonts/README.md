# Proprietary fonts (do not commit binaries here)

This directory holds **PP Formula** (Pangram Pangram), the display face used for
brand takeover headings. It is a paid, license-restricted font and **must never
be committed to this public repository**.

The font files in this folder are gitignored (see the repo `.gitignore`). Only
this README is tracked, so the directory and these instructions survive a clean
checkout.

## How it is loaded

`src/renderer/src/assets/main.css` declares `@font-face { font-family: 'PP Formula';
src: url('/fonts/PPFormula-Extrabold.otf') ... }`. It is served from this public
dir. When the file is absent (OSS clones, most dev and CI builds) the
`--font-display` stack falls back to Inter, so the app still renders correctly.

## Release builds

`build-release.yml` authenticates to GCP via Workload Identity Federation and runs
`pnpm run font:fetch` before building, which downloads the font into this folder
from the private bucket `gs://comfy-org-fonts`.

## Local development

The font is optional for dev (the app falls back to Inter). To render the real
display face locally, authenticate with a comfy.org Google account and run:

```bash
pnpm run font:fetch
```

This requires read access to `gs://comfy-org-fonts`.
