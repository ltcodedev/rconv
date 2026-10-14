export { convertVideo, convertMultiple, checkFfmpeg, getAudioTracks } from './converter.js';
export { downloadVideo, downloadAndConvert, checkYtDlp, isHttpUrl, getFormatForQuality, fetchVideoMetadata } from './downloader.js';
export type {
  ConvertOptions,
  ConvertResult,
  DownloadOptions,
  DownloadResult,
  VideoQuality,
  AvailableQuality,
  VideoMetadata,
  AudioTrack,
  FileInfo,
  FFmpegPreset,
} from './types/index.js';
export { expandGlobPattern } from './utils/glob-expander.js';
export { isVideoFile, fileExists, generateOutputFilename } from './utils/file-validator.js';
export { 
  setupSignalHandlers, 
  cancel, 
  isProcessCancelled,
  resetCancellation,
  setCurrentCommand,
  clearCurrentCommand,
  setCurrentProcess,
  clearCurrentProcess,
} from './utils/signal-handler.js';
