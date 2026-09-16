// maps/warehouse2Spec.ts — the vertical-stack warehouse's geometry as pure data.
//
// The single source of truth for two consumers: maps/warehouse2.ts attaches it
// to the world (kind -> material), scripts/mapSvg.mjs draws it to
// docs/maps/warehouse2.svg. See maps/mapSpec.ts for the contract.
//
// Spatial grammar: VERTICAL. An 8 m catwalk ring runs the full perimeter at
// 5.1 m around a 44 x 24 void cut to the floor, so the ring looks down on the
// floor and the floor looks up at the ring. Spawns are ASYMMETRIC — CTs muster
// in the yard, Ts start already on the ring (core/state.ts:BOT_SPAWNS).
import { segmentRun } from './mapSpec';
import type { LiftSpec, MapBox, MapBoxKind, MapSpec } from './mapSpec';

/** Riser height of every flight. MUST stay <= collision.ts:STEP_HEIGHT or treads become walls. */
export const STEP_H = 0.3;
/** Tread depth of every flight. */
export const STEP_D = 0.75;
/** Risers per flight — every flight on this map is the same climb. */
export const RISERS = 17;
/**
 * Catwalk walking surface. The greybox says 5.0; this is 5.1, because 5.0 /
 * STEP_HEIGHT is not a whole number and warehouse1's idiom (and elevation's)
 * is a deck height that is an exact multiple of the riser. 17 x 0.3 buys that
 * for 10 cm.
 */
export const DECK_Y = RISERS * STEP_H;
/** Decking thickness. DECK_Y - SLAB_T = 4.7 m of headroom below, far over HEAD_HEIGHT. */
export const SLAB_T = 0.4;
/** Tread plate thickness on the open flights — thin, so you can walk under them. */
export const TREAD_T = 0.16;

/** Shell half-extents (to the wall centre-line), wall thickness, wall height. */
export const SHELL_X = 30;
export const SHELL_Z = 20;
export const WALL_T = 1;
export const WALL_H = 10;
/**
 * The wall's two FACES: abutting geometry builds face-to-face (decking stops
 * at INNER, the yard landing starts at OUTER) so no two up-facing surfaces
 * share a plane and flicker. See INNER_X/OUTER_X in the builder's history.
 */
export const INNER_X = SHELL_X - WALL_T / 2;
export const INNER_Z = SHELL_Z - WALL_T / 2;
export const OUTER_X = SHELL_X + WALL_T / 2;
export const OUTER_Z = SHELL_Z + WALL_T / 2;
/** Depth of the catwalk ring in from the wall's CENTRE-LINE; the void lip. */
export const RING = 8;
/** The void: the ring's inner edge, and so the hole's half-extents. */
export const VOID_X = SHELL_X - RING;
export const VOID_Z = SHELL_Z - RING;
/** Fence half-extents — the outer bound of the level. */
export const YARD_X = 44;
export const YARD_Z = 34;

/** Rail height and thickness. Top at 6.2, under a deck eye at 5.1 + 1.9 = 7.0. */
export const RAIL_H = 1.1;
export const RAIL_T = 0.16;
/** Width of both main flights, and so of the rail gaps that receive them. */
export const FLIGHT_W = 3.6;
/** Clearance per side between the moving deck and the catwalk rail. */
export const LIFT_GAP_MARGIN = 0.25;
export const PAD_H = 0.25;
export const PAD_W = 4;
export const LIFT_SPEED = 1.5;
export const LIFT_DWELL = 2;

/** Ground doorways: one per side, 5 m wide. */
export const DOOR_N: [number, number][] = [[-17, -12]];
export const DOOR_S: [number, number][] = [[12, 17]];
export const DOOR_W: [number, number][] = [[6, 11]];
export const DOOR_E: [number, number][] = [[-11, -6]];
/** Catwalk-level ports. The +x pair at z [-3,3] is 6 m: it receives the yard flight. */
export const PORT_N: [number, number][] = [[-26, -22], [-6, -2], [14, 18]];
export const PORT_S: [number, number][] = [[-18, -14], [2, 6], [22, 26]];
export const PORT_W: [number, number][] = [[-16, -12], [-2, 2]];
export const PORT_E: [number, number][] = [[-3, 3], [12, 16]];

/**
 * Decking depth: the wall's inner FACE to the void lip, not RING. RING is
 * measured in from the wall's centre-line, so a band RING deep buries its
 * outer half-thickness of wall — and the lower wall register tops out at
 * DECK_Y too, so the buried strip is two coplanar up-facing surfaces (the
 * flicker this file's history is about). The decking gives up that 0.5 m and
 * stays walking surface at exactly DECK_Y via the wall's own collider.
 */
export const BAND = RING - WALL_T / 2;

/** Centre z of the two void flights. The east one mirrors to -this. */
export const FLIGHT_Z = 8;
/** Mouth x of the void flights. RUN = 12.75, and 9.25 + 12.75 = VOID_X: the far edge lands exactly on the lip. */
export const FLIGHT_MOUTH_X = VOID_X - RISERS * STEP_D;
/** The yard flight's centre-line, clear of the shell wall at x = 30.5. */
export const YARD_FLIGHT_X = 32.5;

/** Cargo lift pads: id, centre, and which way the lower approach lies. */
const LIFT_A = { id: 'cargo-a', x: 8, z: -VOID_Z + PAD_W / 2, sign: -1 as const };
const LIFT_B = { id: 'cargo-b', x: -8, z: VOID_Z - PAD_W / 2, sign: 1 as const };

/** Rack height. Over a ground eye (1.7), under a deck eye (7.0) — nothing hides from the ring. */
export const RACK_H = 3;
/** Centre z of the two central racks; RACK_D deep, leaving a 4 m aisle between. */
export const RACK_Z = 3;
export const RACK_D = 2;
export const RACK_W = 34;
/** Corner pallet stacks, flush to the wall's inner face (centred they would pinch the corridor under AISLE_MIN). */
export const CORNER_X = 28;
export const CORNER_Z = 16;
export const CORNER_SIZE = 3;
export const CORNER_H = 2.4;

/** Container dimensions: length, height, width. Stacked pairs double the height. */
export const CONT_L = 12;
export const CONT_H = 2.6;
export const CONT_W = 2.9;
/** Fence height, panel thickness, and post spacing. */
export const FENCE_H = 4;
export const FENCE_T = 0.12;
export const POST_SPACING = 8;

/** Roof slab underside, and its thickness. 10 m of headroom over the floor. */
export const ROOF_Y = WALL_H;
export const ROOF_T = 0.4;
/** Half-depth of each glazed strip, and its centre z. */
export const SKY_HALF = 1.5;
export const SKY_Z = 6;
/** Purlins under the roof, every 8 m. */
export const BEAM_Z = [-16, -8, 0, 8, 16];

/** [x, z, alongX, stacked] yard containers. */
const CONTAINERS: [number, number, boolean, boolean][] = [
  [-20, 27, true, false], [20, 26, true, true], [34, 30, true, false],
  [-16, -27, true, false], [14, -26, true, false], [32, -29, true, true],
  [-37, -9, false, false], [-37, 9, false, true],
  [38.5, 12, false, false], [38.5, -8, false, false],
];

/** One wall face as solid segments between `gaps` (pure half of wallRun). */
function wallBoxes(
  axis: 'x' | 'z',
  fixed: number,
  from: number,
  to: number,
  y0: number,
  y1: number,
  gaps: readonly (readonly [number, number])[],
  kind: MapBoxKind,
): MapBox[] {
  return segmentRun(from, to, gaps).map(([a, b]) => {
    const mid = (a + b) / 2;
    const len = b - a;
    const h = y1 - y0;
    return axis === 'x'
      ? { x: mid, y: y0, z: fixed, w: len, h, d: WALL_T, kind }
      : { x: fixed, y: y0, z: mid, w: WALL_T, h, d: len, kind };
  });
}

/** One void edge's rail as segments between `gaps` (pure half of railRun). */
function railBoxes(
  axis: 'x' | 'z',
  fixed: number,
  from: number,
  to: number,
  gaps: readonly (readonly [number, number])[],
): MapBox[] {
  return segmentRun(from, to, gaps).map(([a, b]) => {
    const mid = (a + b) / 2;
    const len = b - a;
    return axis === 'x'
      ? { x: mid, y: DECK_Y, z: fixed, w: len, h: RAIL_H, d: RAIL_T, kind: 'rail' }
      : { x: fixed, y: DECK_Y, z: mid, w: RAIL_T, h: RAIL_H, d: len, kind: 'rail' };
  });
}

/** One run of fence: a thin panel plus steel posts every POST_SPACING (pure half of fenceSide). */
function fenceBoxes(
  axis: 'x' | 'z',
  fixed: number,
  from: number,
  to: number,
  ownsCorners: boolean,
): MapBox[] {
  const out: MapBox[] = [];
  // `ownsCorners` decides which of the two meeting runs takes the corner: the
  // owner's panel grows half a thickness past it and stands the corner posts,
  // the other stops half a thickness short and skips them.
  const reach = ownsCorners ? FENCE_T / 2 : -FENCE_T / 2;
  const a = from - reach;
  const b = to + reach;
  const mid = (a + b) / 2;
  const len = b - a;
  out.push(axis === 'x'
    ? { x: mid, y: 0, z: fixed, w: len, h: FENCE_H, d: FENCE_T, kind: 'fence' }
    : { x: fixed, y: 0, z: mid, w: FENCE_T, h: FENCE_H, d: len, kind: 'fence' });
  for (let p = from; p <= to + 1e-6; p += POST_SPACING) {
    if (!ownsCorners && (p <= from + 1e-6 || p >= to - 1e-6)) continue;
    out.push(axis === 'x'
      ? { x: p, y: 0, z: fixed, w: 0.35, h: FENCE_H + 0.3, d: 0.35, kind: 'post' }
      : { x: fixed, y: 0, z: p, w: 0.35, h: FENCE_H + 0.3, d: 0.35, kind: 'post' });
  }
  return out;
}

function liftSpec(def: { id: string; x: number; z: number; sign: -1 | 1 }): LiftSpec {
  return {
    id: def.id,
    x: def.x,
    z: def.z,
    width: PAD_W,
    depth: PAD_W,
    thickness: PAD_H,
    lowerY: PAD_H,
    upperY: DECK_Y,
    speed: LIFT_SPEED,
    dwell: LIFT_DWELL,
    lowerLanding: [def.x, 0, def.z - def.sign * (PAD_W / 2 + 1)],
    upperLanding: [def.x, DECK_Y, def.sign * (VOID_Z + 1)],
  };
}

/** Build the vertical-stack warehouse's full geometry spec. Fresh arrays every call. */
export function warehouse2Spec(): MapSpec {
  // B. Shell — two registers per side. The N/S runs own all four corners (full
  // OUTER width); the E/W runs stop at the inner face of the wall they meet.
  const boxes: MapBox[] = [
    ...wallBoxes('x', -SHELL_Z, -OUTER_X, OUTER_X, 0, DECK_Y, DOOR_N, 'wall'),
    ...wallBoxes('x', -SHELL_Z, -OUTER_X, OUTER_X, DECK_Y, WALL_H, PORT_N, 'wall'),
    ...wallBoxes('x', SHELL_Z, -OUTER_X, OUTER_X, 0, DECK_Y, DOOR_S, 'wall'),
    ...wallBoxes('x', SHELL_Z, -OUTER_X, OUTER_X, DECK_Y, WALL_H, PORT_S, 'wall'),
    ...wallBoxes('z', -SHELL_X, -INNER_Z, INNER_Z, 0, DECK_Y, DOOR_W, 'wall'),
    ...wallBoxes('z', -SHELL_X, -INNER_Z, INNER_Z, DECK_Y, WALL_H, PORT_W, 'wall'),
    ...wallBoxes('z', SHELL_X, -INNER_Z, INNER_Z, 0, DECK_Y, DOOR_E, 'wall'),
    ...wallBoxes('z', SHELL_X, -INNER_Z, INNER_Z, DECK_Y, WALL_H, PORT_E, 'wall'),
  ];

  // C. Catwalk ring: four slabs, flush at the corners. N/S bands run the full
  // width; E/W bands fill what is left — one continuous loop.
  const bandZ = INNER_Z - BAND / 2; // 15.75
  const bandX = INNER_X - BAND / 2; // 25.75
  boxes.push(
    { x: 0, y: DECK_Y - SLAB_T, z: -bandZ, w: INNER_X * 2, h: SLAB_T, d: BAND, kind: 'deck' },
    { x: 0, y: DECK_Y - SLAB_T, z: bandZ, w: INNER_X * 2, h: SLAB_T, d: BAND, kind: 'deck' },
    { x: -bandX, y: DECK_Y - SLAB_T, z: 0, w: BAND, h: SLAB_T, d: VOID_Z * 2, kind: 'deck' },
    { x: bandX, y: DECK_Y - SLAB_T, z: 0, w: BAND, h: SLAB_T, d: VOID_Z * 2, kind: 'deck' },
  );

  // Rail along all four void edges, gapped where flights land and lifts dock.
  // Corners go to the x-runs (same rule as the shell wall). Passengers need an
  // unobstructed walk from each lift onto the ring.
  const half = FLIGHT_W / 2;
  const liftGap = PAD_W / 2 + LIFT_GAP_MARGIN;
  const railEnd = VOID_X + RAIL_T / 2;
  const railStop = VOID_Z - RAIL_T / 2;
  boxes.push(
    ...railBoxes('x', -VOID_Z, -railEnd, railEnd, [[LIFT_A.x - liftGap, LIFT_A.x + liftGap]]),
    ...railBoxes('x', VOID_Z, -railEnd, railEnd, [[LIFT_B.x - liftGap, LIFT_B.x + liftGap]]),
    ...railBoxes('z', -VOID_X, -railStop, railStop, [[-FLIGHT_Z - half, -FLIGHT_Z + half]]),
    ...railBoxes('z', VOID_X, -railStop, railStop, [[FLIGHT_Z - half, FLIGHT_Z + half]]),
  );

  // Yard-flight landing, flush with the last tread at z = 3 and stopping at
  // the wall's OUTER face, so the port at z [-3,3] is a step-free walk onto
  // the deck. Outer rail only; the inner side is the doorway.
  const landOut = YARD_FLIGHT_X + 2.5;
  boxes.push(
    {
      x: (OUTER_X + landOut) / 2, y: DECK_Y - SLAB_T, z: 0,
      w: landOut - OUTER_X, h: SLAB_T, d: 6, kind: 'deck',
    },
    { x: landOut - RAIL_T / 2, y: DECK_Y, z: 0, w: RAIL_T, h: RAIL_H, d: 6, kind: 'rail' },
  );

  // F. Ground cover: two long racks splitting the middle into three lanes,
  // mid-lane pallet blocks in the outer lanes (the central lane stays open end
  // to end), and corner stacks flush to the walls.
  boxes.push(
    { x: 0, y: 0, z: -RACK_Z, w: RACK_W, h: RACK_H, d: RACK_D, kind: 'rack' },
    { x: 0, y: 0, z: RACK_Z, w: RACK_W, h: RACK_H, d: RACK_D, kind: 'rack' },
    { x: 0, y: 0, z: -9, w: 6, h: RACK_H, d: 4, kind: 'crate' },
    { x: 0, y: 0, z: 9, w: 6, h: RACK_H, d: 4, kind: 'crate' },
  );
  for (const sx of [1, -1] as const) {
    for (const sz of [1, -1] as const) {
      boxes.push({
        x: sx * CORNER_X, y: 0, z: sz * CORNER_Z,
        w: CORNER_SIZE, h: CORNER_H, d: CORNER_SIZE, kind: 'crate',
      });
    }
  }

  // G. Yard containers.
  for (const [x, z, alongX, stacked] of CONTAINERS) {
    const w = alongX ? CONT_L : CONT_W;
    const d = alongX ? CONT_W : CONT_L;
    boxes.push({ x, y: 0, z, w, h: CONT_H, d, kind: 'crate' });
    if (stacked) boxes.push({ x, y: CONT_H, z, w, h: CONT_H, d, kind: 'crate' });
  }

  // G. Yard fence: corners belong to the x-runs, panels and posts alike.
  boxes.push(
    ...fenceBoxes('x', -YARD_Z, -YARD_X, YARD_X, true),
    ...fenceBoxes('x', YARD_Z, -YARD_X, YARD_X, true),
    ...fenceBoxes('z', -YARD_X, -YARD_Z, YARD_Z, false),
    ...fenceBoxes('z', YARD_X, -YARD_Z, YARD_Z, false),
  );

  // H. Roof: three opaque bands with two glazed strips between them (built as
  // bands, not one slab with glass over it, so nothing z-fights), plus purlins
  // hung under the deck. Ordinary solids — a roof bullets pass through is a
  // roof that does not exist for the only system that can reach it.
  const roofW = OUTER_X * 2;
  const edge = OUTER_Z;
  const strip = SKY_Z + SKY_HALF;
  boxes.push(
    { x: 0, y: ROOF_Y, z: -(edge + strip) / 2, w: roofW, h: ROOF_T, d: edge - strip, kind: 'roof' },
    { x: 0, y: ROOF_Y, z: (edge + strip) / 2, w: roofW, h: ROOF_T, d: edge - strip, kind: 'roof' },
    { x: 0, y: ROOF_Y, z: 0, w: roofW, h: ROOF_T, d: (SKY_Z - SKY_HALF) * 2, kind: 'roof' },
  );
  for (const sz of [1, -1] as const) {
    boxes.push({ x: 0, y: ROOF_Y, z: sz * SKY_Z, w: roofW, h: ROOF_T, d: SKY_HALF * 2, kind: 'glass' });
  }
  // Purlins span wall FACE to wall face. Their tops sit below the roof, so no
  // body could ever rest on one — silhouette only.
  for (const z of BEAM_Z) {
    boxes.push({ x: 0, y: ROOF_Y - 0.55, z, w: INNER_X * 2, h: 0.55, d: 0.7, kind: 'beam' });
  }

  return {
    name: 'warehouse2',
    ground: { minX: -YARD_X, maxX: YARD_X, minZ: -YARD_Z, maxZ: YARD_Z },
    boxes,
    // D. Three open flights — thin treads you walk under (world.ts:addOpenStairs).
    // Built solid they would be two 13 m wedges of cover in the middle of the
    // hole the map exists for. The void pair mirrors by a 180-degree turn about
    // the origin; the yard flight is the only way up that never touches the
    // interior, arriving through the +x port at z [-3,3].
    flights: [
      { x: -FLIGHT_MOUTH_X, y: 0, z: -FLIGHT_Z, width: FLIGHT_W, stepH: STEP_H, stepD: STEP_D, count: RISERS, dir: 'x-', open: true, treadT: TREAD_T, kind: 'stair' },
      { x: FLIGHT_MOUTH_X, y: 0, z: FLIGHT_Z, width: FLIGHT_W, stepH: STEP_H, stepD: STEP_D, count: RISERS, dir: 'x+', open: true, treadT: TREAD_T, kind: 'stair' },
      { x: YARD_FLIGHT_X, y: 0, z: 3 + RISERS * STEP_D, width: FLIGHT_W, stepH: STEP_H, stepD: STEP_D, count: RISERS, dir: 'z-', open: true, treadT: TREAD_T, kind: 'stair' },
    ],
    // E. Cargo lifts: physical decks flush against the catwalk lip, cycling
    // floor <-> ring. Both teams can wait, board and ride either direction.
    lifts: [liftSpec(LIFT_A), liftSpec(LIFT_B)],
    targets: [],
    labels: [],
    notes: [
      'Roof slabs, skylights and purlins at 10 m are drawn as a dashed roofline only; the plan shows the interior.',
      'Main flights are open steel (walk-under); void flights land flush on the ring lip.',
      'Fence panels block movement but not bullets or sight; posts block both.',
      'Lifts cycle floor <-> ring; passengers board from the marked landings.',
    ],
  };
}
