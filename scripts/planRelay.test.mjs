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
import { evaluateEvents, recoverySession } from './planRelayGate.mjs';
import { formatAllowedCommands } from './planRelayPrompt.mjs';

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
call_index=1
if test -f "$PLAN_RELAY_TEST_COUNT"; then
  IFS= read -r previous_calls < "$PLAN_RELAY_TEST_COUNT"
  call_index=$((previous_calls + 1))
fi
printf '%s\\n' "$call_index" > "$PLAN_RELAY_TEST_COUNT"
printf '%s\\n' "$@" > "$PLAN_RELAY_TEST_ARGS.$call_index"
printf '%s' "$OPENCODE_CONFIG_CONTENT" > "$PLAN_RELAY_TEST_CONFIG"
printf '%s\\n' "$XDG_CONFIG_HOME" > "$PLAN_RELAY_TEST_XDG"
healthy_stream() {
    printf '%s\\n' \\
      '{"type":"step_start","part":{}}' \\
      '{"type":"tool_use","part":{"tool":"edit","state":{"status":"completed","input":{"filePath":"src/x.ts"}}}}' \\
      '{"type":"step_finish","part":{"reason":"tool-calls"}}' \\
      '{"type":"step_start","part":{}}' \\
      '{"type":"text","part":{"text":"Implementation complete."}}' \\
      '{"type":"step_finish","part":{"reason":"stop"}}'
}
activity_without_finish_stream() {
    printf '%s\\n' \\
      '{"type":"step_start","part":{}}' \\
      '{"type":"tool_use","part":{"tool":"edit","state":{"status":"completed","input":{"filePath":"src/x.ts"}}}}' \\
      '{"type":"text","part":{"text":"Implementation complete."}}'
}
length_stream() {
    printf '%s\\n' \\
      '{"type":"step_start","sessionID":"ses_fixture","part":{}}' \\
      '{"type":"step_finish","sessionID":"ses_fixture","part":{"reason":"length"}}'
}
case "\${PLAN_RELAY_TEST_STREAM:-healthy}" in
  healthy)
    healthy_stream
    ;;
  length)
    length_stream
    ;;
  length_then_healthy)
    if test "$call_index" -eq 1; then
      length_stream
    else
      healthy_stream
    fi
    ;;
  length_then_activity_without_finish)
    if test "$call_index" -eq 1; then
      length_stream
    else
      activity_without_finish_stream
    fi
    ;;
  length_slow_then_healthy)
    if test "$call_index" -eq 1; then
      sleep 1
      length_stream
    else
      healthy_stream
    fi
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

  // Record the watchdog supplied to each executor turn, then delegate to the
  // real GNU timeout required by the runner. This makes the shared-budget
  // contract observable without weakening the hung-executor integration test.
  const realTimeout = execFileSync('sh', ['-c', 'command -v timeout'], { encoding: 'utf8' }).trim();
  const fakeTimeout = join(fakeBin, 'timeout');
  writeFileSync(fakeTimeout, `#!/usr/bin/env bash
printf '%s\\n' "$2" >> "$PLAN_RELAY_TEST_TIMEOUTS"
exec ${JSON.stringify(realTimeout)} "$@"
`);
  chmodSync(fakeTimeout, 0o755);

  const capture = {
    args: join(root, 'args.txt'),
    count: join(root, 'count.txt'),
    config: join(root, 'config.json'),
    xdg: join(root, 'xdg.txt'),
    timeouts: join(root, 'timeouts.txt'),
  };
  const env = {
    ...process.env,
    OPENROUTER_API_KEY: 'test-only',
    OPENCODE_BIN: fake,
    PLAN_RELAY_TEST_ARGS: capture.args,
    PLAN_RELAY_TEST_COUNT: capture.count,
    PLAN_RELAY_TEST_CONFIG: capture.config,
    PLAN_RELAY_TEST_XDG: capture.xdg,
    PLAN_RELAY_TEST_TIMEOUTS: capture.timeouts,
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

  test('selects only a no-edit length-truncated session for recovery', () => {
    const start = { type: 'step_start', sessionID: 'ses_recover', part: {} };
    const finish = {
      type: 'step_finish',
      sessionID: 'ses_recover',
      part: { reason: 'length' },
    };
    const truncated = stream(start, finish);
    expect(recoverySession(truncated)).toBe('ses_recover');
    expect(recoverySession(stream(EDIT_CALL, start, finish))).toBeUndefined();
    expect(
      recoverySession(
        stream(
          { type: 'step_start', sessionID: 'ses_done', part: {} },
          { type: 'step_finish', sessionID: 'ses_done', part: { reason: 'stop' } },
        ),
      ),
    ).toBeUndefined();
    expect(recoverySession(stream({ type: 'step_finish', part: { reason: 'length' } }))).toBeUndefined();
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

  test('does not count activity from before a recovery continuation', () => {
    const { ok, failures } = evaluateEvents(
      stream(
        { type: 'text', part: { text: 'Baseline verified.' } },
        { type: 'step_finish', part: { reason: 'length' } },
        { type: 'step_start', part: {} },
        { type: 'step_finish', part: { reason: 'stop' } },
      ),
    );
    expect(ok).toBe(false);
    expect(failures.join('\n')).toContain('neither file edits nor an assistant response');
  });

  test('accepts recovery activity when OpenCode omits the final step finish', () => {
    expect(
      evaluateEvents(
        stream(
          { type: 'step_finish', part: { reason: 'length' } },
          EDIT_CALL,
          { type: 'text', part: { text: 'Implementation complete.' } },
        ),
      ),
    ).toEqual({ ok: true, failures: [] });
  });

  test('rejects a session with only failed edits and no response', () => {
    const { ok, failures } = evaluateEvents(
      stream(
        {
          type: 'tool_use',
          part: {
            tool: 'edit',
            state: { status: 'error', input: { filePath: 'src/x.ts' }, error: 'oldString not found' },
          },
        },
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
  test('formats allowed bash policy entries without including deny rules', () => {
    const formatted = formatAllowedCommands({
      agent: {
        executor: {
          permission: {
            bash: {
              '*': 'deny',
              rg: 'allow',
              'rg *': 'allow',
              'git show *': 'allow',
              'CS_SMOKE_BASE=http://localhost:* node scripts/smoke-test.mjs': 'allow',
              cat: 'deny',
            },
          },
        },
      },
    });

    expect(formatted).toBe(
      'rg with optional arguments; git show with arguments; CS_SMOKE_BASE=http://localhost:* node scripts/smoke-test.mjs',
    );
    expect(formatted).not.toContain('cat');
  });

  test('rejects configs without an allowed bash command', () => {
    expect(() => formatAllowedCommands({})).toThrow(
      'executor config is missing agent.executor.permission.bash',
    );
    expect(() =>
      formatAllowedCommands({ agent: { executor: { permission: { bash: { '*': 'deny' } } } } }),
    ).toThrow('executor config contains no allowed bash commands');
  });

  test('pins GLM-5.3-Flash high with persistence and publication disabled', () => {
    const model = config.provider.openrouter.models['z-ai/glm-5.3-flash'];
    expect(config.enabled_providers).toEqual(['openrouter']);
    expect(model.variants.high.reasoning.effort).toBe('high');
    expect(config.share).toBe('disabled');
    expect(config.snapshot).toBe(false);
    expect(config.autoupdate).toBe(false);
  });

  test('allows rg and validation while denying unlisted shell commands', () => {
    const policy = config.agent.executor.permission;
    expect(policy['*']).toBe('deny');
    expect(policy.external_directory).toBe('deny');
    expect(policy.edit).toBe('allow');
    expect(policy.grep).toBe('deny');
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
    expect(args.slice(args.indexOf('--variant'), args.indexOf('--variant') + 2)).toEqual(['--variant', 'high']);
    expect(args).not.toContain('--auto');
    expect(argsText).toContain(`Allowed commands are: ${formatAllowedCommands(config)}.`);
    expect(argsText).toContain('All unlisted shell commands are denied');
    expect(argsText).toContain('Use the read tool with offsets and limits for file contents.');
    expect(argsText).toContain('generic grep tool is denied');
    expect(argsText).toContain('explicit, narrow file or directory path');
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
    expect(readFileSync(fixture.capture.count, 'utf8').trim()).toBe('1');
  });

  test('continues a no-edit length-truncated session once and gates the combined stream', () => {
    const fixture = createFixture();
    const result = run(fixture, fixture.linked, { PLAN_RELAY_TEST_STREAM: 'length_then_healthy' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toMatch(
      /continuing no-edit length-truncated session once with [1-9][0-9]*s remaining: ses_fixture/,
    );
    expect(readFileSync(fixture.capture.count, 'utf8').trim()).toBe('2');

    const firstArgs = readFileSync(`${fixture.capture.args}.1`, 'utf8').trim().split('\n');
    expect(firstArgs).toContain('--file');
    expect(firstArgs).not.toContain('--session');

    const secondArgs = readFileSync(`${fixture.capture.args}.2`, 'utf8').trim().split('\n');
    expect(secondArgs.slice(secondArgs.indexOf('--session'), secondArgs.indexOf('--session') + 2)).toEqual([
      '--session',
      'ses_fixture',
    ]);
    expect(secondArgs.slice(secondArgs.indexOf('--variant'), secondArgs.indexOf('--variant') + 2)).toEqual([
      '--variant',
      'high',
    ]);
    expect(secondArgs).not.toContain('--file');

    const [runDir] = readdirSync(join(fixture.linked, '.plan-relay'));
    const events = readFileSync(join(fixture.linked, '.plan-relay', runDir, 'events.jsonl'), 'utf8');
    expect(events).toContain('"reason":"length"');
    expect(events).toContain('Implementation complete.');
  });

  test('accepts a successful recovery whose final step-finish event is absent', () => {
    const fixture = createFixture();
    const result = run(fixture, fixture.linked, {
      PLAN_RELAY_TEST_STREAM: 'length_then_activity_without_finish',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(fixture.capture.count, 'utf8').trim()).toBe('2');

    const [runDir] = readdirSync(join(fixture.linked, '.plan-relay'));
    const events = readFileSync(join(fixture.linked, '.plan-relay', runDir, 'events.jsonl'), 'utf8');
    expect(events).toContain('"reason":"length"');
    expect(events).toContain('Implementation complete.');
    expect(events).not.toContain('"reason":"stop"');
  });

  test('gives recovery only the remaining watchdog budget', () => {
    const fixture = createFixture();
    const result = run(fixture, fixture.linked, {
      OPENCODE_TIMEOUT: '5',
      PLAN_RELAY_TEST_STREAM: 'length_slow_then_healthy',
    });
    expect(result.status, result.stderr).toBe(0);

    const timeouts = readFileSync(fixture.capture.timeouts, 'utf8')
      .trim()
      .split('\n')
      .map(Number);
    expect(timeouts).toHaveLength(2);
    expect(timeouts[0]).toBe(5);
    expect(timeouts[1]).toBeGreaterThan(0);
    expect(timeouts[1]).toBeLessThan(timeouts[0]);
  });

  test('fails the run on a truncated or dead zero-exit session', () => {
    const truncated = createFixture();
    const truncatedResult = run(truncated, truncated.linked, { PLAN_RELAY_TEST_STREAM: 'length' });
    expect(truncatedResult.status).toBe(1);
    expect(truncatedResult.stderr).toContain('liveness gate');
    expect(truncatedResult.stderr).toContain('length');
    expect(readFileSync(truncated.capture.count, 'utf8').trim()).toBe('2');

    const dead = createFixture();
    const deadResult = run(dead, dead.linked, { PLAN_RELAY_TEST_STREAM: 'dead' });
    expect(deadResult.status).toBe(1);
    expect(deadResult.stderr).toContain('neither file edits nor an assistant response');
    expect(readFileSync(dead.capture.count, 'utf8').trim()).toBe('1');
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
