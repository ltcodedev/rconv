export interface ConvertOptions {
  input: string;
  output: string;
  recursive?: boolean;
  audioTracks?: number[];
  onProgress?: (percent: number, file: string) => void;
  onStart?: (file: string) => void;
  onComplete?: (file: string) => void;
  onError?: (file: string, error: Error) => void;
  onQueue?: (files: string[]) => void;
  manageSignals?: boolean;
}

export interface ConvertResult {
  input: string;
  output: string;
  success: boolean;
  error?: Error;
}

export interface AudioTrack {
  index: number;
  codec: string;
  channels?: number;
  language?: string;
}

export interface FileInfo {
  path: string;
  basename: string;
  dirname: string;
  extension: string;
  isValidVideo: boolean;
}

export interface FFmpegPreset {
  codecVideo: string;
  codecAudio: string;
  qualityVideo: string;
  codecDavinci: string;
}

export const DEFAULT_PRESET: FFmpegPreset = {
  codecVideo: 'mpeg4',
  codecAudio: 'pcm_s16le',
  qualityVideo: '0',
  codecDavinci: '.mov',
};

export type VideoQuality = 'best' | '2160p' | '1440p' | '1080p' | '720p' | '480p' | '360p' | '240p' | '144p' | 'audio' | string;

export interface AvailableQuality {
  name: string;
  description: string;
  value: VideoQuality;
  height?: number;
  width?: number;
  fps?: number;
}

export interface VideoMetadata {
  title: string;
  duration?: number;
  thumbnail?: string;
  qualities: AvailableQuality[];
}

export interface DownloadOptions {
  url: string;
  output: string;
  quality?: VideoQuality;
  keepOriginal?: boolean;
  audioTracks?: number[];
  onDownloadStart?: (url: string) => void;
  onDownloadProgress?: (percent: number, rawStatus?: string) => void;
  onDownloadComplete?: (file: string) => void;
  onConvertStart?: (file: string) => void;
  onConvertProgress?: (percent: number, file: string) => void;
  onConvertComplete?: (file: string) => void;
  onError?: (error: Error) => void;
  manageSignals?: boolean;
}

export interface DownloadResult {
  url: string;
  downloadedFile?: string;
  output: string;
  success: boolean;
  error?: Error;
}

export interface CliOptions {
  input: string;
  output: string;
  recursive: boolean;
  mapAudio?: string;
  quality?: string;
  keepOriginal?: boolean;
  listQualities?: boolean;
  version: boolean;
  help: boolean;
}
