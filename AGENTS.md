# AGENTS.md

Guidance for AI agents (and humans) working in this repository.

## Project

Browser FPS demo: Three.js + Vite, plain ES modules, no framework. All game code lives in `src/`; markup/CSS in `index.html`.

## Workflow

Default loop for every non-trivial change: **plan → worktree → implement → open draft PR**.

1. **Plan** — agree scope and approach with the user before touching code.
2. **Worktree** — every branch is developed in its own git worktree, never directly in the shared primary checkout (which stays on `main`). One session per worktree; never run two sessions against one working copy:

   ```sh
   git worktree add ../cs-demo-<slug> -b feat/<short-slug>
   ```

3. **Implement** — on a feature branch cut from `main` (inside its worktree):
   - `feat/<short-slug>` for features, `fix/<short-slug>` for bug fixes
   - As many WIP commits as sensible while working; commit messages: short imperative summary, optionally `;`-joined clauses, e.g.

   ```
   Fix missing player import breaking reload; add smoke test and debug hook
   ```
4. **Draft PR** — once implementation AND verification (build + smoke test) pass, push the branch and open a draft PR against `main`:
   - `gh pr create --draft --title "<imperative summary>" --body "..."`
   - PR body: what changed, why, and verification results.
5. **Review** — the user merges personally in the GitHub UI. Do NOT run `gh pr merge` or `gh pr ready` unless explicitly instructed for that specific PR.

Direct pushes to `main` are the exception, only when the user asks (e.g., hotfixes, workflow/docs meta-changes).

## Commands

```sh
npm run dev                    # dev server (http://localhost:5173)
npm run build                  # production build -> dist/
npm test                       # Vitest unit tests (no browser, ~200 ms)
node scripts/smoke-test.mjs    # headless E2E check (requires dev server running)
```

Two test layers, deliberately split:

- **`npm test`** — pure simulation logic (state, and from PR 2 on: accuracy, recoil, ballistics). Runs in plain Node, no browser, no dev server. Fast enough to run on every edit.
- **`scripts/smoke-test.mjs`** — integration: real rendering, real input events, both maps. This is the layer that catches missing imports and wiring breakage. Drives the user's Brave browser via puppeteer-core; its executable path is machine-specific (Flatpak path) and may need adjusting on other machines. Point it at a non-default port with `CS_SMOKE_BASE=http://localhost:5177 node scripts/smoke-test.mjs`.

## Architecture rules

- **All shared mutable state lives in `src/core/state.js`** (`player`, `weapon`, `game`, `keys`, `bots`, effects collections) — except the level-geometry registries `solids`/`colliders`, which `world.js` owns so registration has exactly one path. Do not create new cross-module mutable globals elsewhere.
- **`core/state.js` must stay importable in plain Node.** It may use THREE's math classes (`Vector3`, `Box3`), but never `document`, `window`, `location`, or a `WebGLRenderer`. This is what makes the simulation unit-testable: `src/core/state.test.js` runs in plain Node, so a browser global at module scope breaks every test in it on import. Browser-derived values are written IN by `main.js` at startup (see `game.map`) rather than read here. Anything browser-only belongs in `core/engine.js` or behind an `init*()` function.
- **Engine singletons (`renderer`, `scene`, `camera`, `clock`) live in `src/core/engine.js`** and are created by `initEngine()`, not at module scope. They are `export let` live bindings: reading them at module scope (before init) yields `undefined`.
- **No module-scope side effects that touch the engine or the DOM.** A module needing either exposes an `init*()` function that `main.js` calls in order. Current order, which `main.js` documents inline:

  ```
  initEngine() → initHUD() → initWeaponViewmodels() → buildMap()/buildRange() → respawn() → loop
  ```

- **Gameplay math lives in `src/sim/`, as pure functions.** Accuracy, recoil, ballistics, damage zones, speed tiers and blend easing take every input as a parameter — no engine imports, no DOM, no reads of shared state. That is what makes them unit-testable in plain Node (`npm test`), and it is where new gameplay math belongs. Modules like `weapons.js` are thin bindings that feed live state in.
- **Extract and wire in the same commit.** If you lift a formula or constant into `sim/`, delete the inline original and switch every call site at once. A named constant that nothing imports, or a pure function shadowed by a surviving inline copy, is two sources of truth plus a comment that lies.
- **The per-frame stage order in `main.js:animate()` is load-bearing:**

  ```
  updateMovement → updateWeapon → updateCamera → updateViewmodel → updateBots → updateHUD
  ```

  `updateWeapon` consumes the blends `updateMovement` writes and decays `game.recoil`; `updateCamera` and `updateViewmodel` then read that post-decay recoil, so camera, viewmodel and bullets agree within a frame. Reordering aims the camera a frame ahead of the shots (`5e004a5`). The pin runs the other way too: `updateMovement` writes `camera.position`, and `shoot()` — reached from inside `updateWeapon` — rays from `camera.getWorldPosition()`, so that write cannot be deferred to `updateCamera` without firing every shot from the previous frame's eye. Keep the sequence flat in `animate()` — do not nest one stage inside another.
- **Dependency direction:** everything may import from `core/state.js` and `sim/`; browser-side modules also import `core/engine.js` and `world.js`. Modules must not import each other in cycles. Current flow: `main` → {player, bots, weapons, map, range} → {world, sim, core}. `world.js` sits between the map builders and `core/`: unlike `sim/` it is not engine-free — it imports `scene` from `core/engine.js` — but it reads `scene` only inside `addSolidBox`, which is what keeps the module importable in plain Node.
- **Level geometry must go through `src/world.js`**, which owns `solids` (raycast targets: bullets, decals, bot LOS) and `colliders` (world-space AABBs for movement). Adding meshes to the scene directly creates walk-through/shoot-through bugs. That is the whole public surface — if none of these fits, add a function here rather than pushing to the arrays yourself:

  | | |
  |---|---|
  | `addSolidBox(x,y,z,w,h,d,mat)` | Create + `scene.add` + register both. **The default** for walls and crates. Browser-only. |
  | `createSolidBox(x,y,z,w,h,d,mat)` | Same construction, but no scene and no registration. Pure; the seam `addSolidBox` is built from, and where `y` = BASE is unit-tested. |
  | `registerSolidBox(mesh)` | Both registries, for a mesh you positioned yourself. Pure. |
  | `registerSolid(mesh)` | Raycast target, **no** AABB — flat ground planes only. Pure. |
  | `registerGroupParts(group, {shootable, blocking})` | Parts under a transformed parent. Flushes the group's world matrix before measuring, and takes two lists because they legitimately differ (a range target's post blocks walking but not bullets). Pure. |
  | `resetWorld()` | Clears both registries. Tests only. |

  `registerSolid` is narrower than it looks: it is right for the ground planes because a flat `PlaneGeometry` measures to a **zero-height** box at y ≈ 0, below `TEST_BOX_MIN_Y`, so an AABB there would do nothing at all — movement is bounded by the perimeter/lane walls instead. Geometry with real height (a floor slab, a raised platform, a ramp) is **not** this case and must go through `addSolidBox`/`registerSolidBox`, or you ship a walk-through floor.

  Only `addSolidBox` touches the scene; the rest are pure and unit-tested, because all three bugs this has caused (`431ac6e` no-clip, `faa52c5` AABBs at the origin, and the base-vs-centre offset) live in the scene-free half.
- **Map switching is a full page reload** driven by the `?map=` URL param (read once by `main.js` at startup into `game.map`). Never hot-swap scene contents at runtime — map builders (`map.js`, `range.js`) assume a fresh scene. Any new map needs: a builder registered in main.js, spawn handling in `combat.js:respawn()`, and a smoke-test pass.
- **Damage flows through `combat.js`** (`damagePlayer` / `damageBot`) — don't mutate HP from callers.
- DOM writes only in `hud.js`. Sound synthesis only in `audio.js`.

## Gotchas learned the hard way

- **Missing imports are NOT build errors here.** Vite/rollup won't flag an identifier used inside a function body if it happens to resolve as a global at runtime — it becomes a silent `ReferenceError` when that code path first runs (this is how reload broke once). After refactors or moving code between modules, run the smoke test, not just `npm run build`. `npm test` does not catch this either for browser-side modules — only the smoke test exercises them.
- Pointer lock has a browser-enforced cooldown after `exitPointerLock()`; re-locking too soon silently fails. The canvas click handler recovers, keep that behavior when touching menus.
- The game loop only simulates while pointer lock is held (`game.locked && game.started`) but always renders. Anything added to the loop should respect that split.
- **Stale dev servers serve stale code.** An orphaned `vite` process holding port 5173 makes every smoke test validate an old build (new servers silently shift to 5174). Before testing: `fuser -k <port>/tcp`, start the server with `--port <n> --strictPort`, and confirm the port from its log. With parallel worktrees, parallel dev servers are expected — pick a distinct port per worktree and point the smoke test at it with `CS_SMOKE_BASE` (it defaults to 5173).
- `window.__cs` in main.js is a debug/testing hook relied on by the smoke test — keep it exporting `{ game, weapon, player, bulletHoles, colliders }`.
- **Euler rotation orders matter**: the camera and shot-direction math must both use `'YXZ'`. Default `'XYZ'` silently aims shots somewhere else (this caused bullets flying skyward once). The order now lives in one place — `sim/ballistics.js:EULER_ORDER` — with a test pinning shot direction against a `'YXZ'` camera matrix, so the two can no longer drift apart silently.

## Conventions

- JSDoc on exported functions; "why" comments for non-obvious logic; tuning notes inline on gameplay constants (e.g., `fireRate: 0.105 // ≈ 9.5 rounds/sec`).
- No comments that merely restate code. Keep existing `// ---------- Section ----------` headers.
- No asset files: all audio is WebAudio-synthesized, all visuals are procedural geometry.

## Roadmap / deferred ideas

Maintainability tranche 1 (in progress) — see the plan for full rationale:

- **PR 1 (done):** split `core.js` into pure `core/state.js` + browser-only `core/engine.js`; explicit init order; Vitest.
- **PR 2 (done):** extract pure sim math into `src/sim/` (`accuracy`, `recoil`, `ballistics`, `damage`, `movement`, `smoothing`) with unit tests; hoist the frame pipeline into `main.js` so intra-frame ordering is visible.
- **PR 3 (done):** single geometry-registration path in `src/world.js` (`addSolidBox`, `registerSolid`, `registerGroupParts`), replacing the duplicated `addBox` in `map.js`/`range.js`; `collidesAt` now takes `colliders` as a parameter, matching `hasLineOfSight`.
- **PR 4:** `sim/validateWeapons.js` enforcing the `recoilRecover < recoilKick / fireRate` class of constraint that has now been fixed twice by hand.

Deferred to a later tranche:

- **TypeScript migration + an ESLint gate.** Full `.ts`, starting with `src/sim/*` (already pure functions with explicit params, so they convert with no restructuring). The lint config bans `any` — `@typescript-eslint/no-explicit-any` plus the `no-unsafe-*` family, since explicit-`any` alone doesn't stop `any` leaking in from loosely-typed three.js surfaces — and `ban-ts-comment` for `@ts-ignore`. Two `tsconfig` flags matter as much: `strict` and `noUncheckedIndexedAccess` (`WEAPONS[game.slot]` and `zoomFovs[game.zoomLevel]` are unchecked index reads on input-mutated state). Note `no-undef` needs no TypeScript and would catch the missing-import gotcha above today, if it's ever worth pulling forward on its own.
- Unifying the two time bases (`clock.elapsedTime` vs `performance.now()`) behind one game clock plus a pausable scheduler.
- Splitting `game` into owner-scoped slices.

Dropped: unifying Bot and the player under a shared entity base class. It addresses none of the regression classes this codebase has actually hit, and would couple a probabilistic AI to a physics-driven controller.
