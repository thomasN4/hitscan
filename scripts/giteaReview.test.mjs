import { describe, expect, test } from 'vitest';
import { composeBody, hasReviewMarker, marker } from './gitea-review.mjs';

const SHA = 'abc123';

describe('Gitea review identity', () => {
  test.each([
    ['claude', 'Claude'],
    ['codex', 'GPT-5.6 Sol'],
    ['opencode', 'OpenCode / GLM-5.3-Flash'],
  ])('labels %s output as %s', (reviewer, name) => {
    const body = composeBody('## Bugs\n\n- finding', SHA, reviewer);
    expect(body).toContain(`**${name} review**`);
    expect(body).toContain(marker(SHA));
  });

  test('uses the selected provider for a clean review', () => {
    expect(composeBody('NO FINDINGS', SHA, 'codex')).toContain('**GPT-5.6 Sol review** — no findings.');
    expect(composeBody('NO FINDINGS', SHA, 'opencode')).toContain('**OpenCode / GLM-5.3-Flash review** — no findings.');
  });

  test('rejects empty output and unknown providers', () => {
    expect(() => composeBody('  ', SHA, 'claude')).toThrow('Review file is empty');
    expect(() => composeBody('NO FINDINGS', SHA, 'other')).toThrow('Unknown reviewer');
  });

  test('recognizes new and legacy per-commit markers', () => {
    expect(hasReviewMarker(`text ${marker(SHA)}`, SHA)).toBe(true);
    expect(hasReviewMarker(`text <!-- claude-review:${SHA} -->`, SHA)).toBe(true);
    expect(hasReviewMarker(`text ${marker('different')}`, SHA)).toBe(false);
  });
});
