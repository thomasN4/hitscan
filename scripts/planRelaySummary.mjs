// Plan Relay run summary — reduce a retained opencode JSONL event stream to the
// machine half of a run's record: cost, tokens, per-turn timing, files touched,
// denied tool calls. Pure, like the liveness gate beside it: summarizeEvents
// does no I/O, so unit tests feed synthetic streams and a run retained months
// ago can be re-summarized from disk.
//
// The runner attempts this for EVERY run, the failures most of all — a watchdog
// kill or a gate rejection is the run whose cost, last tool call and denied
// commands the planner actually needs, and it is the one the transcript makes
// hardest to read by hand. A summary failure is reported without replacing the
// executor's status, so the retained event stream remains the fallback record.
//
// The planner copies the numbers into a wave entry in docs/plan-relay-log.md.
// This file is local and pruned; that entry is the committed record.
//
// Deliberately absent: any split of a turn's span into tool time versus model
// time. opencode's tool_use `state.time` is the part's emission window, not the
// command's wall clock — a retained run records `npm run typecheck && npm test`
// as 21ms and `npm run build` as 17ms. A "model round-trip" derived from that
// is confidently wrong, so only the honest measurement survives: span_ms, from
// the first to the last event timestamp.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseEventLines } from './planRelayGate.mjs';
import { PLAN_RELAY_VERSION } from './planRelayVersion.mjs';

const EDIT_TOOLS = new Set(['edit', 'write']);
// A policy denial embeds the entire permission table in state.error — hundreds
// of bytes of noise per call. Classify on it; never store it.
const DENIAL_MARKER = 'prevents you from using this specific tool call';
const COMMAND_LIMIT = 200;
const FINAL_TEXT_LIMIT = 2000;

// The pins live here rather than in bash so a record cannot outlive the values
// that produced them. PRIMARY_MODEL is what the runner tries first;
// FALLBACK_MODEL is the one-shot retry on the same invocation. The runner
// reports which one actually ran as --model_used, and the summary stamps that —
// a record claiming the primary when the fallback did the work would lie to the
// wave entry that cites it.
const OPENCODE_VERSION = '1.18.28';
const PRIMARY_MODEL = 'opencode/muse-spark-1.3-contributor-free';
const FALLBACK_MODEL = 'openrouter/meta/muse-spark-1.3-contributor';
const MODEL = PRIMARY_MODEL;
const VARIANT = 'xhigh';

/** Sum a provider-reported field, staying null when NO step carried it. */
function makeSum() {
  return { total: 0, seen: false };
}

function addTo(acc, value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    acc.total += value;
    acc.seen = true;
  }
}

function valueOf(acc) {
  return acc.seen ? acc.total : null;
}

function addSum(target, source) {
  target.total += source.total;
  target.seen = target.seen || source.seen;
}

function isoOrNull(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z') : null;
}

/**
 * Turn boundaries: exact when the runner supplies them, inferred otherwise.
 *
 * Neither sessionID nor messageID can mark a turn — a recovery continues the
 * SAME session via --session, and step_start/step_finish pair per assistant
 * message, so messageID is a step identity. The runner knows the boundary as a
 * line count; re-judging from disk falls back to the one condition under which
 * the runner launches a second turn at all (plan-relay.sh: a length-truncated
 * final step with no completed edit), which is the same slice the gate takes.
 */
function inferBoundaries(entries) {
  const boundaries = [];
  entries.forEach((entry, index) => {
    const event = entry.event;
    if (event?.type !== 'step_finish' || event?.part?.reason !== 'length') return;
    if (index < entries.length - 1) boundaries.push(entry.line);
  });
  return boundaries;
}

function splitTurns(entries, boundaries) {
  const turns = [];
  let current = [];
  const cuts = new Set(boundaries);
  for (const entry of entries) {
    current.push(entry);
    if (cuts.has(entry.line)) {
      turns.push(current);
      current = [];
    }
  }
  if (current.length > 0) turns.push(current);
  return turns.length > 0 ? turns : [[]];
}

function countLines(content) {
  if (typeof content !== 'string') return null;
  if (content === '') return 0;
  const lines = content.split('\n').length;
  return content.endsWith('\n') ? lines - 1 : lines;
}

function relativize(path, worktree) {
  if (typeof path !== 'string' || path.length === 0) return path;
  if (!worktree) return path;
  const prefix = worktree.endsWith('/') ? worktree : `${worktree}/`;
  // A path outside the worktree stays absolute. external_directory: deny should
  // make that impossible; if one appears, you want to see it.
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

export function summarizeEvents(jsonl, { worktree = '', boundaries = [] } = {}) {
  const entries = parseEventLines(jsonl);
  const nonBlank = jsonl.split('\n').filter((line) => line.trim()).length;
  const supplied = boundaries.filter((line) => Number.isFinite(line) && line > 0);
  const cuts = supplied.length > 0 ? supplied : inferBoundaries(entries);
  const turnEntries = splitTurns(entries, cuts);

  const sessions = [];
  const files = new Map();
  const tools = {};
  const denied = [];
  const totalTokens = {
    input: makeSum(),
    output: makeSum(),
    reasoning: makeSum(),
    total: makeSum(),
    cache_read: makeSum(),
    cache_write: makeSum(),
  };
  const totalCost = makeSum();
  let steps = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  let edits = 0;
  let additions = 0;
  let deletions = 0;
  let finalText = null;

  const turns = turnEntries.map((group, index) => {
    const events = group.map((entry) => entry.event);
    const timestamps = events
      .map((e) => e?.timestamp)
      .filter((t) => typeof t === 'number' && Number.isFinite(t));
    const spanMs = timestamps.length > 0 ? Math.max(...timestamps) - Math.min(...timestamps) : null;

    const turnCost = makeSum();
    const turnTokens = {
      input: makeSum(),
      output: makeSum(),
      reasoning: makeSum(),
      total: makeSum(),
      cache_read: makeSum(),
      cache_write: makeSum(),
    };
    let turnSteps = 0;
    let turnEdits = 0;
    let finishReason = null;
    let session = null;

    for (const event of events) {
      const sessionId = event?.sessionID ?? event?.part?.sessionID;
      if (typeof sessionId === 'string' && sessionId.length > 0) {
        session = session ?? sessionId;
        if (!sessions.includes(sessionId)) sessions.push(sessionId);
      }

      if (event?.type === 'step_finish') {
        turnSteps += 1;
        steps += 1;
        finishReason = event?.part?.reason ?? finishReason;
        addTo(turnCost, event?.part?.cost);
        const tokens = event?.part?.tokens ?? {};
        addTo(turnTokens.input, tokens.input);
        addTo(turnTokens.output, tokens.output);
        addTo(turnTokens.reasoning, tokens.reasoning);
        addTo(turnTokens.total, tokens.total);
        addTo(turnTokens.cache_read, tokens.cache?.read);
        addTo(turnTokens.cache_write, tokens.cache?.write);
      }

      if (event?.type === 'text') {
        const text = event?.part?.text;
        if (typeof text === 'string' && text.length > 0) finalText = text;
      }

      if (event?.type !== 'tool_use') continue;
      const tool = event?.part?.tool ?? 'unknown';
      const state = event?.part?.state ?? {};
      const status = state.status ?? 'unknown';
      toolCalls += 1;
      tools[tool] = tools[tool] ?? {};
      tools[tool][status] = (tools[tool][status] ?? 0) + 1;
      if (status === 'error') {
        toolErrors += 1;
        if (typeof state.error === 'string' && state.error.includes(DENIAL_MARKER)) {
          const command = state.input?.command ?? state.input?.filePath ?? '';
          denied.push({
            turn: index + 1,
            tool,
            command: String(command).slice(0, COMMAND_LIMIT),
          });
        }
      }
      if (EDIT_TOOLS.has(tool) && status === 'completed') {
        turnEdits += 1;
        edits += 1;
        const diff = state.metadata?.filediff;
        const path = relativize(diff?.file ?? state.input?.filePath ?? '', worktree);
        if (path) {
          const record = files.get(path) ?? { path, edits: 0, additions: 0, deletions: 0 };
          record.edits += 1;
          // Only `edit` carries a filediff. A `write` creating a file reports
          // just content and exists:false, so count its lines rather than
          // record a new file as +0/-0. A write OVER an existing file stays
          // unattributed: its deletions are genuinely not in the stream, and a
          // one-sided count would read as a pure addition.
          const written =
            !diff && tool === 'write' && state.metadata?.exists === false
              ? countLines(state.input?.content)
              : null;
          if (Number.isFinite(diff?.additions)) {
            record.additions += diff.additions;
            additions += diff.additions;
          } else if (written !== null) {
            record.additions += written;
            additions += written;
          }
          if (Number.isFinite(diff?.deletions)) {
            record.deletions += diff.deletions;
            deletions += diff.deletions;
          }
          files.set(path, record);
        }
      }
    }

    addSum(totalCost, turnCost);
    for (const key of Object.keys(totalTokens)) addSum(totalTokens[key], turnTokens[key]);

    return {
      index: index + 1,
      session,
      started_at: isoOrNull(timestamps.length > 0 ? Math.min(...timestamps) : NaN),
      ended_at: isoOrNull(timestamps.length > 0 ? Math.max(...timestamps) : NaN),
      span_ms: spanMs,
      steps: turnSteps,
      finish_reason: finishReason,
      cost_usd: valueOf(turnCost),
      tokens: Object.fromEntries(Object.entries(turnTokens).map(([k, v]) => [k, valueOf(v)])),
      edits: turnEdits,
    };
  });

  // Gate invocation plus a fresh opencode boot; the only place that cost shows.
  const gapMs = [];
  for (let i = 1; i < turns.length; i += 1) {
    const previous = turns[i - 1].ended_at;
    const next = turns[i].started_at;
    gapMs.push(previous && next ? Date.parse(next) - Date.parse(previous) : null);
  }

  const spans = turns.map((turn) => turn.span_ms).filter((ms) => ms !== null);
  const spanTotal = spans.length > 0 ? spans.reduce((sum, ms) => sum + ms, 0) : null;

  return {
    opencode: OPENCODE_VERSION,
    model: MODEL,
    variant: VARIANT,
    sessions,
    turn_boundaries: supplied.length > 0 ? 'runner' : 'inferred',
    turns,
    gap_ms: gapMs,
    totals: {
      cost_usd: valueOf(totalCost),
      tokens: Object.fromEntries(Object.entries(totalTokens).map(([k, v]) => [k, valueOf(v)])),
      steps,
      tool_calls: toolCalls,
      tool_errors: toolErrors,
      denied_calls: denied.length,
      edits,
      files_changed: files.size,
      additions,
      deletions,
      event_lines: entries.length,
      // A watchdog kill leaves a half-written final line. A record that
      // swallowed it would look like a clean short run.
      unparsable_lines: nonBlank - entries.length,
      span_ms: spanTotal,
    },
    files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
    tools,
    denied,
    final_text: finalText === null ? null : finalText.slice(0, FINAL_TEXT_LIMIT),
    final_text_truncated: finalText !== null && finalText.length > FINAL_TEXT_LIMIT,
  };
}

// An explicit whitelist, because a bash typo (--duration-s=) would otherwise
// produce a summary silently missing a field.
const STRING_KEYS = [
  'plan_document_version',
  'run',
  'wave',
  'worktree',
  'branch',
  'baseline',
  'model_used',
  'started_at',
  'ended_at',
  'recovery',
  'recovery_session',
  'gate',
];
const NUMBER_KEYS = ['duration_s', 'watchdog_s', 'turns_launched', 'turn1_lines', 'exit_status'];
const BOOLEAN_KEYS = ['node_modules_shared'];

export function parseOptions(argv) {
  const options = {};
  for (const arg of argv) {
    const split = arg.indexOf('=');
    if (!arg.startsWith('--') || split < 0) throw new Error(`malformed option: ${arg}`);
    const key = arg.slice(2, split);
    const raw = arg.slice(split + 1);
    if (STRING_KEYS.includes(key)) options[key] = raw;
    else if (NUMBER_KEYS.includes(key)) options[key] = raw === '' ? null : Number(raw);
    else if (BOOLEAN_KEYS.includes(key)) options[key] = raw === 'true';
    else throw new Error(`unknown option: --${key}`);
  }
  return options;
}

export function buildSummary(jsonl, options) {
  const { turn1_lines: turn1Lines, model_used: modelUsed, ...supplied } = options;
  const derived = summarizeEvents(jsonl, {
    worktree: supplied.worktree ?? '',
    boundaries: Number.isFinite(turn1Lines) && turn1Lines > 0 ? [turn1Lines] : [],
  });
  return {
    plan_relay_version: PLAN_RELAY_VERSION,
    plan_document_version: supplied.plan_document_version ?? null,
    run: supplied.run ?? null,
    wave: supplied.wave ?? null,
    worktree: supplied.worktree ?? null,
    branch: supplied.branch ?? null,
    baseline: supplied.baseline ?? null,
    node_modules_shared: supplied.node_modules_shared ?? false,
    started_at: supplied.started_at ?? null,
    ended_at: supplied.ended_at ?? null,
    duration_s: supplied.duration_s ?? null,
    watchdog_s: supplied.watchdog_s ?? null,
    turns_launched: supplied.turns_launched ?? null,
    recovery: supplied.recovery ?? null,
    recovery_session: supplied.recovery_session || null,
    exit_status: supplied.exit_status ?? null,
    gate: supplied.gate ?? null,
    ...derived,
    model: modelUsed ?? derived.model,
    fallback_model: FALLBACK_MODEL,
  };
}

function main(argv) {
  const [eventsFile, outFile, ...rest] = argv;
  if (!eventsFile || !outFile) {
    console.error('Usage: planRelaySummary.mjs <events.jsonl> <out.json> [--key=value ...]');
    return 2;
  }
  let options;
  try {
    options = parseOptions(rest);
  } catch (err) {
    console.error(`Plan Relay summary: ${err.message}`);
    return 2;
  }
  let jsonl;
  try {
    jsonl = readFileSync(eventsFile, 'utf8');
  } catch (err) {
    console.error(`Plan Relay summary: cannot read events file: ${eventsFile}: ${err.message}`);
    return 2;
  }
  try {
    writeFileSync(outFile, `${JSON.stringify(buildSummary(jsonl, options), null, 2)}\n`);
  } catch (err) {
    console.error(`Plan Relay summary: cannot write summary: ${outFile}: ${err.message}`);
    return 2;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
