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
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['dist/**'] },

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
    files: ['src/**/*.js'],
    ignores: ['src/**/*.test.js'],
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
    files: ['src/**/*.test.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node,
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
];
