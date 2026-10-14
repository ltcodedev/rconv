import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { checkFfmpeg, convertVideo } from './converter.js';
import type { AvailableQuality, DownloadOptions, DownloadResult, VideoMetadata, VideoQuality } from './types/index.js';
import { removeTrailingSlash } from './utils/path-utils.js';
import {
  clearCurrentProcess,
  isProcessCancelled,
  setCurrentProcess,
  setupSignalHandlers,
} from './utils/signal-handler.js';

export function isHttpUrl(input: string): boolean {
  if (!input || typeof input !== 'string') {
    return false;
  }
  try {
    const url = new URL(input.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function checkYtDlp(): boolean {
  const result = spawnSync('yt-dlp', ['--version'], { stdio: 'ignore' });
  return !result.error && result.status === 0;
}

export function getFormatForQuality(quality?: VideoQuality): string {
  if (!quality || quality === 'best') {
    return 'bestvideo*+bestaudio/best';
  }
  if (quality === 'audio') {
    return 'bestaudio/best';
  }

  const heightMatch = String(quality).match(/^(\d+)p?$/i);
  if (heightMatch) {
    const height = heightMatch[1];
    return `bestvideo[height<=${height}]+bestaudio/best[height<=${height}]/best`;
  }

  return quality;
}

export async function fetchVideoMetadata(url: string): Promise<VideoMetadata> {
  if (!checkYtDlp()) {
    throw new Error('yt-dlp is not installed or not in PATH.');
  }

  if (!isHttpUrl(url)) {
    throw new Error(`Invalid URL: ${url}`);
  }

  return new Promise<VideoMetadata>((resolve, reject) => {
    const proc = spawn('yt-dlp', ['-J', '--no-playlist', url]);
    let stdoutBuffer = '';
    let stderrBuffer = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderrBuffer += chunk.toString();
    });

    proc.on('error', (err) => {
      reject(err);
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        const err = stderrBuffer.trim() || `yt-dlp exited with code ${code}`;
        reject(new Error(`Failed to fetch video information: ${err}`));
        return;
      }

      try {
        const data = JSON.parse(stdoutBuffer);
        const title: string = data.title || 'Vídeo sem título';
        const duration: number | undefined = data.duration;
        const thumbnail: string | undefined = data.thumbnail;
        const formats: any[] = data.formats || [];

        // Agrupa por altura única pegando a melhor taxa de frames
        const heightMap = new Map<number, { width?: number; fps?: number }>();
        for (const f of formats) {
          if (f.vcodec && f.vcodec !== 'none' && typeof f.height === 'number' && f.height > 0) {
            const current = heightMap.get(f.height);
            if (!current || (f.fps && (!current.fps || f.fps > current.fps))) {
              heightMap.set(f.height, { width: f.width, fps: f.fps });
            }
          }
        }

        const sortedHeights = Array.from(heightMap.keys()).sort((a, b) => b - a);

        const qualities: AvailableQuality[] = [
          {
            name: '⭐ Melhor Qualidade (Máxima)',
            description: sortedHeights[0] ? `Resolução nativa até ${sortedHeights[0]}p` : 'Melhor disponível',
            value: 'best',
          },
          ...sortedHeights.map((h) => {
            const info = heightMap.get(h);
            const fpsStr = info?.fps && info.fps > 30 ? ` (${info.fps}fps)` : '';
            let label = `${h}p`;
            if (h >= 2160) label += ' (4K UHD)';
            else if (h >= 1440) label += ' (2K QHD)';
            else if (h >= 1080) label += ' (Full HD)';
            else if (h >= 720) label += ' (HD)';
            else if (h >= 480) label += ' (SD)';

            return {
              name: `${label}${fpsStr}`,
              description: info?.width ? `Resolução ${info.width}x${h}` : `Resolução ${h}p`,
              value: `${h}p`,
              height: h,
              width: info?.width,
              fps: info?.fps,
            };
          }),
          {
            name: '🎵 Apenas Áudio (PCM Linear)',
            description: 'Extrai faixa de som convertida em PCM .mov',
            value: 'audio',
          },
        ];

        resolve({
          title,
          duration,
          thumbnail,
          qualities,
        });
      } catch (parseError) {
        reject(new Error(`Failed to parse video metadata: ${parseError}`));
      }
    });
  });
}

export async function downloadVideo(
  url: string,
  tempDir: string,
  options?: {
    quality?: VideoQuality;
    onStart?: (url: string) => void;
    onProgress?: (percent: number, statusText?: string) => void;
  }
): Promise<string> {
  if (!checkYtDlp()) {
    throw new Error(
      'yt-dlp is not installed or not in PATH.\n' +
      'Please install yt-dlp to download videos:\n' +
      '  Ubuntu/Debian: sudo apt install yt-dlp\n' +
      '  Fedora:        sudo dnf install yt-dlp\n' +
      '  Arch Linux:    sudo pacman -S yt-dlp\n' +
      '  macOS:         brew install yt-dlp\n' +
      '  Python:        pip install yt-dlp'
    );
  }

  if (isProcessCancelled()) {
    throw new Error('Download cancelled');
  }

  const metaFilePath = join(tempDir, '__rconv_output_meta.txt');
  options?.onStart?.(url);

  return new Promise<string>((resolve, reject) => {
    const format = getFormatForQuality(options?.quality);
    const args = [
      '--no-playlist',
      '--newline',
      '-f', format,
      '-P', `home:${tempDir}`,
      '-P', `temp:${tempDir}`,
      '--print-to-file', 'after_video:filepath', metaFilePath,
      url,
    ];

    const proc = spawn('yt-dlp', args);
    setCurrentProcess(proc);

    let stderrBuffer = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      const lines = text.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const match = trimmed.match(/\[download\]\s+([\d.]+)%/);
        if (match) {
          const percent = parseFloat(match[1]);
          options?.onProgress?.(percent, trimmed);
        }
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderrBuffer += chunk.toString();
    });

    proc.on('error', (err) => {
      clearCurrentProcess();
      reject(err);
    });

    proc.on('close', (code) => {
      clearCurrentProcess();

      if (isProcessCancelled()) {
        reject(new Error('Download cancelled'));
        return;
      }

      if (code !== 0) {
        const errorMsg = stderrBuffer.trim() || `yt-dlp exited with code ${code}`;
        reject(new Error(`Failed to download video: ${errorMsg}`));
        return;
      }

      // 1. Tenta recuperar pelo arquivo meta gerado pelo yt-dlp
      if (existsSync(metaFilePath)) {
        try {
          const lines = readFileSync(metaFilePath, 'utf-8').trim().split('\n');
          const lastLine = lines[lines.length - 1]?.trim();
          if (lastLine && existsSync(lastLine)) {
            resolve(lastLine);
            return;
          }
        } catch {}
      }

      // 2. Fallback: procurar no tempDir o arquivo baixado
      const files = readdirSync(tempDir)
        .filter((file) => !file.startsWith('__rconv_output_meta') && !file.endsWith('.part') && !file.endsWith('.ytdl'))
        .map((file) => join(tempDir, file));

      if (files.length > 0) {
        resolve(files[0]);
        return;
      }

      reject(new Error('Download finished but no output file was found.'));
    });
  });
}

export async function downloadAndConvert(options: DownloadOptions): Promise<DownloadResult> {
  const {
    url,
    output,
    quality = 'best',
    keepOriginal = false,
    audioTracks,
    onDownloadStart,
    onDownloadProgress,
    onDownloadComplete,
    onConvertStart,
    onConvertProgress,
    onConvertComplete,
    onError,
    manageSignals = true,
  } = options;

  if (manageSignals) {
    setupSignalHandlers();
  }

  if (!isHttpUrl(url)) {
    const error = new Error(`Invalid URL: ${url}. Expected a valid http:// or https:// URL.`);
    onError?.(error);
    return { url, output: '', success: false, error };
  }

  if (!checkFfmpeg()) {
    const error = new Error(
      'FFmpeg is not installed or not in PATH.\n' +
      'Please install FFmpeg to convert videos:\n' +
      '  Ubuntu/Debian: sudo apt install ffmpeg\n' +
      '  Fedora:        sudo dnf install ffmpeg\n' +
      '  Arch Linux:    sudo pacman -S ffmpeg\n' +
      '  macOS:         brew install ffmpeg'
    );
    onError?.(error);
    return { url, output: '', success: false, error };
  }

  const outputDir = removeTrailingSlash(output);
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'rconv-dl-'));
  let downloadedFilePath: string | undefined;

  try {
    downloadedFilePath = await downloadVideo(url, tempDir, {
      quality,
      onStart: onDownloadStart,
      onProgress: onDownloadProgress,
    });

    onDownloadComplete?.(downloadedFilePath);

    if (isProcessCancelled()) {
      throw new Error('Process cancelled');
    }

    onConvertStart?.(downloadedFilePath);

    const convertResult = await convertVideo({
      input: downloadedFilePath,
      output: outputDir,
      audioTracks,
      onProgress: onConvertProgress,
      onComplete: onConvertComplete,
    });

    if (!convertResult.success) {
      throw convertResult.error ?? new Error('Conversion failed');
    }

    let finalOriginalPath: string | undefined;

    if (keepOriginal && downloadedFilePath && existsSync(downloadedFilePath)) {
      const originalTarget = join(outputDir, basename(downloadedFilePath));
      renameSync(downloadedFilePath, originalTarget);
      finalOriginalPath = originalTarget;
    }

    return {
      url,
      downloadedFile: finalOriginalPath,
      output: convertResult.output,
      success: true,
    };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    onError?.(error);
    return {
      url,
      output: '',
      success: false,
      error,
    };
  } finally {
    try {
      if (existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {}
  }
}
