import { describe, expect, test, vi } from 'vitest';
import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runWithSoftDeadline } from './run-with-soft-deadline.mjs';

describe('runWithSoftDeadline', () => {
  test('does not warn when the command finishes before the soft deadline', async () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await runWithSoftDeadline({
      label: 'Fast review',
      softMs: 1_000,
      command: process.execPath,
      commandArgs: ['-e', 'process.exit(0)'],
    });
    expect(code).toBe(0);
    expect(stderr).not.toHaveBeenCalled();
    stderr.mockRestore();
  });

  test('warns without killing or replacing a command past the soft deadline', async () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await runWithSoftDeadline({
      label: 'Slow review',
      softMs: 5,
      command: process.execPath,
      commandArgs: ['-e', 'setTimeout(() => process.exit(0), 30)'],
    });
    expect(code).toBe(0);
    expect(stderr).toHaveBeenCalledOnce();
    expect(stderr.mock.calls[0]?.[0]).toContain('still running');
    stderr.mockRestore();
  });

  test('redirects child stdout to the requested review file', async () => {
    const output = join(tmpdir(), `review-deadline-${process.pid}.txt`);
    try {
      const code = await runWithSoftDeadline({
        label: 'Captured review',
        softMs: 1_000,
        stdoutFile: output,
        command: process.execPath,
        commandArgs: ['-e', 'console.log("NO FINDINGS")'],
      });
      expect(code).toBe(0);
      expect(readFileSync(output, 'utf8')).toBe('NO FINDINGS\n');
    } finally {
      unlinkSync(output);
    }
  });
});
