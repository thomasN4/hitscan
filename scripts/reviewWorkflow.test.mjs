import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const workflow = readFileSync(join(scriptsDir, '../.github/workflows/review.yml'), 'utf8');
const codexJob = workflow.slice(workflow.indexOf('  codex_review:'), workflow.indexOf('  claude_review:'));
const opencodeJob = workflow.slice(workflow.indexOf('  opencode_review:'), workflow.indexOf('  post:'));

describe('AI review workflow', () => {
  test('installs and invokes Claude Code from an isolated per-job prefix', () => {
    expect(workflow).toContain(
      'npm install --prefix /tmp/claude-code @anthropic-ai/claude-code@2.1.246',
    );
    expect(workflow).toContain('/tmp/claude-code/node_modules/.bin/claude -p');
    expect(workflow).not.toMatch(/npm (?:i|install) -g @anthropic-ai\/claude-code/);
  });

  test('sources reviewer tools from pinned npm artifacts without APT', () => {
    expect(workflow).not.toContain('apt-get');
    expect(codexJob).toContain('@openai/codex@0.149.1');
    expect(codexJob).toContain("-path '*/codex-resources/bwrap'");
    expect(codexJob).toContain('install -m 0755 "$bundled_bwrap" /usr/bin/bwrap');
    expect(opencodeJob).toContain('@vscode/ripgrep@1.18.0');
    expect(opencodeJob).toContain('install -m 0755 "$rg_path" /usr/local/bin/rg');
    expect(opencodeJob).toContain('command -v rg');
  });

  test('retries the OpenCode review once on the OpenRouter fallback', () => {
    expect(opencodeJob).toContain('review_with opencode/muse-spark-1.3-contributor-free');
    expect(opencodeJob).toContain('review_with openrouter/meta/muse-spark-1.3-contributor');
    expect(opencodeJob).toContain('retrying once on the OpenRouter fallback');
    expect(opencodeJob).toContain('Muse Spark OpenRouter fallback did not resolve');
  });

  test('reports a skipped primary and missing keys honestly', () => {
    expect(opencodeJob).toContain('No Zen API key is set; running the OpenRouter fallback directly.');
    expect(opencodeJob).toContain('No review API key is set; configure OPENCODE_API_KEY or OPENROUTER_API_KEY.');
    // The failure warning must interpolate the live status, never a sentinel.
    expect(opencodeJob).toContain('Primary review model failed (exit $status)');
    expect(opencodeJob).not.toContain('failed (exit 2)');
  });
});
