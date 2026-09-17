// maps/warehouse1Spec.ts — the distribution warehouse's geometry as pure data.
//
// The single source of truth for two consumers: maps/warehouse1.ts attaches it
// to the world (kind -> material), scripts/mapSvg.mjs draws it to
// docs/maps/warehouse1.png. See maps/mapSpec.ts for the contract.
//
// Spatial grammar: an AISLE GRID. Six racking rows run north-south, cut by two
// cross-aisles per side, so almost every fight happens along a lane with a
// hard edge — and leaving a lane means committing to a crossing. The footprint
// is the arena's exactly (120 x 120) — a map design choice, not a constraint.
import type { MapBox, MapSpec } from './mapSpec';

/** Perimeter half-extent and wall thickness — the arena's numbers. */
export const WAREHOUSE1_HALF = 60;
export const WAREHOUSE1_WALL_T = 2;
/** Inner face of the perimeter shell on +x (aisle arithmetic builds to it). */
export const WAREHOUSE1_SHELL_INNER = WAREHOUSE1_HALF - WAREHOUSE1_WALL_T / 2; // 59

/** Riser/tread of every flight. STEP_H MUST stay <= collision.ts:STEP_HEIGHT. */
export const WAREHOUSE1_STEP = { h: 0.3, d: 0.75 } as const;
/** Mezzanine walk surface: 12 risers exactly, far above the ~1.45 m jump apex. */
export const WAREHOUSE1_DECK_Y = 3.6;
/** Slab thickness; 3.2 m of headroom underneath, over HEAD_HEIGHT. */
export const WAREHOUSE1_SLAB_T = 0.4;

/** Half-extents of the office's OUTER faces; walls are 1 m thick, centred 0.5 m inside. */
export const WAREHOUSE1_OFF = { x: 10, z: 8 } as const;
/** Ground-floor wall height; the slab sits on top of it. */
export const WAREHOUSE1_OFF_WALL_H = WAREHOUSE1_DECK_Y - WAREHOUSE1_SLAB_T; // 3.2

/** Centre x of each rack row (mirrored to -x), centre z of each segment, row thickness, segment length. */
export const WAREHOUSE1_RACK = {
  // number[] (not tuples) so indexed reads stay `number | undefined` and the
  // call sites prove their miss case with `!`, as the builders always have.
  x: [16, 26, 36] as number[],
  z: [-16, 0, 16] as number[],
  w: 3,
  d: 10,
  hLow: 4.0, // inner/mid rows: over a ground eye, under a mezzanine eye
  hTall: 6.0, // outer rows: over the mezzanine eye too — flanks hide from the deck
} as const;

/** Dock top; over STEP_HEIGHT, under the jump apex — hence the flights. */
export const WAREHOUSE1_DOCK_H = 1.2;
/** Over STEP_HEIGHT, under the jump apex: the player vaults, bots walk around. */
export const WAREHOUSE1_CONVEYOR_H = 0.9;
/** Inner (low-x) end of a flank conveyor — aisle arithmetic builds to it. */
export const WAREHOUSE1_CONVEYOR_INNER = 42;

/**
 * Pallet stacks, as [x, z] pairs. Cover for the open ground only — the dock
 * yards and the flank lanes. None in the aisles: an aisle is a route, and a
 * 3 m crate in a 7 m aisle leaves 2 m either side, under AISLE_MIN, which
 * would cost the lane its nav cells. The third crate in each trio is offset
 * so its top butt-joins rather than overlapping the pair (issue #74).
 */
const PALLET_SPOTS: [number, number][] = [
  // South dock yard
  [-14, 30], [-11, 33], [-11, 30],
  [14, 30], [17, 33], [17, 30],
  [0, 26], [3, 24],
  // North dock yard
  [-14, -30], [-11, -33], [-11, -30],
  [14, -30], [17, -33], [17, -30],
  [0, -26], [3, -24],
  // Flank lanes
  [46, 30], [-46, 30], [46, -30], [-46, -30],
  [46, 0], [-46, 0],
];

/** Second tier, reachable by jump only. A 6 m perch sees over the 4.0 m rows. */
const STACKED_PALLETS: [number, number][] = [
  [-11, 30], [17, -30],
];

/** Build the warehouse's full geometry spec. Fresh arrays every call. */
export function warehouse1Spec(): MapSpec {
  const W = WAREHOUSE1_HALF;
  const T = WAREHOUSE1_WALL_T;
  const DECK_Y = WAREHOUSE1_DECK_Y;
  const SLAB_T = WAREHOUSE1_SLAB_T;
  const OFF_X = WAREHOUSE1_OFF.x;
  const OFF_Z = WAREHOUSE1_OFF.z;
  const WALL_H = WAREHOUSE1_OFF_WALL_H;
  const { h: STEP_H, d: STEP_D } = WAREHOUSE1_STEP;
  const RACK = WAREHOUSE1_RACK;
  const boxes: MapBox[] = [
    // Perimeter shell.
    { x: 0, y: 0, z: W, w: 2 * W + T * 2, h: 8, d: T, kind: 'wall' },
    { x: 0, y: 0, z: -W, w: 2 * W + T * 2, h: 8, d: T, kind: 'wall' },
    { x: W, y: 0, z: 0, w: T, h: 8, d: 2 * (W - T / 2), kind: 'wall' },
    { x: -W, y: 0, z: 0, w: T, h: 8, d: 2 * (W - T / 2), kind: 'wall' },

    // A. Mezzanine office, x [-10,10], z [-8,8]. Ground floor with 4 m doorways
    // in ALL FOUR faces (N/S x [-2,2], E/W z [-2,2]) — routable from every
    // approach. Unlike elevation's two-story building there is NO internal
    // flight and no stairwell hole: the ground floor is a fight space and the
    // slab is a single box with no interior edges to wedge on.
    { x: -6, y: 0, z: OFF_Z - 0.5, w: 8, h: WALL_H, d: 1, kind: 'wall2' },
    { x: 6, y: 0, z: OFF_Z - 0.5, w: 8, h: WALL_H, d: 1, kind: 'wall2' },
    { x: -6, y: 0, z: -OFF_Z + 0.5, w: 8, h: WALL_H, d: 1, kind: 'wall2' },
    { x: 6, y: 0, z: -OFF_Z + 0.5, w: 8, h: WALL_H, d: 1, kind: 'wall2' },
    // East/west runs stop at the north/south inner faces (z=+-7) so corners
    // butt-join (issue #74).
    { x: -OFF_X + 0.5, y: 0, z: -4.5, w: 1, h: WALL_H, d: 5, kind: 'wall2' },
    { x: -OFF_X + 0.5, y: 0, z: 4.5, w: 1, h: WALL_H, d: 5, kind: 'wall2' },
    { x: OFF_X - 0.5, y: 0, z: -4.5, w: 1, h: WALL_H, d: 5, kind: 'wall2' },
    { x: OFF_X - 0.5, y: 0, z: 4.5, w: 1, h: WALL_H, d: 5, kind: 'wall2' },
    // One slab over the whole footprint, edges flush with the walls' outer
    // faces — both flights join it without elevation's half-tread notch.
    { x: 0, y: WALL_H, z: 0, w: 2 * OFF_X, h: SLAB_T, d: 2 * OFF_Z, kind: 'deck' },
    // Parapet. North/south gaps at x [-2,2] receive the flights; east railed;
    // WEST deliberately open over a 3.6 m drop — a one-way exit, and why the
    // deck is not a safe camp. East run stops at the north/south inner faces
    // (z=+-7.5) so corners butt-join (issue #74).
    { x: -6, y: DECK_Y, z: OFF_Z - 0.25, w: 8, h: 1.0, d: 0.5, kind: 'rail' },
    { x: 6, y: DECK_Y, z: OFF_Z - 0.25, w: 8, h: 1.0, d: 0.5, kind: 'rail' },
    { x: -6, y: DECK_Y, z: -OFF_Z + 0.25, w: 8, h: 1.0, d: 0.5, kind: 'rail' },
    { x: 6, y: DECK_Y, z: -OFF_Z + 0.25, w: 8, h: 1.0, d: 0.5, kind: 'rail' },
    { x: OFF_X - 0.25, y: DECK_Y, z: 0, w: 0.5, h: 1.0, d: 2 * (OFF_Z - 0.5), kind: 'rail' },

    // C. Loading docks, both ends: x [-30,30], z from the perimeter inner
    // face at 59 out to 45. A 1.2 m lip to fight off.
    { x: 0, y: 0, z: 52, w: 60, h: WAREHOUSE1_DOCK_H, d: 14, kind: 'deck' },
    { x: 0, y: 0, z: -52, w: 60, h: WAREHOUSE1_DOCK_H, d: 14, kind: 'deck' },

    // D. Conveyors — the player-only shortcut. Two per flank, spanning x = 42
    // out to the perimeter, so the only way past on foot is the 4.5 m gap at
    // the racking's outer edge or the pocket between them.
    { x: 50.5, y: 0, z: 12, w: 17, h: WAREHOUSE1_CONVEYOR_H, d: 1.5, kind: 'conveyor' },
    { x: 50.5, y: 0, z: -12, w: 17, h: WAREHOUSE1_CONVEYOR_H, d: 1.5, kind: 'conveyor' },
    { x: -50.5, y: 0, z: 12, w: 17, h: WAREHOUSE1_CONVEYOR_H, d: 1.5, kind: 'conveyor' },
    { x: -50.5, y: 0, z: -12, w: 17, h: WAREHOUSE1_CONVEYOR_H, d: 1.5, kind: 'conveyor' },
  ];

  // B. Racking: six rows along z, three segments each so the lanes stay
  // permeable. One box per segment rather than modelled posts and shelves.
  for (const bx of RACK.x) {
    const h = bx === 36 ? RACK.hTall : RACK.hLow;
    for (const bz of RACK.z) {
      boxes.push({ x: bx, y: 0, z: bz, w: RACK.w, h, d: RACK.d, kind: 'rack' });
      boxes.push({ x: -bx, y: 0, z: bz, w: RACK.w, h, d: RACK.d, kind: 'rack' });
    }
  }
  for (const [x, z] of PALLET_SPOTS) boxes.push({ x, y: 0, z, w: 3, h: 3, d: 3, kind: 'crate' });
  for (const [x, z] of STACKED_PALLETS) boxes.push({ x, y: 3, z, w: 3, h: 3, d: 3, kind: 'crate' });

  return {
    name: 'warehouse1',
    ground: { minX: -W, maxX: W, minZ: -W, maxZ: W },
    boxes,
    flights: [
      // Two mezzanine flights, mirrored across z = 0: 12 risers top out level
      // with the deck, 9 m of run puts the last tread flush on the slab edge
      // (17 - 9 = 8 south, -17 + 9 = -8 north). Neither team starts closer.
      { x: 0, y: 0, z: 17, width: 4, stepH: STEP_H, stepD: STEP_D, count: 12, dir: 'z-', open: false, kind: 'stair' },
      { x: 0, y: 0, z: -17, width: 4, stepH: STEP_H, stepD: STEP_D, count: 12, dir: 'z+', open: false, kind: 'stair' },
      // Dock flights: 4 risers = 1.2, 3 m of run flush on the dock face
      // (42 + 3 = 45). Two per dock so a bot down either flank finds one —
      // without them bots could never get up and half of each spawn band
      // would be dead ground to them.
      { x: 24, y: 0, z: 42, width: 6, stepH: STEP_H, stepD: STEP_D, count: 4, dir: 'z+', open: false, kind: 'stair' },
      { x: -24, y: 0, z: 42, width: 6, stepH: STEP_H, stepD: STEP_D, count: 4, dir: 'z+', open: false, kind: 'stair' },
      { x: 24, y: 0, z: -42, width: 6, stepH: STEP_H, stepD: STEP_D, count: 4, dir: 'z-', open: false, kind: 'stair' },
      { x: -24, y: 0, z: -42, width: 6, stepH: STEP_H, stepD: STEP_D, count: 4, dir: 'z-', open: false, kind: 'stair' },
    ],
    lifts: [],
    targets: [],
    labels: [],
    notes: [
      'Mezzanine west edge is open over a 3.6 m drop; east railed.',
      'Conveyors (0.9 m) are player-vaulted; bots walk the 4.5 m gap at the racking outer edge.',
    ],
  };
}
