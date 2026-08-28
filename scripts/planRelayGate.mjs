// Plan Relay liveness gate — judge a completed executor session from its
// retained opencode JSONL event stream. Pure: evaluateEvents does no I/O, so
// the unit tests can feed synthetic streams and the retained evidence can be
// re-judged at any time.
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

export function evaluateEvents(jsonl) {
  const failures = [];
  const events = [];
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // The stream is evidence, not a contract; skip anything unparsable.
    }
  }

  const lastStepFinish = events.findLast((e) => e?.type === 'step_finish');
  if (lastStepFinish?.part?.reason === 'length') {
    failures.push(
      'final step ended truncated (finish reason "length"): the session produced no usable response',
    );
  }

  const edited = events.some(
    (e) =>
      e?.type === 'tool_use' &&
      EDIT_TOOLS.has(e.part?.tool) &&
      e.part?.state?.status === 'completed',
  );
  const responded = events.some((e) => e?.type === 'text');
  if (!edited && !responded) {
    failures.push('session produced neither file edits nor an assistant response');
  }

  return { ok: failures.length === 0, failures };
}

function main(argv) {
  const [eventsFile] = argv;
  if (!eventsFile) {
    console.error('Usage: planRelayGate.mjs <events.jsonl>');
    return 2;
  }
  let jsonl;
  try {
    jsonl = readFileSync(eventsFile, 'utf8');
  } catch (err) {
    console.error(`Plan Relay gate: cannot read events file: ${eventsFile}: ${err.message}`);
    return 2;
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
