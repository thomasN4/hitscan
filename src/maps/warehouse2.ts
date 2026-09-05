// warehouse2.ts — "vertical stack": a roofed shed with a catwalk ring, inside
// a fenced yard.
//
// The third full combat map, and the first whose spatial grammar is VERTICAL.
// maps/warehouse1.ts is an aisle grid — almost every fight happens along a
// lane, and its one deck is a 20 x 16 island you climb to. Here the second
// storey is the dominant space: an 8 m catwalk ring runs the full perimeter at
// 5.1 m, and the 44 x 24 middle is cut away entirely, so the ring looks down
// on the floor and the floor looks up at the ring. That hole is the map — a
// mezzanine gallery around an atrium, "open to below" on the drawing.
//
// Built from the greybox in maps/mockups/warehouse_layout_d.html. Where the
// numbers here differ from that file, a comment says why.
//
// Five ideas hold it together:
//
//   - The ring sees everything and hides nothing. A standing eye on the deck
//     is at 5.1 + 1.9 = 7.0, over every piece of ground cover; the answer is
//     that the rail tops out at 6.2, well under that eye, so holding the ring
//     means being visible from the floor from the waist up. Same lever as
//     warehouse1's parapet, applied to a much bigger surface.
//   - The shell wall is built in TWO registers with independent gaps: one
//     5 m doorway per side at ground level, and two or three 4 m ports per
//     side at catwalk level. Ground and ring are different maps of the same
//     building, connected only where this file says they are.
//   - The two main flights stand in the open void and are OPEN — thin treads
//     you walk under (world.ts:addOpenStairs). Built the ordinary solid way
//     they would be two 13 m wedges of cover in the middle of the hole the map
//     exists for.
//   - The cargo lifts are the fast way up and cost you the arc: no cover, no
//     control, and everyone can see where you will land. One-way, so the
//     graph never routes a bot down one (world.ts:addLiftPad).
//   - Spawns are ASYMMETRIC — CTs muster in the yard and have to come through
//     a doorway, Ts start already on the ring (core/state.ts:BOT_SPAWNS). The
//     ring is the prize and one side begins holding it.
//
// Unlike warehouse1 this map does NOT have to borrow the arena's footprint:
// bot spawns became per-map in the same change that added it, so the shell is
// the size the greybox wanted (60 x 40 inside an 88 x 68 yard) rather than the
// size bots.ts used to insist on.
//
// All geometry goes through world.ts, which registers each solid as both a
// raycast target and a movement AABB. Do not add meshes to the scene directly:
// that is how you get walk-through / shoot-through bugs.
import * as THREE from 'three';
import { createCelMaterial } from '../core/materials';
import { scene } from '../core/engine';
import {
  addSolidBox, addOpenStairs, addLiftPad, registerSolid, registerGroupParts,
  colliders, coplanarTopOverlaps,
} from '../world';
import { STEP_HEIGHT, HEAD_HEIGHT } from '../collision';
import { GRAVITY } from '../sim/movement';
import { launchApex } from '../sim/lift';

// Deliberately spread WIDER than warehouse1's palette, not just shifted
// brighter. Under a roof the hemisphere is doing most of the lighting, and a
// hemisphere has no direction — it flattens. Values that read as distinct
// surfaces outdoors, where the sun separates them, collapse into one grey mass
// in here, so the separation has to come from the materials themselves.
const matYard   = createCelMaterial({ color: 0x6a7078 }); // asphalt
const matFloor  = createCelMaterial({ color: 0x868b92 }); // sealed concrete
const matShell  = createCelMaterial({ color: 0x969ca5 }); // corrugated steel
// Darker than the floor on purpose: the deck is read from ABOVE and BELOW all
// game, and matching the concrete would leave the void's edge invisible from
// the ring — which is the one edge on this map you can walk off.
const matSlab   = createCelMaterial({ color: 0x767d85 });
// The brightest things in the building, for warehouse1's reason: the rail and
// the stairs are the geometry a player most needs to pick out at a glance, and
// at close values they vanish into the deck they stand on.
const matRail   = createCelMaterial({ color: 0xb4bcc5 });
const matStair  = createCelMaterial({ color: 0xaab2bb });
const matRack   = createCelMaterial({ color: 0x3f6a8c });
const matCrate  = createCelMaterial({ color: 0x8a6d3f });
const matLift   = createCelMaterial({ color: 0xe08b28 }); // safety orange
const matFence  = createCelMaterial({ color: 0x7e858e });
// Overhead and wanting to recede — the darkest surface in the shell.
const matRoof   = createCelMaterial({ color: 0x50565e });
const matBeam   = createCelMaterial({ color: 0x434952 });
const matGlass  = createCelMaterial({ color: 0xc2d6e6, transparent: true, opacity: 0.5 });

// ---------- Dimensions ----------
// Every number the map is built from, each pinned to the engine constant that
// decides it. Change one here rather than at a use site.

/** Riser height of every flight. MUST stay <= collision.ts:STEP_HEIGHT or treads become walls. */
const STEP_H = 0.3;
/** Tread depth of every flight. */
const STEP_D = 0.75;
/** Risers per flight — every flight on this map is the same climb. */
const RISERS = 17;
/**
 * Catwalk walking surface.
 *
 * The greybox says 5.0; this is 5.1, because 5.0 / STEP_HEIGHT is not a whole
 * number and warehouse1's idiom (and elevation's) is a deck height that is an
 * exact multiple of the riser. 17 x 0.3 buys that for 10 cm.
 */
const DECK_Y = RISERS * STEP_H;
/** Decking thickness. DECK_Y - SLAB_T = 4.7 m of headroom below, far over HEAD_HEIGHT. */
const SLAB_T = 0.4;
/** Tread plate thickness on the open flights — thin, so you can walk under them. */
const TREAD_T = 0.16;

/** Shell half-extents (to the wall centre-line), wall thickness, wall height. */
const SHELL_X = 30, SHELL_Z = 20, WALL_T = 1, WALL_H = 10;
/**
 * The wall's two FACES, which is what abutting geometry has to be built to.
 *
 * SHELL_X/SHELL_Z are centre-lines, and a centre-line is not a surface: a slab
 * built out to one overlaps the inner half of the wall it meets. Where both
 * tops then land on the same plane — decking and the lower wall register both
 * top out at DECK_Y — the two up-facing surfaces fight for the depth buffer
 * and flicker as the camera moves. Every join in this file is therefore built
 * face-to-face: the decking stops at INNER, the yard landing starts at OUTER,
 * and each corner belongs to exactly one of the two runs that meet there.
 */
const INNER_X = SHELL_X - WALL_T / 2, INNER_Z = SHELL_Z - WALL_T / 2;
const OUTER_X = SHELL_X + WALL_T / 2, OUTER_Z = SHELL_Z + WALL_T / 2;
/**
 * Depth of the catwalk ring, measured in from the wall's CENTRE-LINE — so it
 * sets where the void lip falls, not how much decking there is. The decking
 * itself is BAND, half a wall thinner, and stops at the wall's inner face.
 */
const RING = 8;
/** The void: the ring's inner edge, and so the hole's half-extents. */
const VOID_X = SHELL_X - RING, VOID_Z = SHELL_Z - RING;
/** Fence half-extents — the outer bound of the level. */
const YARD_X = 44, YARD_Z = 34;

/** Rail height and thickness. Top at 6.2, under a deck eye at 5.1 + 1.9 = 7.0. */
const RAIL_H = 1.1, RAIL_T = 0.16;
/** Width of both main flights, and so of the rail gaps that receive them. */
const FLIGHT_W = 3.6;
/**
 * Extra rail gap either side of a lift pad, beyond the pad's own width.
 *
 * A flight arrives on a fixed line and needs a gap no wider than itself. An
 * ARC does not: a launched body steers all the way up, so where it comes down
 * is the pad's position plus whatever the brain did with a second and a half
 * of air. Measured drift on a bot riding pad A was 2.4 m off the pad's centre-
 * line, which cleared a pad-width gap and put it on TOP of the rail — a 0.16 m
 * ledge the nav graph treats as standable and connects to nothing, so the bot
 * perches there for the rest of its life. Two metres of margin covers the
 * observed drift with room to spare, and a wide opening opposite a goods lift
 * is what the real building would have anyway.
 */
const LIFT_GAP_MARGIN = 2;

/**
 * Upward velocity a cargo lift imparts.
 *
 * Sized off the ARC, not the apex. Apex alone only has to beat DECK_Y; what
 * actually matters is how long the body spends ABOVE DECK_Y, because until it
 * clears the deck its head is under the slab and slideMoveXZ will not let it
 * move over. 17 m/s gives ~0.73 s over the deck, ~4.7 m of travel at walk
 * speed against the ~3 m a pad centre needs. At 16 that window halves and
 * bots start clipping the lip and falling back in.
 */
const LAUNCH_VEL = 17;
/** Pad height. At or under STEP_HEIGHT or it must be JUMPED onto, and bots have no jump. */
const PAD_H = 0.25;
/** Pad footprint. */
const PAD_W = 4;
/**
 * Largest body footprint radius on the map.
 *
 * Two sources, and the larger wins: bots.ts:BOT_RADIUS is nav.ts:NAV_RADIUS =
 * 0.5, and core/state.ts:player.radius is 0.45.
 */
const BODY_RADIUS_MAX = 0.5;
/**
 * How far a pad's far edge stands back from the void lip.
 *
 * The ring slab's underside is at DECK_Y - SLAB_T = 4.7 and its collider runs
 * from the lip outward, so a footprint that reaches under it gets its head
 * swept by collision.ts:resolveVertical, clamped to feet 4.7 - HEAD_HEIGHT =
 * 2.7, and dropped straight back onto the pad — which fires again. A
 * permanent bounce, not a ride. LIP_GAP is at least twice BODY_RADIUS_MAX,
 * so "footprint overlaps the slab" (z < -VOID_Z + r) and "footprint overlaps
 * the pad" (z > padMinZ - r) are disjoint sets: a body the ceiling stops is
 * by construction no longer on the pad, so it lands on the floor and stays
 * there. It is a floor strip, not a rail — the pad is still walked onto from
 * the lip side, it just no longer reaches it. Proven in checkClearances()
 * and pinned in sim/lift.test.ts.
 */
const LIP_GAP = 1;

/**
 * Minimum clear width of anything meant to be walked down.
 *
 * The same reasoning as warehouse1: nav.ts samples at CELL = 1 m with
 * NAV_RADIUS = 0.5, so a gap of width w leaves a standable band of w - 1, and
 * four metres guarantees three sampled cells across it whatever phase the grid
 * lands on. Enforced, not just documented — see checkClearances().
 */
const AISLE_MIN = 4;

/** Build the vertical-stack warehouse. Called once, via the maps/index.ts registry. */
export function buildWarehouse2(): void {
  buildGround();
  buildShell();
  buildRing();
  buildFlights();
  buildLifts();
  buildCover();
  buildYard();
  buildRoof();

  if (import.meta.env.DEV) checkClearances();
}

// ---------- A. Ground ----------
// Two planes, both raycast-only: movement is bounded by the fence, and a
// rotated PlaneGeometry has no usable AABB anyway (world.ts:registerSolid).
// The shell floor is lifted 1 cm so it wins the depth test against the yard
// rather than z-fighting it.

function buildGround(): void {
  const yard = new THREE.Mesh(new THREE.PlaneGeometry(YARD_X * 2, YARD_Z * 2), matYard);
  yard.rotation.x = -Math.PI / 2;
  yard.receiveShadow = true;
  scene.add(yard);
  registerSolid(yard);

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(SHELL_X * 2, SHELL_Z * 2), matFloor);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0.01;
  floor.receiveShadow = true;
  scene.add(floor);
  registerSolid(floor);
}

// ---------- B. Shell — two registers ----------
// Each side of the building is built TWICE: once from the floor to the deck,
// once from the deck to the eaves, each with its own gaps. That is what makes
// the ring a real second storey — the ground floor's one doorway and the
// catwalk's firing ports are unrelated openings in the same wall.
//
// A lower-register wall tops out at exactly DECK_Y, so collision.ts:blocks
// reads it as steppable (not blocking) for a body standing on the deck, and as
// a wall for a body on the floor. The upper register does the blocking up top.

/** Ground doorways: one per side, 5 m wide. */
const DOOR_N: [number, number][] = [[-17, -12]];
const DOOR_S: [number, number][] = [[12, 17]];
const DOOR_W: [number, number][] = [[6, 11]];
const DOOR_E: [number, number][] = [[-11, -6]];
/** Catwalk-level ports. The +x pair at z [-3,3] is 6 m: it receives the yard flight. */
const PORT_N: [number, number][] = [[-26, -22], [-6, -2], [14, 18]];
const PORT_S: [number, number][] = [[-18, -14], [2, 6], [22, 26]];
const PORT_W: [number, number][] = [[-16, -12], [-2, 2]];
const PORT_E: [number, number][] = [[-3, 3], [12, 16]];

// The N/S runs own all four corners — they run the full OUTER width, and the
// E/W runs stop at the inner face of the wall they meet. Built symmetrically
// (both runs to their centre-lines) each corner would be covered twice, with
// the two tops coplanar, AND still leave the outermost square of the corner
// covered by neither.
function buildShell(): void {
  wallRun('x', -SHELL_Z, -OUTER_X, OUTER_X, 0, DECK_Y, DOOR_N);
  wallRun('x', -SHELL_Z, -OUTER_X, OUTER_X, DECK_Y, WALL_H, PORT_N);
  wallRun('x',  SHELL_Z, -OUTER_X, OUTER_X, 0, DECK_Y, DOOR_S);
  wallRun('x',  SHELL_Z, -OUTER_X, OUTER_X, DECK_Y, WALL_H, PORT_S);
  wallRun('z', -SHELL_X, -INNER_Z, INNER_Z, 0, DECK_Y, DOOR_W);
  wallRun('z', -SHELL_X, -INNER_Z, INNER_Z, DECK_Y, WALL_H, PORT_W);
  wallRun('z',  SHELL_X, -INNER_Z, INNER_Z, 0, DECK_Y, DOOR_E);
  wallRun('z',  SHELL_X, -INNER_Z, INNER_Z, DECK_Y, WALL_H, PORT_E);
}

/**
 * One wall face, as solid segments between `gaps`.
 *
 * @param axis which axis the wall RUNS along
 * @param fixed the wall's centre-line on the other axis
 * @param from/to extent along `axis`
 * @param y0/y1 the vertical register this call builds
 * @param gaps openings along `axis`, ascending and non-overlapping
 */
function wallRun(
  axis: 'x' | 'z',
  fixed: number,
  from: number,
  to: number,
  y0: number,
  y1: number,
  gaps: readonly [number, number][],
): void {
  const cuts = [from, ...gaps.flat(), to];
  for (let i = 0; i < cuts.length; i += 2) {
    const a = cuts[i]!, b = cuts[i + 1]!;
    if (b - a < 0.05) continue; // a gap flush with the end leaves no segment
    const mid = (a + b) / 2, len = b - a, h = y1 - y0;
    if (axis === 'x') addSolidBox(mid, y0, fixed, len, h, WALL_T, matShell);
    else addSolidBox(fixed, y0, mid, WALL_T, h, len, matShell);
  }
}

// ---------- C. The catwalk ring ----------
// Four slabs, flush at the corners, hugging all four walls. The N and S bands
// run the full 60 m width; the E and W bands fill only what is left between
// them, which is what makes the join a single continuous loop rather than four
// platforms.

/**
 * Decking depth: the wall's inner FACE to the void lip, not RING.
 *
 * RING is measured in from the wall's centre-line, so a band RING deep buries
 * its outer half-thickness of wall — and the lower wall register tops out at
 * DECK_Y too, so the buried strip is two coplanar up-facing surfaces running
 * the whole perimeter. Under a solid wall you never see it; under a catwalk
 * PORT it is the sill you stand on, which is where the flicker showed. The
 * 0.5 m the decking gives up is still walking surface at exactly DECK_Y —
 * the wall's own collider holds it up — so nothing moves but the rendering.
 */
const BAND = RING - WALL_T / 2;

function buildRing(): void {
  const bandZ = INNER_Z - BAND / 2; // 15.75
  const bandX = INNER_X - BAND / 2; // 25.75
  addSolidBox(0, DECK_Y - SLAB_T, -bandZ, INNER_X * 2, SLAB_T, BAND, matSlab);
  addSolidBox(0, DECK_Y - SLAB_T,  bandZ, INNER_X * 2, SLAB_T, BAND, matSlab);
  addSolidBox(-bandX, DECK_Y - SLAB_T, 0, BAND, SLAB_T, VOID_Z * 2, matSlab);
  addSolidBox( bandX, DECK_Y - SLAB_T, 0, BAND, SLAB_T, VOID_Z * 2, matSlab);

  // Rail along all four void edges, gapped where something arrives.
  //
  // The greybox's rail runs are decorative and line up with nothing; these
  // gaps are placed deliberately. Each flight lands through one, and each lift
  // arc comes down through one — a body thrown onto the deck edge and stopped
  // by a 1.1 m rail falls straight back into the void.
  //
  // The four corners go to the x-runs, for the shell wall's reason: two runs
  // each built to the lip would double-cover a RAIL_T square at every corner,
  // coplanar at the rail top, in the brightest material on the map.
  const half = FLIGHT_W / 2;
  const liftGap = PAD_W / 2 + LIFT_GAP_MARGIN;
  const railEnd = VOID_X + RAIL_T / 2, railStop = VOID_Z - RAIL_T / 2;
  railRun('x', -VOID_Z, -railEnd, railEnd, [[PAD_A_X - liftGap, PAD_A_X + liftGap]]);
  railRun('x',  VOID_Z, -railEnd, railEnd, [[PAD_B_X - liftGap, PAD_B_X + liftGap]]);
  railRun('z', -VOID_X, -railStop, railStop, [[-FLIGHT_Z - half, -FLIGHT_Z + half]]);
  railRun('z',  VOID_X, -railStop, railStop, [[ FLIGHT_Z - half,  FLIGHT_Z + half]]);
}

/** One void edge's rail, as segments between `gaps`. Same shape as wallRun. */
function railRun(
  axis: 'x' | 'z',
  fixed: number,
  from: number,
  to: number,
  gaps: readonly [number, number][],
): void {
  const cuts = [from, ...gaps.flat(), to];
  for (let i = 0; i < cuts.length; i += 2) {
    const a = cuts[i]!, b = cuts[i + 1]!;
    if (b - a < 0.05) continue;
    const mid = (a + b) / 2, len = b - a;
    if (axis === 'x') addSolidBox(mid, DECK_Y, fixed, len, RAIL_H, RAIL_T, matRail);
    else addSolidBox(fixed, DECK_Y, mid, RAIL_T, RAIL_H, len, matRail);
  }
}

// ---------- D. Flights ----------
// Three open flights, all built with world.ts:addOpenStairs: two mirrored in
// the void by a 180-degree turn about the origin rather than across an axis,
// so neither team's approach is the other's reversed, and the yard flight
// against the +x wall. All climb from their ground to the ring.
//
// The void flights climb 17 x 0.75 = 12.75 m of run, putting the far edge of
// the last tread exactly on the ring's inner edge: 9.25 + 12.75 = 22 = VOID_X.
// That flush join is what lets addOpenStairs' NavLink top land ON the deck
// rather than a half-tread short of it (the notch maps/elevation.ts
// documents).
//
// The yard flight is the only way up that never touches the interior, so a
// player can reach the ring without entering the building at all, and it
// arrives through the +x wall's catwalk port at z [-3, 3]. It is open like
// the others — thin treads, and the yard side of the wall gains a walk-under
// gap for free — and its treads hang from the same TREAD_T plate, so there is
// one stair idiom on the map, not two.

/** Centre z of the two void flights. The east one mirrors to -this. */
const FLIGHT_Z = 8;
/** Mouth x of the void flights. RUN = 12.75, and 9.25 + 12.75 = VOID_X. */
const FLIGHT_MOUTH_X = VOID_X - RISERS * STEP_D;
/** The yard flight's centre-line, clear of the shell wall at x = 30.5. */
const YARD_FLIGHT_X = 32.5;

function buildFlights(): void {
  addOpenStairs(-FLIGHT_MOUTH_X, 0, -FLIGHT_Z, FLIGHT_W, STEP_H, STEP_D, RISERS, TREAD_T, matStair, 'x-');
  addOpenStairs( FLIGHT_MOUTH_X, 0,  FLIGHT_Z, FLIGHT_W, STEP_H, STEP_D, RISERS, TREAD_T, matStair, 'x+');

  // Yard flight: mouth at z = 15.75, topping out at z = 3 on its landing.
  addOpenStairs(YARD_FLIGHT_X, 0, 3 + RISERS * STEP_D, FLIGHT_W, STEP_H, STEP_D, RISERS, TREAD_T, matStair, 'z-');
  // Landing, flush with the last tread at z = 3 and stopping at the wall's
  // OUTER face, so the port at z [-3, 3] is a step-free walk onto the deck:
  // landing, then a metre of wall top at the same height, then decking. Run
  // to the centre-line instead and it overlaps the wall exactly as the ring
  // bands did, in the one port a player walks through rather than shoots from.
  const landOut = YARD_FLIGHT_X + 2.5;
  addSolidBox((OUTER_X + landOut) / 2, DECK_Y - SLAB_T, 0, landOut - OUTER_X, SLAB_T, 6, matSlab);
  // Outer rail only; the inner side is the doorway.
  addSolidBox(landOut - RAIL_T / 2, DECK_Y, 0, RAIL_T, RAIL_H, 6, matRail);
}

// ---------- E. Cargo lifts ----------
// One per half, rotationally symmetric with the flights. Each stands LIP_GAP
// back from the void lip — a pad flush with it launches bodies into the ring
// slab's underside, which is the permanent bounce LIP_GAP exists to remove —
// so the arc now carries a body the ~3 m from the pad's centre to the lip,
// and comes down through a rail gap cut for it.

/**
 * Pad centres. Each lands on the band its arc is aimed at, a LIP_GAP short of
 * the lip.
 */
const PAD_A_X = 8, PAD_A_Z = -(VOID_Z - PAD_W / 2 - LIP_GAP);  // (8, -9) -> the -z band
const PAD_B_X = -8, PAD_B_Z = VOID_Z - PAD_W / 2 - LIP_GAP;    // (-8, 9) -> the +z band
/** How far onto the band the arc is aimed — clear of the lip, short of the wall. */
const PAD_LANDING_INSET = 2;

function buildLifts(): void {
  addLiftPad(PAD_A_X, 0, PAD_A_Z, PAD_W, PAD_W, PAD_H, LAUNCH_VEL,
    new THREE.Vector3(PAD_A_X, DECK_Y, -VOID_Z - PAD_LANDING_INSET), matLift);
  addLiftPad(PAD_B_X, 0, PAD_B_Z, PAD_W, PAD_W, PAD_H, LAUNCH_VEL,
    new THREE.Vector3(PAD_B_X, DECK_Y, VOID_Z + PAD_LANDING_INSET), matLift);
}

// ---------- F. Ground cover ----------
// Sparse on purpose. The ring already sees the whole floor, so the floor's
// cover is about crossing it, not holding it: two long racks split the middle
// into three lanes, and the corner stacks sit AGAINST the shell wall rather
// than out in the under-ring corridor, which would pinch it under AISLE_MIN.

/** Rack height. Over a ground eye (1.7), under a deck eye (7.0) — nothing hides from the ring. */
const RACK_H = 3;
/** Centre z of the two central racks; they are RACK_D deep, leaving a 4 m aisle between. */
const RACK_Z = 3, RACK_D = 2, RACK_W = 34;
/**
 * Corner pallet stacks, flush to the wall's inner face rather than centred in
 * the under-ring corridor. Centred they would leave ~2 m either side, under
 * AISLE_MIN, and quietly cost the corridor its corners.
 */
const CORNER_X = 28, CORNER_Z = 16, CORNER_SIZE = 3, CORNER_H = 2.4;

function buildCover(): void {
  addSolidBox(0, 0, -RACK_Z, RACK_W, RACK_H, RACK_D, matRack);
  addSolidBox(0, 0,  RACK_Z, RACK_W, RACK_H, RACK_D, matRack);
  // Pallet blocks: mid-lane cover in the two outer lanes (x [-3, 3], at
  // z [-11, -7] and [7, 11]), breaking up the long run between the racks and
  // the under-ring corridor. The central lane between the racks (z [-2, 2])
  // stays open end to end — its ends at x = ±17 and the void lip at ±22 are
  // untouched.
  addSolidBox(0, 0, -9, 6, RACK_H, 4, matCrate);
  addSolidBox(0, 0,  9, 6, RACK_H, 4, matCrate);
  // Corner stacks. 2.4 m is over the ~1.45 m jump apex, so these are cover and
  // not a perch, and 4.7 - 2.4 = 2.3 m of clearance under the ring keeps them
  // from becoming a ceiling.
  for (const sx of [1, -1] as const) {
    for (const sz of [1, -1] as const) {
      addSolidBox(sx * CORNER_X, 0, sz * CORNER_Z, CORNER_SIZE, CORNER_H, CORNER_SIZE, matCrate);
    }
  }
}

// ---------- G. Yard ----------
// The outdoor half: shipping containers for cover on the approach, and a
// chain-link fence bounding the level.
//
// The fence panels are BLOCKING BUT NOT SHOOTABLE — the inverse of the range
// target's post, and the other half of why registerGroupParts takes the two
// lists separately (world.ts:93-95). Chain-link stops a body and not a bullet,
// and a panel in `solids` would also block bot line-of-sight through it, which
// would make the yard fight read as though the fence were a wall. The posts
// are solid steel and go in both.

/** Container dimensions: length, height, width. Stacked pairs double the height. */
const CONT_L = 12, CONT_H = 2.6, CONT_W = 2.9;
/** Fence height, panel thickness, and post spacing. */
const FENCE_H = 4, FENCE_T = 0.12, POST_SPACING = 8;

function buildYard(): void {
  // [x, z, alongX, stacked]
  const containers: [number, number, boolean, boolean][] = [
    [-20, 27, true, false], [20, 26, true, true], [34, 30, true, false],
    [-16, -27, true, false], [14, -26, true, false], [32, -29, true, true],
    [-37, -9, false, false], [-37, 9, false, true],
    [38.5, 12, false, false], [38.5, -8, false, false],
  ];
  for (const [x, z, alongX, stacked] of containers) {
    const w = alongX ? CONT_L : CONT_W;
    const d = alongX ? CONT_W : CONT_L;
    addSolidBox(x, 0, z, w, CONT_H, d, matCrate);
    if (stacked) addSolidBox(x, CONT_H, z, w, CONT_H, d, matCrate);
  }

  // Corners belong to the x-runs, panels and posts alike — the same rule as
  // the shell wall and the void rail. The z-runs stop half a panel short and
  // skip their end posts; built to the corner they would lay a second panel
  // over the first and stand a post inside a post, exactly coincident.
  const group = new THREE.Group();
  const posts: THREE.Mesh[] = [];
  const panels: THREE.Mesh[] = [];
  fenceSide('x', -YARD_Z, -YARD_X, YARD_X, group, posts, panels, true);
  fenceSide('x',  YARD_Z, -YARD_X, YARD_X, group, posts, panels, true);
  fenceSide('z', -YARD_X, -YARD_Z, YARD_Z, group, posts, panels, false);
  fenceSide('z',  YARD_X, -YARD_Z, YARD_Z, group, posts, panels, false);
  scene.add(group);
  registerGroupParts(group, { shootable: posts, blocking: [...panels, ...posts] });
}

/**
 * One run of fence: a thin mesh panel plus steel posts every POST_SPACING.
 *
 * `from`/`to` are the CORNERS the run spans, both runs meeting at each one.
 * `ownsCorners` decides which of the two takes them: the owner's panel grows
 * half a thickness past each corner and it stands the corner posts, the other
 * stops half a thickness short and skips them. Both runs claiming a corner
 * puts two identical posts in the same place and crosses the panels.
 */
function fenceSide(
  axis: 'x' | 'z',
  fixed: number,
  from: number,
  to: number,
  group: THREE.Group,
  posts: THREE.Mesh[],
  panels: THREE.Mesh[],
  ownsCorners: boolean,
): void {
  const reach = ownsCorners ? FENCE_T / 2 : -FENCE_T / 2;
  const a = from - reach, b = to + reach;
  const mid = (a + b) / 2, len = b - a;
  const panel = new THREE.Mesh(
    axis === 'x'
      ? new THREE.BoxGeometry(len, FENCE_H, FENCE_T)
      : new THREE.BoxGeometry(FENCE_T, FENCE_H, len),
    matFence);
  panel.position.set(axis === 'x' ? mid : fixed, FENCE_H / 2, axis === 'x' ? fixed : mid);
  group.add(panel);
  panels.push(panel);

  for (let p = from; p <= to + 1e-6; p += POST_SPACING) {
    if (!ownsCorners && (p <= from + 1e-6 || p >= to - 1e-6)) continue;
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.35, FENCE_H + 0.3, 0.35), matFence);
    post.position.set(axis === 'x' ? p : fixed, (FENCE_H + 0.3) / 2, axis === 'x' ? fixed : p);
    post.castShadow = true;
    group.add(post);
    posts.push(post);
  }
}

// ---------- H. Roof ----------
// The first roof in this codebase, and the reason core/state.ts:Ambience grew
// light intensities: the opaque slabs shadow most of the interior, so indoors
// leans on the hemisphere — while the two glazed strips admit the directional
// sun in bands, which is what keeps the inside from rendering flat.
//
// Built as three slabs with two glazed strips between them rather than one
// slab with glass laid over it, so nothing z-fights. The strips run the full
// width (the greybox stops them at x +-20) because cutting them short would
// fragment the roof into nine pieces to save nothing.
//
// Ordinary solids, not decoration: a roof that bullets pass through is a roof
// that does not exist for the only system that can currently reach it.
//
// Known and accepted cost: the roof's TOP is a legal standing surface as far as
// sim/navGrid.ts is concerned — nothing is above it, so canStand says yes — and
// it contributes ~2,600 unreachable nodes, about a quarter of the graph. The
// fence tops and the rail tops do the same on a smaller scale. It is left
// alone deliberately: the alternative is to register the roof raycast-only,
// which trades a measured, contained waste for a walk-through floor the moment
// anything on this map can reach 10 m. Measured whole, this map builds in
// 28 ms against warehouse1's 40, because the footprint is much smaller.

/** Roof slab underside, and its thickness. 10 m of headroom over the floor. */
const ROOF_Y = WALL_H, ROOF_T = 0.4;
/** Half-depth of each glazed strip, and its centre z. */
const SKY_HALF = 1.5, SKY_Z = 6;
/** Purlins under the roof, every 8 m. */
const BEAM_Z = [-16, -8, 0, 8, 16];

function buildRoof(): void {
  const w = OUTER_X * 2;
  /** Outer edge of the roof, and the inner edge of each outboard band. */
  const edge = OUTER_Z, strip = SKY_Z + SKY_HALF;
  // Three opaque bands: outboard of each strip, and the one between them.
  addSolidBox(0, ROOF_Y, -(edge + strip) / 2, w, ROOF_T, edge - strip, matRoof);
  addSolidBox(0, ROOF_Y,  (edge + strip) / 2, w, ROOF_T, edge - strip, matRoof);
  addSolidBox(0, ROOF_Y, 0, w, ROOF_T, (SKY_Z - SKY_HALF) * 2, matRoof);
  // Two glazed strips — SOLID, but not shadow casters.
  //
  // That one flag is what makes the roof survivable. createSolidBox turns on
  // castShadow for everything, so a fully opaque roof puts the entire interior
  // in the sun's shadow and leaves it lit by the hemisphere alone; measured,
  // that renders at less than half warehouse1's brightness, and no amount of
  // hemiIntensity buys it back, because a hemisphere has no direction and
  // flattens rather than lights. Clearing castShadow on the glazing lets the
  // sun through exactly where a skylight would, so the floor gets two bright
  // bands and the shell gets a light direction — while the strips stay solid
  // to bullets and bodies like any other roof panel.
  for (const sz of [1, -1] as const) {
    addSolidBox(0, ROOF_Y, sz * SKY_Z, w, ROOF_T, SKY_HALF * 2, matGlass).castShadow = false;
  }

  // Purlins, hung under the deck. Their tops are below the roof, so no body
  // could ever rest on one — canStand rejects a foothold whose head is inside
  // the slab above it — and they cost nothing but silhouette. They span wall
  // FACE to wall face: run to the centre-lines and each end buries itself in
  // the upper wall register, whose top is at ROOF_Y too.
  for (const z of BEAM_Z) {
    addSolidBox(0, ROOF_Y - 0.55, z, INNER_X * 2, 0.55, 0.7, matBeam);
  }
}

// ---------- Clearance check ----------
// Loud, not fatal, and DEV-only — the same shape as warehouse1's checkAisles,
// and statically dead in production builds.
//
// Three failure modes, all quiet. A route narrowed under AISLE_MIN still looks
// walkable and still lets the PLAYER through, but stops holding sampled nav
// cells, so bots simply never use it. A lift whose arc no longer clears the
// deck it serves still launches you — it just drops you back where you
// started, which reads as a broken pad rather than a changed constant. And a
// solid built to a centre-line rather than a face lands its top face in the
// same plane as its neighbour's, which renders as a flickering patch and is
// invisible in the source: see INNER_X/OUTER_X, and world.ts's
// coplanarTopOverlaps, which is what actually measures it.
//
// Everything below is derived from the constants the geometry is built from,
// and compared against the ENGINE constants themselves rather than copies, so
// neither side can drift.

function checkClearances(): void {
  const problems: string[] = [];
  const atLeast = (name: string, got: number, min: number, unit = 'm'): void => {
    if (got < min) problems.push(`${name} is ${got.toFixed(2)} ${unit}, under ${min}`);
  };
  const atMost = (name: string, got: number, max: number, unit = 'm'): void => {
    if (got > max) problems.push(`${name} is ${got.toFixed(2)} ${unit}, over ${max}`);
  };

  // Routes. The ring's two band widths are what a bot walks along up top; the
  // under-ring corridor and the central lane are the ground equivalents.
  atLeast('catwalk band (N/S)', INNER_Z - VOID_Z, AISLE_MIN);
  atLeast('catwalk band (E/W)', INNER_X - VOID_X, AISLE_MIN);
  atLeast('central floor lane', RACK_Z * 2 - RACK_D, AISLE_MIN);
  atLeast('rack end to shell wall', INNER_X - RACK_W / 2, AISLE_MIN);
  atLeast('corner stack to void lip', CORNER_X - CORNER_SIZE / 2 - VOID_X, AISLE_MIN);
  atLeast('headroom over a corner stack', DECK_Y - SLAB_T - CORNER_H, HEAD_HEIGHT);
  for (const [name, gaps] of [
    ['N doorway', DOOR_N], ['S doorway', DOOR_S],
    ['W doorway', DOOR_W], ['E doorway', DOOR_E],
  ] as const) {
    atLeast(name, gaps[0]![1] - gaps[0]![0], AISLE_MIN);
  }

  // Heights. Both are the difference between a surface and an engine constant,
  // which is exactly the kind of pair that breaks silently when one moves.
  atLeast('headroom under the ring', DECK_Y - SLAB_T, HEAD_HEIGHT);
  atMost('flight riser', STEP_H, STEP_HEIGHT);
  atMost('lift pad height', PAD_H, STEP_HEIGHT);

  // Lifts. The apex has to beat the deck, and the flight has to land ON the
  // band — a pad aimed past the wall is as broken as one that falls short.
  const apex = launchApex(LAUNCH_VEL, GRAVITY);
  atLeast('lift apex over the deck', apex - DECK_Y, 0.5);
  atMost('lift landing inset', PAD_LANDING_INSET, RING - AISLE_MIN / 2);
  atLeast('lift rail gap', PAD_W + 2 * LIFT_GAP_MARGIN, AISLE_MIN + PAD_W / 2);
  // review-bot caught this group testing the apex and the landing inset but
  // never the lip gap itself; the relaunch bounce it prevents is LIP_GAP's.
  for (const padZ of [PAD_A_Z, PAD_B_Z]) {
    atLeast('lift pad gap to the void lip',
      VOID_Z - (Math.abs(padZ) + PAD_W / 2), 2 * BODY_RADIUS_MAX);
  }

  // Flush joins. Both void flights must top out exactly on the void lip, or
  // the NavLink aims at a point that is not the deck.
  const run = RISERS * STEP_D;
  if (Math.abs(FLIGHT_MOUTH_X + run - VOID_X) > 1e-6) {
    problems.push(`void flight overruns the lip by ${(FLIGHT_MOUTH_X + run - VOID_X).toFixed(2)} m`);
  }
  if (Math.abs(RISERS * STEP_H - DECK_Y) > 1e-6) {
    problems.push(`flights climb ${(RISERS * STEP_H).toFixed(2)} m against a ${DECK_Y} m deck`);
  }

  // Coincident geometry. This one reads the world that was actually built
  // rather than the constants above, because it is a property of the boxes and
  // not of any one number — the flicker it catches has come from a slab, a
  // rail, a purlin and a fence post so far, each a different arithmetic slip.
  for (const o of coplanarTopOverlaps(colliders)) {
    problems.push(
      `coplanar top faces at y=${o.y.toFixed(2)} over ${o.area.toFixed(2)} m2 ` +
      `(x ${o.minX.toFixed(2)}..${o.maxX.toFixed(2)}, z ${o.minZ.toFixed(2)}..${o.maxZ.toFixed(2)})`);
  }

  for (const p of problems) console.error(`[warehouse2] ${p}`);
}
