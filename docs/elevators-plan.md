# Cycling cargo elevators

## Decisions

Warehouse 2 replaces its two launch pads with physical 4 × 4 m orange decks at
(8, −10) and (−8, 10), matching the greybox's footprints. The agreed two-way
behavior supersedes the mockup's one-way annotation. Decks move from a 0.25 m
walking surface to the 5.1 m catwalk at 1.5 m/s, dwelling 2 seconds at each end.
They start together at the lower stop. No doors, switches, damage, or new audio.

## Interfaces and implementation

`world.ts` owns elevator registration and runtime geometry. `addElevator(spec)`
accepts an ID, dimensions, stop heights, speed, dwell, stable landing positions,
and material. `registerElevator` provides the scene-free registration seam.
`updateElevators` advances the cycle inside the gameplay gate before actor
movement; each actor consumes `elevatorCarry` once. Motion and swept passenger
checks live in `sim/elevator.ts`. An obstruction freezes both position and cycle
time until clear. Static landing support wins at shared deck edges. Jumping or
walking off releases support, without launch velocity.

Moving decks remain in collision and shooting registries, but are excluded from
navigation sampling. Explicit transport edges carry elevator IDs and a waiting
cost. The position-only navigation API is preserved; bots use `transportRoute`
with tagged legs. `sim/elevatorTravel.ts` drives approach/wait/board/ride/exit
from snapshots. Pre-boarding interruptions cancel; committed rides finish before
replanning. Death and respawn clear transport state. Weapon decals attach to the
hit object and FIFO removal removes them from their actual parent.

The existing launch-pad builder and simulation remain available to other maps.
The mockup is retained as the original design artifact; obsolete launch-arc
rationale in Warehouse 2 has been replaced by elevator clearance checks.

## Verification

Unit coverage checks cycle boundaries, passenger attachment/detachment, swept
obstructions and recovery, collider/raycast synchronization, registration reset,
navigation invariance across platform positions, and both traversal directions.
The browser smoke suite exercises both physical elevators with player input and
real bot route execution, plus pause/resume, jump release, moving decals,
interruption disposition, and respawn cleanup. It polls behavior with bounded
wall-clock deadlines. Visual inspection checks the orange deck's flush join and
rail opening at the catwalk dock.

**PR #115 timeout update:** player checks retain a 45 s wall limit; bot transport
and interruption checks allow 30 game seconds with a 120 s wall failsafe. All
elevator waits share a 270 s total wall deadline, leaving 30 s before Puppeteer's 300 s
protocol timeout for cleanup and diagnostic delivery. Late legs receive only
the remaining total budget. A timer bounds missing animation frames while
browser JavaScript remains responsive; a blocked event loop still requires the
protocol timeout. Timeout failures report the active check, actor/elevator
snapshot, elapsed clocks and exhausted budget; the four complete bot legs also
report observed transport phases.
