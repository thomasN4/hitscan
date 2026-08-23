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
// the three blocks below do: browser for the game, node for the tooling.
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['dist/**'] },

  // Game code: runs in the browser, ES modules.
  {
    files: ['src/**/*.js'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.browser,
    },
  },

  // Unit tests: plain Node via Vitest, no browser globals. Keeping them out
  // of the browser block is deliberate — a test that reaches for `document`
  // is a test that stopped being a pure-simulation test.
  {
    files: ['src/**/*.test.js'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node,
    },
  },

  // Tooling: this config file.
  {
    files: ['eslint.config.js'],
    ...js.configs.recommended,
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
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
  },
];
