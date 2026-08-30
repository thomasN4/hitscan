// Doc gate for docs/plan-relay-log.md — the committed record of Plan Relay
// waves. It guards the structure a reader and a future gate depend on, and
// nothing else.
//
// The load-bearing check is that the highest row in Version history equals
// PLAN_RELAY_VERSION. That is what turns a digest bump into a written
// explanation: planRelay.test.mjs fails when the relay sources move without a
// version bump, and this fails until the new version has a row saying what
// changed. Neither gate alone forces bump-and-log; together they do.
//
// Deliberately NOT gated, and it should stay that way:
// - prose, wording or length of any entry. It is a journal, not a form.
// - cost, duration or file counts cross-checked against summary.json. Run
//   directories are ignored, local and pruned, so such a check would fail on
//   every machine but the one that produced the run.
// - that every run has an entry. Unknowable from the repository, and forcing
//   one per run would turn the log into a second events.jsonl.
// - the plan schema version in an entry. It is a property of that plan, not of
//   this log.
// - branch naming. AGENTS.md owns that rule; a second copy is a second thing to
//   fix.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { PLAN_RELAY_VERSION } from './planRelayVersion.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOG = join(ROOT, 'docs', 'plan-relay-log.md');

// The file carries a commented-out entry template. It is documentation for the
// author, not an entry, so it must not be parsed as one.
const text = readFileSync(LOG, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
const lines = text.split('\n');

const VERSION_ROW = /^\|\s*v(\d+)\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*(\S.*?)\s*\|$/;
const WAVE_HEADING = /^### (\d{4}-\d{2}-\d{2}) — wave `([^`]+)` — (\d+) executors?$/;
const WAVE_HEADING_FORM = '### YYYY-MM-DD — wave `<id>` — N executors';
const TABLE_ROW = /^\|\s*\d+\s*\|/;

function sectionLines(heading) {
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^## /.test(line));
  return end < 0 ? rest : rest.slice(0, end);
}

const versions = sectionLines('## Version history')
  .map((line) => VERSION_ROW.exec(line.trim()))
  .filter(Boolean)
  .map((match) => ({ version: Number(match[1]), date: match[2], change: match[3] }));

const waveSection = sectionLines('## Waves');
const waves = [];
waveSection.forEach((line, index) => {
  if (!line.startsWith('### ')) return;
  const match = WAVE_HEADING.exec(line.trim());
  const rest = waveSection.slice(index + 1);
  const end = rest.findIndex((next) => next.startsWith('### '));
  const body = (end < 0 ? rest : rest.slice(0, end)).join('\n');
  waves.push({ heading: line.trim(), match, body });
});

describe('Plan Relay log', () => {
  test('has exactly one version history and one waves section', () => {
    const count = (heading) => lines.filter((line) => line.trim() === heading).length;
    expect([count('## Version history'), count('## Waves')]).toEqual([1, 1]);
  });

  test('version history runs 1..N with no gaps and no duplicates', () => {
    expect(versions.length).toBeGreaterThan(0);
    const numbers = versions.map((row) => row.version);
    const expected = Array.from({ length: numbers.length }, (unused, i) => i + 1);
    expect([...numbers].sort((a, b) => a - b)).toEqual(expected);
  });

  test('the newest version history row is the current PLAN_RELAY_VERSION', () => {
    const highest = Math.max(...versions.map((row) => row.version));
    expect(
      highest,
      `docs/plan-relay-log.md documents relay versions up to v${highest}, but ` +
        `scripts/planRelayVersion.mjs is at v${PLAN_RELAY_VERSION}. Add a ` +
        `v${PLAN_RELAY_VERSION} row saying what changed.`,
    ).toBe(PLAN_RELAY_VERSION);
  });

  test('every wave heading carries a date, an id and an executor count', () => {
    const offenders = waves
      .filter((wave) => !wave.match)
      .map((wave) => `${wave.heading}\n  expected: ${WAVE_HEADING_FORM}`);
    expect(offenders).toEqual([]);
  });

  test('waves are appended in date order and their ids are unique', () => {
    const dated = waves.filter((wave) => wave.match);
    const dates = dated.map((wave) => wave.match[1]);
    expect([...dates].sort()).toEqual(dates);
    const ids = dated.map((wave) => wave.match[2]);
    expect([...new Set(ids)]).toEqual(ids);
  });

  test('each wave lists one table row per executor it declares', () => {
    const offenders = waves
      .filter((wave) => wave.match)
      .map((wave) => {
        const declared = Number(wave.match[3]);
        const rows = wave.body.split('\n').filter((line) => TABLE_ROW.test(line.trim())).length;
        return declared === rows ? null : `${wave.heading} declares ${declared}, table has ${rows}`;
      })
      .filter(Boolean);
    expect(offenders).toEqual([]);
  });

  test('each wave cites a known relay version and records a verdict', () => {
    const known = new Set(versions.map((row) => row.version));
    const offenders = [];
    for (const wave of waves.filter((entry) => entry.match)) {
      const cited = /\bRelay v(\d+)\b/.exec(wave.body);
      if (!cited) offenders.push(`${wave.heading} cites no "Relay vN"`);
      else if (!known.has(Number(cited[1]))) {
        offenders.push(`${wave.heading} cites Relay v${cited[1]}, which has no history row`);
      }
      if (!wave.body.includes('Verdict:')) offenders.push(`${wave.heading} has no "Verdict:"`);
    }
    expect(offenders).toEqual([]);
  });
});
