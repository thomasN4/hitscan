// maps/rangeSpec.ts — the shooting range's geometry as pure data.
//
// The single source of truth for two consumers: maps/range.ts:buildRange
// attaches it to the world, scripts/mapSvg.mjs draws it to docs/maps/range.png.
// Visual-only detail stays in the builder (canvas label textures, bullseye
// rings, silhouette part dims matching bots.ts) — positions and extents live
// here. See maps/mapSpec.ts for the contract.
import type { MapBox, MapSpec } from './mapSpec';

/** Firing lane width, length and centre z — the floor every wall, target and marker stands on. */
export const LANE_W = 30;
export const LANE_D = 130;
export const LANE_CZ = -30;

/** Wall height (lane walls, rear wall) and the taller backstop. */
const WALL_H = 4;
const BACKSTOP_H = 5;

/** Distances with painted floor markers, in metres down-lane from the firing line. */
const MARKER_D = [10, 20, 30, 40, 50, 60] as const;

/** Build the range's full geometry spec. Fresh arrays every call. */
export function rangeSpec(): MapSpec {
  // Lane walls run continuously from the backstop (z=-80.5) to the rear wall
  // (z=20) — no gaps, so no void is visible anywhere from inside the lane.
  // The rear wall owns the corners; the side walls stop at its inner face
  // (z=19.5) so the corner tops butt-join instead of overlapping (issue #74).
  const boxes: MapBox[] = [
    { x: -10, y: 0, z: -30.25, w: 1, h: WALL_H, d: 99.5, kind: 'wall2' }, // left wall
    { x: 10, y: 0, z: -30.25, w: 1, h: WALL_H, d: 99.5, kind: 'wall2' }, // right wall
    { x: 0, y: 0, z: 20, w: 21, h: WALL_H, d: 1, kind: 'wall2' }, // rear wall behind firing line
    { x: 0, y: 0, z: -80.5, w: 21, h: BACKSTOP_H, d: 1, kind: 'wall' }, // backstop
    // Firing-line marker strip across the floor. Unregistered on purpose: a
    // 2 cm paint strip is not cover and not a decal surface — the builder
    // scene-adds it without a collider, and the map draws it as a line.
    // y is the BASE (0); the centred strip mesh spans 0..0.02.
    { x: 0, y: 0, z: 5, w: 18, h: 0.02, d: 0.4, kind: 'marker' },
  ];

  // Distance markers down the center of each half-lane (60 M flanks the
  // centered far target like the closer pairs do).
  const labels = MARKER_D.flatMap((d) => [
    { x: -5, z: 5 - d, text: `${d} M` },
    { x: 5, z: 5 - d, text: `${d} M` },
  ]);

  return {
    name: 'range',
    ground: { minX: -LANE_W / 2, maxX: LANE_W / 2, minZ: LANE_CZ - LANE_D / 2, maxZ: LANE_CZ + LANE_D / 2 },
    boxes,
    flights: [],
    lifts: [],
    // Staggered distances and heights on both halves of the lane, angled
    // slightly toward the firing line. Near ones for spray control, far ones
    // for accuracy. Part dims match bots.ts exactly (torso 1.075, head 1.6,
    // legs 0.375) so headshot practice transfers — that match is owned by the
    // builder's addTarget, positions are owned here.
    targets: [
      { x: -4.5, z: -5, height: 0, yaw: 0 }, // 10 m
      { x: 4.5, z: -15, height: 1.0, yaw: 0 }, // 20 m, raised
      { x: -5.5, z: -25, height: 0, yaw: 0 }, // 30 m
      { x: 5.5, z: -35, height: 0.6, yaw: 0 }, // 40 m, slightly raised
      { x: 0, z: -55, height: 0, yaw: 0 }, // 60 m — full-lane accuracy test
    ],
    labels,
    notes: ['Target silhouettes are position markers; part dims match bots.ts (see builder).'],
  };
}
