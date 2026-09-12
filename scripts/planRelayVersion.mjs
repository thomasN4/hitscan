// Plan Relay tooling version — the integer a wave entry in
// docs/plan-relay-log.md cites so its numbers can be attributed to the code
// that produced them.
//
// This is NOT `plan_relay_version`. That field, in a plan's YAML frontmatter,
// versions the plan DOCUMENT schema — the handoff contract between planner and
// executor — and it is validated in plan-relay.sh. The two axes move
// independently: the relay grew a watchdog, a liveness gate and a recovery turn
// across eleven commits while the document schema never moved off 1. Do not
// "sync" them.
//
// SOURCE_DIGEST pins the relay's behaviour bytes. planRelay.test.mjs
// recomputes it from disk and fails when the sources moved without a bump, and
// planRelayLog.test.mjs then fails until the new version has a history row —
// so a behaviour change cannot land unversioned or unexplained.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PLAN_RELAY_VERSION = 8;

// Sorted, and asserted sorted, so the digest's input order is reviewable rather
// than incidental. planRelayVersion.mjs is absent on purpose: a file cannot
// contain a digest of itself, and completing this list later would make the
// gate unsatisfiable. Tests are absent because a test edit is not a behaviour
// change, and a gate that fires on one teaches reflexive bumping.
export const SOURCE_FILES = [
  'scripts/opencode-executor-config.json',
  'scripts/plan-relay.sh',
  'scripts/planRelayGate.mjs',
  'scripts/planRelayPrompt.mjs',
  'scripts/planRelaySummary.mjs',
];

export const DIGEST_LENGTH = 16;

export const SOURCE_DIGEST = 'b24a0fe9db5c0b3d';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Digest the relay sources. Pure: `read(relativePath) -> Buffer`.
 *
 * Each file contributes its path and byte length before its bytes, so moving a
 * block between two hashed files changes the digest (path) and no two files can
 * concatenate into an ambiguous stream (length). Bytes are hashed raw, never
 * decoded, so no normalization can hide a change.
 */
export function computeDigest(read) {
  const hash = createHash('sha256');
  for (const file of SOURCE_FILES) {
    const bytes = read(file);
    hash.update(`${file}\n${bytes.length}\n`);
    hash.update(bytes);
  }
  return hash.digest('hex').slice(0, DIGEST_LENGTH);
}

export function digestFromDisk(root = ROOT) {
  return computeDigest((file) => readFileSync(join(root, file)));
}

/**
 * The remedial text the drift test prints. It carries the computed digest
 * verbatim because the entire cost of this gate is paid at the moment it fires:
 * a gate that makes you go compute the fix by hand gets worked around.
 */
export function driftMessage(computed) {
  return [
    'Plan Relay sources changed without a version bump.',
    '',
    `  recorded PLAN_RELAY_VERSION  ${PLAN_RELAY_VERSION}`,
    `  recorded SOURCE_DIGEST       ${SOURCE_DIGEST}`,
    `  computed from disk           ${computed}`,
    '',
    'Changed: one or more of',
    ...SOURCE_FILES.map((file) => `  ${file}`),
    '',
    'Fix in this order:',
    `  1. scripts/planRelayVersion.mjs: PLAN_RELAY_VERSION = ${PLAN_RELAY_VERSION + 1}`,
    `  2. scripts/planRelayVersion.mjs: SOURCE_DIGEST = '${computed}'`,
    `  3. docs/plan-relay-log.md: add a v${PLAN_RELAY_VERSION + 1} row to Version history`,
    '     saying what changed. scripts/planRelayLog.test.mjs fails until you do.',
  ].join('\n');
}

function main(argv) {
  console.log(argv[0] === '--digest' ? digestFromDisk() : String(PLAN_RELAY_VERSION));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
