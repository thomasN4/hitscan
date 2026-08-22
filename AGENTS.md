# AGENTS.md

Guidance for AI agents (and humans) working in this repository.

## Project

Browser FPS demo: Three.js + Vite, plain ES modules, no framework. All game code lives in `src/`; markup/CSS in `index.html`.

## Workflow

Work in **plan → implement → commit** increments. Commit only when explicitly requested (or when the agreed plan ends with a commit step). Use pull requests once the project grows beyond simple single-branch work. Commit messages: short imperative summary, optionally `;`-joined clauses, e.g.

```
Fix missing player import breaking reload; add smoke test and debug hook
```

## Commands

```sh
npm run dev                    # dev server (http://localhost:5173)
npm run build                  # production build -> dist/
node scripts/smoke-test.mjs    # headless E2E check (requires dev server running)
```

The smoke test drives the user's Brave browser via puppeteer-core; its executable path is machine-specific (Flatpak path) and may need adjusting on other machines.

## Architecture rules

- **All shared mutable state lives in `src/core.js`** (`player`, `weapon`, `game`, `keys`, collections). Do not create new cross-module mutable globals elsewhere.
- **Dependency direction:** everything may import from `core.js`; modules must not import each other in cycles. Current flow: `main` → {player, bots, weapons...} → core.
- **Level geometry must go through `map.js:addBox`**, which registers both the movement AABB (`colliders`) and the raycast target (`solids`). Adding meshes directly to the scene creates walk-through/shoot-through bugs.
- **Damage flows through `combat.js`** (`damagePlayer` / `damageBot`) — don't mutate HP from callers.
- DOM writes only in `hud.js`. Sound synthesis only in `audio.js`.

## Gotchas learned the hard way

- **Missing imports are NOT build errors here.** Vite/rollup won't flag an identifier used inside a function body if it happens to resolve as a global at runtime — it becomes a silent `ReferenceError` when that code path first runs (this is how reload broke once). After refactors or moving code between modules, run the smoke test, not just `npm run build`.
- Pointer lock has a browser-enforced cooldown after `exitPointerLock()`; re-locking too soon silently fails. The canvas click handler recovers, keep that behavior when touching menus.
- The game loop only simulates while pointer lock is held (`game.locked && game.started`) but always renders. Anything added to the loop should respect that split.
- `window.__cs` in main.js is a debug/testing hook relied on by the smoke test — keep it exporting `{ game, weapon, player, bulletHoles }`.

## Conventions

- JSDoc on exported functions; "why" comments for non-obvious logic; tuning notes inline on gameplay constants (e.g., `fireRate: 0.105 // ≈ 9.5 rounds/sec`).
- No comments that merely restate code. Keep existing `// ---------- Section ----------` headers.
- No asset files: all audio is WebAudio-synthesized, all visuals are procedural geometry.

## Roadmap / deferred ideas

- Unify Bot and the player under a shared entity/combatant base class (both currently duplicate movement/collision/shooting logic in different forms). Deferred — revisit when adding a second entity type or weapon.
