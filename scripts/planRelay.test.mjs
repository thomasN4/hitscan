import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { evaluateEvents, recoverySession } from './planRelayGate.mjs';
import { formatAllowedCommands } from './planRelayPrompt.mjs';
import { parseOptions, summarizeEvents } from './planRelaySummary.mjs';
import {
  PLAN_RELAY_VERSION,
  SOURCE_DIGEST,
  SOURCE_FILES,
  computeDigest,
  digestFromDisk,
  driftMessage,
} from './planRelayVersion.mjs';

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
  writeFileSync(join(primary, '.gitignore'), '.plan-relay\nnode_modules\n');
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
  echo 1.18.28
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
worktree=""
previous=""
for argument in "$@"; do
  if test "$previous" = "--dir"; then worktree="$argument"; fi
  previous="$argument"
done
healthy_stream() {
    printf '%s\\n' \\
      '{"type":"step_start","sessionID":"ses_fixture","timestamp":1700000000000,"part":{}}' \\
      '{"type":"tool_use","sessionID":"ses_fixture","timestamp":1700000001000,"part":{"tool":"edit","state":{"status":"completed","input":{"filePath":"src/x.ts"},"metadata":{"filediff":{"file":"'"$worktree"'/src/x.ts","additions":12,"deletions":3}}}}}' \\
      '{"type":"step_finish","sessionID":"ses_fixture","timestamp":1700000002000,"part":{"reason":"tool-calls","cost":0.01,"tokens":{"input":100,"output":20,"reasoning":5,"total":125,"cache":{"read":50,"write":0}}}}' \\
      '{"type":"step_start","sessionID":"ses_fixture","timestamp":1700000003000,"part":{}}' \\
      '{"type":"text","sessionID":"ses_fixture","timestamp":1700000004000,"part":{"text":"Implementation complete."}}' \\
      '{"type":"step_finish","sessionID":"ses_fixture","timestamp":1700000005000,"part":{"reason":"stop","cost":0.02,"tokens":{"input":200,"output":30,"reasoning":10,"total":240,"cache":{"read":80,"write":0}}}}'
}
denied_stream() {
    printf '%s\\n' \\
      '{"type":"step_start","sessionID":"ses_fixture","timestamp":1700000000000,"part":{}}' \\
      '{"type":"tool_use","sessionID":"ses_fixture","timestamp":1700000001000,"part":{"tool":"bash","state":{"status":"error","input":{"command":"npm run dev > /tmp/x.log 2>&1 &"},"error":"The user has specified a rule which prevents you from using this specific tool call. PERMISSION TABLE: bash deny ..."}}}' \\
      '{"type":"tool_use","sessionID":"ses_fixture","timestamp":1700000002000,"part":{"tool":"edit","state":{"status":"completed","input":{"filePath":"src/x.ts"},"metadata":{"filediff":{"file":"'"$worktree"'/src/x.ts","additions":4,"deletions":1}}}}}' \\
      '{"type":"text","sessionID":"ses_fixture","timestamp":1700000003000,"part":{"text":"Done."}}' \\
      '{"type":"step_finish","sessionID":"ses_fixture","timestamp":1700000004000,"part":{"reason":"stop","cost":0.05}}'
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
  denied)
    denied_stream
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
# The runner's "no watchdog budget remains" branch needs a turn that overruns
# the budget and still exits zero, which the real timeout makes impossible: it
# kills such a turn. Dropping --kill-after and the seconds leaves the executor
# to run free while the budget arithmetic in the runner is unchanged.
if test -n "\${PLAN_RELAY_TEST_NO_WATCHDOG:-}"; then
  shift 2
  exec "$@"
fi
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

function summaryOf(fixture) {
  const runs = readdirSync(join(fixture.linked, '.plan-relay'));
  expect(runs).toHaveLength(1);
  return JSON.parse(
    readFileSync(join(fixture.linked, '.plan-relay', runs[0], 'summary.json'), 'utf8'),
  );
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

  test('pins Muse Spark 1.3 Contributor xhigh with persistence and publication disabled', () => {
    const model = config.provider.openrouter.models['meta/muse-spark-1.3-contributor'];
    expect(config.enabled_providers).toEqual(['openrouter']);
    expect(model.variants.xhigh.reasoning.effort).toBe('xhigh');
    expect(model.limit).toEqual({ context: 1048576, output: 943718 });
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
      'openrouter/meta/muse-spark-1.3-contributor',
    ]);
    expect(args.slice(args.indexOf('--variant'), args.indexOf('--variant') + 2)).toEqual(['--variant', 'xhigh']);
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
    const summary = summaryOf(fixture);
    expect(summary.exit_status).toBe(17);
    expect(summary.gate).toBe('skipped');
    expect(summary.turns_launched).toBe(1);
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
      'xhigh',
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
    // The killed run is the one whose record matters most, and the summary must
    // not have replaced the watchdog's status with its own.
    const summary = summaryOf(fixture);
    expect(summary.exit_status).toBe(124);
    expect(summary.gate).toBe('skipped');
    expect(summary.watchdog_s).toBe(1);
  });

  test('writes a summary stamped with the wave, the relay version and the run totals', () => {
    const fixture = createFixture();
    const result = run(fixture, fixture.linked, { PLAN_RELAY_WAVE: 'warehouse-lighting' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('Plan Relay summary: .plan-relay/');
    const summary = summaryOf(fixture);
    expect(summary.wave).toBe('warehouse-lighting');
    expect(summary.gate).toBe('pass');
    expect(summary.exit_status).toBe(0);
    expect(summary.turns_launched).toBe(1);
    expect(summary.recovery).toBe('not-applicable');
    expect(summary.recovery_session).toBeNull();
    expect(summary.plan_relay_version).toBe(PLAN_RELAY_VERSION);
    expect(summary.plan_document_version).toBe('1');
    expect(summary.model).toBe('openrouter/meta/muse-spark-1.3-contributor');
    expect(summary.variant).toBe('xhigh');
    expect(summary.branch).toBe('feat/test');
    expect(summary.baseline).toBe(fixture.baseline);
    expect(summary.node_modules_shared).toBe(false);
    expect(summary.turn_boundaries).toBe('runner');
    expect(summary.sessions).toEqual(['ses_fixture']);
    expect(summary.totals.cost_usd).toBeCloseTo(0.03, 10);
    expect(summary.totals.tokens).toEqual({
      input: 300,
      output: 50,
      reasoning: 15,
      total: 365,
      cache_read: 130,
      cache_write: 0,
    });
    expect(summary.totals.span_ms).toBe(5000);
    // The executor reports an absolute path; a log entry needs a repo-relative one.
    expect(summary.files).toEqual([{ path: 'src/x.ts', edits: 1, additions: 12, deletions: 3 }]);
    expect(summary.final_text).toBe('Implementation complete.');
  });

  test('writes UTC summary timestamps under a non-UTC timezone', () => {
    const fixture = createFixture();
    const before = Date.now();
    const result = run(fixture, fixture.linked, { TZ: 'America/New_York' });
    const after = Date.now();
    expect(result.status, result.stderr).toBe(0);
    const summary = summaryOf(fixture);
    expect(Date.parse(summary.started_at)).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(summary.started_at)).toBeLessThanOrEqual(after + 1000);
    expect(Date.parse(summary.ended_at)).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(summary.ended_at)).toBeLessThanOrEqual(after + 1000);
  });

  test('defaults the wave to the run directory, never to something shared-looking', () => {
    const fixture = createFixture();
    expect(run(fixture).status).toBe(0);
    const runs = readdirSync(join(fixture.linked, '.plan-relay'));
    const summary = summaryOf(fixture);
    expect(summary.wave).toBe(runs[0]);
    expect(summary.run).toBe(runs[0]);
  });

  test('records a failed gate and the recovery it attempted', () => {
    const fixture = createFixture();
    const result = run(fixture, fixture.linked, { PLAN_RELAY_TEST_STREAM: 'length' });
    expect(result.status).toBe(1);
    const summary = summaryOf(fixture);
    expect(summary.gate).toBe('fail');
    expect(summary.recovery).toBe('taken');
    expect(summary.turns_launched).toBe(2);
    expect(summary.turns).toHaveLength(2);
    expect(summary.turns[0].finish_reason).toBe('length');
  });

  test('records a recovery declined for want of watchdog budget', () => {
    const fixture = createFixture();
    const result = run(fixture, fixture.linked, {
      PLAN_RELAY_TEST_STREAM: 'length_slow_then_healthy',
      PLAN_RELAY_TEST_NO_WATCHDOG: '1',
      OPENCODE_TIMEOUT: '1',
    });
    expect(result.stderr).toContain('no watchdog budget remains');
    expect(readFileSync(fixture.capture.count, 'utf8').trim()).toBe('1');
    const summary = summaryOf(fixture);
    expect(summary.recovery).toBe('declined-no-budget');
    expect(summary.turns_launched).toBe(1);
  });

  test('warns about a shared install only when a wave is declared', () => {
    const shared = createFixture();
    symlinkSync(shared.primary, join(shared.linked, 'node_modules'));
    const quiet = run(shared);
    expect(quiet.status, quiet.stderr).toBe(0);
    expect(quiet.stderr).not.toContain('needs its own install');
    expect(summaryOf(shared).node_modules_shared).toBe(true);

    const wave = createFixture();
    symlinkSync(wave.primary, join(wave.linked, 'node_modules'));
    const loud = run(wave, wave.linked, { PLAN_RELAY_WAVE: 'w1' });
    expect(loud.status, loud.stderr).toBe(0);
    expect(loud.stderr).toContain('needs its own install');
    expect(summaryOf(wave).node_modules_shared).toBe(true);
  });

  test('rejects a malformed wave id', () => {
    const fixture = createFixture();
    const result = run(fixture, fixture.linked, { PLAN_RELAY_WAVE: 'has spaces' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('PLAN_RELAY_WAVE');
  });

  test('does not let a failing summary writer mask the run status', () => {
    const fixture = createFixture();
    const stub = join(dirname(fixture.plan), 'summary-stub.mjs');
    writeFileSync(stub, 'process.exit(3);\n');
    const result = run(fixture, fixture.linked, { PLAN_RELAY_SUMMARY: stub });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('summary could not be written');
  });

  test('rejects a non-numeric OPENCODE_TIMEOUT', () => {
    const fixture = createFixture();
    const result = run(fixture, fixture.linked, { OPENCODE_TIMEOUT: 'soon' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('OPENCODE_TIMEOUT');
  });
});

describe('Plan Relay summary', () => {
  const DENIAL =
    'The user has specified a rule which prevents you from using this specific tool call. ' +
    'PERMISSION TABLE: bash {"*":"deny"} ...';
  const RICH = stream(
    { type: 'step_start', sessionID: 'ses_a', timestamp: 1000, part: {} },
    {
      type: 'tool_use',
      sessionID: 'ses_a',
      timestamp: 1100,
      part: {
        tool: 'edit',
        state: {
          status: 'completed',
          metadata: { filediff: { file: '/w/src/a.ts', additions: 10, deletions: 2 } },
        },
      },
    },
    {
      type: 'tool_use',
      sessionID: 'ses_a',
      timestamp: 1200,
      part: {
        tool: 'edit',
        state: {
          status: 'completed',
          metadata: { filediff: { file: '/w/src/a.ts', additions: 5, deletions: 1 } },
        },
      },
    },
    {
      type: 'tool_use',
      sessionID: 'ses_a',
      timestamp: 1300,
      part: {
        tool: 'bash',
        state: { status: 'error', input: { command: 'npm run dev &' }, error: DENIAL },
      },
    },
    { type: 'tool_use', sessionID: 'ses_a', timestamp: 1400, part: { tool: 'read', state: { status: 'completed' } } },
    { type: 'text', sessionID: 'ses_a', timestamp: 1500, part: { text: 'All done.' } },
    {
      type: 'step_finish',
      sessionID: 'ses_a',
      timestamp: 1600,
      part: {
        reason: 'stop',
        cost: 0.25,
        tokens: { input: 10, output: 2, reasoning: 1, total: 13, cache: { read: 7, write: 3 } },
      },
    },
  );

  test('totals cost, tokens, tools and per-file line counts', () => {
    const summary = summarizeEvents(RICH, { worktree: '/w' });
    expect(summary.totals.cost_usd).toBe(0.25);
    expect(summary.totals.tokens).toEqual({
      input: 10,
      output: 2,
      reasoning: 1,
      total: 13,
      cache_read: 7,
      cache_write: 3,
    });
    expect(summary.totals.span_ms).toBe(600);
    expect(summary.totals.edits).toBe(2);
    expect(summary.totals.tool_calls).toBe(4);
    expect(summary.totals.tool_errors).toBe(1);
    // Two edits to one file merge into one entry rather than two rows.
    expect(summary.files).toEqual([{ path: 'src/a.ts', edits: 2, additions: 15, deletions: 3 }]);
    expect(summary.tools).toEqual({
      edit: { completed: 2 },
      bash: { error: 1 },
      read: { completed: 1 },
    });
    expect(summary.sessions).toEqual(['ses_a']);
    expect(summary.final_text).toBe('All done.');
  });

  test('records a denied call by its command and never by its error blob', () => {
    const summary = summarizeEvents(RICH, { worktree: '/w' });
    expect(summary.denied).toEqual([{ turn: 1, tool: 'bash', command: 'npm run dev &' }]);
    expect(JSON.stringify(summary)).not.toContain('PERMISSION TABLE');
  });

  test('leaves a path outside the worktree absolute', () => {
    const summary = summarizeEvents(RICH, { worktree: '/elsewhere' });
    expect(summary.files.map((file) => file.path)).toEqual(['/w/src/a.ts']);
  });

  const TWO_TURNS = stream(
    { type: 'step_finish', sessionID: 'ses_a', timestamp: 1000, part: { reason: 'length', cost: 0.1 } },
    {
      type: 'tool_use',
      sessionID: 'ses_a',
      timestamp: 2000,
      part: {
        tool: 'edit',
        state: { status: 'completed', metadata: { filediff: { file: 'src/b.ts', additions: 1, deletions: 0 } } },
      },
    },
    { type: 'step_finish', sessionID: 'ses_a', timestamp: 3000, part: { reason: 'stop', cost: 0.2 } },
  );

  test('splits turns on the boundary the runner supplies', () => {
    const summary = summarizeEvents(TWO_TURNS, { boundaries: [1] });
    expect(summary.turn_boundaries).toBe('runner');
    expect(summary.turns.map((turn) => turn.cost_usd)).toEqual([0.1, 0.2]);
    expect(summary.turns[0].finish_reason).toBe('length');
    expect(summary.gap_ms).toEqual([1000]);
  });

  test('infers the same split from a length marker when re-judging from disk', () => {
    const supplied = summarizeEvents(TWO_TURNS, { boundaries: [1] });
    const inferred = summarizeEvents(TWO_TURNS);
    expect(inferred.turn_boundaries).toBe('inferred');
    expect(inferred.turns.map((turn) => turn.cost_usd)).toEqual(
      supplied.turns.map((turn) => turn.cost_usd),
    );
  });

  test('reports absent provider numbers as null rather than a confident zero', () => {
    const summary = summarizeEvents(stream({ type: 'step_finish', part: { reason: 'stop' } }));
    expect(summary.totals.cost_usd).toBeNull();
    expect(summary.totals.span_ms).toBeNull();
    expect(summary.totals.tokens.input).toBeNull();
    expect(summary.turns[0].model_ms).toBeUndefined();
  });

  test('counts a half-written final line instead of swallowing it', () => {
    // What a watchdog kill leaves behind; a record that hid it would read as a
    // clean short run.
    const summary = summarizeEvents(`${RICH}\n{"type":"step_fin`);
    expect(summary.totals.unparsable_lines).toBe(1);
    expect(summary.totals.event_lines).toBe(7);
  });

  test('counts a new file written whole, which carries no filediff', () => {
    // opencode reports `write` with content and exists:false and no filediff,
    // so a created file would otherwise land in the record as +0/-0.
    const created = summarizeEvents(
      stream({
        type: 'tool_use',
        part: {
          tool: 'write',
          state: {
            status: 'completed',
            input: { filePath: '/w/src/new.ts', content: 'a\nb\nc\n' },
            metadata: { exists: false },
          },
        },
      }),
      { worktree: '/w' },
    );
    expect(created.files).toEqual([{ path: 'src/new.ts', edits: 1, additions: 3, deletions: 0 }]);

    const oneBlankLine = summarizeEvents(
      stream({
        type: 'tool_use',
        part: {
          tool: 'write',
          state: {
            status: 'completed',
            input: { filePath: '/w/src/blank.txt', content: '\n' },
            metadata: { exists: false },
          },
        },
      }),
      { worktree: '/w' },
    );
    expect(oneBlankLine.files).toEqual([
      { path: 'src/blank.txt', edits: 1, additions: 1, deletions: 0 },
    ]);

    // A write OVER an existing file has deletions that are simply not in the
    // stream, so it stays unattributed rather than reading as a pure addition.
    const overwritten = summarizeEvents(
      stream({
        type: 'tool_use',
        part: {
          tool: 'write',
          state: {
            status: 'completed',
            input: { filePath: '/w/src/old.ts', content: 'a\nb\n' },
            metadata: { exists: true },
          },
        },
      }),
      { worktree: '/w' },
    );
    expect(overwritten.files).toEqual([{ path: 'src/old.ts', edits: 1, additions: 0, deletions: 0 }]);
  });

  test('rejects an unknown or malformed option rather than dropping a field', () => {
    expect(() => parseOptions(['--duration-s=4'])).toThrow(/unknown option/);
    expect(() => parseOptions(['--gate'])).toThrow(/malformed option/);
    expect(parseOptions(['--gate=pass', '--duration_s=4', '--node_modules_shared=true'])).toEqual({
      gate: 'pass',
      duration_s: 4,
      node_modules_shared: true,
    });
  });
});

describe('Plan Relay version', () => {
  test('lists the relay sources, excluding itself and every test', () => {
    expect(Number.isInteger(PLAN_RELAY_VERSION) && PLAN_RELAY_VERSION > 0).toBe(true);
    expect(SOURCE_FILES.length).toBeGreaterThan(0);
    expect([...SOURCE_FILES].sort()).toEqual(SOURCE_FILES);
    // A file cannot contain a digest of itself; completing this list later
    // would make the gate unsatisfiable rather than merely stricter.
    expect(SOURCE_FILES).not.toContain('scripts/planRelayVersion.mjs');
    expect(SOURCE_FILES.filter((file) => file.includes('.test.'))).toEqual([]);
    expect(SOURCE_FILES.filter((file) => !existsSync(join(scriptsDir, '..', file)))).toEqual([]);
  });

  test('digests paths as well as bytes', () => {
    // Verified against a synthetic reader, because the drift test below imports
    // the algorithm from the very file it is checking.
    const bytes = Object.fromEntries(SOURCE_FILES.map((file, i) => [file, Buffer.from(`body-${i}`)]));
    const base = computeDigest((file) => bytes[file]);
    const swapped = {
      ...bytes,
      [SOURCE_FILES[0]]: bytes[SOURCE_FILES[1]],
      [SOURCE_FILES[1]]: bytes[SOURCE_FILES[0]],
    };
    expect(computeDigest((file) => swapped[file])).not.toBe(base);
    const appended = {
      ...bytes,
      [SOURCE_FILES[0]]: Buffer.concat([bytes[SOURCE_FILES[0]], Buffer.from('x')]),
    };
    expect(computeDigest((file) => appended[file])).not.toBe(base);
  });

  test('the relay sources still match the recorded version', () => {
    const computed = digestFromDisk();
    expect(computed, driftMessage(computed)).toBe(SOURCE_DIGEST);
  });
});
