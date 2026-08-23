# Maintainability tranche — plan and running log

Living document. PRs 1–5 are merged. The
review lessons below are the most reusable part of this file: each one cost a
review cycle to find, and several describe traps that are still easy to walk
back into.

## Why this work exists

Reviewing the shipped bug fixes in `git log`, the regressions clustered into six
causes — none of which was "missing abstraction":

| Commit | Root cause | Class |
|---|---|---|
| `730d9cc` | `player` used but not imported; resolved as a runtime global | unresolved reference |
| `351f772` | camera and `shoot()` each derived aim direction independently | duplicated derivation |
| `431ac6e`/`927b7c0` | `range.js` had its own `addBox` copy that forgot `colliders` | duplicated invariant |
| `faa52c5` | `Box3.setFromObject` ran before `updateMatrixWorld` | temporal coupling |
| `46900f7`, `b080350` | `recoilRecover` must stay under `recoilKick / fireRate`; nothing enforced it | unvalidated constant relation |
| `5e004a5` | recoil kick applied before vs. after the shot ray was built | intra-frame ordering |

The deepest enabler was that **nothing in `src/` could be imported outside a
browser**: `core.js` constructed a `WebGLRenderer` and called
`document.body.appendChild` at module scope. So the only test was a Puppeteer
script needing Brave, a live dev server, and sleep-based timing fights with
SwiftShader. Pure math — spread, recoil decay, shot direction, damage zones —
was only reachable through a render loop.

A `Bot`/player shared base class (once on the `AGENTS.md` roadmap) was
**dropped**: it addresses none of the causes above, and would couple a
probabilistic AI to a physics-driven controller.

---

## Merged

### PR 1 — Split engine from state (#5, `4b2fc18`)

`core.js` → pure `core/state.js` + browser-only `core/engine.js` built by
`initEngine()`. `initHUD()` / `initWeaponViewmodels()` replaced module-scope
side effects. Vitest added. `smoke-test.mjs` reads `CS_SMOKE_BASE`.

### PR 2 — Extract pure sim math; explicit frame stage order (#6, `2325a0b`)

Six pure modules under `src/sim/`. `updatePlayer` split into `updateMovement` /
`updateCamera` / `updateViewmodel`, sequenced in `main.js:animate()`.

### PR 3 — One registration path for level geometry (#7, `e759e6d`)

`src/world.js` owns `solids`/`colliders`. `collision.js` became pure
(`collidesAt` takes `colliders`).

### PR 4 — Port `feat/smg-tuning` onto the refactored tree (#8, `9396684`)

Superseded draft PR #4, which was cut from `bdefc62` — before all three
refactors — so it edited files that no longer existed in that shape. Ported the
branch's final state rather than merging.

Rifle → SMG. New accuracy model:

```
spread = ((stance + movement + air) × spray + inherent) × ADS
```

Plus horizontal recoil (`recoilYaw`, `aimYaw`), airborne as a fourth stance, and
a proportional crosshair projection.

### PR 5 — Validate tuning constants (#12, `d81f0ea`)

`src/sim/validateWeapons.js`: pure `validateWeapons(defs)` → violation strings,
enforcing the three sustained-fire bounds (vertical, spray, yaw against the
MEAN kick) with the `semiAuto` exemption the sniper's bolt-cycle settle needs,
plus static sanity — caps, cones, the zoom ladder, scalar ranges, the
`scopeGate` window, and the view-climb ceiling at `RECOIL_CAP`. Consumed twice:
a Vitest hard gate over the real `WEAPONS` table, and a dev-gated
`console.error` per violation in `main.js` before `initEngine()` (loud, not
fatal). The module docs state the bounds are necessary, not sufficient; the
loop-replaying tests in `sim/recoil.test.js` pin actual numbers.

### PR 6 — ESLint gate (#13)

`eslint.config.js` (flat), `npm run lint`, no TypeScript — the piece the
"later tranche" section below flagged as worth pulling forward on its own.
Rules live once in a top-level entry (a file matching no block would
otherwise parse with zero rules); four `files` blocks vary only globals:
browser for `src/**` — carrying an `ignores: ['src/**/*.test.js']` that must
live there, because flat config merges every matching block's globals and a
later block cannot remove them — Node for `src/**/*.test.js` (a test
reaching for `document` has stopped being a pure-simulation test; Vitest
itself stays undeclared so bare `test`/`expect` trip `no-undef`) and for
this config, and **both** for `scripts/smoke-test.mjs` — it runs in Node
but every `page.evaluate()` callback executes in the browser, so declaring
only Node flags 75 correct references.

`src/` was already clean. Non-vacuity was proven the way review lesson 7
prescribes: deleting `player` from `weapons.js`'s state import reproduces
`730d9cc` and lint reports three `no-undef` errors. First review caught the
same standard silently failing for the test-file block (lesson 10); fixed
with the `ignores` above and re-proven per environment via `--print-config`.

### PR 7 — Full TypeScript migration (`refactor/ts-migration`)

All of `src/**` renamed to `.ts` in one pass; `index.html` entry updated;
`scripts/smoke-test.mjs` untouched. Toolchain: `typescript@5.9` (7.x is out —
typescript-eslint peers `<6.1.0`), `typescript-eslint@8.67`, `@types/three@0.160`.
tsconfig: `strict`, **`noUncheckedIndexedAccess: true`** (folded in from the old
PR-8 plan — with browser modules converting in the same pass there were no
unchecked-JS consumers left to defer for), `allowJs`/`checkJs:false`,
`moduleResolution:"bundler"`, `verbatimModuleSyntax`. New `npm run typecheck`
gate; typescript-eslint's `recommendedTypeChecked` scoped to `src/**/*.ts` with
`no-undef` off there (tsc owns missing imports in TS).

Type design highlights:

- Domain vocabulary lives in `core/state.ts`: `WeaponDef` (sniper-only fields
  optional), `LiveWeapon` as a subset-plus-ammo mirror (NOT a `WeaponDef`),
  `GameState` with `map: 'arena' | 'range'`, the structural `Bot` shape that
  `bots.ts`'s concrete class implements, `HitZone`.
- three.js's `userData` is `Record<string, any>` — the one `any` leak vector.
  Two owned accessors hold the only casts: `bots.ts:botFor()` (returns
  `Bot | undefined`; callers narrow) and `weapons.ts:magBaseY()`.
- Dynamic index reads get narrowing helpers that throw named errors on
  impossible values (`currentDef()`, `aimFovFor()`), optional reads use `?.`
  (`scopeGate`) or degrade gracefully (HUD zoom label), and no `?? fallback`
  was introduced anywhere.
- `hud.ts:requireEl(id)` throws a named startup error for missing markup —
  the migration's one *intended* behavior change, replacing distant
  null-property crashes.

Verification: all six gates green, smoke test byte-for-byte unmodified against
both dev server and `vite preview`, plus non-vacuity probes (lessons 15–18).

Review found a second behavior change that was not intended, and a gate the
migration had silently disarmed:

- **The swap conversion shipped inverted.** Extracting switchWeapon's operands
  into `outgoing`/`incoming` locals flipped `punchRad` ÷ `punchRad`, scaling the
  rendered view punch by ratio² instead of holding it: a ~2.8° aim snap on every
  mid-spray swap, and 1-2-1 as a 40% free recoil cancel. All six gates were green
  over it, because the arithmetic sat behind `sfxSwitch()`'s AudioContext where
  the Node suite cannot reach. Fixed by lesson 2's remedy — a pure seam,
  `sim/recoil.ts:convertOnSwap()` — with nine cases pinning it against the real
  table, non-vacuity re-proven per lesson 7 (the inverted ratio fails 6 of 9).
  Recorded as lesson 19.
- **Unit-test purity went unguarded.** `no-undef` off for `.ts` disarmed the
  lesson-10 `ignores` mechanism the moment the tests became TypeScript, and
  `lib.es2022.full` gave tsc no reason to object either. Re-armed with
  `no-restricted-globals` plus a `no-restricted-imports` ban on browser-side
  modules, scoped to `src/**/*.test.ts`; re-proven per environment. Lesson 17
  is about this class; that it recurred *here* is the point of lesson 19's
  second half.

---

## Review lessons

Ordered roughly by how easy they are to repeat.

### On extraction

1. **Wire what you extract, in the same commit.** `RECOIL_CAP`/`BLOOM_CAP`/
   `BASE_FOV` shipped with JSDoc calling them the source of truth while every
   call site still hardcoded `6`/`0.25`/`75`. An extraction that leaves the
   inline original in place is worse than none: two sources of truth plus a
   comment that lies.
2. **Making a function browser-only can strand an untested invariant behind
   it.** `y + h / 2` in `addSolidBox` was the only line encoding "y is the BASE,
   not the centre", and it sat behind a `scene.add` where Node could not reach
   it — removing the lift sank every wall halfway into the floor with all 72
   tests green. Fix: split out a pure seam (`createSolidBox`). When a function
   must touch the engine, ask what pure logic is now on the far side.

### On re-sequencing (the costliest category)

3. **When moving a call between stages, ask two things: what did it read that
   is now written later in the frame, and what guard did it inherit from its old
   caller?** Both bugs found in PR 2's review were this:
   - `camera.position` moved after `updateWeapon`, but `shoot()` rays from
     `camera.getWorldPosition()` — every shot fired from the previous frame's
     eye (~16 cm behind at sprint; from the death location after `respawn()`).
   - `updateWeapon` silently lost the `player.alive` guard it had been
     inheriting from `updatePlayer`'s early return. `exitPointerLock()` is
     async, so a frame runs dead-but-locked and would fire.
4. **A pure-function equivalence sweep does not cover a reorder.** A
   12,137-case bit-exact sweep passed while both bugs above were live. It was
   structurally blind to them.

### On verification

5. **Sample at the moment that matters, not at frame boundaries.** PR 4 shipped
   `recoilYaw` draining at the *vertical* rate, which returned the walk to
   exactly 0 before every shot: 0 of 30 rounds were displaced, and only the
   camera twitched. A browser probe sampling per frame showed a 0.32 peak, both
   signs, settling to 0 — and read as success. The fix's test replays the fire
   loop and asserts on `recoilYaw` **sampled at each shot** (now 88% off-centre).
6. **Simulate the loop; don't hand-seed the end state.** `sprayRecover: 0.45`
   satisfied `< sprayKick / fireRate` and still only reached spray 1.28 against
   a documented 2.8, because decay runs *during* fire, not only after it. A test
   that seeds `1 + 30 × sprayKick` and then decays cannot see this; one that
   replays the fire loop can. Retuned to 0.29 in `c5b702f`. Where a comment
   quotes a number, pin that number with a loop-replaying test.
7. **Prove a regression test non-vacuous by mutating the fix away** and
   confirming it fails with the original signature. This caught two real gaps.
8. **`npm run build` proves nothing about missing imports** — Vite will not flag
   an identifier used inside a function body if it resolves as a runtime global.
   Run the smoke test after any code movement.
9. **Run the smoke test against `vite preview`, not just the dev server.**
   Rollup-only breakage in new cross-module edges does not show up in the dev
   server's unbundled ESM.
10. **Prove each of a gate's environments, not just one representative case.**
   PR 6's non-vacuity probe covered `no-undef` against game code but never
   probed the test-file block, where the gate was silently vacuous: flat
   config merges the globals of every matching `files` entry, so
   `src/**/*.test.js` resolved to browser ∪ Node and a test touching
   `document.title` passed clean despite three documents promising otherwise.
   The fix is structural — exclusion via `ignores` on the *first* matching
   block, since nothing downstream can remove a merged key — and the probe is
   now per environment: `--print-config` on a game file (has `document`) and
   a test file (does not), plus a deliberately browser-touching test that
   must fail lint.

### On documentation

11. **A docstring's *reason* must be right, not just its conclusion.**
   `registerSolid` was justified with "an AABB would be a floor-height box the
   player stands inside" — false; a rotated `PlaneGeometry` measures to a
   zero-height box below `TEST_BOX_MIN_Y`, so the AABB is inert. The wrong
   reason would send someone adding a thick floor slab through `registerSolid`
   and ship a walk-through floor: the doc reintroducing the bug class the module
   exists to prevent.
12. **Grep for comments the change falsifies**, and don't write present-tense
    comments about work a later PR will do.
13. **Don't overstate the history.** "All three bugs this has caused" counted a
    latent gap as a shipped bug. Two real bugs, one covered gap.
14. **Document the full public surface.** `registerSolidBox` was exported but
    unlisted, so a contributor with an already-positioned mesh would find no
    listed option and reach for the arrays directly.

### On the TypeScript migration

15. **Extension mapping is gated by the IMPORTER, not the target.** Vite
    resolves `'./x.js'` onto `x.ts` only when the file doing the importing is
    itself TypeScript, so no incremental rename order works while specifiers
    still carry `.js`: renaming a leaf breaks every `.js` consumer, and renaming
    a consumer first breaks nothing but buys nothing. Dropping the extensions
    across `src/` in their own commit (`130f267`) is what made the conversion
    orderable at all. Verified against vite 5.4.21's resolver and tsc's
    `bundler` mode before the sweep, not after.
16. **Vitest resolves through its own bundled Vite, not the workspace's.** The
    suite ran against vite 8.2.2 while `npm run dev`/`build` used 5.4.21, so a
    resolution edge has to hold under both — a specifier change proven green by
    `npm test` alone is proven on the wrong resolver. This is also why `npm test`
    passing says nothing about whether `npm run build` will.
17. **When a gate's mechanism moves, re-prove the gate, not the mechanism.**
    Turning `no-undef` off for `.ts` handed missing-import detection to tsc
    (TS2304) — that half genuinely transferred, and deleting an import binding
    proves it. But `no-undef` had a *second* job: with browser globals withheld
    from test files it was what kept the unit suite Node-pure. Probing that the
    globals were still Node-only confirmed the wrong thing; the globals were
    never the mechanism. See lesson 19.
18. **A typed signature can surface behavior nobody chose.** Writing
    `partForMesh(bot: { head: object; legs: object }, mesh: object)` made it
    explicit that torso is the *fallback*, not a match — a ray hitting nothing
    recognizable still reads as a torso hit. The types did not change that; they
    made it impossible to keep not noticing. Where a signature exposes an
    unintended default, decide about it in the same PR rather than encoding it.

### On refactoring under green gates

19. **Naming an expression's operands can silently invert it, and "no behavior
    change" is exactly when nobody looks.** `f5fcb6a` turned
    `WEAPONS[game.slot].punchRad / WEAPONS[slot].punchRad` into
    `incoming.punchRad / outgoing.punchRad` — a reciprocal — while converting
    weapons.js to TypeScript. All six gates stayed green: the arithmetic was
    pure, but it sat behind `sfxSwitch()`'s AudioContext, so lesson 2's failure
    mode had been sitting there since before the migration and the migration is
    merely what tripped it. Two consequences, both of them things the code's own
    comment said the conversion existed to prevent (a mid-spray aim snap, and
    1-2-1 as a free recoil cancel). Three rules fall out:
    - A mechanical refactor needs its invariant pinned **before** the refactor,
      not after. A test written afterwards pins whatever shipped.
    - When the refactor is *what* moves logic across the browser boundary, apply
      lesson 2 in the same commit — ask what pure logic is now unreachable.
    - Prefer a signature where the mistake is a type error. `convertOnSwap` takes
      the two weapons as objects, not four numbers, so transposing them fails to
      compile: `incoming` needs a `sprayCap` and `outgoing` does not.

---

## Later tranche — what remains

The TypeScript migration and the ESLint gate both landed (PR 6, PR 7); the
rule table and tsconfig decisions that used to live here are now history, not
plan. Still deferred:

- Unifying the two time bases (`clock.elapsedTime` vs `performance.now()`)
  behind one game clock plus a pausable scheduler.
- Splitting `game` into owner-scoped slices.

---

## Working agreement

Per `AGENTS.md`: plan → worktree → implement → **draft** PR. The user merges in
the GitHub UI; do not run `gh pr merge` or `gh pr ready` unprompted.

Each PR needs its own worktree off current `origin/main` with its own
`npm install` — symlinking the primary checkout's `node_modules` writes shared
state the other worktrees read.

All six must pass:

1. `npm run lint`
2. `npm run typecheck`
3. `npm test`
4. `npm run build`
5. `node scripts/smoke-test.mjs`, against **both** the dev server and
   `vite preview`. Pick a port no other worktree is using
   (`ss -ltnp | grep 517`), start with `--port <n> --strictPort`, confirm the
   port from its log, and pass `CS_SMOKE_BASE=http://localhost:<n>`. An orphaned
   server silently serves stale code.
6. Manual check of both maps (`/` and `/?map=range`).

**Invariants that must survive:** `window.__cs` keeps exporting
`{ game, weapon, player, bulletHoles, colliders }`. `scripts/smoke-test.mjs`
needs no changes *for a refactor* — if an assertion must be relaxed, that is a
regression, not a test problem. A deliberate **behavior** change may legitimately
edit it (PR 4 changed the accuracy phase), but everything outside the changed
behavior must pass unmodified.
