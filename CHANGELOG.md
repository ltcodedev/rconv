# Changelog

All notable changes to this project will be documented in this file.

## [1.2.0] - 2026-10-14

### Added
- Native Rust GUI powered by Slint (`rconv-gui`), fully compatible with Wayland and X11 without WebKitGTK dependencies
- Direct video downloading using `yt-dlp` with automatic conversion to DaVinci Resolve compatible `.mov` in both CLI, TUI and GUI
- Multi-track External Audio support (`Faixas de Áudio Externo Adicionais`) for dedicated microphones and field recorders
- DaVinci Resolve-style Waveform Audio Synchronization via Fast Fourier Transform (FFT) cross-correlation with millisecond precision
- Interactive Reference Track Selector (`Faixa de Referência`) allowing external tracks to sync against any video audio stream
- Manual offset adjustment and latency compensation in seconds (`+ retardo / - avanço`)
- Dynamic UI responsiveness with dedicated `ScrollView` ensuring accessibility across compact displays and laptops
- Conditional folder controls: recursive toggle and batch parameters only display for folder selections, while audio sync is dedicated to file inputs
- Video quality selection for downloads (`best`, `1080p`, `720p`, `480p`, `360p`, `audio`) via `-q, --quality` flag
- Dedicated CLI command `rconv download <url>` with alias `rconv dl <url>`
- Transparent URL detection for the `-i, --input <url>` parameter
- Option `--keep-original` to preserve the downloaded original file alongside the converted video
- Option `-F, --list-qualities` to probe and list all available resolutions for a video before downloading
- Dynamic detection of available video resolutions in the TUI when entering a video URL
- Redesigned interactive TUI with top navigation tabs (`Arquivos Locais`, `Baixar da Web`, `Sobre & Ajuda`)
- Button-styled actions panel in TUI with clear icons and visual feedback
- Dedicated Web Download tab in TUI with modal video quality picker displaying real video formats
- Automated GitHub Actions release pipeline (`.github/workflows/release-gui.yml`) compiling standalone Linux binaries upon tag push
- Programmatic exports `downloadAndConvert`, `downloadVideo`, `fetchVideoMetadata`, `checkYtDlp`, `isHttpUrl`, and `getFormatForQuality`

### Fixed
- Fixed `RangeError: String.prototype.repeat` when updating progress bar at 100% completion in TUI

## [1.1.4] - 2026-08-05

### Fixed
- Run the global CLI with Bun so the OpenTUI native renderer is available after npm installation

## [1.1.3] - 2026-08-05

### Fixed
- Initialize OpenTUI Bun runtime support before creating the native renderer

## [1.1.2] - 2026-08-05

### Added
- Daily npm update notification with a cached registry check

### Changed
- Recommend npm as the primary global installation method

## [1.1.1] - 2026-08-05

### Fixed
- Publish metadata now points to the `ltcodedev/rconv` repository
- Normalize the npm binary entry for the `rconv` command

## [1.1.0] - 2026-08-05

### Added
- Interactive `rconv tui` control center with media browser, configurable output folders, audio track selection, progress and execution logs
- Directory path autocomplete and named output folder creation in the TUI
- TUI controls for starting and cancelling conversions
- Library callbacks for queue discovery and optional signal management

### Fixed
- FFmpeg availability check and actionable conversion errors
- Signal handlers no longer terminate library consumers directly

## [1.0.0] - 2024-04-05

### Added
- TypeScript/JavaScript implementation as npm package `@ltcode/rconv`
- CLI tool `rconv` with same interface as shell script
- Library API for programmatic usage
- Support for Bun and Node.js
- GitHub Actions for automated testing and publishing
- Full TypeScript types and declarations

### Features
- Convert videos to DaVinci Resolve compatible format (.mov, MPEG-4 + PCM audio)
- Wildcard and glob pattern support (`*.mp4`, `*.mkv`)
- Recursive directory search with preserved structure (`-r` flag)
- Audio track selection (`-m` flag)
- Ctrl+C handler to cancel all conversions
- Progress callbacks for library usage

### Migration from Shell Script
- Shell script moved to `legacy/` folder
- Original install script still works via `curl | bash`
- Users can choose between npm/bun install or legacy shell script

---

## Legacy Shell Script Versions

### [0.7] - 2024-04-05
- Added `-v/--version` flag

### [0.6] - 2024-04-05
- Fixed directory structure preservation for absolute paths in recursive mode

### [0.5] - 2024-04-05
- Ctrl+C now cancels entire queue, not just current video

### [0.4] - 2024-04-05
- Added `-r/--recursive` flag for subdirectory search
- Preserves directory structure in output

### [0.3] - 2024-04-05
- Fixed wildcard expansion with spaces in paths
- Removed incorrect `local` keyword usage
- Added `-m/--map-audio` documentation in help

### [0.2] - Initial shell script release
- Basic video conversion to DaVinci Resolve format
- Support for wildcards and multiple files
- Audio track mapping
