#!/usr/bin/env bun
import { createRequire } from 'node:module';
import { cac } from 'cac';
import { convertMultiple, checkFfmpeg } from './converter.js';
import { checkYtDlp, downloadAndConvert, fetchVideoMetadata, isHttpUrl } from './downloader.js';
import type { ConvertOptions } from './types/index.js';
import { isProcessCancelled, setupSignalHandlers } from './utils/signal-handler.js';
import { runTui } from './tui/index.js';
import { checkForUpdate, formatUpdateMessage } from './utils/update-checker.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

function printFfmpegError(): void {
  console.error('Error: FFmpeg is not installed or not in PATH.');
  console.error('');
  console.error('Please install FFmpeg:');
  console.error('  Ubuntu/Debian: sudo apt install ffmpeg');
  console.error('  Fedora:        sudo dnf install ffmpeg');
  console.error('  Arch Linux:    sudo pacman -S ffmpeg');
  console.error('  macOS:         brew install ffmpeg');
}

function printYtDlpError(): void {
  console.error('Error: yt-dlp is not installed or not in PATH.');
  console.error('');
  console.error('Please install yt-dlp to download videos:');
  console.error('  Ubuntu/Debian: sudo apt install yt-dlp');
  console.error('  Fedora:        sudo dnf install yt-dlp');
  console.error('  Arch Linux:    sudo pacman -S yt-dlp');
  console.error('  macOS:         brew install yt-dlp');
  console.error('  Python:        pip install yt-dlp');
}

function parseAudioTracks(mapAudioOption?: string): number[] | undefined {
  if (!mapAudioOption) {
    return undefined;
  }
  const tracks = String(mapAudioOption)
    .split(',')
    .map((track) => Number(track.trim()));

  if (tracks.some((track) => !Number.isInteger(track) || track < 0)) {
    console.error('Error: --map-audio must contain non-negative integer stream indices, for example: 1,3,5');
    process.exit(1);
  }
  return tracks;
}

async function handleListQualities(url: string): Promise<void> {
  if (!checkYtDlp()) {
    printYtDlpError();
    process.exit(1);
  }

  console.log(`Checking available video qualities for: ${url}...`);
  try {
    const meta = await fetchVideoMetadata(url);
    console.log('');
    console.log('=================================');
    console.log(`Title: ${meta.title}`);
    if (meta.duration) {
      const minutes = Math.floor(meta.duration / 60);
      const seconds = meta.duration % 60;
      console.log(`Duration: ${minutes}:${seconds.toString().padStart(2, '0')}`);
    }
    console.log('=================================');
    console.log('Available Qualities:');
    for (const q of meta.qualities) {
      const desc = q.description ? `(${q.description})` : '';
      console.log(`  • ${q.name.padEnd(32)} ${desc.padEnd(26)} -> -q ${q.value}`);
    }
    console.log('');
    console.log('Example:');
    console.log(`  rconv dl "${url}" -q ${meta.qualities[1]?.value || 'best'}`);
    process.exit(0);
  } catch (err) {
    console.error('Error fetching qualities:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

async function handleDownload(
  url: string,
  outputDir: string,
  opts: { mapAudio?: string; keepOriginal?: boolean; quality?: string }
): Promise<void> {
  if (!checkYtDlp()) {
    printYtDlpError();
    process.exit(1);
  }

  if (!checkFfmpeg()) {
    printFfmpegError();
    process.exit(1);
  }

  const audioTracks = parseAudioTracks(opts.mapAudio);

  console.log('=================================');
  console.log(`Downloading and converting from URL: ${url}`);
  console.log(`Quality: ${opts.quality || 'best'}`);
  console.log(`Destination: ${outputDir}`);
  console.log('=================================');
  console.log('');

  const result = await downloadAndConvert({
    url,
    output: outputDir,
    quality: opts.quality,
    keepOriginal: !!opts.keepOriginal,
    audioTracks,
    onDownloadStart: () => {
      console.log('--- Downloading video with yt-dlp ---');
    },
    onDownloadProgress: (percent, statusText) => {
      if (statusText) {
        process.stdout.write(`\r${statusText}`);
      } else {
        process.stdout.write(`\rDownload progress: ${percent.toFixed(1)}%`);
      }
    },
    onDownloadComplete: (file) => {
      process.stdout.write('\n');
      console.log(`✓ Download complete: ${file}`);
    },
    onConvertStart: (file) => {
      console.log('');
      console.log(`--- Converting to DaVinci Resolve format (.mov): ${file} ---`);
    },
    onConvertProgress: (percent) => {
      if (percent > 0) {
        process.stdout.write(`\rConversion progress: ${percent.toFixed(1)}%`);
      }
    },
    onConvertComplete: () => {
      process.stdout.write('\n');
    },
    onError: (error) => {
      process.stdout.write('\n');
      console.error(`✗ Error: ${error.message}`);
    },
  });

  console.log('');
  console.log('=================================');
  if (result.success) {
    console.log(`✓ Output generated successfully: ${result.output}`);
    if (result.downloadedFile) {
      console.log(`✓ Original downloaded video kept: ${result.downloadedFile}`);
    }
    process.exit(0);
  } else {
    if (isProcessCancelled()) {
      console.log('Operation cancelled');
    } else {
      console.log('Download or conversion failed');
    }
    process.exit(1);
  }
}

export async function runCli(): Promise<void> {
  const cli = cac('rconv');

  cli
    .version(version)
    .usage('[options]')
    .help();

  cli
    .option('-i, --input <pattern>', 'Input video file, pattern (e.g., *.mp4, *.mkv) or video URL')
    .option('-o, --output <directory>', 'Output directory for converted files')
    .option('-r, --recursive', 'Search recursively in subdirectories')
    .option('-m, --map-audio <tracks>', 'Map specific audio tracks (comma-separated, e.g., 1,3,5)')
    .option('-q, --quality <quality>', 'Video quality for download (best, 1080p, 720p, 480p, 360p, audio) [default: best]')
    .option('-F, --list-qualities', 'List available video qualities for URL and exit')
    .option('--keep-original', 'Keep original downloaded file when downloading from URL');

  cli.command('tui', 'Open the interactive rconv control panel');

  cli
    .command('download <url>', 'Download video using yt-dlp and convert to DaVinci Resolve format')
    .alias('dl')
    .option('-o, --output <directory>', 'Output directory for converted files (defaults to current directory)')
    .option('-m, --map-audio <tracks>', 'Map specific audio tracks (comma-separated, e.g., 1,3,5)')
    .option('-q, --quality <quality>', 'Video quality for download (best, 1080p, 720p, 480p, 360p, audio) [default: best]')
    .option('-F, --list-qualities', 'List available video qualities for URL and exit')
    .option('--keep-original', 'Keep original downloaded file alongside converted .mov');

  const { options } = cli.parse(process.argv, { run: false });

  if (cli.matchedCommandName === 'tui') {
    const latestVersion = await checkForUpdate(version);
    if (latestVersion) {
      console.warn(formatUpdateMessage(version, latestVersion));
    }
    await runTui();
    return;
  }

  setupSignalHandlers();

  // Caso 1: Subcomando 'download' ou 'dl'
  if (cli.matchedCommandName === 'download' || cli.matchedCommandName === 'dl') {
    const url = cli.args[0] as string;
    if (options.listQualities) {
      await handleListQualities(url);
      return;
    }
    const outputDir = (options.output as string) || process.cwd();
    await handleDownload(url, outputDir, {
      mapAudio: options.mapAudio as string | undefined,
      quality: options.quality as string | undefined,
      keepOriginal: !!options.keepOriginal,
    });
    return;
  }

  // Caso 2: Opção de entrada ausente ou help/version
  if (!options.input || (!options.output && !options.listQualities)) {
    if (options.help || options.version) {
      return;
    }
    
    console.error('Error: Missing required options --input and --output');
    console.error('Use --help to see available options');
    process.exit(1);
  }

  // Caso 3: Entrada é uma URL HTTP/HTTPS
  if (isHttpUrl(options.input as string)) {
    if (options.listQualities) {
      await handleListQualities(options.input as string);
      return;
    }

    const latestVersion = await checkForUpdate(version);
    if (latestVersion) {
      console.warn(formatUpdateMessage(version, latestVersion));
    }

    await handleDownload(options.input as string, options.output as string, {
      mapAudio: options.mapAudio as string | undefined,
      quality: options.quality as string | undefined,
      keepOriginal: !!options.keepOriginal,
    });
    return;
  }

  // Caso 4: Conversão tradicional de arquivos locais
  if (!checkFfmpeg()) {
    printFfmpegError();
    process.exit(1);
  }

  const latestVersion = await checkForUpdate(version);
  if (latestVersion) {
    console.warn(formatUpdateMessage(version, latestVersion));
  }

  const audioTracks = parseAudioTracks(options.mapAudio as string | undefined);

  const convertOptions: ConvertOptions = {
    input: options.input as string,
    output: options.output as string,
    recursive: !!options.recursive,
    audioTracks,
    onStart: (file) => {
      console.log('');
      console.log(`--- Processing: ${file} ---`);
    },
    onProgress: (percent) => {
      if (percent > 0) {
        console.log(`Progress: ${percent.toFixed(1)}%`);
      }
    },
    onComplete: (file) => {
      console.log(`✓ Conversion of ${file} completed successfully!`);
    },
    onError: (file, error) => {
      console.error(`✗ Error converting ${file}:`);
      console.error(error.message);
    },
  };

  console.log('=================================');
  console.log('Starting conversion');
  console.log('');

  const results = await convertMultiple(convertOptions);

  const successful = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  console.log('');
  console.log('=================================');
  console.log(`Completed: ${successful.length} files converted successfully`);

  if (isProcessCancelled()) {
    console.log('Conversion cancelled');
    process.exit(1);
  }
  
  if (failed.length > 0) {
    console.log(`Failed: ${failed.length} files failed to convert`);
    process.exit(1);
  }

  process.exit(0);
}

runCli().catch((error) => {
  console.error('Fatal error:', error.message);
  process.exit(1);
});
