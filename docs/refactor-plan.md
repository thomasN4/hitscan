# Maintainability tranche — plan and running log

Living document. All nine PRs are merged or under review. The
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
unchecked-JS consumers left to defer for), `allowJs:false` (review: src/ is
100% .ts, so leaving it on would let a stray .js join the program unchecked),
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
- Dynamic index reads decide their miss case explicitly: `aimFovFor()` clamps,
  the HUD zoom label degrades to empty, and no `?? fallback` was introduced
  anywhere. Review went one better on the weapon table — `WEAPONS` is a tuple
  and `game.slot` a `WeaponSlot` union, so that read has no miss to decide and
  `currentDef()`'s throw, the `ammoStore` guard and 27 `!` assertions were
  deleted as unreachable rather than maintained.
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
  Recorded as lesson 19. Playtesting the fix then found the comment that
  motivated it was itself half wrong — converting stops the aim snap but NOT
  1-2-1 as a recoil cancel, because the incoming weapon's `recoilRecover`
  drains the carried units anyway (0.277 s on the sniper). Pre-existing on
  `main`, deferred to issue #15, pinned as behavior, and recorded as lesson 20.
- **Unit-test purity went unguarded.** `no-undef` off for `.ts` disarmed the
  lesson-10 `ignores` mechanism the moment the tests became TypeScript, and
  `lib.es2022.full` gave tsc no reason to object either. Re-armed with
  `no-restricted-globals` plus a `no-restricted-imports` ban on browser-side
  modules, scoped to `src/**/*.test.ts`; re-proven per environment. Lesson 17
  is about this class; that it recurred *here* is the point of lesson 19's
  second half.

### PR 8 — One gameplay clock with a pausable scheduler (`refactor/game-clock`)

Gameplay timing had drifted onto three bases that disagree about both epoch
and pause: THREE.Clock's `elapsedTime` (fire-rate gate, view bob) keeps
running through pause because `animate()` always calls `getDelta()`; raw
`performance.now()` (reload start/progress/end) shares neither its zero point
nor its pause; wall-clock `setTimeout` fired gameplay events mid-pause — dead
bots revived behind the menu at 6 s / 2.5 s, and reload clicks played over a
reload that (had it been pausable) wasn't progressing.

The unification: a pure `GameClock` (`sim/gameClock.ts`) — an accumulator
advanced ONLY from main.ts's sim block as stage 0 of the load-bearing frame
order, plus a scheduler drained from inside `advance()`, so scheduled work
inherits pause semantics structurally rather than via flags. The shared
instance lives in `core/state.ts:gameTime` per the single-state-home rule;
the class stays in `sim/`, where Node tests replay real frame cadences
directly (16 cases: ordering, cancel, chaining, drain-during-one-advance,
frame-by-frame replay).

Moved onto game time: `weapon.lastShot` + the fire-rate gate, all three
reload bookkeeping sites, view-bob phase (which used to snap to an arbitrary
cycle point on resume), bot self-respawn, the round-win wave respawn, and the
reload click sequence in `audio.ts`.

Deliberately left on wall clock, each documented at its site: combat.ts's
death-screen delay (it fires DURING pause — scheduling it on game time would
mean the screen never appears), muzzle-flash cleanup and hud fades (cosmetic,
and readable behind menus). A third member, main.ts's double-tap-W sprint
window, left with the double-tap mechanic itself when sprint was remapped to
hold-Shift. `clock.getDelta()` remains main's raw-frame-dt source; the
clamp happens before `advance`, so a tab-switch spike can't fast-forward the
scheduler.

Declared behavior changes, all intended: no free first shot after a long
pause; a paused reload suspends mid-mag instead of finishing behind the menu
(the smoke test's 2.6 s wait held under headless SwiftShader on BOTH servers);
bots stop reviving during pause; reload audio freezes with its animation.
`smoke-test.mjs` byte-for-byte unchanged, every phase green on both maps
against dev server and `vite preview`.

Verification honesty note: pause/resume mid-reload was confirmed by manual
playtest in review. The bot-respawn half was NOT confirmed end-to-end — bots
are unnamed, identical meshes often behind cover, and `__cs` doesn't expose
them — so it rests on the clock's unit-tested freeze semantics plus
inspection of `Bot.die`'s one-line binding. Deferred with an issue (#17)
rather than counted as manually verified.

**Resolved by PR #24 (2026-08-24); issue #17 is closed.** Each of the three
blockers named above was removed rather than worked around: bots got stable
ids and names (so a specific bot can be identified across a kill), `__cs` now
exposes `bots` and `gameTime`, and the smoke test gained an automated
kill→pause→assert phase that proves the respawn timer freezes behind the menu.
The paragraph above stands as the period record of what PR 8 actually shipped
with — see the archival policy in Working agreement.

Review round: the reviewer reproduced a real drain-order bug against the
scheduler's own documented contract — the job queue sorted once per
`advance()`, but a job enqueued DURING the drain was appended behind pending
entries, where a head check against a later-due job skipped it for the rest
of that advance (a due-now chain fired one frame late). The code comment even
claimed otherwise — lesson 11 applies to fresh code, not just moved code; and
the existing chaining test couldn't see any of this because its queue was
empty at chain time. Fixed by sorting every iteration, with the adversarial
test written red first (lesson 7): pending later-due job + mid-drain zero-delay
chain. Also hardened the dt guard against NaN (`< 0` passes it, poisoning `t`
and inverting the drain guard into drain-everything).

### PR 9 — Owner-scoped state slices (`refactor/game-slices`)

The flat 25-field `game` bag split by owning system, all slices still
exported from `core/state.ts` (ownership clarity, not new module homes):

| slice | fields | writer(s) |
|---|---|---|
| `session` | map, locked, started | main.ts |
| `input` | shooting, aiming, running | event handlers (+ `shoot()`'s unscopeOnShot) |
| `aim` | yaw, pitch | mousemove, respawn |
| `wpn` | spread, spray, recoil, recoilYaw, adsLerp, slot, zoomLevel, zoomScale | weapons.ts (respawn resets) |
| `motion` | runLerp, moveLerp, crouchLerp, airLerp, stepTimer, bobAmt | player.ts (respawn resets) |
| `score` | scoreKills, scoreDeaths, roundTime | bots / combat / main loop |

Each slice's interface doc names its writers. Mechanics that made the ~100
call-site migration safe: ONE slice per commit with `GameState` shrinking
each time, so tsc turned any missed `game.x` into a compile error while the
smoke test would have caught a stale runtime read — per-commit completeness
enforced by the gates instead of review attention (the lesson-19 failure mode,
structurally blocked). Names dodge two collisions found by reading locals:
`move` was taken by a Vector3 local in player.ts (`motion`), `weapon` existed
(`wpn`).

The flat shape survives for exactly one consumer: `window.__cs.game`,
rebuilt in main.ts as a get/set-only facade typed as the intersection of the
six slice interfaces. It stores nothing — every access round-trips to a
slice, so it cannot drift into a second source of truth — and no importable
`game` exists for gameplay code anymore. `smoke-test.mjs` byte-for-byte
unchanged; its writes (`cs.game.pitch = ...`) exercise the setters, its
reads the getters.

Verification: six gates green after every commit; smoke green on both maps
against dev server (:5197) and `vite preview` (:5198). Behavior identical —
a pure refactor with no declared changes. AGENTS.md/tsconfig comments were
swept onto slice names; this file's PR 7-era `game.*` mentions are left as
period records.

---

## Review lessons

**Lesson numbers are permanent IDs.** They are assigned in order of recording,
never reordered and never reused. A lesson may be moved between categories or
annotated in place, but its number travels with it — code comments cite bare
`lesson N` (`weapons.ts`, `recoil.test.ts`, `gameClock.test.ts`,
`botBrains.test.ts`, `AGENTS.md`), and those citations have no other anchor.

One counter is shared across **every** plan document in `docs/`, so a bare
`lesson N` stays unambiguous no matter which tranche recorded it: new lessons
are appended at the end of the list in whichever `docs/*-plan.md` owns the
current tranche, continuing from the highest number already used. The next free
number is **21**.

`scripts/lessonNumbering.test.mjs` enforces all of this in `npm test` — numbers
unique and gapless across documents, every citation resolving, and the
number→title mapping pinned so a renumber that stays well-formed still turns
the suite red. It is a gate rather than a review habit on purpose; that is
lesson 19's own rule.

The category grouping below is presentation only. Within it, entries are
ordered roughly by how easy they are to repeat.

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
    1-2-1 as a free recoil cancel — though see lesson 20: the comment was only
    right about the first). Three rules fall out:
    - A mechanical refactor needs its invariant pinned **before** the refactor,
      not after. A test written afterwards pins whatever shipped.
    - When the refactor is *what* moves logic across the browser boundary, apply
      lesson 2 in the same commit — ask what pure logic is now unreachable.
    - Prefer a signature where the mistake is a type error. `convertOnSwap` takes
      the two weapons as objects, not four numbers, so transposing them fails to
      compile: `incoming` needs a `sprayCap` and `outgoing` does not.
20. **A pure-function test can be exactly right and still miss the behavior,
    when the behavior is an interaction with TIME.** The nine `convertOnSwap`
    cases from lesson 19 all pass, all assert the correct thing, and between
    them cover both cap directions — and 137 green tests still shipped a
    playtest-obvious bug, because every one of them passes ZERO time. The
    conversion is lossless; the reset happens over the next 0.277 s, as the
    incoming weapon's `recoilRecover` drains what the swap carried. The unit
    under test was fine. The unit was the wrong unit.
    - This is lesson 6 from the other side. Lesson 6 is about hand-seeding an
      *accumulation* (seeding `1 + 30 × sprayKick` instead of replaying the fire
      loop); this is hand-seeding a *duration*. Same remedy: replay the loop.
    - Ask what happens in the frames AFTER the function returns. Extracting a
      pure seam moves an instant into a module that cannot see time pass, which
      makes the seam correct and the question easier to forget.
    - When a comment claims an invariant, test the invariant as stated, not the
      function. "1-2-1 is not a free recoil cancel" is a claim about a sequence
      of player actions; no test of a single conversion can settle it.

---

## Later tranche — what remains

**Nothing — the maintainability tranche is complete (PRs 1–9).** One item
remains tracked OUTSIDE it as deliberate behavior work, not refactoring:
issue #15 (weapon switching should cost time; pinned as behavior in
`sim/recoil.test.ts`).
*(Annotation, feat/swap-delay: fixed — a shared 0.4 s SWAP_DELAY in
`sim/weaponSwap.ts` now gates firing/scoping/reloading and freezes
recoil/spray decay through the deploy window.)*

Issue #17 (bot-respawn observability) was also listed here until PR #24 closed
it; see the resolution note in the PR 8 section.

---

## After this tranche

Work that came after PR 9 belongs to the AI-augmentation tranche and is
recorded in its own plan document, not appended here. Listed so this file does
not read as though nothing has happened since:

- **PR #24 — bot respawn observability** (closes #17). Stable bot ids/names,
  `__cs.bots` + `__cs.gameTime`, and a kill→pause→assert smoke phase that
  verifies the respawn freeze PR 8 could only argue for.
- **PR #25 — the `BotBrain` seam.** Bot decision policy extracted into
  `sim/botBrains.ts` behind an interface; `Bot` executes intents. The one
  sanctioned stateful class in `sim/` (see AGENTS.md).

Their full write-ups, and the AI tranche's own review lessons, land with the
CT-bots work in a `docs/<tranche>-plan.md` of its own.

---

## Working agreement

Per `AGENTS.md`: plan → worktree → implement → **draft** PR. The user merges in
the Gitea UI; do not run `tea pr merge`, and do not strip a PR's `WIP: ` prefix,
unprompted.

**Archival policy for this file and every other `docs/*-plan.md`: append and
annotate, never renumber.** A closed tranche's record is not rewritten to match
what later turned out to be true — a claim that has since been resolved,
corrected or overtaken keeps its original wording and gains an annotation
beside it saying what changed and which PR changed it. Rewriting reads as
though the mistake was never made, and it costs the one thing these documents
are for: knowing what was actually believed at the time. The corollary is the
numbering rule above — lesson numbers are IDs, so a new lesson is appended
rather than inserted where it thematically belongs.

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
