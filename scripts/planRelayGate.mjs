// Plan Relay liveness gate — judge a completed executor session from its
// retained opencode JSONL event stream. Pure: evaluateEvents and
// recoverySession do no I/O, so the unit tests can feed synthetic streams and
// the retained evidence can be re-judged at any time.
//
// Death modes this catches, both observed in retained .plan-relay runs:
// - the model burned its reasoning budget in one step and the stream ended
//   finish-reason "length" with no usable output — opencode exits 0, so
//   without this gate the runner reports success over a session that did
//   nothing;
// - the session produced neither edits nor any assistant response (provider
//   stream died before the model said or did anything). A legitimate
//   zero-edit blocker report still emits a final response, so it passes.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const EDIT_TOOLS = new Set(['edit', 'write']);

function parseEvents(jsonl) {
  const events = [];
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // The stream is evidence, not a contract; skip anything unparsable.
    }
  }
  return events;
}

function hasCompletedEdit(events) {
  return events.some(
    (e) =>
      e?.type === 'tool_use' &&
      EDIT_TOOLS.has(e.part?.tool) &&
      e.part?.state?.status === 'completed',
  );
}

/**
 * Return the session that may receive ONE procedural recovery prompt.
 *
 * Only the observed death mode is recoverable: a zero-exit turn that consumed
 * its reasoning allowance before making any edit. A partial implementation
 * must remain stopped for the planner to inspect instead of receiving an
 * automatic second chance to compound it.
 */
export function recoverySession(jsonl) {
  const events = parseEvents(jsonl);
  const lastStepFinish = events.findLast((e) => e?.type === 'step_finish');
  if (lastStepFinish?.part?.reason !== 'length' || hasCompletedEdit(events)) return undefined;

  const sessionEvent = events.findLast((e) => {
    const sessionId = e?.sessionID ?? e?.part?.sessionID;
    return typeof sessionId === 'string' && sessionId.length > 0;
  });
  return sessionEvent?.sessionID ?? sessionEvent?.part?.sessionID;
}

export function evaluateEvents(jsonl) {
  const failures = [];
  const events = parseEvents(jsonl);

  const lastStepFinish = events.findLast((e) => e?.type === 'step_finish');
  // A recovery continuation appends to the retained stream. Reconnaissance
  // text from the truncated turn is not evidence that the continuation did
  // anything, so judge liveness only after the most recent truncation.
  const lastLength = events.findLastIndex(
    (e) => e?.type === 'step_finish' && e?.part?.reason === 'length',
  );
  const liveEvents = lastLength >= 0 ? events.slice(lastLength + 1) : events;
  const edited = hasCompletedEdit(liveEvents);
  const responded = liveEvents.some((e) => e?.type === 'text');
  // OpenCode may observe session idle before the final step-finish event. If a
  // continuation emitted usable work after the old length marker, that work
  // supersedes the marker even when a final `stop` never reached stdout.
  if (lastStepFinish?.part?.reason === 'length' && !edited && !responded) {
    failures.push(
      'final step ended truncated (finish reason "length"): the session produced no usable response',
    );
  }
  if (!edited && !responded) {
    failures.push('session produced neither file edits nor an assistant response');
  }

  return { ok: failures.length === 0, failures };
}

function main(argv) {
  const recoveryMode = argv[0] === '--recovery-session';
  const eventsFile = argv[recoveryMode ? 1 : 0];
  if (!eventsFile) {
    console.error('Usage: planRelayGate.mjs [--recovery-session] <events.jsonl>');
    return 2;
  }
  let jsonl;
  try {
    jsonl = readFileSync(eventsFile, 'utf8');
  } catch (err) {
    console.error(`Plan Relay gate: cannot read events file: ${eventsFile}: ${err.message}`);
    return 2;
  }
  if (recoveryMode) {
    const sessionId = recoverySession(jsonl);
    if (sessionId) console.log(sessionId);
    return sessionId ? 0 : 1;
  }

  const { ok, failures } = evaluateEvents(jsonl);
  if (!ok) {
    for (const failure of failures) console.error(`Plan Relay gate: ${failure}`);
  }
  return ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
