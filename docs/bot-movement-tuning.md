# Bot wall and corner tuning

Measured on 2026-09-13, against PR #119's branch, then revalidated after
syncing `abe2d117ed38d0949e19043e67373161ed676fdd` (includes the T-side and
AK-47 merges). This records a bounded empirical tuning exercise, not a claim
of a global optimum or a replacement for playtesting.

## Selected values

| Parameter | Before | Selected | Reason |
|---|---:|---:|---|
| Clearance weight | 0.4 | 0.4 | Cheaper routes bought small time savings at the cost of wall contact on arena. |
| Lookahead | 3 m | 3 m | Longer shortcuts did not provide a robust improvement over the existing line. |
| Wall probe range | 1 m | 1 m | Shorter probes regressed two backing-away cases despite slightly faster travel. |
| Wall push | 0.5 | 0.5 | Weaker push traded away collision clearance. |
| Wall-sense cooldown | 0.5 s | 0.5 s | Shorter cooldown did not produce a compelling independent improvement. |
| Jam threshold | 0.25 s | **0.1 s** | React earlier to a sustained rejection; an isolated 0.05 s clamped frame still cannot arm recovery. |
| Sidestep commitment | 0.5 s | **2 s** | The short commitment repeatedly returned the bot to radial steering before it escaped the corner. |

The five new branch constants were swept, but the durable improvement came
from the existing recovery timers now also used during engagement. Routed
wall clearance was already effective in the controlled fixtures. Changing
its constants simply to produce a new number would have been a regression.
The two-second commitment is the upper search bound: recovery must return
control to normal steering within that interval. Collision still gates every
step, and facing, perception and firing continue during the commitment.

## Measurement and selection

`npm run tune:bots` runs the actual `Bot`, `DefaultBrain`, navigation,
collision and elevator code in a paused browser. The runner advances fixed
simulation steps; wall-clock rendering speed does not score the movement.
Seeded dice are installed only for a synchronous trial and restored in
`finally`. Respawn clears retained hearing before each new stimulus; other
actors are removed in isolated trials. Synthetic boxes use `world.ts`
registration and keep a grid node down the centre of the narrow passages.

Two optional per-bot callbacks observe intended/realized horizontal movement
immediately around the collision gate, and actual route builds. An optional
brain-parameter object and lookahead override are per instance. `buildNav`
accepts an optional clearance weight; normal startup still uses the default.
There are no menu controls, mutable tuning globals or alternate physics.

Collision loss is `sum(max(0, intended - realized)) / sum(intended)`.
This catches partial sliding that the existing `moveBlocked` flag misses:
that flag only reports movement below 25% of the requested step. The report
also retains contact time (below 95% realized), longest consecutive stall,
travel time, route builds, heading reversals, engagement time and sampled
trajectories. Aggregate loss summaries average the per-trial ratios; the
multi-bot records instead retain raw totals by movement mode.

The coarse search pairs clearance/lookahead, then probe reach/push, then
cooldown, then jam threshold/commitment. Two finer coordinate sweeps refine
the best candidate within documented bounds in the runner. Failed arrivals
dominate the exploratory score, followed by collision loss, travel time and
stall duration. Paired guards prevent faster arrivals from hiding increased
grinding. The exploratory winner is **not automatically applied**: a later
validation failure rejects it, and retained values can be preferable to a
fragile numerical optimum.

Controlled coverage includes parallel walls, both directions around a
corner, an inside corner, a 1.5 m doorway and corridor, lateral/back/inside
corner combat, and open combat. Real-map cases cover arena wall travel,
warehouse racks in both directions, a doorway, stairs, and both directions
on both cargo elevators. Initial seeds were 11/29/47 at 60 Hz and 3.9 m/s;
validation used new seeds, 20/30/120 Hz, speeds 3.2/3.9/4.6 m/s, and start
offsets -0.1/+0.1/+0.15 m. Final confirmation used seeds 997/1597/2591.

## Results

Final controlled confirmation: 306 trials (153 baseline/candidate pairs),
zero failed arrivals and zero paired regressions. The fresh-seed synthetic
results were:

| Metric | Before | Selected |
|---|---:|---:|
| Mean combat collision loss, four fixtures | 8.751% | 1.062% |
| Mean inside-corner combat collision loss | 33.288% | 2.531% |
| Longest continuous rejected-motion stall | 0.267 s | 0.108 s |
| Mean routed travel time | 4.752 s | 4.752 s |
| Routed collision loss | approximately zero | approximately zero |

That is about **88% less collision loss across the combat fixtures**, and
**92% less in the inside-corner fixture**. These are fixture-specific results,
not population-wide percentages. The remaining loss includes approaching
the contact and recovering; it is not a promise of zero wall touches.

The multi-bot confirmation runs six enemies and three allies for 60 simulated
seconds, cycling through every catalog primary (including AK-47), on arena
and warehouse2, with both player-side settings and three fresh seeds. HP is
raised to keep the measured population alive. Those encounters diverge as
steering changes who sees whom; their per-mode totals are diagnostic rather
than paired-trajectory acceptance tests.

Across the 12 population pairs (24 matches), weighted collision-loss totals
were:

| Map/mode | Before | Selected |
|---|---:|---:|
| Arena engagement | 0.569% | 0.424% |
| Arena routed/patrol travel | 0.118% | 0.205% |
| Warehouse2 engagement | 3.276% | 3.054% |
| Warehouse2 routed/patrol travel | 0.208% | 0.198% |

Some individual matches worsened, and arena travel loss rose by 0.087
percentage points in aggregate. This is why the controlled improvement must
not be presented as a universal match-wide reduction.

Acceptance checks reject any failed controlled arrival, more than 0.5
percentage points additional collision loss in an individual trial, more
than 0.05 s additional stall, more than 10% additional travel time plus one
frame, loss of engagement, or skipping a previously exercised transport.
The regular unit suite also replays the inside corner with real collision
at 20/60/120 Hz, comparing shipped defaults with the previous timers, so
restoring the old recovery behavior fails the regression test.

## Reproduce

Start a fresh server after changing source (Vite hot reload can otherwise
give dynamic imports a different module instance from the running game):

```sh
npm run dev -- --host 127.0.0.1 --port 5187 --strictPort
npm run tune:bots -- --check --seeds 997,1597,2591 \
  --config '{"stuckTime":0.25,"commitTime":0.5}' \
  --candidate '{"stuckTime":0.1,"commitTime":2}' \
  --output /tmp/bot-movement.json --plot /tmp/bot-movement.png
```

`CS_SMOKE_BASE` overrides the server URL; `CS_BROWSER` overrides the Brave
executable. `--quick` omits the population matches but retains controlled
validation. `--sweep --check` explores parameters and reports any validation
regressions with a nonzero exit. JSON retains configurations and full trial
metrics/trajectories; `--plot` renders baseline/candidate paths for inspection.
Outputs belong outside the tracked tree. The final checks also include
lint, typecheck, all unit tests, build, and the full smoke test against the
production preview.

Verification on the synced tree: lint and typecheck passed; **1,066 tests in
44 files passed**; production build passed (the existing bundle-size warning
remains); the full smoke test against preview port 5188 passed with no
console/page errors. Final paired acceptance reported no regressions, and
the trajectory plot was inspected. The bounded sweep command was also rerun
on the synced tree; its slightly faster alternative introduced additional
arena wall contact, so the selected values above preserve the clearer route.
