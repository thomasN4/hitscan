// maps/elevationSpec.ts — the elevation playtest map's geometry as pure data.
//
// The single source of truth for two consumers: maps/elevation.ts:buildElevation
// attaches it to the world (kind -> material), scripts/mapSvg.mjs draws it to
// docs/maps/elevation.png. See maps/mapSpec.ts for the contract.
//
// Unlike arena.ts (a place to fight) this is an INSTRUMENT: every feature exists
// to make one bot behavior observable (which staircase a bot finds, what it
// does under an overhead target, whether it walks off unrailed edges). The
// jump-only hops are the control: no bot can ever use them, so a bot ON the
// bridge proves it took a stair — which holds only while BrainIntent stays
// jumpless.
import type { MapBox, MapSpec } from './mapSpec';

/** Half-extent of the ground plane and the perimeter centre-line. */
export const ELEVATION_HALF = 60;

/**
 * Riser height of every flight. MUST stay <= collision.ts:STEP_HEIGHT (0.18)
 * or the treads become walls. Tread depth of every flight.
 */
export const ELEVATION_STEP = { h: 0.18, d: 0.3 } as const;
/**
 * Walk surface of every upper level. 3.6 = 20 risers exactly, and it clears
 * the ~1.45 m jump apex by a wide margin — resolveVertical does no head-bump
 * check while rising, so a walkable top within one jump of the floor below
 * could be jumped THROUGH and landed on.
 */
export const ELEVATION_DECK_Y = 3.6;
/** Slab thickness; DECK_Y - SLAB_T = 3.2 m of headroom underneath, well over collision.ts:HEAD_HEIGHT (1.75). */
export const ELEVATION_SLAB_T = 0.4;

/** Ground-floor wall height; the slab sits on top of it. */
const BLD_WALL_H = ELEVATION_DECK_Y - ELEVATION_SLAB_T; // 3.2
/** Parapet height (above STEP_HEIGHT so it contains walkers, below a deck eye so LOS works both ways) and thickness. */
const PARAPET = { h: 1.0, t: 0.5 } as const;

/**
 * Cover crates, as [x, z] pairs. The third crate in each trio is offset so its
 * top butt-joins rather than overlapping the pair (issue #74). Typed as pairs
 * so the destructured x/z are numbers under noUncheckedIndexedAccess.
 */
const CRATE_SPOTS: [number, number][] = [
  [-22, -14], [-25, -11], [-22, -11],
  [24, -18], [27, -21],
  [-30, 16], [-33, 19], [-30, 19],
  [40, 26], [43, 23],
  [-6, 30], [-3, 33],
  [46, -14], [-46, 4],
];

/** Second-tier crates, reachable by jump only — bots stay on the ground beside them. */
const STACKED_CRATES: [number, number][] = [
  [-22, -11], [-30, 19],
];

/** Build the elevation map's full geometry spec. Fresh arrays every call. */
export function elevationSpec(): MapSpec {
  const W = ELEVATION_HALF;
  const DECK_Y = ELEVATION_DECK_Y;
  const SLAB_T = ELEVATION_SLAB_T;
  const WALL_H = BLD_WALL_H;
  const { h: STEP_H, d: STEP_D } = ELEVATION_STEP;
  const boxes: MapBox[] = [
    // Perimeter walls, same footprint as the arena.
    { x: 0, y: 0, z: W, w: 2 * W + 4, h: 8, d: 2, kind: 'wall2' },
    { x: 0, y: 0, z: -W, w: 2 * W + 4, h: 8, d: 2, kind: 'wall2' },
    { x: W, y: 0, z: 0, w: 2, h: 8, d: 2 * (W - 1), kind: 'wall2' },
    { x: -W, y: 0, z: 0, w: 2, h: 8, d: 2 * (W - 1), kind: 'wall2' },

    // A. Two-story building, x [-14,14], z [-12,12]. Ground floor: doorways at
    // N/S x [-2,2] and W z [-2,2]; east face solid. East/west runs stop at the
    // north/south inner faces so the corner tops butt-join (issue #74).
    { x: -8, y: 0, z: -12, w: 12, h: WALL_H, d: 1, kind: 'wall' },
    { x: 8, y: 0, z: -12, w: 12, h: WALL_H, d: 1, kind: 'wall' },
    { x: -8, y: 0, z: 12, w: 12, h: WALL_H, d: 1, kind: 'wall' },
    { x: 8, y: 0, z: 12, w: 12, h: WALL_H, d: 1, kind: 'wall' },
    { x: -14, y: 0, z: -6.75, w: 1, h: WALL_H, d: 9.5, kind: 'wall' },
    { x: -14, y: 0, z: 6.75, w: 1, h: WALL_H, d: 9.5, kind: 'wall' },
    { x: 14, y: 0, z: 0, w: 1, h: WALL_H, d: 23, kind: 'wall' },
    // Second-floor slab in four pieces around the stairwell hole x[2,6] z[-9,0].
    { x: -6, y: WALL_H, z: 0, w: 16, h: SLAB_T, d: 24, kind: 'deck' },
    { x: 10, y: WALL_H, z: 0, w: 8, h: SLAB_T, d: 24, kind: 'deck' },
    { x: 4, y: WALL_H, z: 6, w: 4, h: SLAB_T, d: 12, kind: 'deck' },
    { x: 4, y: WALL_H, z: -10.5, w: 4, h: SLAB_T, d: 3, kind: 'deck' },
    // Parapets. South gap x[6,10] receives the external stair; north and west
    // gaps are OPEN EDGES over a 3.6 m drop — the fall test. East gap z[-2,2]
    // is the bridge mouth. East/west runs stop at the north/south inner faces
    // (z=+-11.75) so corners butt-join (issue #74).
    { x: -4, y: DECK_Y, z: 12, w: 20, h: PARAPET.h, d: PARAPET.t, kind: 'rail' },
    { x: 12, y: DECK_Y, z: 12, w: 4, h: PARAPET.h, d: PARAPET.t, kind: 'rail' },
    { x: -8, y: DECK_Y, z: -12, w: 12, h: PARAPET.h, d: PARAPET.t, kind: 'rail' },
    { x: 8, y: DECK_Y, z: -12, w: 12, h: PARAPET.h, d: PARAPET.t, kind: 'rail' },
    { x: -14, y: DECK_Y, z: -6.875, w: PARAPET.t, h: PARAPET.h, d: 9.75, kind: 'rail' },
    { x: -14, y: DECK_Y, z: 6.875, w: PARAPET.t, h: PARAPET.h, d: 9.75, kind: 'rail' },
    { x: 14, y: DECK_Y, z: -6.875, w: PARAPET.t, h: PARAPET.h, d: 9.75, kind: 'rail' },
    { x: 14, y: DECK_Y, z: 6.875, w: PARAPET.t, h: PARAPET.h, d: 9.75, kind: 'rail' },

    // B. Bridge (deliberately unrailed, 4 m wide) + tower deck flush with it.
    // Bridge underside at 3.2 m clears HEAD_HEIGHT, so the ground below stays
    // walkable and the bridge doubles as overhead cover.
    { x: 22, y: DECK_Y - SLAB_T, z: 0, w: 16, h: SLAB_T, d: 4, kind: 'deck' },
    { x: 35, y: 0, z: 0, w: 10, h: DECK_Y, d: 12, kind: 'wall2' },

    // C. West plateau, 2.88 m: a second, lower tier, so "bot shooting down at a
    // bot on another tier" is testable without either being at deck height.
    { x: -38, y: 0, z: -30, w: 22, h: 2.88, d: 22, kind: 'wall2' },

    // D. Jump-only route — the control case. 1.2 m hops: over STEP_HEIGHT so
    // nobody walks up them, under the ~1.45 m jump apex so the PLAYER can.
    { x: 18, y: 0, z: 8, w: 4, h: 1.2, d: 4, kind: 'crate' },
    { x: 18, y: 0, z: 4, w: 4, h: 2.4, d: 4, kind: 'crate' },
  ];
  for (const [x, z] of CRATE_SPOTS) boxes.push({ x, y: 0, z, w: 3, h: 3, d: 3, kind: 'crate' });
  for (const [x, z] of STACKED_CRATES) boxes.push({ x, y: 3, z, w: 3, h: 3, d: 3, kind: 'crate' });

  return {
    name: 'elevation',
    ground: { minX: -W, maxX: W, minZ: -W, maxZ: W },
    boxes,
    flights: [
      // Internal flight: 20 risers top out at exactly DECK_Y, flush with the
      // slab's south edge at z = 0.
      { x: 4, y: 0, z: -6, width: 4, stepH: STEP_H, stepD: STEP_D, count: 20, dir: 'z+', open: false, kind: 'wall2' },
      // External flight up the south face, ascending z- so the tall end lands
      // against the building at z = 12.5. Top tread and deck never touch — a
      // 0.5-deep notch a walker's circle (0.45/0.5) bridges while moving.
      { x: 8, y: 0, z: 18.5, width: 4, stepH: STEP_H, stepD: STEP_D, count: 20, dir: 'z-', open: false, kind: 'wall2' },
      // Tower stair, ascending z- so the tall end abuts the tower's south
      // face at z = 6.5.
      { x: 35, y: 0, z: 12.5, width: 4, stepH: STEP_H, stepD: STEP_D, count: 20, dir: 'z-', open: false, kind: 'wall2' },
      // Plateau flight: 16 risers = 2.88, flush with the plateau's east face at
      // x = -27. 6 m wide, unlike the 4 m flights.
      { x: -22.2, y: 0, z: -30, width: 6, stepH: STEP_H, stepD: STEP_D, count: 16, dir: 'x-', open: false, kind: 'wall' },
    ],
    lifts: [],
    targets: [],
    labels: [],
    notes: [
      'North and west deck edges are open over a 3.6 m drop; the south parapet gap x[6,10] receives the external stair.',
      'Stairwell hole x[2,6] z[-9,0]: the internal flight climbs through the slab.',
      'Jump crates (1.2 -> 2.4) reach the bridge; bots cannot jump, so a bot on the bridge proves it climbed a stair.',
    ],
  };
}
