# Maintainability tranche — plan and running log

Living document. PRs 1–4 are merged; **PR 5 is the next piece of work.** The
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

### On documentation

10. **A docstring's *reason* must be right, not just its conclusion.**
   `registerSolid` was justified with "an AABB would be a floor-height box the
   player stands inside" — false; a rotated `PlaneGeometry` measures to a
   zero-height box below `TEST_BOX_MIN_Y`, so the AABB is inert. The wrong
   reason would send someone adding a thick floor slab through `registerSolid`
   and ship a walk-through floor: the doc reintroducing the bug class the module
   exists to prevent.
11. **Grep for comments the change falsifies**, and don't write present-tense
    comments about work a later PR will do.
12. **Don't overstate the history.** "All three bugs this has caused" counted a
    latent gap as a shipped bug. Two real bugs, one covered gap.
13. **Document the full public surface.** `registerSolidBox` was exported but
    unlisted, so a contributor with an already-positioned mesh would find no
    listed option and reach for the arrays directly.

---

## PR 5 — Validate tuning constants (NEXT)

Two commits (`46900f7`, `b080350`) fixed the same class of invariant by hand,
and PR 4 added two more coupled rates. Nothing enforces any of them.

**Scope note:** `sim/damage.test.js` already covers the balance intents
(one-tap headshot, sniper two-tap torso, legs never out-damaging torso). Do not
duplicate them.

### Three sustained-fire rules, two different shapes

Checked against the merged table — **the exemptions are not cosmetic**, a naive
rule flags correct tuning:

| Rule | SMG | SNIPER |
|---|---|---|
| `recoilRecover < recoilKick / fireRate` | 6 < 9.52 ok | 13 < 3.64 **violates** |
| `sprayRecover < sprayKick / fireRate` | 0.29 < 0.571 ok | 0.08 < 0.227 ok |
| `yawRecover × fireRate < yawKick / 2` | 0.052 < 0.2 ok | 14.3 < 0.4 **violates** |

- The **recoil** and **yaw** rules apply only when `!def.semiAuto`. The sniper
  over-drains both deliberately: full settle inside the bolt cycle *is* the
  feel, and the vertical settle is what makes `scopeGate` work. Shipping the
  naive rules would flag shipped-correct tuning, and the obvious "fix" breaks
  the scope gate.
- The **spray** rule applies to every weapon; both satisfy it.
- Note the yaw rule's shape differs: the walk is zero-mean, so the drain per
  shot interval is compared against the **mean** kick (`yawKick / 2`), not the
  full kick. Sizing it like the vertical rule is exactly the bug `ce1c3c5`
  fixed.

**These bounds are necessary, not sufficient — say so in the module's docs.**
Passing them means an accumulator *can* grow, not that it grows to the figure
its tuning comment quotes: decay runs during fire, so `sprayRecover: 0.45`
cleared the rule and still peaked at 1.28 against a documented 2.8. The
validator is a floor on sanity; the loop-replaying tests in `sim/recoil.test.js`
are what pin the actual numbers. A validator that implies otherwise is the
"comment that lies" failure in a new costume.

### `validateWeapons(defs)` → array of violation strings

Pure, in `src/sim/validateWeapons.js`. Beyond the three above:

- `sprayCap > 1` (rested is 1; a cap at 1 means spray never accumulates)
- `inherent > 0`, `yawKick > 0`
- `zoomFovs` non-empty, strictly decreasing, every entry below `BASE_FOV`
- `magSize > 0`, `reserveMax >= 0`, `fireRate > 0`, `reloadTime > 0`,
  `damage > 0`, `headshotMult >= 1`
- `scopeGate`, when present, `> 0` and below `RECOIL_CAP` (a gate at the cap
  never opens)
- `punchRad × RECOIL_CAP` under ~10° of view climb

Use `RECOIL_CAP` / `RECOIL_YAW_CAP` / `BASE_FOV` from `core/state.js` — PR 1's
review wired those into every call site; do not reintroduce the literals.

### Two consumers

- **Vitest over the real `WEAPONS`** — the hard gate; a bad constant fails
  `npm test`.
- **`main.js` behind `import.meta.env.DEV`** — `console.error` per violation,
  naming weapon, numbers and consequence ("SMG: sprayRecover 0.8 exceeds
  sustained-fire input 0.57 — sprays will not bloom"). Deliberately **not** a
  throw: this runs before `initEngine()`, so throwing blanks the page and hides
  the message behind a broken app.

### Tests

- both real weapons produce zero violations
- a full-auto clone carrying the sniper's recoil numbers **is** flagged, and
  likewise for the yaw rule — proving each exemption is a live branch, not a
  disabled rule
- one case per rule, each asserting the message names the offending weapon and
  field
- a fully valid def returns `[]`

**Files:** new `src/sim/validateWeapons.js` + test; `src/main.js`.

**Risk note.** No runtime behavior change — the only production edit is a
dev-gated `console.error`. The risk is the inverse of PR 2's: a *wrong rule*
failing CI on good tuning. Check every rule against the real table before
writing it.

---

## Later tranche — TypeScript + lint gate

Recorded so the decisions aren't relitigated.

**Full `.ts` migration** (chosen over JSDoc + `checkJs`): rename incrementally
under `allowJs`, starting with `src/sim/*` — already pure functions with
explicit parameters, so they convert with no restructuring.

**ESLint + typescript-eslint**, landing with the migration:

| Rule | Bug class it catches |
|---|---|
| `no-undef` | the `730d9cc` missing-import `ReferenceError` — `AGENTS.md` gotcha #1 |
| `@typescript-eslint/no-explicit-any` | the `any` ban |
| `@typescript-eslint/no-unsafe-*` | `any` leaking in from loosely-typed three.js surfaces — banning explicit `any` alone does not stop this |
| `@typescript-eslint/ban-ts-comment` | `@ts-ignore` silencing a real error |

Two `tsconfig` flags matter as much: `strict`, and **`noUncheckedIndexedAccess`**
— `WEAPONS[game.slot]` and `zoomFovs[game.zoomLevel]` are unchecked index reads
on input-mutated state. Wire `npm run lint` into the verification set.

**Worth pulling forward:** `no-undef` needs no TypeScript. A flat ESLint config
with `languageOptions.globals.browser` would catch the repo's most-cited trap
today, in roughly a 20-line PR.

**Also deferred:** unifying the two time bases (`clock.elapsedTime` vs
`performance.now()`) behind one game clock plus a pausable scheduler; splitting
`game` into owner-scoped slices.

---

## Working agreement

Per `AGENTS.md`: plan → worktree → implement → **draft** PR. The user merges in
the GitHub UI; do not run `gh pr merge` or `gh pr ready` unprompted.

Each PR needs its own worktree off current `origin/main` with its own
`npm install` — symlinking the primary checkout's `node_modules` writes shared
state the other worktrees read.

All four must pass:

1. `npm test`
2. `npm run build`
3. `node scripts/smoke-test.mjs`, against **both** the dev server and
   `vite preview`. Pick a port no other worktree is using
   (`ss -ltnp | grep 517`), start with `--port <n> --strictPort`, confirm the
   port from its log, and pass `CS_SMOKE_BASE=http://localhost:<n>`. An orphaned
   server silently serves stale code.
4. Manual check of both maps (`/` and `/?map=range`).

**Invariants that must survive:** `window.__cs` keeps exporting
`{ game, weapon, player, bulletHoles, colliders }`. `scripts/smoke-test.mjs`
needs no changes *for a refactor* — if an assertion must be relaxed, that is a
regression, not a test problem. A deliberate **behavior** change may legitimately
edit it (PR 4 changed the accuracy phase), but everything outside the changed
behavior must pass unmodified.
