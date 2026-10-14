import { describe, expect, test } from 'bun:test';
import { isHttpUrl, checkYtDlp, downloadAndConvert, getFormatForQuality, fetchVideoMetadata } from '../src/downloader.js';

describe('downloader', () => {
  describe('getFormatForQuality', () => {
    test('returns correct yt-dlp format strings for qualities', () => {
      expect(getFormatForQuality('best')).toBe('bestvideo*+bestaudio/best');
      expect(getFormatForQuality('1080p')).toContain('height<=1080');
      expect(getFormatForQuality('720p')).toContain('height<=720');
      expect(getFormatForQuality('480p')).toContain('height<=480');
      expect(getFormatForQuality('360p')).toContain('height<=360');
      expect(getFormatForQuality('audio')).toBe('bestaudio/best');
      expect(getFormatForQuality('custom-format')).toBe('custom-format');
    });
  });

  describe('isHttpUrl', () => {
    test('identifies valid http and https URLs', () => {
      expect(isHttpUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true);
      expect(isHttpUrl('http://example.com/video.mp4')).toBe(true);
      expect(isHttpUrl('https://vimeo.com/123456')).toBe(true);
    });

    test('rejects local file paths, globs and invalid inputs', () => {
      expect(isHttpUrl('video.mp4')).toBe(false);
      expect(isHttpUrl('./videos/*.mp4')).toBe(false);
      expect(isHttpUrl('/home/user/video.mkv')).toBe(false);
      expect(isHttpUrl('ftp://example.com/video.mp4')).toBe(false);
      expect(isHttpUrl('')).toBe(false);
      expect(isHttpUrl('   ')).toBe(false);
    });
  });

  describe('checkYtDlp', () => {
    test('returns a boolean status indicating yt-dlp presence', () => {
      const available = checkYtDlp();
      expect(typeof available).toBe('boolean');
    });
  });

  describe('fetchVideoMetadata', () => {
    test('rejects on invalid URL', async () => {
      await expect(fetchVideoMetadata('not-a-url')).rejects.toThrow('Invalid URL');
    });
  });

  describe('downloadAndConvert validation', () => {
    test('returns error for invalid URL without throwing unhandled exception', async () => {
      const result = await downloadAndConvert({
        url: 'not-a-valid-url',
        output: './test-output',
        manageSignals: false,
      });

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('Invalid URL');
    });
  });
});
