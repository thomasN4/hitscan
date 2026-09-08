// eslint.config.js — the lint gate.
//
// This config exists for ONE rule above all: `no-undef`. The repo's
// most-cited trap (AGENTS.md, gotcha #1) is that a missing import is not a
// build error here — Vite/rollup will not flag an identifier used inside a
// function body if it happens to resolve as a runtime global, so it ships as
// a silent ReferenceError on the first call (`730d9cc`, the reload break).
// `no-undef` catches exactly that, at edit time, without needing TypeScript.
//
// It only works if the globals are declared per environment, which is what
// the `files` blocks below do: browser for the game, node for the tooling.
//
// Division of labor since the TS migration: `no-undef` owns missing imports
// in `.js` files only. In `.ts` files it must stay OFF (typescript-eslint
// requirement — type names trip it), and the job moves to `tsc --noEmit`
// (`npm run typecheck`, TS2304). Either gate alone catches `730d9cc`; run
// both.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'recordings/**'] },

  // Rules live here ONCE, with no `files`, so every linted file gets them.
  // Spreading recommended into each block instead left any file matching no
  // block (a future root vite.config.js, say) parsing with zero rules — a
  // silent no-op. The blocks below only vary languageOptions/globals; flat
  // config merges those in on top of this entry.
  js.configs.recommended,

  // Game code: runs in the browser, ES modules.
  //
  // The `ignores` here is load-bearing and must live in THIS block. Flat
  // config merges the globals of every matching block (later keys win, but
  // nothing is ever removed), and `src/**/*.js` matches the test files too —
  // so without the exclusion they'd resolve to browser ∪ Node and a test
  // reaching for `document` would pass clean. A block lower down cannot
  // undo that merge; exclusion can only happen in the first one.
  {
    files: ['src/**/*.{js,ts}'],
    ignores: ['src/**/*.test.{js,ts}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.browser,
    },
  },

  // Unit tests: plain Node via Vitest, no browser globals — a test that
  // reaches for `document` has stopped being a pure-simulation test. Vitest
  // itself is deliberately NOT declared global: every test imports
  // `{ describe, expect, test }` from 'vitest' explicitly, and bare
  // `test`/`expect` tripping `no-undef` keeps it that way.
  {
    files: ['src/**/*.test.{js,ts}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node,
    },
  },

  // TypeScript game + test code: type-aware rules from the migration's rule
  // table (AGENTS.md roadmap), with `no-undef` OFF — see the header. The
  // block is scoped to `.ts` so the presets never reach `.js`/`.mjs`, which
  // is why no disableTypeChecked pass is needed below.
  {
    files: ['src/**/*.ts'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
      },
    },
    rules: {
      'no-undef': 'off',
    },
  },

  // Unit-test purity, re-armed for TypeScript.
  //
  // The `ignores` up in the game-code block withholds browser globals from
  // tests so that `no-undef` fires on `document` — but the block above turns
  // `no-undef` OFF for every `.ts` file, tests included, so once the suite
  // became TypeScript that gate went silently vacuous. Review lesson 10
  // recurring in a new form: the globals were never the mechanism, the rule
  // was. tsc cannot cover the handoff either, because `target: ES2022` with no
  // `lib` pulls in lib.es2022.FULL — which includes DOM.
  //
  // Placement is the OPPOSITE constraint to lesson 10's: that fix had to sit
  // in the first matching block because `ignores` is the only way to remove a
  // merged global. This one ADDS rules, and flat config merges rules
  // later-wins, so it must sit AFTER the block that switches `no-undef` off.
  //
  // A test-only tsconfig with `lib: ["ES2022"]` would be the more complete
  // gate, and was rejected: `world.test.ts` legitimately reaches
  // `core/engine.ts` through `world.ts`, so a DOM-free lib flags correct code.
  // The import ban below buys back most of that reach without the false
  // positive — it draws the line at the test's own import, which is where the
  // architecture actually draws it (AGENTS.md).
  {
    files: ['src/**/*.test.ts'],
    rules: {
      // Not exhaustive, and cannot be — this is the set a simulation test
      // would plausibly reach for. The import ban is what makes the gate
      // structural rather than a denylist.
      'no-restricted-globals': ['error',
        { name: 'document', message: 'Unit tests run in plain Node — see AGENTS.md.' },
        { name: 'window', message: 'Unit tests run in plain Node — see AGENTS.md.' },
        { name: 'location', message: 'Unit tests run in plain Node — see AGENTS.md.' },
        { name: 'navigator', message: 'Unit tests run in plain Node — see AGENTS.md.' },
        { name: 'localStorage', message: 'Unit tests run in plain Node — see AGENTS.md.' },
        { name: 'sessionStorage', message: 'Unit tests run in plain Node — see AGENTS.md.' },
        { name: 'AudioContext', message: 'Unit tests run in plain Node — see AGENTS.md.' },
        { name: 'requestAnimationFrame', message: 'Unit tests run in plain Node — see AGENTS.md.' },
        { name: 'cancelAnimationFrame', message: 'Unit tests run in plain Node — see AGENTS.md.' },
        { name: 'getComputedStyle', message: 'Unit tests run in plain Node — see AGENTS.md.' },
        { name: 'innerWidth', message: 'Unit tests run in plain Node — see AGENTS.md.' },
        { name: 'innerHeight', message: 'Unit tests run in plain Node — see AGENTS.md.' },
        { name: 'devicePixelRatio', message: 'Unit tests run in plain Node — see AGENTS.md.' },
      ],
      // The pure-simulation layer is state / sim / world / collision, per
      // AGENTS.md. A test that imports a renderer-side module has stopped
      // being one, and drags that module's module-scope work into Node.
      'no-restricted-imports': ['error', {
        patterns: [{
          group: [
            '**/core/engine', '**/audio', '**/hud', '**/effects', '**/weapons',
            '**/bots', '**/combat', '**/player', '**/main', '**/map', '**/range',
          ],
          message: 'Browser-side module — unit tests cover the pure simulation layer only (AGENTS.md).',
        }],
      }],
    },
  },

  // Tooling: this config file.
  {
    files: ['eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node,
    },
  },

  // The smoke test is genuinely BOTH environments in one file: it runs in
  // Node, but every `page.evaluate(() => ...)` callback is serialized and
  // executed inside the browser, where `window`, `document`, `KeyboardEvent`
  // and friends are the real globals. Declaring only Node here would flag 75
  // correct references; declaring both is what the file actually has access
  // to, across its two execution contexts.
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
  },
);
