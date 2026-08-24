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
