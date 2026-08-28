import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { evaluateEvents } from './planRelayGate.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const runner = join(scriptsDir, 'plan-relay.sh');
const config = JSON.parse(readFileSync(join(scriptsDir, 'opencode-executor-config.json'), 'utf8'));

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function createFixture({ primaryBranch = 'main', linkedBranch = 'feat/test' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'plan-relay-fixture-'));
  const primary = join(root, 'primary');
  const linked = join(root, 'linked');
  mkdirSync(primary);
  git(primary, ['init', '--quiet', '--initial-branch', primaryBranch]);
  git(primary, ['config', 'user.name', 'Plan Relay Test']);
  git(primary, ['config', 'user.email', 'plan-relay@example.invalid']);
  writeFileSync(join(primary, '.gitignore'), '.plan-relay\n');
  writeFileSync(join(primary, 'tracked.txt'), 'base\n');
  git(primary, ['add', '.gitignore', 'tracked.txt']);
  git(primary, ['commit', '--quiet', '-m', 'Create fixture']);
  git(primary, ['worktree', 'add', '--quiet', '-b', linkedBranch, linked]);

  const baseline = git(linked, ['rev-parse', 'HEAD']);
  const plan = join(root, 'plan.md');
  writeFileSync(plan, `---
plan_relay_version: 1
baseline_commit: ${baseline}
---

# Fixture task

## Summary
Summary.

## Interfaces
None.

## Implementation
Implement it.

## Test Plan
Test it.

## Assumptions
None.
`);

  const fake = join(root, 'opencode');
  writeFileSync(fake, `#!/usr/bin/env bash
set -eu
if test "\${1:-}" = "--version"; then
  echo 1.18.23
  exit 0
fi
printf '%s\\n' "$@" > "$PLAN_RELAY_TEST_ARGS"
printf '%s' "$OPENCODE_CONFIG_CONTENT" > "$PLAN_RELAY_TEST_CONFIG"
printf '%s\\n' "$XDG_CONFIG_HOME" > "$PLAN_RELAY_TEST_XDG"
case "\${PLAN_RELAY_TEST_STREAM:-healthy}" in
  healthy)
    printf '%s\\n' \\
      '{"type":"step_start","part":{}}' \\
      '{"type":"tool_use","part":{"tool":"edit","state":{"status":"completed","input":{"filePath":"src/x.ts"}}}}' \\
      '{"type":"step_finish","part":{"reason":"tool-calls"}}' \\
      '{"type":"step_start","part":{}}' \\
      '{"type":"text","part":{"text":"Implementation complete."}}' \\
      '{"type":"step_finish","part":{"reason":"stop"}}'
    ;;
  length)
    printf '%s\\n' '{"type":"step_start","part":{}}' '{"type":"step_finish","part":{"reason":"length"}}'
    ;;
  dead)
    printf '%s\\n' '{"type":"tool_use","part":{"tool":"read","state":{"status":"completed","input":{"filePath":"x"}}}}'
    ;;
  sleep)
    exec sleep 10
    ;;
esac
exit "\${PLAN_RELAY_TEST_EXIT:-0}"
`);
  chmodSync(fake, 0o755);

  // The runner deliberately preflights ripgrep so the real OpenCode executor
  // can rely on `rg` being available. Keep this fixture hermetic instead of
  // inheriting that system dependency from the developer or CI image. GNU
  // grep accepts the exact long options the runner uses for plan validation.
  const fakeBin = join(root, 'bin');
  mkdirSync(fakeBin);
  const fakeRg = join(fakeBin, 'rg');
  writeFileSync(fakeRg, `#!/usr/bin/env bash
exec grep "$@"
`);
  chmodSync(fakeRg, 0o755);

  const capture = {
    args: join(root, 'args.txt'),
    config: join(root, 'config.json'),
    xdg: join(root, 'xdg.txt'),
  };
  const env = {
    ...process.env,
    OPENROUTER_API_KEY: 'test-only',
    OPENCODE_BIN: fake,
    PLAN_RELAY_TEST_ARGS: capture.args,
    PLAN_RELAY_TEST_CONFIG: capture.config,
    PLAN_RELAY_TEST_XDG: capture.xdg,
    PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
  };
  return { primary, linked, plan, baseline, capture, env };
}

function run(fixture, cwd = fixture.linked, extraEnv = {}) {
  return spawnSync('bash', [runner, fixture.plan], {
    cwd,
    env: { ...fixture.env, ...extraEnv },
    encoding: 'utf8',
  });
}

function stream(...events) {
  return events.map((event) => JSON.stringify(event)).join('\n');
}

const EDIT_CALL = { type: 'tool_use', part: { tool: 'edit', state: { status: 'completed', input: { filePath: 'src/x.ts' } } } };

describe('Plan Relay liveness gate', () => {
  test('accepts a healthy session and a zero-edit blocker report', () => {
    const healthy = stream(
      { type: 'step_start', part: {} },
      EDIT_CALL,
      { type: 'step_finish', part: { reason: 'tool-calls' } },
      { type: 'step_start', part: {} },
      { type: 'text', part: { text: 'Implementation complete.' } },
      { type: 'step_finish', part: { reason: 'stop' } },
    );
    expect(evaluateEvents(healthy)).toEqual({ ok: true, failures: [] });

    const blocker = stream(
      { type: 'step_start', part: {} },
      { type: 'text', part: { text: 'Blocker: repository truth conflicts with the plan.' } },
      { type: 'step_finish', part: { reason: 'stop' } },
    );
    expect(evaluateEvents(blocker)).toEqual({ ok: true, failures: [] });
  });

  test('rejects a length-truncated final step even after edits', () => {
    const { ok, failures } = evaluateEvents(
      stream(EDIT_CALL, { type: 'text', part: { text: 'Working on it' } }, { type: 'step_finish', part: { reason: 'length' } }),
    );
    expect(ok).toBe(false);
    expect(failures.join('\n')).toContain('length');
  });

  test('rejects a session with neither edits nor a response', () => {
    const { ok, failures } = evaluateEvents(
      stream(
        { type: 'tool_use', part: { tool: 'read', state: { status: 'completed', input: { filePath: 'x' } } } },
        { type: 'step_finish', part: { reason: 'tool-calls' } },
      ),
    );
    expect(ok).toBe(false);
    expect(failures.join('\n')).toContain('neither file edits nor an assistant response');
  });

  test('rejects empty and unparsable streams', () => {
    expect(evaluateEvents('').ok).toBe(false);
    expect(evaluateEvents('not json\n{"broken').ok).toBe(false);
  });
});

describe('Plan Relay executor policy', () => {
  test('pins GLM-5.3-Flash max with persistence and publication disabled', () => {
    const model = config.provider.openrouter.models['z-ai/glm-5.3-flash'];
    expect(config.enabled_providers).toEqual(['openrouter']);
    expect(model.variants.max.reasoning.effort).toBe('max');
    expect(config.share).toBe('disabled');
    expect(config.snapshot).toBe(false);
    expect(config.autoupdate).toBe(false);
  });

  test('allows rg and validation while denying unlisted shell commands', () => {
    const policy = config.agent.executor.permission;
    expect(policy['*']).toBe('deny');
    expect(policy.external_directory).toBe('deny');
    expect(policy.edit).toBe('allow');
    expect(policy.bash['*']).toBe('deny');
    expect(policy.bash.rg).toBe('allow');
    expect(policy.bash['rg *']).toBe('allow');
    expect(policy.bash['npm test']).toBe('allow');
    expect(policy.bash.ls).toBe('allow');
    expect(policy.bash['ls *']).toBe('allow');
    expect(Object.keys(policy.bash).some((command) => command === 'cat' || command.startsWith('cat '))).toBe(false);
    expect(policy.bash).not.toHaveProperty('git commit *');
    expect(policy.bash).not.toHaveProperty('git push *');
  });
});

describe('Plan Relay runner', () => {
  test('launches the pinned executor from a clean linked worktree and retains artifacts', () => {
    const fixture = createFixture();
    const result = run(fixture);
    expect(result.status, result.stderr).toBe(0);

    const argsText = readFileSync(fixture.capture.args, 'utf8');
    const args = argsText.trim().split('\n');
    expect(args).toContain('--pure');
    expect(args.slice(args.indexOf('--agent'), args.indexOf('--agent') + 2)).toEqual(['--agent', 'executor']);
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual([
      '--model',
      'openrouter/z-ai/glm-5.3-flash',
    ]);
    expect(args.slice(args.indexOf('--variant'), args.indexOf('--variant') + 2)).toEqual(['--variant', 'max']);
    expect(args).not.toContain('--auto');
    expect(argsText).toContain('rg and ls with optional arguments');
    expect(argsText).toContain('npm run build with optional arguments');
    expect(argsText).toContain('optionally prefixed by CS_SMOKE_BASE=http://localhost:<port>');
    expect(argsText).toContain('All unlisted shell commands are denied');
    expect(argsText).toContain('Use the read tool for file contents.');
    expect(argsText).not.toContain('cat (never .env files)');

    const runs = readdirSync(join(fixture.linked, '.plan-relay'));
    expect(runs).toHaveLength(1);
    const runDir = join(fixture.linked, '.plan-relay', runs[0]);
    expect(readFileSync(join(runDir, 'plan.md'), 'utf8')).toBe(readFileSync(fixture.plan, 'utf8'));
    expect(readFileSync(join(runDir, 'events.jsonl'), 'utf8')).toContain('Implementation complete');
    expect(readFileSync(fixture.capture.config, 'utf8')).toBe(
      readFileSync(join(scriptsDir, 'opencode-executor-config.json'), 'utf8').trim(),
    );
    expect(readFileSync(fixture.capture.xdg, 'utf8').trim()).toBe(join(runDir, 'runtime/config'));
    expect(git(fixture.linked, ['status', '--porcelain'])).toBe('');
  });

  test('rejects the primary checkout and a linked main branch', () => {
    const ordinary = createFixture();
    expect(run(ordinary, ordinary.primary).stderr).toContain('primary checkout is forbidden');

    const linkedMain = createFixture({ primaryBranch: 'trunk', linkedBranch: 'main' });
    expect(run(linkedMain).stderr).toContain('non-main feature branch is required');
  });

  test('rejects dirty state, malformed plans and baseline drift', () => {
    const dirty = createFixture();
    writeFileSync(join(dirty.linked, 'dirty.txt'), 'dirty\n');
    expect(run(dirty).stderr).toContain('worktree must be clean');

    const malformed = createFixture();
    writeFileSync(malformed.plan, '# no contract\n');
    expect(run(malformed).stderr).toContain('closed YAML frontmatter');

    const drifted = createFixture();
    writeFileSync(drifted.plan, readFileSync(drifted.plan, 'utf8').replace(drifted.baseline, '0'.repeat(40)));
    expect(run(drifted).stderr).toContain('baseline mismatch');
  });

  test('propagates the executor exit status', () => {
    const fixture = createFixture();
    const result = run(fixture, fixture.linked, { PLAN_RELAY_TEST_EXIT: '17' });
    expect(result.status).toBe(17);
  });

  test('fails the run on a truncated or dead zero-exit session', () => {
    const truncated = createFixture();
    const truncatedResult = run(truncated, truncated.linked, { PLAN_RELAY_TEST_STREAM: 'length' });
    expect(truncatedResult.status).toBe(1);
    expect(truncatedResult.stderr).toContain('liveness gate');
    expect(truncatedResult.stderr).toContain('length');

    const dead = createFixture();
    const deadResult = run(dead, dead.linked, { PLAN_RELAY_TEST_STREAM: 'dead' });
    expect(deadResult.status).toBe(1);
    expect(deadResult.stderr).toContain('neither file edits nor an assistant response');
  });

  test('kills a hung executor with the watchdog and propagates the timeout status', () => {
    const fixture = createFixture();
    const result = run(fixture, fixture.linked, { PLAN_RELAY_TEST_STREAM: 'sleep', OPENCODE_TIMEOUT: '1' });
    expect(result.status).toBe(124);
    expect(result.stderr).not.toContain('liveness gate');
  });

  test('rejects a non-numeric OPENCODE_TIMEOUT', () => {
    const fixture = createFixture();
    const result = run(fixture, fixture.linked, { OPENCODE_TIMEOUT: 'soon' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('OPENCODE_TIMEOUT');
  });
});
