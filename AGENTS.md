# AGENTS.md

Guidance for AI agents (and humans) working in this repository.

## Project

Browser FPS demo: Three.js + Vite, TypeScript throughout `src/`, no framework. All game code lives in `src/`; markup/CSS in `index.html`. Intra-`src/` imports are extensionless (`from './core/state'`) — that is what let files rename to `.ts` one at a time without touching importers (Vite only maps a `'./x.js'` specifier onto `x.ts` when the *importer* is TS).

## Workflow

Default loop for every non-trivial change: **plan → worktree → implement → open draft PR**.

1. **Plan** — agree scope and approach with the user before touching code.
2. **Worktree** — every branch is developed in its own git worktree, never directly in the shared primary checkout (which stays on `main`). One session per worktree; never run two sessions against one working copy:

   ```sh
   git worktree add ../cs-demo-<slug> -b feat/<short-slug>
   ```

3. **Implement** — on a feature branch cut from `main` (inside its worktree):
   - Branch prefix, `<prefix>/<short-slug>` — the set is these four, no others:
     `feat/` new gameplay or behavior · `fix/` bug fixes · `refactor/` structure
     and tooling with no behavior change (the maintainability tranche: #5, #6,
     #7) · `docs/` documentation only. Take the prefix from this list rather
     than from habit: `chore/` is the Conventional Commits default for tooling
     and is NOT used here.
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
npm run lint                   # ESLint (flat config); no-undef for .js, type-aware rules for .ts
npm run typecheck              # tsc --noEmit; strict + noUncheckedIndexedAccess
npm test                       # Vitest unit tests (no browser, ~200 ms)
node scripts/smoke-test.mjs    # headless E2E check (requires dev server running)
```

Four static/sim layers, deliberately split:

- **`npm run lint`** — static: unused bindings, the `any` ban (`no-explicit-any` + `no-unsafe-*` family), `@ts-ignore` ban. For `.js` files it still owns missing-import detection via `no-undef`; for `.ts` files `no-undef` is OFF and that job belongs to typecheck — though the type-aware rules independently flag unresolved names as error-typed values, so the class is double-covered.

- **`npm run typecheck`** — the compiler as a gate: `strict`, and `noUncheckedIndexedAccess`, which makes every `WEAPONS[game.slot]`-style read prove what happens on a miss. This is now the primary missing-import catcher for `.ts` code (TS2304), which neither `npm run build` nor `npm test` can see.

- **`npm test`** — pure simulation logic: state, accuracy, recoil, ballistics, damage, movement, world registration. Runs in plain Node, no browser, no dev server. Fast enough to run on every edit.
- **`scripts/smoke-test.mjs`** — integration: real rendering, real input events, both maps. This is the layer that catches wiring breakage. Drives the user's Brave browser via puppeteer-core; its executable path is machine-specific (Flatpak path) and may need adjusting on other machines. Point it at a non-default port with `CS_SMOKE_BASE=http://localhost:5177 node scripts/smoke-test.mjs`. Note Vitest resolves through its own bundled Vite (8.x), not the workspace Vite 5 — a resolution edge must work under both.

## Architecture rules

- **All shared mutable state lives in `src/core/state.ts`** (`player`, `weapon`, `game`, `keys`, `bots`, effects collections) — plus the domain vocabulary (`WeaponDef`, `LiveWeapon`, `GameState`, `PlayerState`, the structural `Bot` shape, `HitZone`) — except the level-geometry registries `solids`/`colliders`, which `world.ts` owns so registration has exactly one path. Do not create new cross-module mutable globals elsewhere.
- **`core/state.ts` must stay importable in plain Node.** It may use THREE's math classes (`Vector3`, `Box3`), but never `document`, `window`, `location`, or a `WebGLRenderer`. This is what makes the simulation unit-testable: `src/core/state.test.ts` runs in plain Node, so a browser global at module scope breaks every test in it on import. Browser-derived values are written IN by `main.ts` at startup (see `game.map`) rather than read here. Anything browser-only belongs in `core/engine.ts` or behind an `init*()` function.
- **Engine singletons (`renderer`, `scene`, `camera`, `clock`) live in `src/core/engine.ts`** and are created by `initEngine()`, not at module scope. They are `export let` live bindings typed at their non-optional class types: reading them before init yields `undefined` at runtime, and the "read only after init" contract is documented rather than encoded as `| undefined`.
- **No module-scope side effects that touch the engine or the DOM.** A module needing either exposes an `init*()` function that `main.ts` calls in order. Current order, which `main.ts` documents inline:

  ```
  initEngine() → initHUD() → initWeaponViewmodels() → buildMap()/buildRange() → respawn() → loop
  ```

- **Gameplay math lives in `src/sim/`, as pure functions.** Accuracy, recoil, ballistics, damage zones, speed tiers and blend easing take every input as a parameter — no engine imports, no DOM, no reads of shared state. That is what makes them unit-testable in plain Node (`npm test`), and it is where new gameplay math belongs. Modules like `weapons.ts` are thin bindings that feed live state in.
- **The accuracy model** (`sim/accuracy.ts`) is:

  ```
  spread = ((stance + movement + air) × spray + inherent) × ADS
  ```

  Two things about it are easy to get wrong:
  - **`spray` is a MULTIPLIER resting at 1, not an additive accumulator resting at 0.** It scales the situational group only — `inherent`, the weapon's own rest cone, is added afterwards so sustained fire never degrades a weapon's intrinsic accuracy. Anything that resets spray must reset it to `1` (see `combat.ts:respawn`, and the smoke test's accuracy phase).
  - **Movement is cubic** in measured speed, so sprint diverges sharply from walk rather than scaling linearly.
- **Aim has two axes, and both must be shared.** `currentAimPitch()` and `currentAimYaw()` in `weapons.ts` are the single source for the camera (`updateCamera`) *and* the shot direction (`shoot()`). Movement's forward vector and mouse input stay on the base `game.yaw`/`game.pitch` — routing the view punch into either would steer the player's legs or fight the mouse.
- **Extract and wire in the same commit.** If you lift a formula or constant into `sim/`, delete the inline original and switch every call site at once. A named constant that nothing imports, or a pure function shadowed by a surviving inline copy, is two sources of truth plus a comment that lies.
- **The per-frame stage order in `main.ts:animate()` is load-bearing:**

  ```
  updateMovement → updateWeapon → updateCamera → updateViewmodel → updateBots → updateHUD
  ```

  `updateWeapon` consumes the blends `updateMovement` writes and decays `game.recoil`; `updateCamera` and `updateViewmodel` then read that post-decay recoil, so camera, viewmodel and bullets agree within a frame. Reordering aims the camera a frame ahead of the shots (`5e004a5`). The pin runs the other way too: `updateMovement` writes `camera.position`, and `shoot()` — reached from inside `updateWeapon` — rays from `camera.getWorldPosition()`, so that write cannot be deferred to `updateCamera` without firing every shot from the previous frame's eye. Keep the sequence flat in `animate()` — do not nest one stage inside another.
- **Dependency direction:** everything may import from `core/state.ts` and `sim/`; browser-side modules also import `core/engine.ts` and `world.ts`. Modules must not import each other in cycles. Current flow: `main` → {player, bots, weapons, map, range} → {world, sim, core}. `world.ts` sits between the map builders and `core/`: unlike `sim/` it is not engine-free — it imports `scene` from `core/engine.ts` — but it reads `scene` only inside `addSolidBox`, which is what keeps the module importable in plain Node.
- **Dynamic index reads must prove their miss case.** `noUncheckedIndexedAccess` makes `WEAPONS[game.slot]`-style reads `T | undefined`; the convention: reads of input-mutated indices route through narrowing helpers that throw a named error on an impossible value (`weapons.ts:currentDef`), semantically-optional reads use `?.` or a degrading guard (the HUD zoom label), and NO `?? defaultValue` fallbacks — a fallback invents a value the old code never produced. Bare `!` assertions are for statically-populated tables inside their own module (`state.ts`) and bound-guarded tests.
- **Level geometry must go through `src/world.ts`**, which owns `solids` (raycast targets: bullets, decals, bot LOS) and `colliders` (world-space AABBs for movement). Adding meshes to the scene directly creates walk-through/shoot-through bugs. That is the whole public surface — if none of these fits, add a function here rather than pushing to the arrays yourself:

  | | |
  |---|---|
  | `addSolidBox(x,y,z,w,h,d,mat)` | Create + `scene.add` + register both. **The default** for walls and crates. Browser-only. |
  | `createSolidBox(x,y,z,w,h,d,mat)` | Same construction, but no scene and no registration. Pure; the seam `addSolidBox` is built from, and where `y` = BASE is unit-tested. |
  | `registerSolidBox(mesh)` | Both registries, for a mesh you positioned yourself. Pure. |
  | `registerSolid(mesh)` | Raycast target, **no** AABB — flat ground planes only. Pure. |
  | `registerGroupParts(group, {shootable, blocking})` | Parts under a transformed parent. Flushes the group's world matrix before measuring, and takes two lists because they legitimately differ (a range target's post blocks walking but not bullets). Pure. |
  | `resetWorld()` | Clears both registries. Tests only. |

  `registerSolid` is narrower than it looks: it is right for the ground planes because a flat `PlaneGeometry` measures to a **zero-height** box at y ≈ 0, below `TEST_BOX_MIN_Y`, so an AABB there would do nothing at all — movement is bounded by the perimeter/lane walls instead. Geometry with real height (a floor slab, a raised platform, a ramp) is **not** this case and must go through `addSolidBox`/`registerSolidBox`, or you ship a walk-through floor.

  Only `addSolidBox` touches the scene; the rest are pure and unit-tested, because both bugs this has caused (`431ac6e` no-clip, `faa52c5` AABBs at the origin) live in the scene-free half — as does the base-vs-centre offset, which has not bitten yet but had no test until `createSolidBox` gave it a seam.
- **Map switching is a full page reload** driven by the `?map=` URL param (read once by `main.ts` at startup into `game.map`). Never hot-swap scene contents at runtime — map builders (`map.ts`, `range.ts`) assume a fresh scene. Any new map needs: a builder registered in main.ts, spawn handling in `combat.ts:respawn()`, and a smoke-test pass.
- **Damage flows through `combat.ts`** (`damagePlayer` / `damageBot`) — don't mutate HP from callers.
- DOM writes only in `hud.ts`. Sound synthesis only in `audio.ts`. Every `getElementById` outside markup goes through `hud.ts:requireEl`, so a missing id is a named startup error; every read of three.js's `userData` goes through one owned accessor per tag (`bots.ts:botFor`, `weapons.ts:magBaseY`) rather than scattered casts.

## Gotchas learned the hard way

- **Missing imports are NOT build errors here.** Vite/rollup won't flag an identifier used inside a function body if it happens to resolve as a global at runtime — it becomes a silent `ReferenceError` when that code path first runs (this is how reload broke once). Since the TS migration the class is double-covered: `npm run lint`'s `no-undef` for `.js` files (per-environment globals in `eslint.config.js`; OFF for `.ts`, where type names would false-positive), and `npm run typecheck`'s TS2304 for `.ts`. Run both after any code movement. Static checks are not a substitute for the smoke test: they see undeclared names, the smoke test sees wiring. `npm test` catches neither for browser-side modules.
- Pointer lock has a browser-enforced cooldown after `exitPointerLock()`; re-locking too soon silently fails. The canvas click handler recovers, keep that behavior when touching menus.
- The game loop only simulates while pointer lock is held (`game.locked && game.started`) but always renders. Anything added to the loop should respect that split.
- **Stale dev servers serve stale code.** An orphaned `vite` process holding port 5173 makes every smoke test validate an old build (new servers silently shift to 5174). Before testing: `fuser -k <port>/tcp`, start the server with `--port <n> --strictPort`, and confirm the port from its log. With parallel worktrees, parallel dev servers are expected — pick a distinct port per worktree and point the smoke test at it with `CS_SMOKE_BASE` (it defaults to 5173).
- `window.__cs` in main.ts is a debug/testing hook relied on by the smoke test — keep it exporting `{ game, weapon, player, bulletHoles, colliders }` (its shape is declared on `Window` in main.ts).
- **Euler rotation orders matter**: the camera and shot-direction math must both use `'YXZ'`. Default `'XYZ'` silently aims shots somewhere else (this caused bullets flying skyward once). The order now lives in one place — `sim/ballistics.ts:EULER_ORDER` — with a test pinning shot direction against a `'YXZ'` camera matrix, so the two can no longer drift apart silently.

## Conventions

- Real types on exported functions (`src/` is TypeScript); keep "why" comments for non-obvious logic and inline tuning notes on gameplay constants (e.g., `fireRate: 0.105 // ≈ 9.5 rounds/sec`) — those comments survive conversion because the numbers' reasons don't fit signatures. JSDoc `@param` prose only where the parameter's meaning isn't in its name.
- No comments that merely restate code. Keep existing `// ---------- Section ----------` headers.
- No asset files: all audio is WebAudio-synthesized, all visuals are procedural geometry.

## Roadmap / deferred ideas

Maintainability tranche 1 (complete through the TS migration). **Full plan,
rationale and the running list of review lessons:
[`docs/refactor-plan.md`](docs/refactor-plan.md)** — read it before picking
work up, especially the review-lessons section, which records traps that have
already cost a cycle each.

- **PR 1 (done):** split `core.js` into pure `core/state.js` + browser-only `core/engine.js`; explicit init order; Vitest.
- **PR 2 (done):** extract pure sim math into `src/sim/` (`accuracy`, `recoil`, `ballistics`, `damage`, `movement`, `smoothing`) with unit tests; hoist the frame pipeline into `main.js` so intra-frame ordering is visible.
- **PR 3 (done):** single geometry-registration path in `src/world.js` (`addSolidBox`, `registerSolid`, `registerGroupParts`), replacing the duplicated `addBox` in `map.js`/`range.js`; `collidesAt` now takes `colliders` as a parameter, matching `hasLineOfSight`.
- **PR 4 (done):** port the `feat/smg-tuning` gameplay work onto the refactored tree — rifle→SMG, the `spray`/`inherent`/airborne accuracy model, and horizontal recoil (`recoilYaw`, `aimYaw`).
- **PR 5 (done, #12):** `sim/validateWeapons.js` enforcing the `recoilRecover < recoilKick / fireRate` class of constraint that had been fixed twice by hand. The rule exempts `semiAuto` weapons: the sniper over-drains deliberately (13/s against a 3.64/s input) because full settle between shots is the bolt-action feel and is what makes `scopeGate` work. The `sprayRecover < sprayKick / fireRate` counterpart applies to every weapon.

  Two lessons from PR 4, which shipped both failure modes green, are enforced by that validator:
  - **The horizontal walk needs its own rule.** `recoilYaw` is zero-mean, so the bound is `yawRecover × fireRate < yawKick / 2` (the MEAN kick) — not the vertical form. PR 4 drained it at `recoilRecover`, which zeroed the walk before every shot: no bullet was ever displaced. Same `semiAuto` exemption as above.
  - **These bounds are necessary, not sufficient.** `sprayRecover: 0.45` satisfied `< sprayKick / fireRate` and still only reached spray 1.28 against a documented 2.8, because decay runs *during* fire. Where a comment quotes a number, pin it with a test that simulates the fire loop (`sim/recoil.test.js`), not one that hand-seeds the end state.

- **PR 6 (done, #13):** the ESLint gate, no TypeScript — pulled forward exactly as flagged above.
- **PR 7 (done):** full `.ts` migration under `allowJs`/`strict`/`noUncheckedIndexedAccess`, with the typescript-eslint rules from this section layered onto PR 6's flat config. One deviation from the original note: "start with `src/sim/*`" was unworkable as written (Vite maps `'./x.js'` specifiers onto `.ts` files only for TS importers), solved by extensionless intra-src imports instead of top-down forced ordering.

Deferred to a later tranche:

- Unifying the two time bases (`clock.elapsedTime` vs `performance.now()`) behind one game clock plus a pausable scheduler.
- Splitting `game` into owner-scoped slices.

Dropped: unifying Bot and the player under a shared entity base class. It addresses none of the regression classes this codebase has actually hit, and would couple a probabilistic AI to a physics-driven controller.
