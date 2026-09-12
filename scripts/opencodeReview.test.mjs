import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(scriptsDir, 'opencode-review-config.json'), 'utf8'));

describe('OpenCode review policy', () => {
  test('pins the OpenCode Zen model, high reasoning and non-persistent runtime', () => {
    const model = config.provider.opencode.models['muse-spark-1.3-contributor-free'];
    expect(config.enabled_providers).toEqual(['opencode', 'openrouter']);
    expect(model.variants.high.reasoning.effort).toBe('high');
    expect(model.limit).toEqual({ context: 1048576, output: 943718 });
    expect(config.share).toBe('disabled');
    expect(config.snapshot).toBe(false);
    expect(config.autoupdate).toBe(false);
  });

  test('pins the OpenRouter fallback at the same limits and reasoning', () => {
    const fallback = config.provider.openrouter.models['meta/muse-spark-1.3-contributor'];
    expect(fallback.name).toBe('Muse Spark 1.3 Contributor (OpenRouter)');
    expect(fallback.reasoning).toBe(true);
    expect(fallback.tool_call).toBe(true);
    expect(fallback.variants.high.reasoning.effort).toBe('high');
    expect(fallback.limit).toEqual({ context: 1048576, output: 943718 });
  });

  test('allows repository reads while denying every unlisted capability', () => {
    const policy = config.agent.review.permission;
    expect(policy['*']).toBe('deny');
    expect(policy.read['*']).toBe('allow');
    expect(policy.read['*.env']).toBe('deny');
    expect(policy.external_directory).toBe('deny');
    expect(policy).not.toHaveProperty('bash');
    expect(policy).not.toHaveProperty('edit');
    expect(policy).not.toHaveProperty('webfetch');
    expect(policy).not.toHaveProperty('task');
  });
});

describe('OpenCode review workspace', () => {
  test('exports separate base/head trees, their diff and trusted base instructions', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'opencode-review-fixture-'));
    const output = join(fixture, 'review');
    mkdirSync(output);

    execFileSync('git', ['init', '--quiet', fixture]);
    execFileSync('git', ['config', 'user.name', 'Review Test'], { cwd: fixture });
    execFileSync('git', ['config', 'user.email', 'review-test@example.invalid'], { cwd: fixture });
    writeFileSync(join(fixture, 'AGENTS.md'), 'trusted base instructions\n');
    writeFileSync(join(fixture, 'changed.txt'), 'base\n');
    execFileSync('git', ['add', 'AGENTS.md', 'changed.txt'], { cwd: fixture });
    execFileSync('git', ['commit', '--quiet', '-m', 'Create base'], { cwd: fixture });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixture, encoding: 'utf8' }).trim();

    writeFileSync(join(fixture, 'AGENTS.md'), 'untrusted head instructions\n');
    writeFileSync(join(fixture, 'changed.txt'), 'head\n');
    execFileSync('git', ['add', 'AGENTS.md', 'changed.txt'], { cwd: fixture });
    execFileSync('git', ['commit', '--quiet', '-m', 'Change head'], { cwd: fixture });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixture, encoding: 'utf8' }).trim();

    const mergeBase = execFileSync(
      'bash',
      [join(scriptsDir, 'prepare-opencode-review.sh'), base, head, output],
      { cwd: fixture, encoding: 'utf8' },
    ).trim();

    expect(mergeBase).toBe(base);
    expect(readFileSync(join(output, 'base', 'changed.txt'), 'utf8')).toBe('base\n');
    expect(readFileSync(join(output, 'head', 'changed.txt'), 'utf8')).toBe('head\n');
    expect(readFileSync(join(output, 'AGENTS.md'), 'utf8')).toBe('trusted base instructions\n');
    expect(readFileSync(join(output, 'changes.diff'), 'utf8')).toContain('+head');
  });
});
