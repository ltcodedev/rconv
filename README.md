# @ltcode/rconv

[![npm version](https://img.shields.io/npm/v/@ltcode/rconv.svg)](https://www.npmjs.com/package/@ltcode/rconv)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

CLI and library for converting videos to DaVinci Resolve compatible format. Works with both Bun and Node.js.

## Features

- Convert videos to `.mov` format (MPEG-4 + PCM audio) compatible with DaVinci Resolve
- Download Web videos via `yt-dlp` (YouTube, Vimeo, etc.) directly converted to `.mov`
- Support for wildcards and glob patterns (`*.mp4`, `*.mkv`)
- Recursive directory search with preserved structure
- Select specific audio tracks
- Interactive terminal control center (TUI) with media browser and URL download
- Safe cancellation on Ctrl+C without corrupting conversions or leaving orphan processes
- Works as CLI and library

## Installation

### Via npm

The package is published in the npm registry. This is the recommended global installation method. The interactive TUI requires Bun 1.3 or later at runtime:

```bash
npm install -g @ltcode/rconv
```

### Via Bun

```bash
bun install -g @ltcode/rconv
```

### Updates

`rconv` checks the npm registry once per day and notifies you when a newer version is available. Update with:

```bash
npm install -g @ltcode/rconv@latest
```

### Legacy Shell Script

For users who prefer the original shell script:

```bash
curl -sL https://raw.githubusercontent.com/ltcodedev/rconv/main/install.sh | bash
```

See [legacy/README-legacy.md](legacy/README-legacy.md) for details.

## CLI Usage

### Basic Syntax

```bash
rconv -i <input> -o <output>
```

### Options

| Option | Description |
|--------|-------------|
| `-i, --input <pattern or URL>` | Input video file, pattern (e.g., `*.mp4`, `*.mkv`) or video URL |
| `-o, --output <dir>` | Output directory for converted files |
| `-r, --recursive` | Search recursively in subdirectories (preserves directory structure) |
| `-m, --map-audio <tracks>` | Map specific audio tracks (comma-separated, e.g., `1,3,5`) |
| `-q, --quality <quality>` | Download video quality (`best`, `1080p`, `720p`, `480p`, `360p`, `audio`) [default: `best`] |
| `-F, --list-qualities` | List available video qualities for URL and exit |
| `--keep-original` | Keep the original downloaded video file alongside converted `.mov` |
| `-v, --version` | Show version |
| `-h, --help` | Show help |

### Download Web Videos (yt-dlp)

You can download online videos using the dedicated `download` (or `dl`) command and choose the video quality:

```bash
# Check available resolutions for a video before downloading:
rconv dl "https://www.youtube.com/watch?v=VIDEO_ID" -F

# Download and convert directly to DaVinci Resolve compatible .mov
rconv download "https://www.youtube.com/watch?v=VIDEO_ID" -o ./output

# Selecting a specific resolution (e.g., 1080p, 720p, 480p)
rconv dl "https://www.youtube.com/watch?v=VIDEO_ID" -q 1080p

# Download audio only converted to PCM .mov
rconv dl "https://www.youtube.com/watch?v=VIDEO_ID" -q audio

# Keep the original downloaded file alongside the converted .mov
rconv dl "https://www.youtube.com/watch?v=VIDEO_ID" -q 720p --keep-original
```

Or by directly passing a URL to the `-i` option:

```bash
rconv -i "https://www.youtube.com/watch?v=VIDEO_ID" -o ./output -q 1080p
```

### Interactive Tabbed Control Center (TUI)

```bash
rconv tui
```

The redesigned TUI features a top **Tab navigation bar** and **Button-styled action panels**:

1. **📁 1. Local Files**:
   - Action buttons (`[ 📥 Input ]`, `[ 📤 Output ]`, `[ 📁 New Folder ]`, `[ 🚀 Start ]`, etc.)
   - Visual media and directory browser
   - Configuration summary card
2. **🌐 2. Web Download (yt-dlp)**:
   - Dedicated panel to enter and paste video URLs
   - Resolution selector: `Best (4K)`, `1080p`, `720p`, `480p`, `360p` or `Audio Only`
   - Toggle to keep or discard the raw downloaded video
   - Destination folder selector and direct start button
3. **ℹ️ 3. About & Help**:
   - FFmpeg and yt-dlp health status, codec configurations and keyboard shortcut reference

Main Keyboard Shortcuts:
- `1`, `2`, `3` (or `F1`, `F2`, `F3`): Switch directly between tabs
- `Tab`: Cycle focus across visible panels in the active tab
- `↑` / `↓`: Navigate options and buttons
- `Enter`: Select or execute action
- `P`: Type a directory path
- `N`: Create named output folder
- `Esc`: Close popups or exit
- `Ctrl + C`: Safely cancel running process

### 🖥️ Native Desktop GUI (Rust & Slint)

In addition to the CLI and TUI, the project includes an elegant desktop graphical application written in **Rust** using **Slint UI**:
- **100% Native for Wayland & X11**: Renders directly via GPU hardware acceleration (OpenGL/FemtoVG), free of WebKitGTK or Chromium runtimes, ensuring rock-solid stability and zero Wayland crashes.
- **GitHub Exclusive Distribution**: Kept completely out of npm. Pre-built standalone packages are distributed through [GitHub Releases](https://github.com/ltcodedev/rconv/releases).

To compile and launch the GUI locally:
```bash
cd gui
cargo run --release
```

### Local Conversion Examples

```bash
# Convert a single file
rconv -i video.mp4 -o ./output

# Convert multiple files with wildcard
rconv -i "*.mp4" -o ./converted

# Convert recursively in subdirectories
rconv -r -i "*.mkv" -o ./output

# Select specific audio tracks
rconv -i video.mp4 -o ./output -m 1,3

# Use brace expansion (without quotes)
rconv -i *.{mp4,mkv,avi} -o ./output
```

## Library Usage

### Install as dependency

```bash
npm install @ltcode/rconv
# or
bun add @ltcode/rconv
```

### API

```typescript
import { 
  convertVideo, 
  convertMultiple, 
  downloadAndConvert, 
  checkFfmpeg, 
  checkYtDlp 
} from '@ltcode/rconv';

// 1. Download and convert from URL
const dlResult = await downloadAndConvert({
  url: 'https://www.youtube.com/watch?v=VIDEO_ID',
  output: './output',
  keepOriginal: false, // optional (defaults to false)
  onDownloadProgress: (percent, statusText) => {
    console.log(`Download: ${percent}%`);
  },
  onConvertProgress: (percent) => {
    console.log(`Conversion: ${percent}%`);
  },
  onComplete: (result) => {
    console.log(`Saved at: ${result.output}`);
  },
});

// 2. Convert a single local video
const result = await convertVideo({
  input: 'video.mp4',
  output: './output',
  audioTracks: [1, 3], // optional
});

// 3. Convert multiple videos
const results = await convertMultiple({
  input: '*.mp4',
  output: './converted',
  recursive: true, // optional
  onProgress: (percent, file) => {
    console.log(`${file}: ${percent}%`);
  },
});

// 4. Check dependencies
if (!checkFfmpeg()) {
  console.error('FFmpeg not found');
}
if (!checkYtDlp()) {
  console.error('yt-dlp not found');
}
```

## Graphical Interface (Rust GUI)

`rconv` features a native **Rust** GUI built with **Slint**, delivering high performance, minimal memory footprint, and native Wayland and X11 support.

> [!NOTE]
> The GUI is distributed as a native binary via GitHub Releases and is not published to npm.

### GUI Features

- **Smart Download**: Paste YouTube or Web URLs directly from clipboard (`Ctrl+V` or built-in button) with automatic resolution detection (4K, 2K, 1080p, 720p, etc.).
- **DaVinci Resolve Audio Guarantee**: Merges streams and converts directly to `.mov` with **16-bit Linear PCM audio** (`pcm_s16le`).
- **Audio Track Mapping**: Detects all existing audio streams in the video via `ffprobe` and allows selective track mapping.
- **Audio-Only Extraction**: Dedicated toggle to extract audio tracks without video as PCM `.mov`.
- **Multi-track External Audio & Waveform Sync**: Add external microphone/recorder audio tracks (.wav, .mp3, etc.) with automatic waveform cross-correlation alignment via FFT, reference track selection, and manual latency/offset compensation.
- **Directory Hierarchy Preservation**: Recursively converts folders while preserving complete directory trees.
- **Post-Conversion Actions**: Direct buttons to open destination folder or play converted media in your default system player.
- **Settings Persistence**: Automatically saves download and conversion directories across sessions in `~/.config/rconv/settings.json`.

### Running & Development (Hot Reload)

```bash
# Run GUI in development mode
bun run gui:dev
# or: cargo run --manifest-path gui/Cargo.toml

# Run with automatic Hot Reload (recompiles and restarts on code or UI changes)
bun run gui:watch
# or: cargo watch -C gui -x run

# Build optimized release binary
bun run gui:build
```

## Requirements

- **FFmpeg**: required for video conversion
- **yt-dlp**: required when downloading videos from the Web

### Installing dependencies

```bash
# Ubuntu / Debian
sudo apt install ffmpeg yt-dlp

# Fedora
sudo dnf install ffmpeg yt-dlp

# Arch Linux
sudo pacman -S ffmpeg yt-dlp

# macOS
brew install ffmpeg yt-dlp

# Python (to update yt-dlp if needed)
pip install -U yt-dlp
```

## Supported Formats

Any format supported by FFmpeg can be used as input. Output is `.mov` with MPEG-4 video and PCM audio, compatible with DaVinci Resolve on Linux.

## License

MIT - See [LICENSE](LICENSE) for details.

## Author

Lucas Tiago - [GitHub](https://github.com/eulucastiagolt) - [Website](https://www.lucastiago.com.br)
