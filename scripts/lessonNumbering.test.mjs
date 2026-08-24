// scripts/lessonNumbering.test.mjs — the lesson-numbering gate.
//
// Review lessons in docs/*-plan.md are cited from code by bare number
// ("review lessons 19-20" in weapons.ts). The list is grouped by category and
// ordered "roughly by how easy they are to repeat", so the natural way to add a
// lesson is mid-list — which renumbers everything after it and silently
// repoints every citation. Nothing caught that before this file.
//
// The policy the gate enforces (stated in docs/refactor-plan.md's Review
// lessons header and AGENTS.md): numbers are permanent IDs, assigned in order
// of recording, never reordered and never reused, sharing ONE counter across
// every plan document. Enforced by a gate rather than by review attention —
// which is lesson 19's own rule.
//
// This is a repo-hygiene check, not a simulation test: it reads files off disk
// and asserts nothing about game behavior. It lives in scripts/ so src/ stays
// game code, and rides in `npm test` because that is the gate everyone runs.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = join(ROOT, 'docs');

// First words of each lesson's bolded title, pinned. A renumber that keeps the
// list well-formed (swap two entries, insert in the middle and shift the rest)
// passes every structural check below and still breaks every citation — only a
// snapshot can see it. Deliberately an inline literal rather than
// `toMatchSnapshot`: a renumber then shows up as a readable diff in review and
// cannot be rewritten away with `vitest -u`.
//
// APPENDING a lesson adds a line here. CHANGING a line means a number moved:
// that is the failure this file exists to catch, so fix the numbering rather
// than the pin.
const PINNED_TITLES = {
  1: 'Wire what you extract, in',
  2: 'Making a function browser-only can',
  3: 'When moving a call between',
  4: 'A pure-function equivalence sweep does',
  5: 'Sample at the moment that',
  6: "Simulate the loop; don't hand-seed",
  7: 'Prove a regression test non-vacuous',
  8: 'npm run build proves nothing',
  9: 'Run the smoke test against',
  10: "Prove each of a gate's",
  11: "A docstring's reason must be",
  12: 'Grep for comments the change',
  13: "Don't overstate the history.",
  14: 'Document the full public surface.',
  15: 'Extension mapping is gated by',
  16: 'Vitest resolves through its own',
  17: "When a gate's mechanism moves,",
  18: 'A typed signature can surface',
  19: "Naming an expression's operands can",
  20: 'A pure-function test can be',
};

const TITLE_WORDS = 5;

/** Every plan document. Globbed, not listed: per-tranche plans land over time
 *  (docs/ai-plan.md with #29), and a plan the gate cannot see is unguarded. */
function planDocs() {
  return readdirSync(DOCS)
    .filter((f) => f.endsWith('-plan.md'))
    .sort()
    .map((f) => ({ path: join(DOCS, f), rel: join('docs', f) }));
}

/** Files whose prose may cite a lesson by number. The gate file itself is
 *  excluded — PINNED_TITLES is a definition, not a citation. */
function citingFiles() {
  const out = [join(ROOT, 'AGENTS.md'), ...planDocs().map((d) => d.path)];
  const walk = (dir) => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (full !== fileURLToPath(import.meta.url)) out.push(full);
    }
  };
  walk(join(ROOT, 'src'));
  walk(join(ROOT, 'scripts'));
  return out;
}

/**
 * Lesson definitions in one document: the numbered items under its
 * `## Review lessons` heading, in document order.
 *
 * A LIST, not a map keyed by number — keying here would make a number defined
 * twice in one document overwrite itself and vanish before the duplicate check
 * ever saw it (found by probing that check with a deliberate duplicate; it
 * stayed green).
 *
 * Two shapes in the real files the naive parse gets wrong: a bolded title wraps
 * across lines (lesson 2), and one opens with an inline code span (lesson 8,
 * `npm run build`). So an item is joined into a single line before its title is
 * read, and backticks/emphasis are stripped from the result.
 */
function parseLessons(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^##\s+Review lessons\b/.test(l));
  if (start === -1) return [];

  // Section runs to the next `##` heading (or EOF). `---` rules inside it are
  // not terminators — they separate prose, and a `##` always follows.
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) { end = i; break; }
  }

  const lessons = [];
  let current = null;
  const flush = () => {
    if (!current) return;
    const joined = current.body.join(' ').replace(/\s+/g, ' ').trim();
    const title = /^\*\*(.+?)\*\*/.exec(joined);
    lessons.push({
      n: current.n,
      line: current.line,
      title: normalize(title ? title[1] : joined),
    });
    current = null;
  };

  for (let i = start + 1; i < end; i++) {
    const item = /^(\d+)\.\s+(.*)$/.exec(lines[i]);
    if (item) {
      flush();
      current = { n: Number(item[1]), line: i + 1, body: [item[2]] };
    } else if (current) {
      current.body.push(lines[i].trim());
    }
  }
  flush();
  return lessons;
}

/** Prose → comparable text: no backticks, no emphasis markers, single spaces. */
function normalize(s) {
  return s.replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim();
}

function firstWords(title) {
  return title.split(' ').slice(0, TITLE_WORDS).join(' ');
}

/**
 * Lesson numbers cited in prose, with where each was found.
 *
 * Covers the four forms in the tree today — `lesson 19`, `lessons 10, 17, 19`,
 * `lessons 6/19/20`, `lessons 19-20` — plus the hyphenated adjective
 * (`the lesson-19 failure mode`) and en-dashed ranges (`lessons 15–18`), which
 * this repo's prose uses interchangeably with ASCII hyphens.
 */
const CITATION = /\blessons?\b[\s-]*(\d+(?:\s*[,/&–—-]\s*(?:and\s+)?\d+)*)/gi;

function parseCitations(text) {
  const cited = [];
  for (const match of text.matchAll(CITATION)) {
    const list = match[1];
    const line = text.slice(0, match.index).split('\n').length;
    // Split on separators, keeping them, so `a-b` can expand as a range while
    // `a, b` and `a/b` stay an enumeration.
    const parts = list.split(/\s*([,/&–—-])\s*/).filter((p) => p !== '');
    let previous = null;
    for (let i = 0; i < parts.length; i++) {
      if (/^\d+$/.test(parts[i])) {
        const n = Number(parts[i]);
        const isRange = /^[–—-]$/.test(parts[i - 1] ?? '');
        if (isRange && previous !== null && n > previous) {
          for (let k = previous + 1; k <= n; k++) cited.push({ n: k, line, text: match[0] });
        } else {
          cited.push({ n, line, text: match[0] });
        }
        previous = n;
      }
    }
  }
  return cited;
}

const documents = planDocs().map((d) => ({ ...d, lessons: parseLessons(readFileSync(d.path, 'utf8')) }));

describe('review lesson numbering', () => {
  test('at least one plan document defines lessons', () => {
    expect(documents.length).toBeGreaterThan(0);
    expect(documents.some((d) => d.lessons.length > 0)).toBe(true);
  });

  test('no number is defined twice, in one document or across them', () => {
    const seen = new Map();
    const duplicates = [];
    for (const doc of documents) {
      for (const lesson of doc.lessons) {
        const where = `${doc.rel}:${lesson.line}`;
        if (seen.has(lesson.n)) duplicates.push(`lesson ${lesson.n}: ${seen.get(lesson.n)} and ${where}`);
        else seen.set(lesson.n, where);
      }
    }
    // One counter across every plan document, so a bare "lesson N" in a code
    // comment stays unambiguous no matter which document it came from.
    expect(duplicates).toEqual([]);
  });

  test('numbers run 1..N with no gaps', () => {
    const all = documents.flatMap((d) => d.lessons.map((l) => l.n)).sort((a, b) => a - b);
    expect(all).toEqual(all.map((_, i) => i + 1));
  });

  test('every cited number resolves to exactly one lesson', () => {
    const defined = new Set(documents.flatMap((d) => d.lessons.map((l) => l.n)));
    const dangling = [];
    for (const file of citingFiles()) {
      const rel = relative(ROOT, file);
      for (const c of parseCitations(readFileSync(file, 'utf8'))) {
        if (!defined.has(c.n)) dangling.push(`${rel}:${c.line} cites "${c.text}" — lesson ${c.n} is not defined`);
      }
    }
    expect(dangling).toEqual([]);
  });

  test('pinned titles still carry their numbers', () => {
    const actual = {};
    for (const doc of documents) {
      for (const lesson of doc.lessons) actual[lesson.n] = firstWords(lesson.title);
    }
    // Only the pinned range is compared, so appending lessons 21+ in a new plan
    // document does not fail this until someone chooses to pin them.
    const pinnedRange = Object.fromEntries(
      Object.keys(PINNED_TITLES).map((n) => [n, actual[n]]),
    );
    expect(pinnedRange).toEqual(PINNED_TITLES);
  });
});
