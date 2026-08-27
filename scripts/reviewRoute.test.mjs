import { describe, expect, test } from 'vitest';
import { selectReviewer } from './review-route.mjs';

describe('selectReviewer', () => {
  test.each([
    undefined,
    '',
    '   ',
    'codex',
    ' CODEX ',
  ])('selects Codex for %j', (value) => {
    expect(selectReviewer(value).reviewer).toBe('codex');
  });

  test.each([
    'claude',
    ' Claude ',
    'CLAUDE',
  ])('selects Claude for %j', (value) => {
    expect(selectReviewer(value).reviewer).toBe('claude');
  });

  test.each([
    'opencode',
    ' OpenCode ',
    'OPENCODE',
  ])('selects OpenCode for %j', (value) => {
    expect(selectReviewer(value).reviewer).toBe('opencode');
  });

  test.each([
    'gpt',
    'auto',
    'claude,codex',
  ])('rejects unsupported value %j', (value) => {
    expect(() => selectReviewer(value)).toThrow(/expected "codex", "claude", or "opencode"/);
  });
});
