// maps/arenaSpec.ts — the arena's geometry as pure data.
//
// The single source of truth for two consumers: maps/arena.ts:buildArena
// attaches it to the world (kind -> material), and scripts/mapSvg.mjs draws it
// to docs/maps/arena.png. Change the numbers here, never at a use site — a
// named constant that nothing imports, or placement arithmetic surviving in
// the builder beside this file, is two sources of truth plus a comment that
// lies (maps/mapSpec.ts).
//
// All boxes are in world.ts:addSingleBox... in world.ts:addSolidBox argument
// order: (x, y, z, w, h, d) with y the BASE the box stands on.
import type { MapBox, MapSpec } from './mapSpec';

/** Half-extent of the ground plane and the perimeter centre-line — the 120 x 120 footprint. */
export const ARENA_HALF = 60;
/** Perimeter wall thickness and height. */
export const ARENA_WALL_T = 2;
export const ARENA_WALL_H = 8;

/**
 * Cover crates, as [x, z] pairs. Clusters of three are arranged so a crouching
 * player can hide behind the pair while using the stacked crate as a firing
 * step. The third crate in each trio is OFFSET so its top butt-joins rather
 * than overlapping the pair — same cover silhouette, no shared top area
 * (issue #74).
 *
 * Typed as pairs so the destructured x/z are numbers, not number | undefined
 * under noUncheckedIndexedAccess.
 */
const CRATE_SPOTS: [number, number][] = [
  [-12, -20], [-8, -23], [-9, -20], [15, -18], [18, -15],
  [25, 20], [28, 17], [28, 20], [-20, 25], [-24, 22],
  [5, 38], [8, 35], [8, 38], [-32, -8], [30, -30],
];

/** Second-tier crates, reachable by jump only — stacked on their ground trio. */
const STACKED_CRATES: [number, number][] = [
  [-8, -20], [28.5, 19.5],
];

/** Raised platform with two access routes — the arena's elevation feature. */
const PLATFORM = { x: 26, z: 35, w: 10, h: 2.4, d: 10 } as const;
/** Jump-up ledge on the platform's west face: over walk-step height, under the ~1.45 m jump apex. */
const LEDGE = { x: 19.5, z: 35, w: 3, h: 1.2, d: 3 } as const;

/** Build the arena's full geometry spec. Fresh arrays every call. */
export function arenaSpec(): MapSpec {
  const W = ARENA_HALF;
  const T = ARENA_WALL_T;
  const H = ARENA_WALL_H;
  const boxes: MapBox[] = [
    // Perimeter walls — x-runs own the corners; z-runs stop at their inner
    // faces so the four corner tops butt-join instead of overlapping (issue #74).
    { x: 0, y: 0, z: W, w: 2 * W + T * 2, h: H, d: T, kind: 'wall2' },
    { x: 0, y: 0, z: -W, w: 2 * W + T * 2, h: H, d: T, kind: 'wall2' },
    { x: W, y: 0, z: 0, w: T, h: H, d: 2 * (W - T / 2), kind: 'wall2' },
    { x: -W, y: 0, z: 0, w: T, h: H, d: 2 * (W - T / 2), kind: 'wall2' },
    // Long mid wall with a gap (doorway) — splits the map into two halves;
    // bots spawn on the far side and path through the gap toward the player.
    { x: -25, y: 0, z: 0, w: 55, h: 6, d: 2, kind: 'wall' },
    { x: 35, y: 0, z: 0, w: 40, h: 6, d: 2, kind: 'wall' },
    // Buildings / corner blocks. Each carries the mesh name the ligne-claire
    // illustration pass selects on (core/ligneClaire.ts) — the builder assigns
    // it from MapBox.name, so the tag travels with the placement, not the loop.
    { x: -42, y: 0, z: -42, w: 24, h: 10, d: 24, kind: 'wall', name: 'arena-building' },
    { x: 42, y: 0, z: -42, w: 20, h: 12, d: 20, kind: 'wall2', name: 'arena-building' },
    { x: -42, y: 0, z: 42, w: 26, h: 9, d: 26, kind: 'wall2', name: 'arena-building' },
    { x: 44, y: 0, z: 44, w: 22, h: 11, d: 22, kind: 'wall', name: 'arena-building' },
    // Raised platform x[21,31] z[30,40] and its west-face jump-up ledge.
    { x: PLATFORM.x, y: 0, z: PLATFORM.z, w: PLATFORM.w, h: PLATFORM.h, d: PLATFORM.d, kind: 'wall2' },
    { x: LEDGE.x, y: 0, z: LEDGE.z, w: LEDGE.w, h: LEDGE.h, d: LEDGE.d, kind: 'crate' },
  ];
  for (const [x, z] of CRATE_SPOTS) boxes.push({ x, y: 0, z, w: 3, h: 3, d: 3, kind: 'crate' });
  for (const [x, z] of STACKED_CRATES) boxes.push({ x, y: 3, z, w: 3, h: 3, d: 3, kind: 'crate' });

  return {
    name: 'arena',
    ground: { minX: -W, maxX: W, minZ: -W, maxZ: W },
    boxes,
    // South-face stair flight: 8 x 0.3 = 2.4, flush with the platform top;
    // collision.ts climbs each riser automatically. Stairs x[24,28] z 24->30.
    flights: [
      { x: 26, y: 0, z: 24, width: 4, stepH: 0.3, stepD: 0.75, count: 8, dir: 'z+', open: false, kind: 'stair' },
    ],
    lifts: [],
    targets: [],
    labels: [],
    notes: [],
  };
}
