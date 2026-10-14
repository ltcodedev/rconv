import { describe, expect, test } from 'bun:test';
import { runTui } from '../src/tui';

describe('runTui', () => {
  test('requires an interactive terminal', async () => {
    const originalStdinIsTTY = process.stdin.isTTY;
    try {
      // @ts-expect-error override readonly property for testing
      process.stdin.isTTY = false;
      await expect(runTui()).rejects.toThrow('rconv tui requires an interactive terminal.');
    } finally {
      // @ts-expect-error restore original property
      process.stdin.isTTY = originalStdinIsTTY;
    }
  });
});
