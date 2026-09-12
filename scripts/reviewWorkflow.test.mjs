import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const workflow = readFileSync(join(scriptsDir, '../.github/workflows/review.yml'), 'utf8');
const codexJob = workflow.slice(workflow.indexOf('  codex_review:'), workflow.indexOf('  claude_review:'));
const opencodeJob = workflow.slice(workflow.indexOf('  opencode_review:'), workflow.indexOf('  post:'));

// The review step's own bytes, lifted out of the YAML and run for real. Grep
// assertions cannot tell a correct branch from a plausible-looking one — the
// false "No review API key is set" on a failed primary passed every string
// check in this file — so the key/failure matrix is exercised rather than read.
const reviewStep = opencodeJob.slice(
  opencodeJob.indexOf('      - name: Review with OpenCode Muse Spark 1.3'),
  opencodeJob.indexOf('      - name: Export review'),
);
const RUN_MARKER = '        run: |\n';
const reviewRun = reviewStep
  .slice(reviewStep.indexOf(RUN_MARKER) + RUN_MARKER.length)
  .split('\n')
  .map((line) => (line.startsWith('          ') ? line.slice(10) : line))
  .join('\n');
// From the function definition onward: the preamble ahead of it only renders
// the prompt out of git, which carries none of the logic under test.
const reviewLogic = reviewRun.slice(reviewRun.indexOf('review_with() {'));

// `opencode` is a shell function rather than a PATH stub so the harness stays
// one file, and the two absolute /tmp reads are redirected into the case's own
// directory. Neither rewrites a branch; the decision bytes run verbatim.
const HARNESS = `
# The step's 10-minute warning exists to be reaped, not observed: the kill that
# targets it reaps the subshell, not the sleep it forked, so a real sleep would
# outlive every case by ten minutes and an orphan holding the inherited pipe
# would hang the reader too. Exiting from the stub ends that subshell at once,
# where returning from it would fire the warning immediately instead.
sleep() { exit 0; }
exec > "$STUB_OUTPUT" 2>&1
REVIEW_PROMPT="review the pull request"
opencode() {
  model=""
  want_model=false
  for arg in "$@"; do
    if test "$want_model" = true; then model="$arg"; want_model=false; fi
    if test "$arg" = "--model"; then want_model=true; fi
  done
  echo "$model" >> "$STUB_CALLS"
  case "$model" in
    opencode/*) printf '%s' "$STUB_PRIMARY_OUTPUT"; return "$STUB_PRIMARY_STATUS" ;;
    *) printf '%s' "$STUB_FALLBACK_OUTPUT"; return "$STUB_FALLBACK_STATUS" ;;
  esac
}
`;

function runReviewStep(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'review-step-'));
  const configPath = join(dir, 'opencode-review-config.json');
  writeFileSync(configPath, '{}\n');
  const calls = join(dir, 'calls');
  writeFileSync(calls, '');
  const output = join(dir, 'output');
  writeFileSync(output, '');
  const script = `${HARNESS}\n${reviewLogic.split('/tmp/opencode-review-config.json').join(configPath)}`;
  const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      STUB_CALLS: calls,
      STUB_OUTPUT: output,
      STUB_PRIMARY_STATUS: '0',
      STUB_PRIMARY_OUTPUT: '# primary review\n',
      STUB_FALLBACK_STATUS: '0',
      STUB_FALLBACK_OUTPUT: '# fallback review\n',
      OPENCODE_API_KEY: '',
      OPENROUTER_API_KEY: '',
      ...env,
    },
  });
  return {
    status: result.status,
    output: readFileSync(output, 'utf8'),
    models: readFileSync(calls, 'utf8').split('\n').filter(Boolean),
    // Absent when no provider ran at all, which is itself part of the contract.
    review: existsSync(join(dir, 'review.md')) ? readFileSync(join(dir, 'review.md'), 'utf8') : null,
  };
}

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
    expect(opencodeJob).toContain('and no OPENROUTER_API_KEY fallback is configured.');
    expect(opencodeJob).not.toContain('failed (exit 2)');
  });

  describe('review step key and failure matrix', () => {
    test('runs only the Zen primary when it succeeds', () => {
      const run = runReviewStep({ OPENCODE_API_KEY: 'zen', OPENROUTER_API_KEY: 'router' });
      expect(run.status, run.output).toBe(0);
      expect(run.models).toEqual(['opencode/muse-spark-1.3-contributor-free']);
      expect(run.review).toBe('# primary review\n');
      expect(run.output).not.toContain('::warning::Primary review model failed');
    });

    test('retries a failed primary on the fallback and says so', () => {
      const run = runReviewStep({
        OPENCODE_API_KEY: 'zen',
        OPENROUTER_API_KEY: 'router',
        STUB_PRIMARY_STATUS: '3',
        STUB_PRIMARY_OUTPUT: '',
      });
      expect(run.status, run.output).toBe(0);
      expect(run.models).toEqual([
        'opencode/muse-spark-1.3-contributor-free',
        'openrouter/meta/muse-spark-1.3-contributor',
      ]);
      expect(run.output).toContain('::warning::Primary review model failed (exit 3)');
      expect(run.review).toBe('# fallback review\n');
    });

    test('runs the fallback directly when only its key is set', () => {
      const run = runReviewStep({ OPENROUTER_API_KEY: 'router' });
      expect(run.status, run.output).toBe(0);
      expect(run.models).toEqual(['openrouter/meta/muse-spark-1.3-contributor']);
      expect(run.output).toContain('::notice::No Zen API key is set');
      expect(run.output).not.toContain('Primary review model failed');
    });

    test('names the provider failure when the primary fails with no fallback key', () => {
      const run = runReviewStep({
        OPENCODE_API_KEY: 'zen',
        STUB_PRIMARY_STATUS: '3',
        STUB_PRIMARY_OUTPUT: '',
      });
      expect(run.status, run.output).toBe(3);
      expect(run.models).toEqual(['opencode/muse-spark-1.3-contributor-free']);
      expect(run.output).toContain(
        '::error::Primary review model failed (exit 3) and no OPENROUTER_API_KEY fallback is configured.',
      );
      // The key IS set; claiming otherwise buries the provider failure.
      expect(run.output).not.toContain('No review API key is set');
    });

    test('names both secrets when neither key is set', () => {
      const run = runReviewStep();
      expect(run.status, run.output).toBe(2);
      expect(run.models).toEqual([]);
      expect(run.review).toBeNull();
      expect(run.output).toContain(
        '::error::No review API key is set; configure OPENCODE_API_KEY or OPENROUTER_API_KEY.',
      );
    });

    test('treats a zero exit that wrote no review as a failure worth retrying', () => {
      const run = runReviewStep({
        OPENCODE_API_KEY: 'zen',
        OPENROUTER_API_KEY: 'router',
        STUB_PRIMARY_OUTPUT: '',
      });
      expect(run.status, run.output).toBe(0);
      expect(run.models).toEqual([
        'opencode/muse-spark-1.3-contributor-free',
        'openrouter/meta/muse-spark-1.3-contributor',
      ]);
      expect(run.output).toContain(
        '::warning::opencode/muse-spark-1.3-contributor-free exited 0 without writing a review.',
      );
      expect(run.review).toBe('# fallback review\n');
    });

    test('fails the step when both providers write nothing', () => {
      const run = runReviewStep({
        OPENCODE_API_KEY: 'zen',
        OPENROUTER_API_KEY: 'router',
        STUB_PRIMARY_OUTPUT: '',
        STUB_FALLBACK_OUTPUT: '',
      });
      expect(run.status, run.output).toBe(1);
      expect(run.review).toBe('');
    });
  });
});
