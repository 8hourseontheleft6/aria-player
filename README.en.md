# Aria

[中文](README.md) | **English**

A local music player for Windows and macOS with an iOS-flavoured interface. Electron shell,
**no build step** (the renderer is plain ES modules), no account, no telemetry, no bundled content.

![tech](https://img.shields.io/badge/Electron-43-0a84ff) ![tech](https://img.shields.io/badge/renderer-native%20ESM-5e5ce6) ![license](https://img.shields.io/badge/license-MIT-30d158)

> Version lives in `package.json`. Still pre-1.0: data structures and internal APIs may change.

## Screenshots

| Library | Now playing |
| --- | --- |
| ![Library](docs/screenshots/01-library.png) | ![Now playing](docs/screenshots/02-now-playing.png) |

| Media wall | Dark mode |
| --- | --- |
| ![Media wall](docs/screenshots/12-wall.png) | ![Dark library](docs/screenshots/08-library-dark.png) |

## Three products, one codebase

Same source, three identities. The only difference is **which capabilities get mounted at launch**
(services / plugins / sidebar):

| Product | What it is | How you launch it |
| --- | --- | --- |
| **Aria** | Full app: library, albums/artists, media wall, online metadata, tray | Click the icon |
| **Aria Player** | Lightweight player: no library, plays "opened files" only | Double-click an audio file |
| **Aria Unified** | One installer, two modes: **icon = full, double-click audio = player** | Depends on whether argv contains a real audio file |

Each product/mode has its **own `userData` directory** and its own single-instance lock, so they can run
side by side. Only Aria Player and Aria Unified register file associations — the full app never hijacks
"double-click .mp3".

## Install / build / self-check

```bash
npm ci                  # reproducible install (package-lock.json is committed)
npm start               # run the app
npm run fixtures        # generate the wav fixtures used for manual testing (tests/ is not committed)
npm run check           # 13 static checks (fast, safe for CI)
npm run smoke           # UI self-check: needs a desktop session and a real music folder

npm run dist            # Aria         → release/Aria-Setup-<version>.exe      + Aria-<version>-portable.exe
npm run dist:player     # Aria Player  → release-player/
npm run dist:unified    # Aria Unified → release-unified/
```

`npm run smoke` opens real windows, takes the single-instance lock, simulates drag & drop and even moves
the OS cursor — **it cannot run in CI**. Close every running Aria instance first. CI only runs
`npm ci && npm run check` (see `.github/workflows/check.yml`).

## Unsigned builds

Release binaries are **not code-signed**. Windows SmartScreen shows "Windows protected your PC" →
*More info* → *Run anyway*. macOS Gatekeeper refuses the first launch → right-click the app → *Open*,
or `xattr -dr com.apple.quarantine /Applications/Aria.app`. On Apple Silicon an unsigned build may report
"damaged"; the repo's pack script applies an ad-hoc signature (`scripts/mac-adhoc-sign.js`).

## Legal

- **No content is provided.** The repository contains no audio, no artwork and no lyrics, and ships no
  online sources. Online sources are scripts *you* import yourself.
- For personal use and learning only. Play files you own or are allowed to use.
- Online features: the master switch and **online lyrics are ON by default** (it queries LRCLIB only when
  a local `.lrc` is missing), **online covers are OFF by default**. Turn the master switch off and the app
  works fully offline. Requests come from your machine; nothing is proxied or collected.
- Not affiliated with Apple Inc. "iOS"/"macOS"/"Windows" are mentioned only to describe compatibility.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) (in Chinese), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) and
[SECURITY.md](SECURITY.md). The self-checks are the contract: never relax an assertion.

## License

[MIT](LICENSE) © 2026 Aria contributors.
Third-party dependencies and assets: see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
