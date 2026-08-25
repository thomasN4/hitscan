# AI augmentation tranche — plan and running log

Living document for the bot-AI work that began after the maintainability
tranche closed. It deliberately does **not** grow
[`docs/refactor-plan.md`](refactor-plan.md): that file is the maintainability
tranche's record, and post-hoc edits to it are what issue #28 is about. New
review lessons from THIS tranche land at the bottom of this file; the lessons
in refactor-plan.md remain canonical history. How the two documents relate
was settled by #28 (PR #30): one lesson counter shared across every
`docs/*-plan.md`, numbers are permanent IDs, append and annotate, never
renumber — see AGENTS.md's Roadmap section and the gate
`scripts/lessonNumbering.test.mjs`.

## Why this work exists

The shipped bot AI was a single hardcoded policy fused into one class: no
variance, one enemy team, and no seam a second behavior could plug into.
The arc, agreed up front as three tranches:

1. **Observability** — make the respawn wiring testable end-to-end (issue
   #17's real ask), because "the one I killed" must be identifiable before
   killfeeds, debug logs and smoke phases can say anything useful.
2. **Seam** — abstract the decision policy behind an interface so behavior
   variance becomes configuration, not surgery.
3. **CT bots** — the first consumer of the seam: allied bots with their own
   team identity, targeting, scoring rules and spawn geography.

## Decisions

- **Composition, not inheritance.** The dropped idea of a shared Bot/player
  entity base class stays dropped (see refactor-plan.md). A brain is a
  component the executor holds; the player never becomes a brain-haver.
- **Brains decide, the Bot executes.** `BotBrain.decide(view, dt) → intent`;
  the executor owns collision gating, LOS raycasts, sound/effects and damage
  routing. All policy numbers live in `BrainParams` or brain classes —
  `bots.ts` holds none.
- **LOS is a thunk** (`BrainView.seeTarget`): the raycast is paid at most
  once per cooldown window, pinned by test.
- **Ballistics are brain params.** Hit-chance curve and damage spread live
  in `BrainParams`, so future profiles vary accuracy without touching the
  executor.
- **Full two-sided combat.** Ts target the nearest opposing entity (player
  OR CT); CTs target Ts. The player counts as CT-side. The player entry
  stays listed even while dead so `ctbots=0` behavior is bit-identical to
  pre-team days (chase continues, shooting gated by `targetAlive`).
- **Friendly fire off.** Ally bodies stop player bullets (impact puff, no
  hitmarker, no damage). Bot-vs-bot fire only ever flows cross-team by
  construction.
- **Bot bullets ignore intervening bodies — chosen, not missed.** Player
  rounds are real raycasts, so an ally body blocks them; a bot's shot is
  realized as probability against world-geometry LOS only, so a T can hit
  the player through a CT standing between them (and vice versa). Accepted:
  bodies are transient cover at bot accuracy levels, and a per-shot
  entity raycast buys realism nobody would notice. Revisit if bot accuracy
  profiles ever get sniper-grade.
- **Scoring.** `scoreKills` renders as the CT score and increments on any
  CT-side kill — player or ally. `scoreDeaths` renders as the T score and
  increments on any T-side kill — the player dying (combat.ts) or a T
  downing a CT (bots.ts). Rounds are won when all *Ts* are dead; dead CTs
  self-respawn on their own half via the same pausable 6 s clock everyone
  uses.
- **Identity.** Global `id` unique across teams for debugging; display names
  use per-team counters (`T-1…`, `CT-1…`) so killfeeds read naturally.

## Merged

### Tranche 1 — respawn observability (PR #24, closes #17)

Bots gained stable `id`/`name`; killfeed lines name the victim; DEV-gated
`console.debug` traces death/revival; `__cs.gameTime` exposed next to
`__cs.bots`. Smoke test grew a kill → pause-past-6 s → assert-still-dead →
resume → assert-revived phase proving the clock freeze end-to-end
(`frozeFor: 0, revivedAfter: 6.02`).

### Tranche 2 — the BotBrain seam (PR #25)

`sim/botBrains.ts`: engine-free `BotBrain` interface, `BrainView`/`BrainIntent`,
`BrainParams`, `DefaultBrain` (a parameterized port of the original inline
policy) and pure ballistic helpers. `bots.ts` became a stateless executor.
16 pinning tests with hand-derived expectations and replayed-frame cadence;
they caught the first draft flipping strafe direction a frame late relative
to the original (see lessons below).

## In flight

### Tranche 3 — CT bots

- `Team = 'T' | 'CT'` on `BotShape`; blue-gray palette alongside tan;
  spawn bands mirrored (`z ∈ [−55,−20]` vs `[20,55]`, rejection-sampled);
  `spawnBots(count, team)` wired to `session.botsT` / `session.botsCt`.
- Ballistic constants migrated into `BrainParams`
  (`hitChanceNear/Divisor/Min`, `damageMin/Span`); brains expose
  `hitChance(dist)` / `rollDamage()` so executors never read params.
- Pure `nearestOpposing(origin, candidates)` picks targets (corpses skipped,
  height ignored); shot realization routes `damagePlayer(name)` vs
  `damageBot(bot, dmg, 'torso', name)`.
- Kill attribution through `damageBot`/`die(killerPart, killerName?)`:
  player kills keep the `You ☠ headshot-killed T-n` wording, bot kills read
  `CT-2 killed T-5`; T-on-player deaths replace the old hardcoded
  `'Bot killed You'`.
- Smoke: config phases expect 13 (10+3) and 15 (12+3) registry bots; new
  `[allies]` phase teleports a T beside a CT at collider-free spots and
  asserts cross-team engagement evidence within a generous window.

### Tranche 4 — a brain with height (in flight)

The seam's default policy was planar in every dimension that mattered: it
steered planar (correct — a step only moves in x/z), but it also RANGED
planar, and that is what `maps/elevation.ts` was built to expose. A target on
the deck overhead read as `dist ~ 0`, so the near band pushed bots away from
the flight that reaches it.

Split the two ideas rather than blanket-replacing `dist`:

- `BrainView` keeps planar `toTarget`/`dist` as the STEERING basis, and gains
  `dist3` (true eye-to-eye), `rise` (target feet − own feet), `selfFeetY` and
  `onGround`.
- The chase bands and `engageRange` read `dist3`. The engage gate now agrees
  with the die `rollHit` rolls on, which it never did before — a bot on a
  tower could open up on something its own accuracy curve had written off.
- The near-band back-off is **suppressed while `rise > climbThreshold`**
  (1.5 m, well clear of `STEP_HEIGHT`). You cannot reverse away from something
  overhead; trying only widens the gap to the stairs.
- Target choice became policy: `nearestOpposing` takes a scorer, `BotBrain`
  supplies `targetScore`, and `DefaultBrain` weights height at
  `verticalWeight` (2) because a metre up costs a detour that a metre along
  the ground does not. The scorer defaults to the old planar ranking.
- Executor fix found while wiring it: `bots.ts` listed the player candidate at
  `player.pos`, which is the EYE, while bot candidates are FEET. Invisible
  while y was stripped; 1.7 m of phantom rise the moment anything read it.
- Bots now pitch their heads at the target, so firing up at a deck reads.

**What this did NOT fix, and the mis-diagnosis it corrected.** Bots still do
not reach the deck on the elevation map, and the reason in the smoke test's
`[botClimb]` comment was wrong. It blamed planar band steering — "once inside
farBand the radial term drops out and it circles at constant radius". Tracing
the bot showed it does not circle, it WEDGES: it drifts east until its radius
overlaps the `x >= 6` second-floor slab, and at feet 1.5 that slab's underside
sits below its head, so `collidesAt` blocks every direction — including the
ones that reduce the overlap, since the test is binary on footprint overlap
with no depenetration. It freezes at one coordinate with `moveBlocked` set,
permanently.

**This traps the PLAYER identically** (verified: all four cardinals plus jump,
zero displacement, at feet 1.5 on riser 5 of the internal flight). Feet
anywhere in [1.2, 3.3] inside that footprint are stuck; below 1.2 the slab is
overhead cover and you walk under freely. It is a collision-model soft-lock,
not an AI bug, and no amount of navigation fixes it — a bot that pathfinds
perfectly onto that flight still wedges. Tranche 3's stair navigation is
blocked behind it.

#### Playtest (elevation + arena, collision fix and 3D brain together)

What held: the soft-lock is gone and walls stayed solid everywhere — no leak,
which is the escape behaving as designed (it only ever fires outward). Overall
lethality felt unchanged. No bot was ever seen on the jump-only crates or the
bridge, so the map's control case survives.

What it surfaced:

- **Bots rarely, but not never, try the stairs.** Consistent with the
  climbThreshold dead zone below.
- **A bot pins against geometry and frees itself only once the PLAYER moves
  far enough.** Not a wedge — collision permits the move. The intended *step*
  keeps pointing into the obstacle, and `moveBlocked` flips `strafeDir` every
  frame, so the bot alternates between two mirror-image steps that are both
  refused. Lesson 21's ordering is right; the per-frame flip RATE is not. This
  was the strongest complaint and is now its own piece of work.
- **Bots crowd underneath a deck player** — approach works, arrival does not.
- **A deck player draws more fire than before.** Expected rather than a
  regression: bots now close in instead of retreating, and `botHitChance`
  falls off with distance, so a shorter range is a better roll.
- **The head pitch was invisible.** See lesson 25; replaced with a barrel.

Measured, with both changes in: a bot climbs to feet **2.4** (was 1.5), then
orbits. At 2.4 the rise is 1.2, under `climbThreshold`, so the overhead
suppression switches off and the band holds it one step short. 3D ranging moved
where the stall happens, not that it happens — stair navigation is what closes
it, because a bot must head for the TOP OF THE FLIGHT and keep heading there
until the level changes, which no band around the target can express.

## Deferred

- **Behavioral variance** (aggressive/cautious profiles): now config-only —
  construct brains with different `BrainParams` per bot or team.
- **T-side score naming**: `scoreDeaths` doubles as the T score (it now
  counts all T-side kills, not just player deaths — review finding, fixed
  in-tranche); renaming the field pair to team-named counters is HUD/state
  churn beyond this tranche.
- **#28 reconciliation**: audit of `docs/refactor-plan.md` staleness and the
  archival policy between it and this file.

## Review lessons (AI tranche)

Numbering continues from refactor-plan.md's lesson 20 — one counter across
all plan documents, so a bare `lesson N` in a code comment is unambiguous.

21. **A flip scheduled "between frames" must not become a flip "within" one.**
   The seam's first draft processed collision feedback after computing the
   step; the original toggled direction after frame N's application, so
   frame N+1 must step with the flipped direction. The pre-wiring pin caught
   it — lesson 19's rule (pin the invariant before the refactor) paying for
   itself inside the same PR.
22. **Pipes eat gate failures.** `npm run typecheck | tail` reports tail's
   exit status; a chained `&&` sequence ran straight through a red
   typecheck and briefly committed broken code. Use `set -o pipefail` (or
   run gates bare) whenever output is piped.
23. **A binary "am I inside?" test is a trap unless something can walk back
   out.** `collidesAt` answers overlap with no notion of depth, so
   `slideMoveXZ` refused EVERY direction for an entity already inside
   geometry — the way out included. That soft-locked the player permanently
   on the elevation map's internal flight and froze bots there for whole
   matches. Two things hid it for this long: the collision suite only ever
   tested entities approaching from OUTSIDE, and the one fixture that did
   start inside a wall (`blocking follows the given feet height`) asserted
   the trap as correct behavior. Depenetration is not an optional refinement
   of a solid-body test — without it the test has a state with no exit.
24. **A plausible explanation can be right about the wrong thing.** The
   `[botClimb]` phase explained bots never gaining the deck as planar band
   steering: "once inside farBand the radial term drops out and it circles at
   constant radius". A position trace refuted it — the bot sat frozen at ONE
   coordinate with `moveBlocked` set, wedged rather than circling, and that
   finding is what turned up the soft-lock this PR fixes. But with the wedge
   gone the bot goes on to do precisely what the comment said, holding
   planarDist ~ 13.98 against a farBand of 14 while sweeping across the
   flight. The explanation was accurate about a SECOND stall that the first
   one had been hiding.
   Both halves cost something. It was wrong about the behavior anyone could
   actually observe, and it was believed long enough to shape a plan around.
   It was also right about a stall nobody could reach yet, which is why
   deleting it would have thrown away a real finding. Trace before
   attributing — and when a trace refutes an explanation, check whether it is
   describing something further along the same path rather than nothing.
25. **A cosmetic cue that cannot read is not a cue.** Bots were given head
   pitch so that one firing up at a deck would visibly look up. The math was
   right — correct formula, correct sign, correct three.js rotation
   convention — and a reviewer checked it and agreed. The playtest saw
   nothing at all. The head is a 0.34 m featureless cube rotating about its
   own centre, and a shape with no surface detail and no asymmetry cannot
   show direction by spinning in place; there was never anything to see. The
   fix was not to the maths but to the geometry: a barrel on a hinge, which
   swings. Confirming that a presentation change is CORRECT is not the same
   as confirming it is VISIBLE, and only one of those can be done by reading
   code. Look at it.
26. **A fixed sleep asserts a frame rate, not a behavior.** The `[qcancel]`
   smoke phase budgeted 2600 ms of WALL clock for a reload whose deadline is
   2.2 s of GAME time. Game time advances by `Math.min(clock.getDelta(), 0.05)`
   — the clamp exists so heavy frames do not fast-forward gameplay — so it can
   only ever lag wall time, never lead it. The phase was really asserting "the
   loop keeps within 18% of real time", which nothing promises, and one slow
   frame anywhere in the window failed it with `mag` still 24. Reproduced
   deterministically by starving the loop: the sleep ends at `reloading: true,
   mag: 24`, while polling for completion under identical stalls finishes in
   4.5 s. Wherever a deadline lives on the game clock, POLL for the thing being
   claimed and put the wall clock only in the give-up bound — which the
   `[respawn]` phase in the same file already did.
   Worth noting how it was found: it surfaced as an unattributable one-in-three
   flake, and the first explanation reached for was GC pressure from a new
   allocation. That was a cause of slow frames, not the bug — the bug is that a
   slow frame mattered at all. Lesson 24's shape again.
