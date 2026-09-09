# Warehouse2 bot playtest — team matrix × sound matrix + the stair stall

Date: 2026-09-09. Build: `main` at `ce5a919` (PR #98). Weapons pinned to
`smg` / `pistol` throughout so every cell runs the bot the existing smoke
phases were written for. No `src/` changes in this report; nothing here is a
fix, but section 4 names the mechanism precisely enough to file one.

## Method

Headless Brave (puppeteer-core, SwiftShader) against a worktree dev server,
driving the public `window.__cs` hook only — mode, `mesh.position`,
`targetEye`, `targetInRange`/`targetLOS`, `mag`, `navPath`/`navLeg`,
`moveBlocked`, hp, killfeed, `matchOver`. No private brain state, no claim
about which solver produced an allowed outcome (ai-plan.md lessons 28/29:
pin the invariant, and every live bystander is part of the fixture — so each
controlled probe retires or pins every bot except the one under test, and
each phase carries non-vacuity guards: rounds fired > 0, player displacement
proved, listener kept inside the relevant radius, `targetLOS === true`
recorded as a fixture leak rather than a bot failure).

Occluded ground-lane fixture on x = 5 (verified against the real collider
list, feet-aware — see Fixture notes): bot lane z ≈ −5, player lane z = 0
(5 m, walk/crouch) or z = 11 (16 m, gunshot/run). The two central racks
(z −4…−2 and 2…4, 3 m tall) block ground-eye LOS on every leg, so nothing a
listener does about the player can have come from sight. Distances are
3D earshot distances against the spec radii: gunshot 80 m, run 24 m, walk
12 m, crouch silent.

## 1. Team matrix

`?map=warehouse2&time=300` plus the pinned weapons in all cells.

| Cell | URL tbots/ctbots | Spawn census | 30 s soak travel (m) | Soak modes | matchOver |
|---|---|---|---|---|---|
| 1T-0CT | 1 / 0 | T on ring (feet 5.1) | 47 | patrol/hold | no |
| 6T-0CT | 6 / 0 | all T feet 5.1 | 13.5–54.2 | patrol/hold, 8× engage frames | no |
| 1T-3CT | 1 / 3 | T 5.1, CTs 0 | 23.6–40.4 | hold/patrol/engage/route/search | no |
| 6T-3CT | 6 / 3 | T 5.1, CTs 0 | 10.9–48.3 | engage 107, route 105, search 9 | no |
| 8T-4CT (stress) | 8 / 4 | T 5.1, CTs 0 | 7.1–53 | engage 147, route 114, search 35 | no |

Spawns are exactly per `core/state.ts:BOT_SPAWNS` (Ts mustered on the −z
catwalk band five metres up, CTs in the +z yard). Combat cells fight
immediately and lethally both ways — `T-5 [SMG] ☠ headshot-killed CT-2`
answered by `CT-2 [SMG] ☠ headshot-killed T-2` in the same feed — and the
90 s 6T-3CT soak ran score to 8–10 with zero stall windows and `matchOver`
false throughout. Bots climb: a CT ended one soak on the yard-flight
landing (32.1, 5.1, 4.2) via the yard flight, and mid-soak samples caught
three Ts at feet 1.8/2.4/2.7 on the void flights, moving.

## 2. Sound matrix (identical in all five cells)

| Stance | Setup | Result |
|---|---|---|
| Gunshot, 16 m, through two racks | 5 SMG rounds into the floor | intent on the shot origin in 0.03–0.04 s, `route`, non-shootable throughout, player HP untouched |
| Run, 16→22 m, occluded | 2.5 s game-time KeyW + `running` | investigated (`route`, endpoint tracking the runner), never shootable |
| Walk, 16→28 m (beyond 12 m) | same lane at a walk | silent: hold/patrol only, no leak |
| Walk, 5 m, occluded | central lane | heard: `route`, endpoint on the walker |
| Crouch, 5→9 m, pinned listener | same lane, `crouching`, movement proved (7.2 m) | silent: hold/patrol only, no leak |
| CT + allied (player) gunshot, 6 m | pinned CT, live fire | ignored: hold/patrol, intent never near the shot |

The 6b contract holds end to end on this map: nearest audible gunshot
investigated at once, run/walk radii respected with the 12 m boundary
behaving (heard at 5 m, silent at 16+ m), crouch silent with displacement
proof, allied fire ignored by CTs, and nothing heard ever graded shootable
or drew retaliation.

Route-following itself works: tracing the 16 m gunshot case at 4 Hz, the
bot received a 39-waypoint path, walked it east around the rack end at
≈3.7 m/s with `moveBlocked` false, and at ≈6.8 s acquired the still-parked
player by genuine LOS past the rack end — `engage`, `targetLOS: true`,
`targetInRange: true` — the full hear → route → see → engage pipeline on
one observation chain. (The matrix's `closed: 0` column is a metric
artefact, not a bot failure: the detour initially walks *away* from the
goal, so minimum planar distance over a 2.5 s window never dips. Lesson 28
again — the metric measured the wrong invariant.)

## 3. Secondary observations (not bugs, recorded)

- **Stacked pairs.** 6T-0CT ended with T-1/T-2 at identical landing coords
  and T-3/T-4 at identical stair coords (0.1 m). Bodies have no mutual
  collision, so patrol legs converging on the same waypoint area pile up
  exactly. Cosmetic; the stair pair below is the same signature over a
  real trap (section 4), the landing pair is benign.
- **Idle looks idle.** In no-stimulus soaks every live bot is hold/patrol
  with real travel (47 m in 30 s for the lone T). That is correct
  behaviour, and section 4 is careful to separate it from the freeze,
  which is zero displacement *with* an active patrol path.

## 4. Finding: patrol stair livelock (the "bots stop doing anything")

**Reproduced twice, independently.** A 90 s natural soak (1T-0CT, player
parked in the yard) trapped its only bot at (−20.6, 4.8, −7.85) — high on
the west void flight — from t ≈ 12 s to the end of the run: 77 s,
`patrol`, `moveBlocked` false throughout, position jitter ±0.15 m, y
flickering 4.8 ↔ 5.1 (one riser), path length constant at 27, look target
alternating between two points 1.8 m apart. A second run teleported a
fresh bot straight to the flight and trapped it within 2 s. The 60 s
rerun's stall detector (every live bot < 0.3 m displacement over rolling
10 s windows) flags one merged stall, 14.4 → 59.3 s — 45 game-seconds
frozen. The 6T-0CT T-3/T-4 stair pair is the same signature with two
victims.

**Mechanism, from 4 Hz leg traces.** At the trap the leg flickers 1 ↔ 2
every few frames over a constant 39-node path:

- `path[1]` = (−21.67, 5.1, −7.68), the flight-lip node ≈1.0 m from the bot;
- `path[2]` = (−9.68, 0.3, −6.68), the flight-foot node ≈11 m away —
  a full-flight NavLink edge in a single hop.

`bots.ts:waypointOnRoute` consumes `path[1]` the moment its planar
distance dips under `WAYPOINT_REACHED` (1 m), promoting `leg` to 2 — and
on the next frame the abandon check (`bots.ts:883`) sees the current leg
waypoint 11 m away, past `ROUTE_ABANDON` (6 m), concludes the bot "fell
off", and drops the path. The following frame recomputes A* from the
unchanged position, deterministically regrows the identical 39-node path,
re-consumes to leg 2, and abandons it again. Consume → abandon →
recompute, at ~1–2 frame period, forever: the bot up-steps toward the lip
node, down-steps toward the foot node, net displacement zero,
`moveBlocked` false (every step is accepted), mode `patrol` (a valid
pursuit — nothing interrupts it), burning one budgeted A* per
`ROUTE_INTERVAL` (1 s) each. The y-flicker and the alternating look
targets in the 90 s trace are this two-step, sampled slowly.

**Why it reads as "all the bots stop".** Each trapped bot is individually
livelocked, not budget-starved, so trapping scales with headcount: an idle
field patrols, patrol legs cross the flights (the ring *is* the T spawn,
and patrol goals are map-wide), and every bot that steps onto a flight
behind a >6 m link edge can stick there in `patrol` with a healthy-looking
path. Combat masks it — vision, memory, sound and damage all interrupt
patrol — which is why the 30 s and 90 s combat soaks show zero stalls
while the idle cells collect frozen bots. `matchOver` was false in every
run: this is not the round ending, it is bots standing down one riser
from where they meant to go.

**Suggested fix directions (not attempted here).** Either make the
follower able to walk what the graph emits — split flight link edges so
no single edge exceeds `ROUTE_ABANDON`, or exempt link-edge traversal
from the abandon check — or make consumption and abandon agree: only
abandon against a waypoint the bot has already *departed toward* rather
than one it just inherited by consuming its predecessor. The second
reading is cheaper and more local: `leg` advanced past a node the bot is
still standing on, and the abandon check treats the new leg as ground
truth about where the bot should be.

## Appendix — repro

- Matrix: `?map=warehouse2&tbots={1,6,8}&ctbots={0,3,4}&time=300&
  tweap=smg&tsec=pistol&ctweap=smg&ctsec=pistol`, headless, set
  `started`/`locked`, `player.hp = 100000`.
- Sound fixture: listener ground (5, −5.1); emitter (5, 0) for 5 m
  walk/crouch legs, (5, 11) for 16 m gunshot/run legs; fire into the
  floor (`pitch = −1.4`); walk/run via KeyW + `running` flag, yaw −π/2
  (+x, open lanes both ways); pin the listener only for silence legs.
- Trap: 1T-0CT, park the player at (0, 1.7, 27), sample
  mode/pos/`navPath.length`/`navLeg`/`moveBlocked` at ≥2 Hz for 60–90 s
  game-time; or teleport a fresh bot to (−20.6, 4.8, −7.85) and watch
  `navLeg` flicker 1 ↔ 2 over a constant-length path.

### Fixture notes for future warehouse2 smoke phases

`blocked()` spot checks must be feet-aware on this map: the roof slabs
and purlins (y ≥ 9.45) span the entire floor in x/z projection, so the
arena-style x/z-only check rejects every indoor spot. Gate on
`c.min.y < feet + 1.8 && c.max.y > feet + 0.3`. The west void flight's
treads are real low colliders (z −9.8…−6.2, x −22…−9.25); the only
rack/flight-free ground lane near the centre is z ≈ −5.5…−4.7. Yard
spots (−10, 25), (−10, 31) and (0, 27) are clear of shell, containers
and fence.

---
Co-authored-by: Muse Spark <muse-spark@meta>
