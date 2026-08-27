import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const workflow = readFileSync(join(scriptsDir, '../.github/workflows/review.yml'), 'utf8');

describe('AI review workflow', () => {
  test('installs and invokes Claude Code from an isolated per-job prefix', () => {
    expect(workflow).toContain(
      'npm install --prefix /tmp/claude-code @anthropic-ai/claude-code@2.1.246',
    );
    expect(workflow).toContain('/tmp/claude-code/node_modules/.bin/claude -p');
    expect(workflow).not.toMatch(/npm (?:i|install) -g @anthropic-ai\/claude-code/);
  });
});
