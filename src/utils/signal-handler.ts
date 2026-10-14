import type { FfmpegCommand } from 'fluent-ffmpeg';
import type { ChildProcess } from 'node:child_process';

let isCancelled = false;
let currentCommand: FfmpegCommand | null = null;
let currentProcess: ChildProcess | null = null;
let signalHandler: (() => void) | undefined;

export function cancel(): void {
  isCancelled = true;
  
  // Mata o comando FFmpeg atual se existir
  if (currentCommand) {
    try {
      currentCommand.kill('SIGTERM');
    } catch {
      try {
        currentCommand.kill('SIGKILL');
      } catch {}
    }
  }

  // Mata o processo filho atual (ex: yt-dlp) se existir
  if (currentProcess) {
    try {
      currentProcess.kill('SIGTERM');
    } catch {
      try {
        currentProcess.kill('SIGKILL');
      } catch {}
    }
  }
}

export function isProcessCancelled(): boolean {
  return isCancelled;
}

export function resetCancellation(): void {
  isCancelled = false;
}

export function setCurrentCommand(command: FfmpegCommand | null): void {
  currentCommand = command;
}

export function clearCurrentCommand(): void {
  currentCommand = null;
}

export function setCurrentProcess(proc: ChildProcess | null): void {
  currentProcess = proc;
}

export function clearCurrentProcess(): void {
  currentProcess = null;
}

export function setupSignalHandlers(): void {
  if (signalHandler) {
    return;
  }

  signalHandler = () => {
    console.log('');
    console.log('Cancellation requested. Stopping all conversions...');
    cancel();
  };

  process.on('SIGINT', signalHandler);
  process.on('SIGTERM', signalHandler);
}

export function removeSignalHandlers(): void {
  if (!signalHandler) {
    return;
  }

  process.off('SIGINT', signalHandler);
  process.off('SIGTERM', signalHandler);
  signalHandler = undefined;
}
