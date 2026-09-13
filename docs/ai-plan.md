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
The initial arc, agreed up front as three tranches (later playtests added the
height, navigation and senses work recorded below):

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
  *(Annotation, PR #69: this was the pre-6a shot-gate design.
  `BrainView.seeTarget` is retired; every living bot now runs
  `acquireVisual()` before `decide()`, with cheap rejections spending no ray
  and an eligible look spending at most one ray per frame. The brain receives
  only the resulting zero-or-one copied `visual` observation.)*
- **Ballistics are brain params.** Hit-chance curve and damage spread live
  in `BrainParams`, so future profiles vary accuracy without touching the
  executor.
  *(Annotation, tranche 7a: superseded. Ballistics are the WEAPON's, not the
  policy's. `BrainParams` lost `hitChanceNear/Divisor/Min`, `damageMin/Span`,
  `cooldownMin/Span` and `firstDelayMin/Span`; what stayed is movement. The
  decision was right that a brain must not read executor constants, and wrong
  that the numbers were policy at all — they were an abstract weapon hidden
  inside the policy object, which is exactly why every bot on the field was
  identical. A `FireController` composed into the brain owns them now, and
  landed damage comes from `sim/damage.ts:damageForPart` on the real catalog
  def.)*
- **Full two-sided combat.** Ts target the nearest opposing entity (player
  OR CT); CTs target Ts. The player counts as CT-side. The player entry
  stays listed even while dead so `ctbots=0` behavior is bit-identical to
  pre-team days (chase continues, shooting gated by `targetAlive`).
  *(Annotation, PR #69: the team candidate sets survive, but nearest-
  position targeting and `targetAlive` do not. Perception probes the tracked
  identity first, otherwise fairly rotates through cheaply eligible opposing
  candidates. A dead player remains listed only as a cheap rejection; without
  another observation the bot holds and never chases the corpse.)*
  *(Annotation, PR #120: with a selectable side the player counts as
  `session.playerTeam`-side — bots opposing the player's side list the player
  as a candidate (`bots.ts`), and allied bots never do.)*
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
  *(Annotation, PR #120: with a selectable side the counters credit the
  killer's side — a T-side player kill increments `scoreDeaths` — and rounds
  are won when the side opposing `session.playerTeam` is wiped
  (`combat.ts:checkRoundEnd`).)*
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
policy) and pure ballistic helpers. `bots.ts` became a policy-free executor;
later navigation work added executor-owned route state without moving decisions
back out of the brain. 16 pinning tests with hand-derived expectations and
replayed-frame cadence caught the first draft flipping strafe direction a
frame late relative to the original (see lessons below).

### Tranche 3 — CT bots (PR #29)

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

### Tranche 4 — a brain with height (PRs #33–34)

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

### Tranche 5 — navigation (PRs #38 and #42)

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

### Shot-gate grading on the overlay (issue #46; PRs #50–51)

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
- Cost accounting for that diagnostic probe, stated plainly: it is paid per
  bot per frame while the view is up EVEN WHEN THE TARGET IS OUT OF RANGE,
  where the result cannot change the tier. Kept eager deliberately — the smoke
  census keys on any live bot with any target probing, which a range-gated
  probe would break. The V binding and overlay are DEV-only, but the
  unconditional `window.__cs.game.debugView` facade can enable the probes in a
  production preview for smoke diagnostics; the cost is paid only while that
  flag is up. Revisit only if profiling ever shows it.

*(Annotation, PR #69: the record above describes the pre-6a diagnostic
architecture and is no longer the live contract. Tranche 6a made visual
acquisition gameplay: every living `Bot.update()` calls `acquireVisual()`
regardless of `session.debugView`; cheap rejection may spend zero rays, and an
eligible look spends at most one. `targetInRange`/`targetLOS` are derived every
frame from that acquisition and its agreement with the brain intent, while the
overlay and HUD only consume them. Consequently live data cannot produce
`r-`: `rs` is an agreeing current visual inside engage range, `-s` is one
beyond it, and `--` covers blocked or unprobed looks plus hold, memory and
search. `[debugView]` now asserts that its toggles leave the gameplay-
perception census unchanged; the pre-6a probe-count assertions are retired.)*

### Flat routing (issue #44; PR #52)

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
  *(Annotation, band-steering PR: the route-mode half of that assertion did
  not survive contact with its own successors. A later main run crossed via
  juke-luck alone in 4.5 s without ever routing, and #45's committed strafe
  is a second legitimate wall-rounding solver — so demanding route mode would
  flake against healthy outcomes. The claim is now ARRIVAL within budget,
  mechanism-free; `sawRoute` is recorded for information. Lesson 28.)*
- Nine unit tests pin the latch's edges: adoption frame arithmetic (the first
  stalled frame establishes the baseline and accrues nothing), approach and
  flight re-baselining, in-band pacing staying engagement (#45's hold must
  not read as failure), release-and-fresh-evidence, respawn clearing, and
  jam-recovery reachability from an engage-origin route.

The separate blocked-sight evidence stream was resolved by the band-steering
fixes (#45/#43) below. Blocked sight does not itself force a route: it suppresses
the juke so a committed strafe can clear the occluder. Distance stagnation
remains the evidence that hands flat movement to the nav graph; the two compose
without conflating their triggers.

### Band steering commits (#43/#45; PR #56)

Two playtest complaints with one root shape: the engage blend's lateral
component never COMMITTED to anything.

**#43 — the collision flip is edge-triggered.** `decide` reversed
`strafeDir` on every frame `moveBlocked` was set, so a bot resting against a
wall face reversed ~60×/s; the perpendicular component cancelled itself out
while the radial term kept pushing in — the wall-grind playtesters watched.
Now a run of blocked frames is ONE contact event and flips once
(`wasBlocked`), giving a committed direction to clear the obstacle in — the
same principle `travel()`'s slide commits use for routing bots.

**#45 — blocked sight stands down the juke.** The corner trap composed two
facts: inside the band the radial term is exactly zero (pure strafe at full
speed), and nothing in the policy responded to blocked sight — failed probes
only shortened a cooldown. But those probes already fire every
`retryCooldown` while in range, so the information was arriving and being
discarded. Now each failed probe records `sightBlocked`, and while it holds
the juke is suppressed: the band hold COMMITS one way and walks around
whatever occludes instead of pacing across its face. Any successful probe
clears it; leaving the trigger's range/alive gate clears it; respawn clears
it; the draw is still consumed so scripted rng sequences are unchanged. One
frame of lag is deliberate — the observation lands after this frame's step,
like `moveBlocked`.

Measured with `[cornerTrap]`, a new smoke phase built for the trap: player
and T-1 placed 12 m apart — dead centre of the band hold — either side of
arena's west mid wall, with PR #50's `targetLOS` readout as the acceptance
sensor (the debug view's eager probes make "regained a firing solution"
directly observable). Main paced at the wall for the full 75 s budget twice,
drifting to (−26.7, −2.1) and (−28.7, −6.2), sight never clearing. The fix
regained LOS in **7.1 s**: committed WEST along the face, rounded the wall's
west tip, sight cleared — `sawRoute: false`, i.e. band steering alone solved
it without ever invoking the nav graph. The west tip is only 12.5 m from the
setup, so those randomized runs are observations, not the regression pin: the
smoke phase now forces every juke draw below threshold. Without suppression
the bot re-flips continuously and times out; with it the draws are consumed
but ignored and the bot commits. That was the point of bundling: neither half
gets credit alone, since #43's per-frame flips would have cancelled any
commitment #45 tried to make.

*(Annotation, PR #69: tranche 6a retired the `[cornerTrap]` smoke
fixture. Its setup deliberately hands a bot an occluded opponent it has
never seen and forces the pre-6a `sightBlocked`/juke machinery against it —
under 6a's non-omniscient policy that target is intentionally unknowable
and the only correct result is `hold`, which the `[vision]` phase now
covers end to end, including the damage-priority frame. The hidden-behavior
claim it carried is replaced by `[vision]`, and cross-wall navigation
survives in `[flatRoute]` through observed, frozen memory. #43's contact-edge
commitment remains pinned at the pure/unit layer; #45's `sightBlocked` branch
is retired because blocked sight now yields no current visual for band
steering to act on.)*

### Tranche 6a — vision, awareness and search (PR #69; follow-up PR #72)

Omniscience out, observations in. The specification as approved is kept below
in full, followed by what was actually built and by the approved follow-up that
shipped on top of it. Annotations elsewhere in this document naming PR #69 or
#72 mark the earlier claims this tranche superseded — the pre-6a shot gate, the
nearest-position targeting it replaced, #46's diagnostic probe and the
`[cornerTrap]` fixture.

#### What 6a specified

**Division of ownership.** Perception mechanics stay with the executor;
perception POLICY belongs to the brain.

- `bots.ts` owns the entity registry, range/FOV prechecks, LOS raycasts, stable
  entity lookup, route realization, collision, facing/aim application and the
  realization of any shot the brain orders.
- `DefaultBrain` owns which detected opponent is being followed, its frozen
  last-known position, stimulus priority, search/scan state, expiry and the
  transition between `hold`, `search`, `route` and `engage`.
- Unseen candidates' positions may be used by the executor only to decide
  whether a perception ray is worth attempting. They are not included in
  `BrainView`, used as a movement goal or rendered as an intent until an LOS
  probe succeeds. That is the boundary that removes omniscience.
- Give the player and every bot a stable perception identity (`player` versus
  bot id). The brain stores identities and copied positions, never entity or
  mesh references. A remembered position must not move when its source moves.

**Sight budget and acquisition.** Initial tuning is a **120° horizontal FOV**
and **60 m visual range**. Vertical elevation does not narrow the cone; the
planar yaw test decides whether to look, while the 3D range and world LOS decide
whether the look succeeds.
*(Annotation, PR #72: the range became **80 m** —
`sim/perception.ts:PERCEPTION_RANGE_M`, and the boundary pins follow the
constant. The FOV, the cheap-rejection order and the 45 m engage gate are
unchanged. See the follow-up record below.)*

- Each living bot may spend at most **one perception LOS raycast per frame**.
  If it has an identified opponent, try that opponent first; otherwise rotate
  fairly through opposing candidates by stable id. Range, liveness and the FOV
  dot-product are cheap rejections and do not spend the raycast. After a cheap
  rejection, continue the rotation until one eligible candidate spends the
  raycast or every opponent has been examined; an out-of-cone remembered target
  must not starve acquisition of somebody standing in view.
- Retire #46's separate diagnostic probe rather than letting the display drive
  gameplay. Visual acquisition runs independently of the overlay and feeds the
  `targetInRange`/`targetLOS` readouts as a non-influencing consumer; the
  perception result may feed the display, never the reverse.
- A successful probe produces one visual observation: identity, copied feet
  and eye positions, planar/3D distance and rise. Failure produces no fresh
  target position. The currently identified target remains remembered at its
  last successful observation.
- Ts initially face the CT half and CTs the T half, on construction AND
  respawn. With a real FOV, leaving both teams at the mesh's default yaw would
  make first contact asymmetric by spawn side rather than by policy.

**Brain interface.** Replace the single omniscient target view with a passive
observation view: own feet/facing and movement feedback, zero or one visual
observation, heard stimuli added by 6b, and lazy `nextWaypoint(goal)` routing.
The brain exposes its current focus id so the executor can prioritize the next
probe. `BrainIntent` gains a planar facing direction and focus identity beside
its movement step, shot request and mode.

The executor may realize `wantShoot` only when all three agree in THIS frame:
the intent's focus id, the successful visual observation's id, and the normal
range gate. A last-known position, sound origin or incoming-fire bearing can
drive movement and facing but can never authorize a shot. This is the pin that
prevents awareness work from becoming fire-through-cover by another name.

**Modes and transitions.** Widen `BrainMode` from `engage | route` to
`hold | search | route | engage`; update every exhaustive
`Record<BrainMode, ...>`, debug label and reset site in the same commit.

- `engage`: an identified opponent is visible and band steering owns the move.
- `route`: the brain asked the executor's graph to reach a visible opponent or
  a remembered position and received a waypoint.
- `search`: the bot is scanning at the last-known position, at an incoming-fire
  bearing, or in place because no route to its remembered point exists.
- `hold`: no visible opponent and no live memory. The bot stands down facing
  its last heading. Patrol points and a patrol-goal policy are OUT of tranche 6.

Sight refreshes both identity and last-known position every successful probe.
When sight breaks, freeze that position and route to it; never substitute the
source entity's current position. Arrival is within **1 m planar distance** of
the remembered point. If the graph returns no route while the point remains
farther away, enter search in place rather than retaining an immortal route
request.

On arrival, scan deterministically rather than picking random wander goals
that may land inside geometry: face the arrival bearing, then alternate
**+120° / −120° every 0.75 s**. Those three headings let a 120° FOV cover the
full circle and give unit tests exact phase boundaries. Start the **8 s
`forgetTime` only on arrival** (or on the no-route fallback), so a long valid
route is always investigated rather than expiring halfway across the map.
Reacquisition immediately refreshes memory and returns to engage/route;
expiry clears focus and position and enters hold. Respawn clears every focus,
route, scan and memory field.

**Incoming damage.** The original shorthand, "getting shot reveals the
shooter," is deliberately narrower here: damage reveals the DIRECTION OF THE
SHOT, not the shooter's identity, distance or exact position.

- `damageBot` remains the one HP path. Before applying a live hit, it resolves
  the attacker position already available from the player or named bot and
  hands the victim a normalized planar bearing through an executor-to-brain
  damage-stimulus method.
- A damage bearing overrides visible combat, ordinary sound and stale memory.
  It clears any remembered point, turns the victim toward the bearing and
  starts an in-place search immediately.
- The bot does not manufacture a destination down that ray and does not return
  fire until an ordinary FOV + range + LOS observation identifies an opponent.
  A later visual or audible position may replace the bearing normally.

The complete priority is:

```
incoming-fire bearing
  > currently visible opponent
  > newly heard hostile gunshot
  > newly heard hostile footstep
  > remembered position
  > hold
```

Ordinary sound never pulls a bot off an opponent it currently sees. The damage
bearing is the one interrupt because the victim has direct evidence of a
threat from another direction.

**Observability and acceptance.** Give `hold` and `search` distinct overlay
colours and HUD labels. The intent line/marker points at the visible target,
remembered position or scan bearing as appropriate. #46's range/sight grading
remains meaningful only for a CURRENT visual combat target; memory, sound and
bearing goals render non-shootable rather than inheriting stale `r`/`s` bits.

Pure tests pin the FOV/range boundaries, tracked-first/fair candidate schedule,
one-ray maximum, copied last-known position, sight loss and reacquisition,
route-to-search arrival, no-route fallback, the three-heading scan cadence,
post-arrival expiry, hold, damage priority, no memory-shot and respawn reset.
The smoke test supplies the wiring pins: an opponent hidden behind a wall is
not tracked or shot; crossing into FOV + LOS acquires; breaking LOS routes to
the frozen point; arrival scans then holds; and damaging a bot turns it toward
the incoming bearing without granting immediate retaliation.

#### Implementation record (PR #69)

What the implementation built against the spec above:

- **Engine-free perception seam** — `sim/perception.ts`: stable perception
  identities (`'player'` / bot id), 120° horizontal FOV and 60 m range as
  cheap rejections that never spend the ray, a tracked-first then
  fair-rotation candidate schedule, and at most one LOS raycast per living
  bot per frame through an injected callback — the same pure-seam pattern as
  the rest of `sim/`.
- **Copied brain memory/search/damage state** — `DefaultBrain` clones the
  observed feet/eye into its memory on every successful look, pursues the
  copy on sight loss (`route` until the 1 m arrival or a confirmed dead end),
  then scans three headings (0.75 s each) and forgets 8 s after search entry
  into `hold`. A direction-only incoming-fire bearing outranks a same-frame
  visual for one decision, starts an in-place search, and can never
  authorize a shot.
- **Executor-only candidate/LOS/routing/shot agreement** — `bots.ts` owns the
  candidate list, the raycast, route realization and the trigger: the brain
  receives zero or one observation and never a position it did not see, and a
  shot is realized only when the intent's focus id, the same frame's
  observation id and the range gate all agree. Memory, search and bearing
  intents are structurally unable to fire.
- **Centralized respawn/debug observability** — every per-life field (body,
  placement, brain policy state, perception cursor, cached route and
  cooldown, mode and the `targetEye`/`targetInRange`/`targetLOS` readouts)
  resets in `Bot.respawn()`, and those same public fields are what the DEV
  overlay and HUD readout render.
- **Pure tests** — the Node suite stands at 490 tests in 24 files, including
  the FOV/range boundaries, one-ray budget, copied-memory, route-to-search
  arrival, no-route fallback, scan cadence, forget expiry, damage priority,
  no-memory-shot and respawn-reset pins.
- **Browser acceptance** — the new `[vision]` smoke phase drives the wiring
  end to end on the arena: hidden across the west mid wall → `hold` with no
  intent endpoint, no shootable grading and no damage past the spawn
  stagger; stepping into FOV+LOS → `engage` with the observed eye recorded;
  breaking LOS → `route` pinned to the copied pre-break eye (never the live
  player), non-shootable throughout; arrival → a standing `search` with a
  scan endpoint that expires to `hold` clearing both; and a real SMG hit
  through the firing path → a same-frame bearing `search` with no
  retaliation. The damage frame's 5 m setup hands the bot an eligible
  simultaneous ordinary visual, and the assertion is `targetLOS === false`
  EXACTLY — proof the frame spent its perception probe and the
  higher-priority incoming-fire bearing discarded the look's focus
  agreement, rather than the cheaper reading that no probe was attempted.
  The cross-wall routing outcome in `[flatRoute]` is reseeded to match 6a:
  the bot first acquires the player through a real visual north of the mid
  wall, then runs the original cross-wall claim on that copied observation
  alone, with the intent endpoint held separated from the live hidden
  player and grading non-shootable. The pre-6a `[cornerTrap]` fixture is
  retired (its premise contradicts non-omniscience; see the annotation
  beside it above), and `[debugView]`'s toggling is re-verified as a
  non-influencing consumer: the gameplay-perception census (mode, target,
  grading, endpoint) must be unchanged across the V toggles, replacing the
  pre-6a probe-count assertions.

#### Follow-up — idle patrol and mobile damage search (PR #72)

The approved 6a follow-up, landed on top of the record above. What it added,
and what it deliberately did not:

- **Perception range 60 m → 80 m** — `sim/perception.ts:PERCEPTION_RANGE_M`,
  the FOV/occlusion machinery untouched. The 45 m engagement gate is
  unchanged; the boundary pins in `perception.test.ts` follow the constant.
- **Idle bots patrol** — a strictly lowest-priority fifth `BrainMode`:
  `patrol`. With no visual, no remembered target and no active search, a bot
  stands down for one second (`BrainParams.patrolPause` — armed at spawn,
  respawn, search expiry, patrol arrival and failed selection), then asks
  the executor for a patrol waypoint through a lazy `nextPatrolWaypoint()`
  view callback with the same three-way contract as `nextWaypoint` (vector =
  walk it, `undefined` = route budget deferred, `null` = no usable route →
  restart the pause). Selection policy is the pure, rng-injected
  `navGrid.ts:pickPatrolNode` — at most eight uniform samples over the
  graph's nodes, first sample ≥ 12 m planar wins, otherwise the farthest
  sampled non-current node — while the executor owns the per-bot patrol goal
  and accepts a candidate only when the budgeted A* routes to it (unreachable
  candidates are discarded; a fresh one is picked after the next pause).
  Patrol legs share the existing cached path, leg, jam recovery, 1 m
  waypoint threshold and one-A*-per-frame budget under a distinct `'p'`
  route-owner key; reaching the final node ends the leg. Patrol never
  shoots, carries null focus, grades non-shootable, and looks one metre
  along the next waypoint at eye height. Any visual acquisition or incoming
  damage interrupts immediately and clears the goal/path; respawn clears all
  of it.
  *(Annotation, `4a154f5`, merged with PR #49: a patrol leg no longer re-runs
  A\* on `ROUTE_INTERVAL`. That interval now refreshes only a MOVING pursuit
  goal; a patrol node is immutable, so its valid path is followed to arrival or
  abandonment. A recompute still fires when the path is empty or has drifted.)*
- **Incoming fire advances before scanning** — a damage search keeps its
  direction-only semantics and its 8 s lifetime, but now ADVANCES at normal
  travel speed along the newest bearing for its first
  `BrainParams.damageAdvance` (3 s), the damage frame itself included, while
  continuing to face the three scan headings. A blocked step cancels the
  advance permanently for that search (scan in place, no replanning); a
  later hit re-arms a fresh window and clock on the newest bearing. No
  attacker identity, distance, destination, focus or grade is synthesized,
  and nothing can fire before ordinary visual acquisition.
- **Debug presentation** — `patrol` is cyan in the debug overlay's
  exhaustive mode map and appears in the HUD bot readout; the pure suite
  pins the fifth distinct hue.
- **Coverage** — pure: perception's 80 m boundary, the selector contract
  (sample bound, min-distance preference, farthest fallback, impossible
  cases), brain patrol (initial pause, post-arrival/failure pause, vector /
  deferred / null outcomes, normal speed, null focus, visual and damage
  priority, respawn re-arm) and the damage advance (entry frame movement,
  strict-before-3 s boundary, cadence while moving, blocked-cancels-only,
  clock/bearing reset, no firing, 8 s expiry). Browser: the new `[patrol]`
  smoke phase (below).
- **Deferred, unchanged by this follow-up**: cover seeking, inferred attacker
  identity/distance/destination, return fire without visual acquisition, and
  the Elevation stair/ceiling stall diagnosis. The controlled `[botClimb]`
  scenario must continue to pass.

### Tranche 6b — hearing and sound events (PR #85)

The pre-tranche executor chose the best live opponent from exact world
positions every frame. LOS gated the SHOT, but not the KNOWLEDGE: a bot tracked
somebody through a building, faced them continuously and fed their live
position to the route graph before it had ever seen or heard them. Tranche 6
replaces that omniscience with observations, memory and bounded investigation
without moving raycasts, collision or effects into the brain. 6a did the
replacing (PR #69, above); 6b adds the remaining sense.

It landed in two implementation PRs. **6a established sight, memory and search
first; 6b fed sound into that settled stimulus seam.** Combining them would
have made a failed pursuit ambiguous between vision, memory, hearing and
routing at the exact point the tranche existed to make those causes
observable.

**Status: the tranche is closed. 6a merged as PR #69 on 2026-08-29 with its
follow-up as PR #72 (and one later fix, `4a154f5`, on PR #49); 6b merged as
PR #85 on 2026-08-30. The specification below is the one 6b was built to,
refreshed in PR #81 against the code as it stood after PRs #49, #63 and the
loadout tranche; the departures the implementation made from it are named in
the record that follows. The follow-up its playtest raised is under Planned.**

#### What 6b specified

Add an engine-free `sim/soundEvents.ts` with a fixed-capacity **256-entry ring
buffer**. The module defines the data structure but holds no shared module
global: the live `soundEvents` instance belongs in `core/state.ts`, preserving
the repository's one home for shared mutable game state.

Each immutable event carries a monotonic sequence, game-time timestamp, kind
(`gunshot | footstep`), source identity/team, copied world position and radius.
The identity is `sim/perception.ts:PerceptionId` — the same `'player'`/bot-id
union 6a already tracks, not a second identity scheme — and `Team` arrives as a
**type-only** import from `core/state.ts`, erased at build, so the one runtime
edge between the two modules stays `core/state.ts` → `sim/`. `sim/melee.ts`
imports `HitZone` the same way.

The buffer exposes its latest sequence and non-destructive reads after a
caller's cursor, optionally capped at a captured high-water sequence. If a
cursor predates retained data after wraparound, reading resumes at the oldest
retained event; events are never removed by one listener because every bot must
be able to hear the same occurrence.

**Emitters and tuning.** Emission is gameplay data beside the existing audible
WebAudio effect, not a replacement for `audio.ts`.

- `weapons.ts:shoot`: every accepted PLAYER firearm trigger pull emits one
  **80 m** gunshot from the shot origin, placed immediately after `weapon.mag--`
  and BEFORE the pellet loop. That position does the gating for free: dry fire,
  a blocked whole-mag reload and the knife's `swingMelee` have all returned
  already, and a shotgun's eight pellets share the one trigger pull's event.
- `bots.ts:shoot`: every bot trigger emits one **80 m** gunshot beside
  `sfxEnemyShoot` and before `brain.rollHit`, so misses remain audible.
- `player.ts`: at the existing grounded footstep cadence, emit **24 m** while
  running and **12 m** while walking or aim-walking. Gate the AI event on
  post-collision XZ displacement, not merely held movement keys, so pressing
  into a wall does not reveal the player — `updateMovement` already measures
  exactly that (`player.pos.x - preX` / `player.pos.z - preZ`, the input to
  `measuredMoveLerp`), so the gate reads a value that exists rather than adding
  a second notion of "moving". Leave the audible `sfxFootstep` and its
  key-based flag alone. Crouched and airborne movement is silent, which also
  covers `warehouse2`'s lift launches and every jump without a special case.

**One radius for every firearm.** The loadout tranche landed six weapons
(`smg | sniper | shotgun | pistol | revolver | knife`) between this spec and its
implementation, and 80 m still applies to all five firearms — the same number as
`PERCEPTION_RANGE_M`, so a shot a bot could have seen is a shot it can hear.
Per-weapon loudness (a `WeaponDef.soundRadius`, sniper louder than pistol) is
DEFERRED: it needs a `validateWeapons` rule and a default for bot fire, and it
is a tuning question that wants a playtest of the uniform version first.

Hearing is radius-only. Walls neither silence nor attenuate an event; adding
sound occlusion would spend another geometry-probe budget and is not part of
this tranche. Bots ignore their own and allied events. A heard enemy event
provides an investigation POSITION, not entity identity and never permission
to shoot.

Each executor owns a sound cursor. `updateBots` captures the buffer's high-water
sequence before iterating bots, and every bot reads only through that snapshot;
therefore a shot emitted by an early bot is heard by ALL bots on the next frame
instead of only by later entries in registry order. The executor filters new
events by team and radius and passes the bounded heard set to the brain. In the
original 6b implementation the policy chose gunshots before footsteps and the
newest event within one kind; the follow-up now prefers the nearest gunshot,
newest footstep only when no gunshot is heard (see the 6b follow-up record
under Planned). A dead
bot's cursor resets to the latest sequence on respawn so it cannot replay six
seconds of combat that occurred while it was absent.

Heard positions enter the same route → arrival scan → forget → hold pipeline
6a established, at the priority slot 6a left open for them —
`sim/botBrains.ts`'s "Priority 4 — reserved for a future sound stimulus", which
sits below memory and above patrol.
*(Annotation, the 6b implementation: that sentence, written in the PR #81 doc
refresh, took the placeholder comment's POSITION as the design. It contradicts
this tranche's own ladder above, which reads
`… > newly heard gunshot > newly heard footstep > remembered position >`. The
ladder won — freshness is the whole argument for hearing, and a noise from this
second is better evidence than a memory from ten seconds ago. That was the
original 6b decision: hearing was checked between the visual and the
scan/memory branches, and the placeholder's slot number moved with it. The 6b
follow-up (see under Planned) later reversed this — hearing now applies only
with no memory/search commitment, so fresh sound no longer outranks
memory/search.)*
A heard position carries NO focus id, so
the executor's three-way shot agreement (intent focus, this frame's
observation, range gate) already makes firing on sound impossible; no new gate
is needed. Visible combat ignores ordinary sound; direct damage remains a
separate bearing stimulus and overrides it all. The ring does not carry a
special "shot-at" event — an actual damage call is the authoritative evidence.

Unit tests cover empty/full/wrapped rings, independent readers, stale-cursor
recovery, high-water snapshots, copied positions, radius edges, team filtering,
gunshot/footstep priority, stance radii and respawn cursor reset. Smoke pins
hostile gunshot investigation through a wall, run-full/walk-half boundaries,
crouch silence, allied-sound rejection and damage-bearing precedence over an
already heard event.

#### Implementation record (PR #85)

What the implementation built, and where it departed from the spec above:

- **The ring** — `sim/soundEvents.ts`: an immutable `SoundEvent` (monotonic
  `seq`, game-time `t`, kind, `PerceptionId` source, team, COPIED position,
  radius), a 256-entry `SoundRing` with non-destructive `since(cursor,
  highWater)` reads, `withinEarshot`, and the three radii. `Team` is a
  type-only import, so the one runtime edge stays `core/state.ts` → `sim/`.
  The live instance is `core/state.ts:soundEvents`.
- **Three emitters** — as specified, with one correction: **both gunshots emit
  at the shooter's FEET, not at the eye or muzzle the rays leave from.** A
  heard position is a place to walk to, and `navGrid.ts:nearestNode` scores a
  metre of height like four of ground, so an eye-height goal snaps to the deck
  ABOVE the shooter wherever one exists — a bot investigating a ground-floor
  shot would route upstairs. The 1.7 m is nothing to an 80 m radius.
- **The policy** — `pickHeardLead` (gunshot over footstep, newest within a
  kind, position never consulted: the emitter's radius already decided what is
  audible) plus `adoptHeard`, which clears the focus and installs the heard
  point as the investigation goal.
  *(Annotation, 2026-09-04 follow-up: superseded on both halves — the picker
  now takes the listener feet and prefers the NEAREST gunshot, and hearing
  applies only with no memory/search commitment. See the 6b follow-up record
  under Planned.)* `DefaultBrain.memory` gained a NULLABLE
  `eye`, because a noise leaves a spot on the ground and no pair of eyes;
  `goalLookAt` supplies eye height above the point instead, the same
  convention a scan bearing uses.
- **The executor** — a per-bot `soundCursor`, a single `soundHighWater`
  captured in `updateBots` before any bot runs, team + earshot filtering down
  to the reduced `HeardSound` the brain sees, and a cursor jump to the present
  in `respawn()`. One further executor fix: `waypointToward` keys its route
  cache on the GOAL when there is no focus id, because two successive noises
  would otherwise share the owner `m:*` and the second would walk the first
  one's cached path until `ROUTE_INTERVAL` happened to expire.
- **Nothing new authorizes a shot.** A heard goal carries a null focus, and
  the executor's existing three-way agreement (intent focus, this frame's
  observation, range gate) makes firing on it structurally impossible — the
  same property memory already had, reused rather than re-implemented.
- **Coverage** — 617 pure tests: the ring's sequencing, non-consuming reads,
  independent listeners, retention boundary, stale-cursor recovery, high-water
  snapshots and copied positions; `pickHeardLead`'s kind and recency ordering;
  and the brain's route-to-noise, copied goal, null focus, no-shot,
  visible-ignores-sound, bearing-outranks-sound, sound-replaces-memory,
  sound-interrupts-scan, arrive-scan-forget and respawn pins. Browser: the new
  `[hearing]` phase.
- **`[hearing]`** — arena's west mid wall as the fixture, so nothing a bot does
  about the player can have come from sight: a hostile gunshot through the
  wall is pointed at within 0.02 s and closed on, graded non-shootable
  throughout, with the player unharmed; a CT bot 35 m from the same shot stays
  in hold/patrol because the shooter is its ALLY; the player's own running
  footsteps through the wall are investigated the same way; and the identical
  path crouched is silent, guarded by proof that the player really moved and
  really stayed inside the 12 m walking radius.

Two things the phase cost before it was right, both fixture rather than
product. The crouch step first ran at the footstep distances, where a walk
would have been inaudible anyway — the setup guard caught it, which is the
whole reason it was written. Then it failed with 53 frames of `engage`: the CT
bot left alive by the ally step is an ENEMY of the T under test, so the T was
engaging IT, and the mode histogram cannot tell one cause from another. See
lesson 29.

Also investigated and NOT a 6b regression: one full-suite run had `[vision]`
report that its unaware bot never began patrolling, with `[patrol]` measuring
its first leg at 4.04 s against main's 1.01 s. A position-fixed probe put both
branches at 1.02 s over three runs each, and 6b is inert in that fixture by
construction — the player is dead, so `updateMovement` returns before the
footstep cadence, and nothing shoots, so `heard` is empty on every frame.
Two later full-suite runs passed it. Load-sensitive, pre-existing, and left
alone.

#### Playtest (hearing live)

Playtesters confirm the mechanics feel right. Bots converging on gunfire reads
as intent rather than as swarming, and the run/walk/crouch radii give the
stances something real to trade against each other — the 80 / 24 / 12 metre
numbers need no retuning, and per-weapon loudness stays deferred.

The session raised one refinement rather than a complaint, recorded under
Planned below: bots should prefer the NEAREST gunshot, and should not be pulled
off a pursuit they are already committed to.

#### Why the preceding work was prerequisite

- **#46 (shot-gate grading)** made range and LOS separately visible. Tranche 6
  adds a third distinction — perceived versus merely remembered — and would be
  impossible to playtest honestly if every intent line still looked shootable.
- **#44 (flat routing)** lets a bot reach an arbitrary remembered or heard
  position behind same-level walls. Without its stagnation latch, "search"
  would reintroduce the wall pacing that navigation already measured and fixed.
- **#43 (committed contact steering)** stops per-frame contact flips and still
  applies whenever a current visual drives band steering. #45's blocked-sight
  juke suppression was intentionally retired by 6a: blocked sight supplies no
  current target, while remembered and search travel use their own committed
  routing/slide machinery.
- **6a itself (#69, #72)** is now the largest of them. It owns the stimulus
  seam 6b plugs into — the copied-memory pursuit, the three-heading scan, the
  `forgetTime` expiry and, above all, the shot agreement that makes a
  focus-less stimulus structurally unable to fire. 6b adds a fourth stimulus
  to that ladder and no new machinery for acting on one.

6a therefore landed before 6b, and each received its own feature PR, unit pins,
smoke phase and playtest record.

### Tranche 7a — bots carry a real catalog weapon

**Status: merged as PR #89.** *(Annotation, tranche 7b: this said "the PR is
open and not yet merged" until 7b went looking for the seams it describes. 7b
is now implemented too — see its own section below.)*

Bots had no weapon. They had an *abstraction* of one, baked into
`BrainParams`: a Bernoulli curve (0.65 at point blank, /80 falloff, 0.12
floor), a uniform 8–22 damage roll, one hardcoded `'torso'` zone, a ~1.15 s
random cooldown and a decorative 0.6 m box on a shoulder hinge. Every bot on
the field was identical, and what they carried was pistol-shaped by accident.
Meanwhile the loadout tranche had shipped a six-weapon catalog with real fire
rates, magazines, reload models, damage and pellet counts that nothing on the
AI side could reach.

#### The division

**A brain decides WHETHER to shoot; a `FireController` owns WHAT is being
shot.** `sim/botWeapons.ts` is engine-free like the rest of `sim/`, and takes
the catalog def as a PARAMETER rather than importing `core/state.ts` at
runtime. That is stricter than `sim/validateWeapons.ts`: it also receives the
real table through a parameter, but separately runtime-imports the shared
`RECOIL_CAP` and `BASE_FOV` bounds from state.

- The controller owns cadence, burst discipline, the magazine and its reload
  (`sim/ammo.ts` reused verbatim, `perRound` weapons included), the per-ray
  hit die and the hit zone. `DefaultBrain` COMPOSES one. It does not subclass
  for a weapon, and the ~1000-line stimulus ladder — vision, memory, search,
  hearing, patrol, the damage bearing — was not reopened.
- The brain asks `ready()` and calls `pull()`; the executor calls
  `resolveShot(dist)` with the post-move distance and routes the damage. That
  keeps the three-way shot agreement 6a established exactly as it was.
- **`BotWeaponId = Exclude<WeaponId, 'knife'>`** puts the 7a/7b boundary in
  the type system. A knife needs a swing, not a hit die, and nothing — not the
  URL parser, not the menu, not a future caller — can hand a bot one.
  *(Annotation, tranche 7b (PR #92): the alias is now `BotWeaponId = WeaponId`
  and all three of those routes CAN hand a bot a blade — `?tweap=knife`, the
  menu's Knife option, and the `mixed` draw. The claim was true when written
  and the boundary did its job: widening the alias is what made every Record
   over it demand an answer for a knife. The old exclusion survives as
   `BotFirearmId`, which is what the secondary position is drawn from.)*
   *(Annotation, PR #98: `BotFirearmId` is deleted by this change. The
   positions are now disjoint by type — `BotPrimaryId` (smg/sniper/shotgun)
   vs `BotSidearmId` (pistol/revolver) in `src/core/state.ts:48/55`, drawn
   via `BOT_PRIMARY_IDS`/`BOT_SIDEARM_IDS` in `src/sim/botWeapons.ts:210/724`.)*
- One damage call per trigger pull, however many rays land, with the zone the
  best any ray struck. `damagePlayer` flashes the vignette and plays `sfxHurt`
  per CALL, so eight pellets routed separately would be eight grunts in a
  frame. Same rule `weapons.ts` uses to redden one hitmarker for a pattern.

**What this buys immediately:** a bot-dealt kill can finally say 'headshot'.
The wording existed since tranche 3 and no bot could ever reach it, because
the executor passed a hardcoded `'torso'` for every shot it realized.

#### The draw-order contract, and why it survived

`botBrains.test.ts` scripts the rng positionally across ~1500 lines. The
documented construction order is `[strafeDir, stagger]`, and the stagger is
now the controller's draw — so `arm()` is called from the BRAIN's constructor
after the strafe draw, never from the controller's own. A controller that drew
when it was built would have to be built first, silently shifting every
scripted sequence by one. The test stub honours the same contract, which is
why not one existing script needed editing and all 101 ladder tests pass
unmodified. That is also the evidence that awareness did not move.

The trigger tests stopped asserting cadence THROUGH the brain: cadence,
magazine and reload are pinned in `botWeapons.test.ts` against the real
catalog, and what remains at the brain layer is its actual residual
responsibility — asks `ready()`, calls `pull()`, ticks the weapon once per
frame in every mode so a bot that breaks contact arrives loaded. Lesson 28 at
the unit layer.

#### Tuning, and the gate that governs it

Each weapon's curve was chosen against a stated budget: expected damage per
second at its own preferred range stays near the pre-weapon bot's 6.1, so the
tranche changes bot CHARACTER rather than difficulty. Character comes from the
SHAPE — the sniper's near-flat falloff and 80 m engage range (equal to
`PERCEPTION_RANGE_M`, so anything it can see it can shoot), the shotgun's
curve reaching actual zero inside 11 m, the smg's three-round bursts.

`botWeapons.test.ts` computes that dps analytically from the real catalog and
asserts a deliberately WIDE band. It is not a pin on the tuning — a retune
inside the band must not cost a test edit — and it earned its place before
shipping by catching the shotgun at 57 dps point blank, four times any other
weapon. See lesson 30.

The smg's row is deliberately untuned: its bands, engage range and drift are
the shipped `DEFAULT_BRAIN_PARAMS` values, because smg is what every existing
bot smoke phase is re-pinned to and those phases must run against the bot they
were written for.

#### Selection, and presentation

`?tweap=`/`?ctweap=` on the committed query and two selects in the start menu,
parsed by the pure `sessionConfig.ts`. `asBotWeapon` mirrors `asMapName`
exactly — exhaustive Record, `hasOwn` rather than `in`, shared with the form so
a second literal comparison cannot drift from the parser. Both sides default to
`mixed`; a bot's weapon is drawn once per MATCH and survives respawn, so a
killfeed line cannot name a weapon the bot no longer carries.

Three presentation channels, because one cannot attribute a behaviour to a
weapon during play:

- **Silhouette.** Per-weapon barrels varying only in length and bulk, since
  those are the cues that survive at 20 m (lesson 25). Built from shared
  geometry rather than cloned from `weapons.ts`'s viewmodels — those are
  positioned in CAMERA space, exist one instance each, and live in a module
  that already imports `bots.ts`, so importing back would be the module cycle
  the architecture rules ban. The barrel stays untagged and out of every
  raycast allowlist for the original reason: `partForMesh` falls through to
  `'torso'` for a mesh it does not recognize.
- **Report.** A second per-weapon audio table, deliberately not shared with the
  player's `sfx*` numbers: those are a gun at your own shoulder, these are one
  across a map, and one set would have to be wrong for one of the two. Its
  `falloff` is PRESENTATION loudness — how far a shot carries to the PLAYER'S
  ear — and emphatically not `soundEvents.ts:GUNSHOT_RADIUS_M`, which is how
  far it carries to a BOT's, is one number for every firearm, and stays
  deferred. A sniper that SOUNDS louder is a cue; a sniper that is HEARD
  further is a balance change to 6b's investigation geometry.
- **Readout and killfeed.** `#botDebug` gains the weapon and `mag/magSize`
  with an `R` while reloading — a reload is a window in which a bot cannot
  shoot at all, and without the column that is indistinguishable from the AI
  breaking. The killfeed names the weapon and the zone.

#### Coverage

670 pure tests. `botWeapons.test.ts` pins the curve shapes, the per-ray and
per-zone draw counts, summed damage against `damageForPart` on the real def,
the head-then-torso-then-legs attribution, burst discipline, the reload policy
(dry forces, low-and-not-engaged tops up, low-and-engaged does not), the
`perRound` mid-reload shootability and its cancel, reserve depletion, and the
`mixed` selector's bounds. `sessionConfig.test.ts` pins the parser including
its refusal of `knife`.

Browser: every existing bot phase names `smg` explicitly, and the new
`[botWeapons]` phase runs one 60 m sight line twice — the sniper reaches it,
fires seven rounds and lands 60 damage; the shotgun sees the same player,
grades out of range, and ends with a full magazine and the player untouched.
Trigger pulls are read from the MAGAZINE rather than from damage, because a
pull is deterministic once in range while a hit is a die roll; damage is
asserted as set membership instead, which is exact — a landed smg round can
only be 26 / 19.5 / 52, no revolver value is in that set, and the run observed
all three smg zones.

`[patrol]`'s budget was widened, with a measurement rather than a shrug — see
lesson 31.

#### Deferred by 7a, deliberately

Per-weapon `soundRadius` (unchanged from 6b's reasoning), bot spread/crouch/ADS
state (the hit model is probabilistic by decision — there is no cone), and
**revisiting "bot bullets ignore intervening bodies."** That decision says to
revisit *"if bot accuracy profiles ever get sniper-grade"*, and this tranche
does exactly that. Held anyway: the sniper's reach comes from a flat falloff
curve, not from per-shot precision, and an entity raycast per bot shot spends a
budget tranche 5 measured carefully. Flagged for the playtest — if snipers
shooting allies through allies reads wrong, that is the evidence to reopen it.

## Recently implemented

### Tranche 7b — loadouts, the dry swap and the knife

**Implementation completed 2026-09-04**, in two commits on `feat/bot-loadouts`
(PR #92), each its own Plan Relay handoff verified independently before the next
was written.

7a gave a bot ONE weapon. 7b gives it the player's shape: a primary and a
secondary, reserve ammunition that runs out, a swap when the primary is dry, and
the knife as a real melee option.

#### Why it split at the type, not at the feature

The obvious split — "the pure `sim/` half, then the wiring" — cannot compile.
`BotWeaponId = Exclude<WeaponId, 'knife'>` is the tranche's central edit, and
widening a union is ATOMIC: the moment it widens, every `Record` over it fails
at once (`BOT_WEAPON_TUNING`, `BOT_WEAPON_MODELS`, the audio table), across both
halves of the dependency graph. A first commit holding only `sim/` would have
left `npm run typecheck` red.

So the boundary went somewhere else: **part A landed the whole blade** — a knife
bot is a SINGLE-weapon bot, which 7a's architecture already supported — and
**part B added the multi-position loadout on top**. Each half is independently
green on lint, typecheck, tests and build, which is what let the second relay run
take the first's commit as its baseline. See lesson 32.

#### Part A — a bot may hold the knife

**The tuning table is now a discriminated union.** A blade has no per-ray hit
chance, no falloff divisor and no zone weights, so `BotWeaponTuning` splits into
a shared `BotWeaponPosture` (how a bot moves and paces with it) plus
`BotRangedTuning` and `BotMeleeTuning`. The alternative — a knife row carrying
five ballistics fields nothing reads — is five lies per row, and the compiler
cannot tell you which of them matter. The five firearm rows gained `kind:
'ranged'` and changed in no other way; the smg row is bit-identical, because
every existing bot smoke phase is pinned to it.

**The hit is geometry, not a die.** `MeleeFireController` owns a blade's cadence
with no magazine, no reserve and no reload, and `bots.ts:swing()` resolves
through `sim/melee.ts:meleeSwing` against the focused target's own zone points.
Reach and arc are the catalog's, the nearest part wins, and `isBackstab` supplies
the ×3 — so a knife bot that gets behind a full-health player kills in one
strike, exactly as the player's knife does to a bot.

Three things about that path are deliberate:

- **The arc is measured against the bot's ACTUAL pose** — `this.aim`'s world +Z,
  the barrel axis the update loop just wrote from `intent.lookAt` — and not
  against the eye→target vector, which is always perfectly aligned and would
  make the arc test decorative. A bot that has not finished turning whiffs.
- **The candidates are the ONE focused target's zone points**, not the field.
  The brain already decided WHO; melee.ts decides whether and where. The player
  has no part meshes, so the three points are synthesized at fractions of the
  eye height mirroring the bot mesh's own 2.0 / 1.35 / 0.45 over a 1.9 m eye.
- **A swing emits no `soundEvents` gunshot.** A blade is silent to 6b's hearing,
  so a knife bot cannot summon investigators by attacking — the same shape as the
  player's melee path, which returns before `weapons.ts`'s emit.

**This is the first path by which a bot can melee the PLAYER.**
`weapons.ts:swingMelee` skips `team === 'CT'` and routes only through
`damageBot`, so it could never have served. *(Annotation, PR #120: with a
selectable side the skip is same-side — `src/weapons.ts:352` reads
`bot.team === session.playerTeam`, so a T-side player's knife hits CTs. The
conclusion stands: the player path routes only through `damageBot` and can
never hit the player, so the dedicated `bots.ts` swing path is still
required.)* The two paths share `sim/melee.ts`
rather than each other — `bots.ts` importing `weapons.ts` would be the module
cycle the architecture rules ban.

**Draw discipline is unchanged.** One draw in `arm()`, one per `pull()`, exactly
as a burst-of-one firearm — so the documented `[strafeDir, stagger]` construction
order holds and every scripted rng sequence in `botBrains.test.ts` passed
unedited. That file's only change is one added stub member.

**Selection and presentation.** `?tweap=knife` is a legal setting and the blade
is in the `mixed` pool — roughly one bot in six of a mixed wave carries one,
which inverts the `[botWeapons]` phase's old "mixed never draws a knife"
assertion into its opposite. *(Annotation, PR #98: reversed by the
primary/secondary split — `?tweap=knife` now falls back via
`IS_BOT_WEAPON` in `src/core/sessionConfig.ts:137` (mixed/smg/sniper/shotgun
only) and `mixed` draws primaries only via `BOT_PRIMARY_IDS` in
`src/sim/botWeapons.ts:210`. Stale bookmarks fall back rather than arming a
blade.)* `ENEMY_ATTACK_TONE` gains a `voice` discriminator
beside the five reports rather than routing a blade through `playGunshot`, and
the DEV readout's ammo cell shows the reserve and a dash for a weapon that holds
no rounds.

#### Part B — the loadout and the dry swap

**A `BotLoadout` is an ordered list of POSITIONS** — `[primary, secondary?,
knife]` — delegating the whole `FireController` surface to whichever is active.
*(Annotation, PR #98: the secondary is now mandatory — `[primary, secondary,
knife]` built unconditionally by `makeBotLoadout(primary: BotPrimaryId,
secondary: BotSidearmId, …)` in `src/sim/botWeapons.ts:750`. The
`BotWeaponId | null` secondary and the `null`/`'knife'`-dropping branches are
deleted; positions are disjoint by type so there is no dedupe.)*
Both controllers grew a `FirePosition` surface for it: `tuning`, `dry`, and the
draw-free `load()` / `waitFor()`.

**What "dry" means is the whole design.** A position is spent when its magazine
AND its reserve are empty and no reload is running — not when its magazine is.
A bot that swapped at every empty magazine would be holding the knife two
minutes into every match; a bot that swaps only when a weapon is genuinely
finished swaps perhaps twice a life. The ladder only ever descends, and the
blade at the bottom is never dry, which is what makes it terminate. That is the
answer to 7a's interim behaviour, quoted in the forecast above: a bot which
emptied everything used to keep maneuvering and never shoot again.

**`arm()` takes exactly ONE draw and applies it to every position.** This is
the constraint the commit was built around rather than a detail: `botBrains.
test.ts` scripts ~1500 lines of rng positionally against the documented
`[strafeDir, stagger]` construction order, so three positions each drawing
their own stagger would have shifted every one of those sequences by two.
Applying the single drawn stagger to ALL positions also means a swap during the
stagger cannot bypass it. `SWAP_DELAY` is 0.5 s and takes no draw either.
*(Annotation, feat/swap-delay: `SWAP_DELAY` moved to `sim/weaponSwap.ts` at
0.4 s, shared by bots and the player (closes issue #15) — the value above is
stale, the no-draw half still holds.)*

**The brain's params stop being a match-long constant.** `DefaultBrain` now
takes the BASE params and re-derives the per-weapon bands through
`FireController.params()` whenever the held weapon changes — so a bot that falls
back to its pistol fights at the pistol's range, and one that reaches the blade
closes to 1.8 m. The derivation lives on the controller rather than in the brain
because both edges between those two modules are type-only, and importing
`botBrainParams` as a value would have added a runtime dependency direction that
did not exist.

`Bot.weapon` loses its `readonly` and the aim group's silhouette is rebuilt on a
swap — removing the shared meshes without disposing their geometry or materials,
which every other bot carrying that weapon is still drawing from.

**Selection.** `tsec`/`ctsec` join the committed query and the start menu,
narrowed by `asBotSecondary` over an exhaustive Record exactly as `asBotWeapon`
is. Both sides default to `pistol`, so the dry swap exists in a default match
rather than only when someone goes looking for it. `'knife'` is deliberately
NOT a legal secondary: the blade is already every loadout's last position, so
accepting it would name a duplicate `makeBotLoadout` then drops, and a silently
 ignored setting is worse than one that falls back. A knife PRIMARY, by contrast,
 means a blade-only bot — the playtest lever for the melee path.
 *(Annotation, PR #98: reversed when the menu split into primary/secondary —
 a knife primary is no longer accepted (`primary: BotPrimaryId` in
 `src/sim/botWeapons.ts:750`, rejected by `IS_BOT_WEAPON`), the blade-only
 test was deleted from `src/sim/botWeapons.test.ts`, and the blade survives
 only as every loadout's fallback terminator.)*

#### Coverage

717 pure tests, +35 over 7a. `botWeapons.test.ts` pins the melee controller's
draw discipline and empty magazine, `makeFireController`'s dispatch, the
loadout's one-draw `arm()`, the stagger reaching every position, the swap firing
on a spent reserve and NOT on an empty magazine, `SWAP_DELAY` costing no draw,
every delegated member reporting the new position, the ladder terminating on the
 blade, and `makeBotLoadout`'s knife-primary / null-secondary / dropped-knife /
 doubled-weapon cases. `botBrains.test.ts` pins that the bands follow a swap and
 that nothing is re-derived while the weapon holds still — and, more importantly,
 that **every pre-existing scripted sequence passes unedited**, which is the
 evidence that awareness and cadence did not move. `sessionConfig.test.ts` pins
 the `tsec`/`ctsec` matrix including the knife's refusal.
 *(Annotation, PR #98: the `makeBotLoadout` knife-primary / null-secondary /
 dropped-knife block is deleted by the primary/secondary split — positions are
 disjoint by type so there is nothing to drop or dedupe. Melee stays covered by
 `sim/melee.test.ts` and the ladder tests.)*

Browser: the `[botWeapons]` phase's "mixed never draws a knife" assertion
inverted, the `[config]` phase carries `tsec`/`ctsec` end to end, and a new
`[botKnife]` phase runs the blade twice on the weapon phases' own one-bot lane —
pinned at 60 m it sees the player, grades out of range and touches nothing;
released, it closes to ~1.1 m and deals 55 and 165 while holding no rounds at
all. Damage is asserted as membership in the knife's zone set, which no firearm
can produce in full.
*(Annotation, PR #98: `[botKnife]` (`runBotKnifeCheck`) is deleted with the
knife primary — there is no blade-only bot to pin a lane to. The mixed wave
now draws primaries only; the dry swap end to end is proved by the revolver
leg draining a shotgun primary.)*

**The dry swap has no browser phase**, deliberately: draining 30 + 90 rounds
takes minutes of real time, so it is pinned at the unit layer where it can be
driven directly.

#### Deferred by 7b, deliberately

- A **draw/holster delay for the PLAYER** (issue #15) stays deferred. `SWAP_DELAY`
  is bot-side only and does not touch `switchWeapon`; the asymmetry is deliberate
  and recorded here so a later reader does not read it as the issue being fixed.
  *(Annotation, feat/swap-delay: fixed — `SWAP_DELAY` moved to
  `sim/weaponSwap.ts` at 0.4 s and now gates the player's
  firing/scoping/reloading plus recoil/spray decay; the asymmetry is gone.)*
- Everything 7a deferred is still deferred: per-weapon `soundRadius`, sound
  occlusion, bot spread/crouch/ADS state, and bot bullets ignoring intervening
  bodies.
- **Bots are not class-restricted** the way the player's picker is: any firearm
  may occupy either position. `setLoadout`'s primary/secondary validation is the
  player's rule, and extending it to bots would buy nothing but a second place to
  keep the catalog's classes in sync.
  *(Annotation, PR #98: reversed — the positions are now disjoint by type
  (`BotPrimaryId` smg/sniper/shotgun vs `BotSidearmId` pistol/revolver),
  enforced by `IS_BOT_WEAPON`/`IS_BOT_SECONDARY` and `makeBotLoadout`'s
  signature. This is exactly the class restriction the note says does not
  exist.)*

### Tranche 6b follow-up — nearest gunshot, and who may be interrupted

**Implementation completed 2026-09-04.** The planned refinement is implemented in
`src/sim/botBrains.ts` and pinned in `src/sim/botBrains.test.ts`; no tuning,
emitter, ring, occlusion or patrol change.

- **Nearest, not merely newest.** `pickHeardLead` now takes the listener feet
  and chooses the NEAREST gunshot by 3D squared distance (the same
  point-distance metric `withinEarshot` gates audibility on), with the newest
  sequence as the deterministic tiebreaker on an exact distance tie.
  Gunshot-over-footstep stands; with no gunshot the newest footstep still
  wins. Neither an event nor its position is mutated. The comment was
  rewritten to say why nearest-as-a-lead differs from nearest-as-an-identity:
  6a's ban on ranking by position is about identifying a target, not about
  picking which of several already-audible noises to walk to.
- **Who may be interrupted — the documented REVERSAL.** Hearing now applies
  only when the bot holds no investigation commitment: `memory` is null and
  `searching` is false. A visual-memory pursuit, a previously heard goal and
  any active scan/search therefore outrank a fresh noise (pending
  incoming-fire and current-visual precedence is unchanged), while hold and
  patrol remain interruptible. Ignored sounds are discarded, not queued —
  the executor cursor has already consumed them. The `adoptHeard` comment and
  the Priority 3 ladder note were rewritten so the code states the reversal
  rather than repeating the 6b claim that freshness wins over memory/search.
- **Coverage.** Selector pins for silence, gunshot-over-footstep,
  nearest-despite-recency/order, 3D (not planar) distance, exact-tie
  newest-wins, newest-footstep-without-gunshot and no-mutation; brain pins
  that hearing still interrupts hold/patrol, routes to the nearest of two
  gunshots, and does NOT replace a visual-memory pursuit, a previous heard
  pursuit or an active search. Visible and incoming-fire precedence and the
  no-shot invariant are retained unmodified.

Raised by 6b's playtest and deliberately kept out of PR #85: bots should
investigate the NEAREST gunshot, and only when they are not already fighting or
already travelling toward a target.

The original decision record follows. Both halves changed decisions 6b made on
purpose, so the work started from what those were rather than from a blank page.

- **Nearest, not merely newest.** Before this follow-up, `pickHeardLead` ignored position —
  gunshot over footstep, newest within a kind, nothing else — and its comment
  gives the reason: preferring the nearer of two audible gunshots would
  "quietly reintroduce ranking by position", which is what 6a removed. That
  argument is strong for IDENTIFYING a target and weak for choosing which of
  several noises to walk to, where nearest is simply the better lead. So the
  change is sound, but it must rewrite that comment to say why the two cases
  differ rather than silently contradict it. Note the shape cost: a distance
  test needs the listener's position, which the pure picker does not take.
- **Who may be interrupted — a REVERSAL, not an addition.** 6b originally put hearing
  ABOVE memory and search, following this tranche's ladder
  (`gunshot > footstep > remembered position`) and against the placeholder slot
  6a had left below memory; the contradiction and its resolution are annotated
  beside the ladder above. "Not already fighting or moving toward a target"
  reverses that: a committed pursuit would outrank a fresh noise. Visible
  combat already wins, so the live question is narrower than it sounds — it is
  only about memory pursuit and an active search. The playtest is the evidence
  that should settle it. What must not happen is settling it twice in opposite
  directions without noticing, which is why this is written down rather than
  left as a preference.

Still deferred, and not part of this follow-up unless a playtest asks for them:
per-weapon `soundRadius`, sound occlusion (walls neither silence nor attenuate
today, and adding that spends another geometry-probe budget per bot per event),
and bot footsteps — only the player emits them, so bots cannot hear each other
walk.

## Deferred

- **Behavioral variance** (aggressive/cautious profiles): now config-only —
  construct brains with different `BrainParams` per bot or team.
  *(Annotation, tranche 7a: half-delivered, and by a route this bullet did not
  anticipate. Per-bot `BrainParams` is now real and wired —
  `sim/botWeapons.ts:botBrainParams` builds one per weapon and `bots.ts`
  hands it to the brain — but the axis it varies is the WEAPON, not
  temperament. An aggressive/cautious profile on top of that is a second
  multiplier on the same fields and still deferred.)*
- **T-side score naming**: `scoreDeaths` doubles as the T score (it now
  counts all T-side kills, not just player deaths — review finding, fixed
  in-tranche); renaming the field pair to team-named counters is HUD/state
  churn beyond this tranche.
- **Segmenting flight link edges** (warehouse2 patrol stair livelock, follow-up
  1a): a `NavLink` flight enters the graph as one mouth-to-landing edge
  (`sim/navGrid.ts`, `src/world.ts:NavLink`), so a path can hold an 11 m hop
  the follower must walk in one leg. The livelock itself is fixed at the
  follower — abandonment now requires both the current and previous waypoint
  beyond `ROUTE_ABANDON` (`sim/routeFollow.ts`, wired through
  `bots.ts:waypointOnRoute`) — but the graph still emits hops no single step
  can close. Splitting flight edges so no hop exceeds the abandon distance
  would fix that at the source; deferred as graph/cost-model surgery (direct
  edge vs. intermediates, admissibility, elevator-edge carve-out) beyond the
  follower fix.

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
28. **Pin the invariant, not the mechanism that currently produces it.**
    `[flatRoute]` asserted not just arrival but ARRIVAL-BY-ROUTING, on the
    theory that strafe-luck could not satisfy it. Two PRs later the world
    contained a second legitimate solver — #45's committed strafe walks
    around a wall end without ever opening a route — and one main run even
    crossed on raw juke-luck, so the pin would have flaked against bots
    behaving CORRECTLY. The fix demoted the mechanism to recorded
    information and kept the invariant (arrival within budget) as the only
    assertion. When more than one policy is sanctioned to produce an
    outcome, asserting which one ran is testing yesterday's implementation;
    the units own mechanism isolation, where the rng is scripted and no
    second solver can sneak in.
29. **Every actor a fixture leaves alive is part of the fixture.** The
    `[hearing]` crouch step asserts that a bot never leaves hold/patrol while a
    crouching player walks past the other side of a wall. It failed with 53
    frames of `engage` — and the bot was right: the CT bot left over from the
    ally step two phases earlier is an ENEMY of the T under test, and seeing it
    is a perfectly good reason to engage. The observable the phase reads (did
    this bot start investigating?) cannot say WHICH entity caused it, so any
    second live entity silently satisfies the claim. It passed three isolated
    runs first, because the ally's patrol goal is drawn at random and it
    usually wandered somewhere harmless. Both fixes were fixture work: pin the
    ally while its own claim still needs it, retire it the moment that claim is
    made. The rule generalizes past bots — whenever more than one entity in a
    scenario can produce the signal being measured, the ones not under test
    must be pinned or removed, or the phase reports on whichever happened to
    move.
30. **A per-unit constant is not a per-EVENT consequence.**
    Giving bots real weapons meant giving each a chance a landed ray hits the
    head, and 12% looked obviously reasonable next to a 68% torso — it is
    roughly where real hits land, and it was the same number for every weapon.
    For five of the six it was fine. For the shotgun it put the weapon at 57
    damage per second at point blank, four times any other, because a trigger
    pull is EIGHT rays and each was rolling independently against a x4
    headshot multiplier. The compounding is invisible in the constant and
    obvious in the consequence.
    What caught it was a test that computes the consequence — expected damage
    per second, analytically, from the real catalog table — rather than
    asserting the constants. Its bounds are deliberately wide, because a gate
    that has to be edited every time someone retunes will be widened rather
    than thought about, and then it is not a gate. The fix was not to lower
    the number blindly but to say what a choke does: a pattern lands on a
    body, so pellets do not each get an aimed round's chance at the skull.
    Generalizes past ballistics — whenever a per-unit probability meets a
    multiplier and a count, pin the product, not the factors.
31. **A rate is not a regression until you have measured the population.**
    The `[patrol]` phase failed on the weapons branch, and the branch looked
    guilty: 8 of 14 runs took longer than one second to start patrolling
    against main's 2 of 14, which is a gap too large to shrug at (p ~ 0.02).
    It was not the branch. A patrol candidate is drawn uniformly from the
    WHOLE nav graph, and on arena 3663 of 16155 nodes sit at y >= 3 — the tops
    of the walls (968 at y=8, 576 at y=10, 400 at y=12). A ground bot cannot
    route to those, so a candidate is rejected roughly a quarter of the time
    and each rejection costs a fresh one-second pause.
    Measuring that directly settled it in one run per branch instead of
    another dozen: 300 sampled selections from the phase's exact spot failed
    27% of the time on main and 31% here, and the two grids are identical node
    for node. The run-level difference was load — the phase's loop also has a
    WALL-clock cap, and two dev servers were up.
    The lesson is not "flakes happen". It is that comparing OUTCOME rates
    across branches needs a sample nobody has the patience for, while
    measuring the underlying population is cheap and conclusive — and the
    cheap measurement was available the whole time. Lesson 24's family: an
    explanation that fits the evidence ("my change did this") is not the same
    as the mechanism, and only the mechanism tells you what to fix. Here it
    said: not the product, and not the phase's claim either — its budget,
    which was a bet on a selector's luck.
    It also surfaced a real finding nobody was looking for: about a quarter of
    every idle bot's patrol picks are rooftop nodes it silently discards. That
    is a candidate follow-up (bias the selector toward reachable nodes), not a
    7a fix.
    *(Annotation, PR #110: the follow-up landed. `NavGrid` now carries a
    `component: Int32Array` labelled once at build time
    (`sim/navGrid.ts:labelComponents`), and `pickPatrolNode` skips sampled
    nodes outside the bot's own component. The "roughly a quarter" above no
    longer holds — wall tops and enclosed pockets are never drawn, and the
    `[patrol]` respawn claim's ~2.5%-per-run flake is gone as a consequence
    rather than by moving a budget. The wording above stays as the record of
    what the measurement showed when the selector was whole-graph.)*

32. **A union widening is an atomic commit boundary; put the seam somewhere else.**
    7b's first plan was the obvious one: land the pure `sim/` half, wire it
    second. That split cannot compile. `BotWeaponId` is consumed by a full
    `Record` in three modules on both sides of the dependency graph, so the
    instant the alias widens, every one of them fails at once — there is no
    intermediate state in which only `sim/` knows about the blade. The
    workable boundary was a FEATURE that happened to be type-complete (the
    knife as a single-weapon bot, which 7a's architecture already supported),
    with the multi-position loadout as a second commit on top of it. Before
    splitting a tranche, ask which edit is atomic and route around it: a
    boundary that leaves `npm run typecheck` red between two commits is not a
    boundary, it is one commit someone stopped writing halfway.

33. **A constant written in three places is one constant and two lies — and the
    dangerous copy is the one that only writes.**
    Plan Relay's OpenCode version lived in `plan-relay.sh` (the gate that
    refuses a wrong client), `planRelaySummary.mjs` (the stamp every run record
    carries) and `planRelay.test.mjs` (the fake binary the suite runs against).
    Bumping the first two shipped a run whose `summary.json` claimed 1.18.25
    for an executor the gate had just verified as 1.18.28 — a record
    contradicting the run that produced it, which is the one thing that file
    exists not to do. Note which copy each layer caught: `npm test` failed
    loudly on the third, because a test that hardcodes the value it checks
    fails the moment the value moves. NOTHING caught the second, because a
    summary is written and never read back. When you duplicate a constant, the
    copies with tests are the safe ones; audit the copies that only emit.

34. **A watchdog kill is not a clean stop, and its damage is not in the file list.**
    Tranche 7b part B's relay run hit `OPENCODE_TIMEOUT` at 45 minutes. Ten of
    twelve planned files were complete, which made the run look nearly
    finished — but the kill landed mid-edit and left `bots.ts` syntactically
    invalid (a class brace above the method that should have been inside it),
    two comments truncated mid-sentence, one on an unclosed parenthesis, and
    BOTH test files untouched, so three pre-existing tests failed against a
    widened config and none of the tranche's new pins existed at all. A run
    that dies before its tests is strictly worse than one that dies before its
    implementation: the code reads as finished and nothing holds it in place.
    Two consequences. The timeout is the PLAN's problem — part A took 25
    minutes for twelve files, so an equally large part B had no headroom and
    should have been split again or launched with a raised ceiling. And an
    Implementation section should order the tests BEFORE the last of the
    wiring, because the tail is what a kill takes.
