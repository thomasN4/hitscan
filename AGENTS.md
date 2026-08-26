# AGENTS.md

Guidance for AI agents (and humans) working in this repository.

## Project

Browser FPS demo: Three.js + Vite, TypeScript throughout `src/`, no framework. All game code lives in `src/`; markup/CSS in `index.html`. Intra-`src/` imports are extensionless (`from './core/state'`) — that is what let files rename to `.ts` one at a time without touching importers (Vite only maps a `'./x.js'` specifier onto `x.ts` when the *importer* is TS).

The canonical remote is a self-hosted Gitea instance on the LAN:
`http://192.168.2.161:3000/thomasN4/another-cs-clone` (`origin`). GitHub is no
longer the source of truth — `gh` is the wrong tool here; use `tea` (configured
login: `gitea-lan`).

## Workflow

Default loop for every non-trivial change: **plan → worktree → implement → open draft PR**.

1. **Plan** — agree scope and approach with the user before touching code.
2. **Worktree** — every branch is developed in its own git worktree, never directly in the shared primary checkout (which stays on `main`). One session per worktree; never run two sessions against one working copy:

   ```sh
   git worktree add ../acsc-<slug> -b feat/<short-slug>
   ```

3. **Implement** — on a feature branch cut from `main` (inside its worktree):
   - Branch prefix, `<prefix>/<short-slug>` — the set is these four, no others:
     `feat/` new gameplay or behavior · `fix/` bug fixes · `refactor/` structure
     and tooling with no behavior change · `docs/` documentation only. Take the
     prefix from this list rather than from habit: `chore/` is the Conventional
     Commits default for tooling and is NOT used here.
   - As many WIP commits as sensible while working; commit messages: short imperative summary, optionally `;`-joined clauses, e.g.

   ```
   Fix missing player import breaking reload; add smoke test and debug hook
   ```
4. **Draft PR** — once implementation AND verification (build + smoke test) pass, push the branch and open a draft PR against `main`:
   - `tea pr create --draft --title "<imperative summary>" --description "..."`
   - Gitea has no draft flag on the pull request itself. `--draft` prepends
     `WIP: ` to the title and Gitea refuses to merge while that prefix is
     present — removing the prefix is what marks a PR ready for review.
   - PR body: what changed, why, and verification results.
5. **Review** — the user merges personally in the Gitea UI. Do NOT run `tea pr merge`, and do not strip a PR's `WIP: ` prefix, unless explicitly instructed for that specific PR.
   - Dropping the `WIP: ` prefix is also what triggers the automated reviewer
     (`.github/workflows/review.yml`): a headless `claude -p` reads the diff and
     posts a comment-review as `claude-bot`, once per head commit. It is
     advisory and gates nothing — `npm run lint`/`typecheck`/`test`/`build` in
     `ci.yml` remain the only checks that can fail a PR.

Direct pushes to `main` are the exception, only when the user asks (e.g., hotfixes, workflow/docs meta-changes).

## Commands

```sh
npm run dev                    # dev server (http://localhost:5173)
npm run build                  # production build -> dist/
npm run lint                   # ESLint (flat config); no-undef for .js, type-aware rules for .ts,
                               # browser globals/imports banned in src/**/*.test.ts
npm run typecheck              # tsc --noEmit; strict + noUncheckedIndexedAccess
npm test                       # Vitest: unit tests + the doc gate (no browser, ~200 ms)
node scripts/smoke-test.mjs    # headless E2E check (requires dev server running)
```

Four static/sim layers, deliberately split:

- **`npm run lint`** — static: unused bindings, the `any` ban (`no-explicit-any` + `no-unsafe-*` family), `@ts-ignore` ban. For `.js` files it still owns missing-import detection via `no-undef`; for `.ts` files `no-undef` is OFF and that job belongs to typecheck — though the type-aware rules independently flag unresolved names as error-typed values, so the class is double-covered. It also owns unit-test purity: `src/**/*.test.ts` gets `no-restricted-globals` (browser globals) and `no-restricted-imports` (browser-side modules). Do NOT assume withholding globals is what enforces that — `no-undef` is off for `.ts`, so the rules are the mechanism (review lessons 10, 17, 19).

- **`npm run typecheck`** — the compiler as a gate: `strict`, and `noUncheckedIndexedAccess`, which makes every `WEAPONS[wpn.slot]`-style read prove what happens on a miss. This is now the primary missing-import catcher for `.ts` code (TS2304), which neither `npm run build` nor `npm test` can see.

- **`npm test`** — pure simulation logic: state, accuracy, recoil, ballistics, damage, movement, world registration. Runs in plain Node, no browser, no dev server. Fast enough to run on every edit. When a browser-side module holds pure logic the suite cannot reach, split out a seam rather than mocking — `sim/recoil.ts:convertOnSwap()` is the worked example, and lesson 19 is what it cost to learn twice. The suite also carries one repo-hygiene check that is not simulation logic: `scripts/lessonNumbering.test.mjs`, which reads `docs/*-plan.md` off disk and fails if a review-lesson number moves out from under the comments citing it (see Roadmap).
- **`scripts/smoke-test.mjs`** — integration: real rendering, real input events, all three maps. This is the layer that catches wiring breakage. Drives the user's Brave browser via puppeteer-core; its executable path is machine-specific (Flatpak path) and may need adjusting on other machines. Point it at a non-default port with `CS_SMOKE_BASE=http://localhost:5177 node scripts/smoke-test.mjs`. Note Vitest resolves through its own bundled Vite (8.x), not the workspace Vite 5 — a resolution edge must work under both.

A fifth layer reads rather than runs: the CI reviewer in
`.github/workflows/review.yml`. Its standing instructions are
`scripts/review-prompt.md` — edit that file, not the workflow, to change what
the reviewer looks for, and iterate on it locally without pushing:

```sh
claude -p "Review the pull request whose base commit is $(git merge-base main HEAD) and head commit is HEAD" \
  --append-system-prompt "$(cat scripts/review-prompt.md)" \
  --allowedTools "Read,Grep,Glob,Bash(git diff:*),Bash(git log:*),Bash(git show:*)"
```

## Architecture rules

- **All shared mutable state lives in `src/core/state.ts`**, grouped into owner-scoped slices written by one system each — `session`/`input`/`aim`/`wpn`/`motion`/`score` (see the slices' docs for their writers) — alongside `player`, `weapon`, `keys`, `bots`, the effects collections and `gameTime`, plus the domain vocabulary (`WeaponDef`, `LiveWeapon`, `PlayerState`, the structural `Bot` shape, `HitZone`) — except the level-geometry registries `solids`/`colliders`, which `world.ts` owns so registration has exactly one path. Do not create new cross-module mutable globals elsewhere. `window.__cs.game`'s flat shape is a delegation-only facade over the slices built in main.ts; gameplay code imports slices directly.
- **`core/state.ts` must stay importable in plain Node.** It may use THREE's math classes (`Vector3`, `Box3`), but never `document`, `window`, `location`, or a `WebGLRenderer`. This is what makes the simulation unit-testable: `src/core/state.test.ts` runs in plain Node, so a browser global at module scope breaks every test in it on import. Browser-derived values are written IN by `main.ts` at startup (see `session.map`) rather than read here. Anything browser-only belongs in `core/engine.ts` or behind an `init*()` function.
- **Engine singletons (`renderer`, `scene`, `camera`, `clock`) live in `src/core/engine.ts`** and are created by `initEngine()`, not at module scope. They are `export let` live bindings typed at their non-optional class types: reading them before init yields `undefined` at runtime, and the "read only after init" contract is documented rather than encoded as `| undefined`.
- **No module-scope side effects that touch the engine or the DOM.** A module needing either exposes an `init*()` function that `main.ts` calls in order. Current order, which `main.ts` documents inline:

  ```
  initEngine() → initHUD() → initWeaponViewmodels() → BUILDERS[session.map]() → respawn() → initMenus() → loop
  ```

- **Gameplay math lives in `src/sim/`, as pure functions.** Accuracy, recoil, ballistics, damage zones, speed tiers and blend easing take every input as a parameter — no engine imports, no DOM, no reads of shared state. That is what makes them unit-testable in plain Node (`npm test`), and it is where new gameplay math belongs. Modules like `weapons.ts` are thin bindings that feed live state in. One sanctioned exception: a stateful policy class (`sim/botBrains.ts:DefaultBrain`) keeps per-bot state across `decide()` calls — still engine-free, DOM-free and shared-state-free, with every frame's world knowledge arriving via the `BrainView` parameter.
- **The accuracy model** (`sim/accuracy.ts`) is:

  ```
  spread = ((stance + movement + air) × spray + inherent) × ADS
  ```

  Two things about it are easy to get wrong:
  - **`spray` is a MULTIPLIER resting at 1, not an additive accumulator resting at 0.** It scales the situational group only — `inherent`, the weapon's own rest cone, is added afterwards so sustained fire never degrades a weapon's intrinsic accuracy. Anything that resets spray must reset it to `1` (see `combat.ts:respawn`, and the smoke test's accuracy phase).
  - **Movement is cubic** in measured speed, so sprint diverges sharply from walk rather than scaling linearly.
- **Aim has two axes, and both must be shared.** `currentAimPitch()` and `currentAimYaw()` in `weapons.ts` are the single source for the camera (`updateCamera`) *and* the shot direction (`shoot()`). Movement's forward vector and mouse input stay on the base `aim.yaw`/`aim.pitch` — routing the view punch into either would steer the player's legs or fight the mouse.
- **Extract and wire in the same commit.** If you lift a formula or constant into `sim/`, delete the inline original and switch every call site at once. A named constant that nothing imports, or a pure function shadowed by a surviving inline copy, is two sources of truth plus a comment that lies.
- **The per-frame stage order in `main.ts:animate()` is load-bearing:**

  ```
  updateMovement → updateWeapon → updateCamera → updateViewmodel → updateBots → updateHUD
  ```

  `updateWeapon` consumes the blends `updateMovement` writes and decays `wpn.recoil`; `updateCamera` and `updateViewmodel` then read that post-decay recoil, so camera, viewmodel and bullets agree within a frame. Reordering aims the camera a frame ahead of the shots (`5e004a5`). The pin runs the other way too: `updateMovement` writes `camera.position`, and `shoot()` — reached from inside `updateWeapon` — rays from `camera.getWorldPosition()`, so that write cannot be deferred to `updateCamera` without firing every shot from the previous frame's eye. Keep the sequence flat in `animate()` — do not nest one stage inside another.
- **Dependency direction:** everything may import from `core/state.ts` and `sim/`; browser-side modules also import `core/engine.ts` and `world.ts`. Modules must not import each other in cycles. Current flow: `main` → {player, bots, weapons, menu, maps/} → {world, sim, core}. `maps/index.ts` imports only its sibling builders, so the registry adds no new direction. `world.ts` sits between the map builders and `core/`: unlike `sim/` it is not engine-free — it imports `scene` from `core/engine.ts` — but it reads `scene` only inside `addSolidBox`, which is what keeps the module importable in plain Node.
- **Dynamic index reads must prove their miss case, or make the miss unrepresentable.** `noUncheckedIndexedAccess` makes an array read `T | undefined`. Prefer removing the case: where the table is fixed-size, key it by a literal union — a tuple indexed by its own union (`wpn.slot: WeaponSlot` into per-position arrays) OR a `Record<WeaponId, WeaponDef>` catalog — either way the read is exempt from the flag and there is no miss to guard. Where the index is genuinely unbounded (`zoomFovs[wpn.zoomLevel]`), decide explicitly: `weapons.ts:aimFovFor` clamps because it owes its caller a number, the HUD zoom label degrades to empty because a view must not throw mid-frame, and a narrowing helper that throws a named error is right where a miss means corrupted state. NO `?? defaultValue` fallbacks on INDEX reads — a fallback invents a value the old code never produced. (A documented-default optional field like `pellets ?? 1` is a different thing: the default is part of the field's contract, stated where the field is declared.) Bare `!` assertions are for bound-guarded reads (`impacts[i]` inside its own loop, `hits[0]` after a length check) and tests.
- **Level geometry must go through `src/world.ts`**, which owns `solids` (raycast targets: bullets, decals, bot LOS) and `colliders` (world-space AABBs for movement). Adding meshes to the scene directly creates walk-through/shoot-through bugs. That is the whole public surface — if none of these fits, add a function here rather than pushing to the arrays yourself:

  | | |
  |---|---|
  | `addSolidBox(x,y,z,w,h,d,mat)` | Create + `scene.add` + register both. **The default** for walls and crates. Browser-only. |
  | `addStairs(x,y,z,width,stepH,stepD,count,mat?,dir?)` | Flight of full-height step boxes composed from `addSolidBox`; top riser lands exactly at `y + count*stepH`. Keep `stepH` ≤ `collision.ts:STEP_HEIGHT` or the risers become walls. Browser-only. |
  | `createSolidBox(x,y,z,w,h,d,mat)` | Same construction, but no scene and no registration. Pure; the seam `addSolidBox` is built from, and where `y` = BASE is unit-tested. |
  | `registerSolidBox(mesh)` | Both registries, for a mesh you positioned yourself. Pure. |
  | `registerSolid(mesh)` | Raycast target, **no** AABB — flat ground planes only. Pure. |
  | `registerGroupParts(group, {shootable, blocking})` | Parts under a transformed parent. Flushes the group's world matrix before measuring, and takes two lists because they legitimately differ (a range target's post blocks walking but not bullets). Pure. |
  | `resetWorld()` | Clears both registries. Tests only. |

  `registerSolid` is narrower than it looks: it is right for the ground planes because a flat `PlaneGeometry` measures to a **zero-height** box at y ≈ 0 — always steppable under the feet-aware collision model (`STEP_HEIGHT`), so an AABB there would do nothing at all — movement is bounded by the perimeter/lane walls instead. Geometry with real height (a floor slab, a raised platform, a ramp) is **not** this case and must go through `addSolidBox`/`registerSolidBox`, or you ship a walk-through floor.

  Only `addSolidBox` (and `addStairs`, through it) touches the scene; the rest are pure and unit-tested, because both bugs this has caused (`431ac6e` no-clip, `faa52c5` AABBs at the origin) live in the scene-free half — as does the base-vs-centre offset, which has not bitten yet but had no test until `createSolidBox` gave it a seam.
- **Movement collision is feet-aware; elevation is resolved in `collision.ts`, not per entity.** Entities are positioned by their FEET height: `collidesAt(pos, radius, feetY, colliders)` blocks only geometry rising more than `STEP_HEIGHT` above the feet (so risers don't block), and `resolveVertical` integrates gravity against `supportHeightAt` with a swept ceiling — that one rule produces resting, step-up, swept landings (no tunneling) and walking off edges. `slideMoveXZ` also takes a blocked axis move when it strictly UNWEDGES — every collider blocking at the destination overlaps the footprint less along the moving axis than it does now — because a binary overlap test otherwise refuses every direction to an entity already inside geometry, the way out included (lesson 23). Strictly-worse vetoes, so approaching from outside is refused exactly as before and walls stay solid; unchanged is indifferent, not a veto. A grounded entity additionally STICKS to support within one `STEP_HEIGHT` below its feet (`wasGrounded` param fed back from the caller's last frame): without it, descending a flight micro-free-falls every riser (~13 frames of near-full air-accuracy penalty per tread). Deeper drops — ledges — still go airborne; jumps still rise because the `velY > 0` check comes first. Player AND bots go through the shared `slideMoveXZ` + `resolveVertical` pair; do not open-code a second gate. **A bot STEERS planar but RANGES in 3D**: `BrainView.toTarget`/`dist` stay y-stripped because a step only ever moves in x/z (facing comes off them too), while every range decision — the chase bands, `engageRange`, the hit die, and which candidate is worth chasing — reads `dist3`/`rise`, so elevation makes shots genuinely farther rather than just occluded. Ranging on the planar number is what once made a target on a deck overhead read as point-blank and pushed bots away from the stairs that reach it. Candidate positions handed to `nearestOpposing` are FEET on every arm — `player.pos` is an EYE, so `bots.ts` drops `eyeHeight` before listing it. The player's `pos` stays the EYE position (`feet = pos.y − eyeHeight`); physics snaps to support instantly while the camera rides `motion.groundSmoothY` (~80 ms blend) so stairs don't jitter the view.
- **Match config is committed as one URL query, and map switching is a full page reload.** The start menu encodes `?map=&tbots=&ctbots=&time=` (time in SECONDS; `core/sessionConfig.ts` parses/clamps it — pure and unit-tested — and `main.ts` writes the result into `session` at startup). Play navigates only when the form differs from the applied config; otherwise it just re-locks. Never hot-swap scene contents at runtime — the map builders in `src/maps/` assume a fresh scene. Any new map needs: a builder in `src/maps/` listed in `maps/index.ts`'s `BUILDERS` (a full `Record<MapName, () => void>`, so widening `MapName` fails to compile until it is registered), a `MapName` entry in state.ts + sessionConfig's `asMapName` (shared with the menu form — do NOT re-derive the map from `mapSel.value` in menu.ts), an `<option>` in index.html, a `SUBTITLES` line in menu.ts, a `combat.ts:SPAWN_Z` entry (a full `Record<MapName, number>`, so the compiler demands one), and a smoke-test pass.
- **Damage flows through `combat.ts`** (`damagePlayer` / `damageBot`) — don't mutate HP from callers.
- DOM writes only in `hud.ts` (in-game HUD) and `menu.ts` (`#startMenu` / `#pauseMenu` / `#loadoutScreen`). Sound synthesis only in `audio.ts`. Every `getElementById` outside markup goes through `hud.ts:requireEl`, so a missing id is a named startup error; every read of three.js's `userData` goes through one owned accessor per tag (`bots.ts:botFor`, `weapons.ts:magBaseY`) rather than scattered casts. The loadout has ONE writer: the picker's Deploy path calls `setLoadout()` (which validates the primary/secondary class split and arms ammo + the live weapon via `armLoadout()`) — never mutate `loadout`/`ammoStore`/`weapon` directly from elsewhere. sessionStorage persistence of the last loadout lives in `menu.ts` because `state.ts` must stay Node-pure; `sanitizeLoadout()` there owns what may be applied.

## Gotchas learned the hard way

- **Missing imports are NOT build errors here.** Vite/rollup won't flag an identifier used inside a function body if it happens to resolve as a global at runtime — it becomes a silent `ReferenceError` when that code path first runs (this is how reload broke once). Since the TS migration the class is double-covered: `npm run lint`'s `no-undef` for `.js` files (per-environment globals in `eslint.config.js`; OFF for `.ts`, where type names would false-positive), and `npm run typecheck`'s TS2304 for `.ts`. Run both after any code movement. Static checks are not a substitute for the smoke test: they see undeclared names, the smoke test sees wiring. `npm test` catches neither for browser-side modules.
- Pointer lock has a browser-enforced cooldown after `exitPointerLock()`; re-locking too soon silently fails. The canvas click handler recovers, keep that behavior when touching menus.
- The game loop only simulates while pointer lock is held (`session.locked && session.started`) but always renders. Anything added to the loop should respect that split.
- **Stale dev servers serve stale code.** An orphaned `vite` process holding port 5173 makes every smoke test validate an old build (new servers silently shift to 5174). Before testing: `fuser -k <port>/tcp`, start the server with `--port <n> --strictPort`, and confirm the port from its log. With parallel worktrees, parallel dev servers are expected — pick a distinct port per worktree and point the smoke test at it with `CS_SMOKE_BASE` (it defaults to 5173).
- `window.__cs` in main.ts is a debug/testing hook relied on by the smoke test — keep it exporting `{ game, weapon, player, bots, bulletHoles, colliders, gameTime }` (its shape is declared on `Window` in main.ts).
- **Euler rotation orders matter**: the camera and shot-direction math must both use `'YXZ'`. Default `'XYZ'` silently aims shots somewhere else (this caused bullets flying skyward once). The order now lives in one place — `sim/ballistics.ts:EULER_ORDER` — with a test pinning shot direction against a `'YXZ'` camera matrix, so the two can no longer drift apart silently.

## Conventions

- Real types on exported functions (`src/` is TypeScript); keep "why" comments for non-obvious logic and inline tuning notes on gameplay constants (e.g., `fireRate: 0.105 // ≈ 9.5 rounds/sec`) — those comments survive conversion because the numbers' reasons don't fit signatures. JSDoc `@param` prose only where the parameter's meaning isn't in its name.
- No comments that merely restate code. Keep existing `// ---------- Section ----------` headers.
- No asset files: all audio is WebAudio-synthesized, all visuals are procedural geometry.

## Roadmap / deferred ideas

**Plans, rationale and the running list of review lessons live in
`docs/<tranche>-plan.md`, one per tranche** — the maintainability tranche's is
[`docs/refactor-plan.md`](docs/refactor-plan.md), and later tranches get their
own rather than growing it. Read the review-lessons section before picking work
up; it records traps that have already cost a cycle each. Completed work is
archived in those documents, not summarized here — this section only tracks
what is still open.

Three rules govern them, enforced by `scripts/lessonNumbering.test.mjs` in
`npm test`:

- **Review lessons share one counter across all plan documents.** A new lesson
  continues from the highest number already used anywhere in `docs/*-plan.md`,
  so a bare `lesson N` in a code comment is unambiguous.
- **Lesson numbers are permanent IDs** — assigned in order of recording, never
  reordered, never reused. A lesson may move between categories or be annotated
  in place; its number goes with it. Append new ones at the end of the list, not
  where they thematically belong.
- **Append and annotate, never renumber.** A closed tranche's record keeps its
  original wording; corrections land as annotations beside the claim, naming
  what changed and which PR changed it.

Deferred to a later tranche:

- Making weapon switching cost time (a draw/holster delay, ideally with a viewmodel animation on `poseReload`'s model). Switching is instant today, so `1-2-1` is a free recoil cancel — the conversion in `switchWeapon` is lossless, but the incoming weapon's `recoilRecover` then drains the carried units, and the sniper's 13/s clears a full smg climb in 0.277 s. The same zero-cost window also lets a swap dodge `scopeGate` and re-clamp `spray`. Tracked as **issue #15**; pre-existing behavior, pinned in `sim/recoil.test.ts` so a fix has to update the test deliberately.

Dropped: unifying Bot and the player under a shared entity base class. It addresses none of the regression classes this codebase has actually hit, and would couple a probabilistic AI to a physics-driven controller.
