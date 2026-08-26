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

### Tranche 5 — navigation (in flight)

Reactive steering has a ceiling, and measurement found it. With the player
held on the second-floor deck, the worst 5-second windows show bots walking
17 m to finish 0.1 m from where they started, **never blocked**, standing
directly underneath. Not pinned — routeless. 7 of 40 windows; median
straightness 0.81, so most bots move fine.

That killed two cheaper designs before either shipped:

- A stuck-detector keyed on sustained `moveBlocked` fired on **0%** of frames.
  The longest run of consecutive blocked frames across 8 bots over 30 s is
  1–2, peak blocked rate 1%. `blk` looks solid in the readout because it
  flickers fast, not because it stays set.
- Straight-line steering to a stair mouth cannot solve the measured case
  either. The internal flight ascends `z+` from `z=-9` and tops out at `z=0`,
  so a bot at `(4, 0, 8)` faces its 3.6 m **tall end**, and the nearest
  outdoor flight is behind a doorway.

So: an actual graph. `sim/navGrid.ts` samples the world into multi-level
walkable nodes and A*s over them; `nav.ts` binds it to `collision.ts` and
`world.ts`; `world.ts:addStairs` publishes each flight's endpoints as a
`NavLink`, since a grid coarse enough to be cheap reads every staircase as a
wall. Measured on the elevation map: 16,896 nodes, 124,140 edges, 4 links,
33 ms to build, and a 23-waypoint route from under the deck to the deck that
traverses exactly one 3.6 m link jump.

Two things worth knowing before building on it:

- **Representation matters more than it looks.** Arrays-of-arrays-of-objects
  cost 5.5 MB of live heap against a 6.3 MB baseline for the entire game.
  Flat CSR typed arrays cost ~1.4 MB, and the build dropped 53 ms to 33 ms.
- **A\* is 3.7 ms** for a worst-case cross-map route. Per-bot recomputes must
  be staggered and bounded, or a dozen bots re-routing on the same frame will
  be felt.

#### Bots follow the graph

Routing is gated on height alone — `rise > climbThreshold` to enter, held down
to a much lower `climbExit` (0.45) because a bot partway up a flight still
reads a rise of a metre and dropping it back to band steering there IS the
stall this replaces. Same-level routing waits on evidence that same-level bots
actually fail to arrive. *(That evidence arrived: issue #44, and the flat
latch below is its answer.)*

**Result: going-nowhere windows 7/40 → 3/40**, and the remaining ones changed
character — they are mostly bots at `feetY 3.6, rise 0.0`, on the deck orbiting
at combat range, which is the engage band working rather than a navigation
failure. `[botClimb]` went from reporting 2.4 m after ~900 grounded frames of
milling to asserting arrival at 3.6 m in ~90.

Two findings from step 0, which handed a bot a perfect path before any policy
existed:

- **The perpendicular drift is load-bearing, and that was backwards from the
  plan.** Steering straight at waypoints with no drift jams on a doorway jamb
  and stays there, blocked 96% of frames. But high drift jams too, elsewhere:
  0.7 and 0.35 fail approaching the external stair, 0.15–0.2 fail on the
  internal flight's west edge, and only ~0.1 cleared all four test routes — a
  value holding by luck, not design. Drift is combat maneuvering that
  accidentally unsticks things.
  So routing uses NO drift plus an explicit recovery: sustained rejection
  commits the bot to sliding one way along whatever blocks it, alternating side
  between attempts. All four routes then complete at zero drift.
- **That vindicates the stuck-detector dropped from the earlier tranche.** It
  fired on 0% of frames under normal steering because the drift was already
  doing the job. Under path-following the jam is real — a stuck path-follower
  is blocked 60–100% of frames, against 1% in ordinary play. The mechanism was
  right; it was keyed to a situation that did not arise.

And one from measuring the result rather than trusting it: a coarse grid gives
a flight one link edge, mouth to landing, so **a bot partway up routes back
DOWN** to reach the only edge that climbs, then walks up, then is re-routed
down. Observed as a bot frozen two risers up for fifteen seconds, never
blocked. Fixed by joining every node ON a flight to both its ends — a staircase
is traversable from anywhere along it, which is why `NavLink` carries the
flight's width.

Budget: one A* per frame across all bots, since a route costs ~4 ms and a dozen
bots recomputing together is a dropped frame. With 12 bots all wanting routes,
p50 frame time moves 16.9 → 18.4 ms and p95/p99 do not regress.

#### Watching it, rather than tracing it

Every finding above was won by instrumentation: position traces, `[botClimb]`
console phases, the `#botDebug` text block, straightness histograms. None of them
show WHERE a bot thinks it is going, and the map is opaque — a bot routing to a
staircase does it behind a wall. Lessons 24 and 26 are both cases of an
explanation surviving because nobody could look at the thing it described.

`src/debugView.ts` closes that: a DEV-only overlay on `V` that wireframes the
level (so bots and routes are visible through geometry, and the 40–140 m fog goes
off with it), draws each bot's REMAINING route as a polyline, and draws a line
from each bot's eye to its current target tinted by `mode`. Both call sites in
`main.ts` are `import.meta.env.DEV`-guarded, so it leaves production builds
entirely — verified by grepping `dist/`.

Two things it taught immediately, both about presentation rather than routing:

- **1 px is all a line gets, so contrast is the only lever.** WebGL caps
  `LineBasicMaterial` width at 1 px on every platform that matters. The first
  palette used team amber and steel blue, which are perfectly sensible team
  colours and completely invisible against a dusty-tan scene (`0xbfae8f`)
  wireframed in brown. Magenta and electric blue read instantly. Lesson 25
  again — the maths was never in question, the visibility was.
- **An intent line ending at the viewpoint has no length — at any angle.** A
  bot targeting the PLAYER gets `targetEye = camera.position`, and every point
  on a segment ending at the projection centre maps to the same image point.
  Measured, with the bot 345 px off screen-centre: sampling that line at
  t = 0, 0.25, 0.5, 0.75, 0.9, 0.99, 0.999 gives the identical pixel every
  time, while moving the far endpoint 2 m sideways sweeps the same line clean
  off the screen. The condition is not "the player is looking ALONG the line"
  — that is rare, and it is what puts the bot mid-screen. It is "the player is
  standing at the END of it", which is always true. So the one case worth
  seeing most, *this bot is coming for me*, was the one case the line could
  never show, and no adjustment to the line fixes it: shortening it or drawing
  a fixed-length stub keeps it collinear with the same ray.
  The fix is a screen-facing marker — a diamond built in the camera's own
  right/up basis above each bot, mode-tinted, scaled by its own distance so it
  holds a constant apparent size. It carries the mode the line cannot, and
  costs the builder one extra parameter (the camera basis) to stay pure.

`path`/`leg` stay private on `Bot`; the overlay reads them through `navPath`/
`navLeg` getters, and `targetEye` is a new display-only field written where
`update()` already computes the value for its LOS ray — the same "public because
a DEV readout renders it, written here only" contract `mode` and `moveBlocked`
already carry.

### Shot-gate grading on the overlay (issue #46)

The playtest report behind this issue — *"the bots are almost always engaging,
probably because they can see their enemies through walls"* — was the overlay
lying by omission. One bit, brain mode, carried everything it drew, and
`engage` means *not routing*, not *can shoot*: a bot 80 m away behind three
walls drew the same solid intent line as one mid-gunfight. The gates were
already honest (`dist3 < engageRange`, then `seeTarget()`); nothing could SEE
that.

Now the tint carries what the hue cannot. The intent line and marker grade by
the actual shot gates — full = inside engage range with sight proven this
frame, half = in range but sight unproven or blocked, quarter = tracking a
target beyond engage range — while the hue stays the mode's.

- `BotBrain.inRange(dist)` exposes the trigger's exclusive comparison so the
  executor never reads params, same rationale as `hitChance`.
- The two halves cost differently and are treated differently:
  `Bot.targetInRange` is a comparison, fresh every frame; `Bot.targetLOS`
  costs a real raycast, so it is taken only while `session.debugView` is up.
  Policy's own probe stays lazy — at most once per cooldown window — exactly
  as the issue required: a deliberate choice to pay while inspecting, never a
  side effect. Both reset alongside `targetEye` on no-target and respawn.
- Smoke `[debugView]` pins the gating end-to-end: zero probes before any V
  press, at least one live bot probing while up (the pin asserts ≥1, not
  every — a bot whose target died mid-phase legitimately holds `null`),
  none after down, resumed on re-toggle. Dead bots are excluded from the
  census — their `update()` early-returns, so a corpse killed mid-overlay
  legitimately keeps the last value it took.
- Two carriers for one state (PR 1.5), because neither survives contact with
  eyes alone: brightness tiers are hard to tell apart at a glance and not
  colorblind-trivial, so `hud.ts:updateBotDebug` now renders the same gates
  as an `r`/`s` text column beside the mode — `rs` can fire, `r-` in range
  but sight unproven or blocked, `--` tracking beyond engage range.
- Cost accounting for that DEV probe, stated plainly: it is paid per bot per
  frame while the view is up EVEN WHEN THE TARGET IS OUT OF RANGE, where the
  result cannot change the tier. Kept eager deliberately — the smoke census
  keys on any live bot with any target probing, which a range-gated probe
  would break, and the cost cannot ship outside DEV. Revisit only if
  profiling ever shows it.

### Flat routing (issue #44)

The nav graph has covered the whole map since tranche 5, but the brain only
asked it for routes UP: `wantRoute` keyed on `rise` alone, so every wall,
crate and building on the flat was left to band steering — which knows the
direction to its target and whether last frame's step was refused, and nothing
else. Issue #44's playtest was that design failing exactly as documented:
bots pacing ±3 m at a wall face with no `blk`, because sliding keeps ~0.7 of
the intended step and step-rejection cannot see a stall it never causes. The
measured case was stark enough to gate the fix on: against pre-fix main, a T
teleported south of arena's mid wall with the player on the CT half ground to
a halt at (−9.6, −1.5) — pressed into the wall's face, never in route mode,
still there 45 s later.

The latch, in `DefaultBrain`: while NOT routed by the climb gate and beyond
`farBand`, planar distance is tracked against a baseline. Closing by more than
`noProgressEpsilon` (0.25 m — several frames' worth; per-frame closure is only
~0.07 m, so a per-frame test arms the timer mid-approach) or retreating by
more than `fleeReset` (2 m — a fleeing goal is not stagnation; without this,
chasing anything faster latches permanently) re-baselines and resets.
Otherwise the accrual grows; at `noProgressTime` (1.5 s) routing engages
regardless of rise, and stays engaged until `dist3` comes back inside farBand
— the same evidence-then-hand-over shape as climbThreshold/climbExit, with
the band boundary playing climbExit's role. Release keys on band entry ALONE:
closure made en route does not release early, so a long open-ground chase
stays graph-followed until the target is back inside farBand — deliberate,
because flip-flopping between steering and graph mid-chase would thrash both.

What it buys:

- The graph now covers the flat, and `travel()`'s jam recovery — built and
  validated in tranche 5 but unreachable from engage mode, because engage
  zeroed `blockedFor`/`commitLeft` every frame — finally fires in the
  situations playtesters were reporting.
- Smoke `[flatRoute]` pins it end-to-end on arena: same teleport, poll for
  feet crossing z ≥ 2 AND route mode observed en route (strafe-luck cannot
  satisfy it). Fix: crossed at x = 3.5 — through the wall's east gap, the
  only path — in 8 s, `sawRoute: true`. Pre-fix main fails the phase with the
  bot still south of the wall.
- Nine unit tests pin the latch's edges: adoption frame arithmetic (the first
  stalled frame establishes the baseline and accrues nothing), approach and
  flight re-baselining, in-band pacing staying engagement (#45's hold must
  not read as failure), release-and-fresh-evidence, respawn clearing, and
  jam-recovery reachability from an engage-origin route.

Deliberately deferred to the band-steering fixes (#45/#43): routing when SIGHT
has been blocked long enough. This latch keys on distance progress, not sight;
the two compose but are separate evidence streams.

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
27. **A constant headed for Float32 storage should be chosen to survive it.**
    The overlay's brightness tiers were first drafted as 1 / 0.55 / 0.25, and
    the pin asserting the mid tier failed — not because the maths was wrong
    but because the color buffer is a `Float32Array`, and 0.55 has no exact
    float32 representation: it round-trips as 0.550000011920929, while 1,
    0.5 and 0.25 are exact. The fix was to pick the value the storage can hold
    (0.5 reads identically) rather than loosen the assertion with a tolerance;
    an exact pin that survives is worth more than a fuzzy one that passes.
    Same family as the LIFT comment in debugView.test.ts about 1.9 rounding —
    but that one tolerated at read time, where this could be fixed at write
    time, which is always the better end of the pipe.
