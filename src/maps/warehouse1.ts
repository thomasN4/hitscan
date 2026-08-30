// warehouse1.ts — a distribution-warehouse combat map.
//
// The second full combat map after arena.ts, built on a different spatial
// grammar: where the arena is blocks scattered in open ground, this is an
// AISLE GRID. Six racking rows run north-south, cut by two cross-aisles per
// side, so almost every fight happens along a lane with a hard edge — and
// leaving a lane means committing to a crossing.
//
// Three ideas hold it together:
//
//   - The mezzanine is the one place that sees over the racks. A standing eye
//     on the deck is at 3.6 + 1.9 = 5.5 m, above the 4.0 m inner rows; the
//     6.0 m outer rows deliberately stay above it, so the flanks are the
//     answer to someone holding the deck. Two stairs, mirrored across z = 0,
//     mean neither team starts closer to it.
//   - The docks give each side a raised lip to fight off, reachable by a short
//     flight so bots can use it too.
//   - The conveyors are the player's alone. At 0.9 m they are over
//     STEP_HEIGHT so nobody walks them, and under the ~1.45 m jump apex so
//     the player vaults them — bots have no jump in BrainIntent and must walk
//     the 4.5 m gap at the lane's inner edge. Same mechanism as
//     maps/elevation.ts's jump-only hops, used here for a mobility edge
//     rather than as a proof.
//
// The footprint is the arena's exactly (120 x 120, walls at +-60) — a map
// design choice, not a constraint. Bot spawns are configured per map
// (core/state.ts:BOT_SPAWNS), so a different footprint would simply ship its
// own spawn boxes alongside it.
//
// All geometry goes through world.ts, which registers each solid as both a
// raycast target and a movement AABB. Do not add meshes to the scene
// directly: that is how you get walk-through / shoot-through bugs. Every
// staircase goes through addStairs specifically, which is also what publishes
// its NavLink — a hand-built flight is one bots cannot see.
import * as THREE from 'three';
import { scene } from '../core/engine';
import { addSolidBox, addStairs, registerSolid } from '../world';

const matFloor   = new THREE.MeshLambertMaterial({ color: 0x7a7c80 }); // sealed concrete
const matShell   = new THREE.MeshLambertMaterial({ color: 0x8d9199 }); // corrugated shed wall
const matOffice  = new THREE.MeshLambertMaterial({ color: 0xa8adb4 });
const matRack    = new THREE.MeshLambertMaterial({ color: 0x3f6a8c }); // painted steel racking
const matDeck    = new THREE.MeshLambertMaterial({ color: 0x848b91 }); // mezzanine + dock slabs
// Galvanised, and kept well clear of matFloor's value on purpose: stairs
// and parapets are the geometry a player most needs to pick out at a
// glance, and at close values they vanish into the concrete.
const matStair   = new THREE.MeshLambertMaterial({ color: 0x9aa2ab });
const matCrate   = new THREE.MeshLambertMaterial({ color: 0x8a6d3f }); // pallet stacks
const matSteel   = new THREE.MeshLambertMaterial({ color: 0xb0b4bb }); // conveyors

// ---------- Dimensions ----------
// Every number the map is built from, each pinned to the engine constant that
// decides it. Change one here rather than at a use site.

/** Riser height of every flight. MUST stay <= collision.ts:STEP_HEIGHT (0.3) or treads become walls. */
const STEP_H = 0.3;
/** Tread depth of every flight. */
const STEP_D = 0.75;
/** Mezzanine walk surface. 3.6 = 12 risers exactly, and far above the ~1.45 m jump apex. */
const DECK_Y = 3.6;
/** Slab thickness; DECK_Y - SLAB_T = 3.2 m of headroom underneath, over collision.ts:HEAD_HEIGHT (2.0). */
const SLAB_T = 0.4;
/**
 * Minimum clear width of anything meant to be walked down.
 *
 * nav.ts samples at CELL = 1 m with NAV_RADIUS = 0.5, so a gap of width w
 * leaves a standable band of w - 1. Four metres guarantees three sampled cells
 * across it whatever phase the grid lands on; three would be at the mercy of
 * where the level's bounds happen to start. Enforced, not just documented —
 * see checkAisles() at the foot of this file.
 */
const AISLE_MIN = 4;

/** Perimeter: half-extent, wall thickness, wall height — the arena's numbers. */
const W = 60, T = 2, H = 8;

/** Build the warehouse. Called once, via the maps/index.ts registry. */
export function buildWarehouse1(): void {
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), matFloor);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  registerSolid(ground); // raycast target only — walking is bounded by the perimeter walls

  addSolidBox(0, 0,  W, 2*W+T*2, H, T, matShell);
  addSolidBox(0, 0, -W, 2*W+T*2, H, T, matShell);
  addSolidBox( W, 0, 0, T, H, 2*W, matShell);
  addSolidBox(-W, 0, 0, T, H, 2*W, matShell);

  buildMezzanine();
  buildRacking();
  buildDocks();
  buildConveyors();
  buildPallets();

  if (import.meta.env.DEV) checkAisles();
}

// ---------- A. Mezzanine office — map centre, x [-10,10], z [-8,8] ----------
// The contested high ground, and the only structure straddling the mid-line.
// Unlike maps/elevation.ts's two-story building there is NO internal flight
// and no stairwell hole: that building exists to test whether bots find an
// interior route, this one wants its ground floor to be a fight space and its
// slab to be a single box with no interior edges to wedge on
// (collision.ts:96-101).

/** Half-extents of the office's OUTER faces; walls are 1 m thick, centred 0.5 m inside. */
const OFF_X = 10, OFF_Z = 8;
/** Ground-floor wall height; the slab sits on top of it. */
const OFF_WALL_H = DECK_Y - SLAB_T; // 3.2

function buildMezzanine(): void {
  // Ground floor, doorways 4 m wide in ALL FOUR faces — routable from every
  // approach, so holding the inside is a choice rather than a chokepoint.
  // North/south doorway x [-2,2]; east/west doorway z [-2,2].
  addSolidBox(-6, 0,  OFF_Z - 0.5, 8, OFF_WALL_H, 1, matOffice);
  addSolidBox( 6, 0,  OFF_Z - 0.5, 8, OFF_WALL_H, 1, matOffice);
  addSolidBox(-6, 0, -OFF_Z + 0.5, 8, OFF_WALL_H, 1, matOffice);
  addSolidBox( 6, 0, -OFF_Z + 0.5, 8, OFF_WALL_H, 1, matOffice);
  addSolidBox(-OFF_X + 0.5, 0, -5, 1, OFF_WALL_H, 6, matOffice);
  addSolidBox(-OFF_X + 0.5, 0,  5, 1, OFF_WALL_H, 6, matOffice);
  addSolidBox( OFF_X - 0.5, 0, -5, 1, OFF_WALL_H, 6, matOffice);
  addSolidBox( OFF_X - 0.5, 0,  5, 1, OFF_WALL_H, 6, matOffice);

  // One slab over the whole footprint. Its edges are flush with the walls'
  // outer faces at x +-10 / z +-8, which is what lets both flights join it
  // without the half-tread notch maps/elevation.ts documents.
  addSolidBox(0, OFF_WALL_H, 0, 2*OFF_X, SLAB_T, 2*OFF_Z, matDeck);

  // Two flights, mirrored across z = 0. 12 x 0.3 = 3.6 tops out level with the
  // deck, and 12 x 0.75 = 9 m of run puts the far edge of the last tread
  // exactly on the slab edge: 17 - 9 = 8 south, -17 + 9 = -8 north.
  addStairs(0, 0,  17, 4, STEP_H, STEP_D, 12, matStair, 'z-');
  addStairs(0, 0, -17, 4, STEP_H, STEP_D, 12, matStair, 'z+');

  // Parapet. 1.0 m is chosen for the reason maps/elevation.ts spells out:
  // above STEP_HEIGHT so it contains walkers, but below a standing eye on the
  // deck (3.6 + 1.9 = 5.5 vs top 4.6), so you can be seen and shot from the
  // floor exactly as easily as you can shoot down from it.
  const PAR_H = 1.0, PAR_T = 0.5;
  // North and south: gaps at x [-2,2] receive the flights.
  addSolidBox(-6, DECK_Y,  OFF_Z - PAR_T/2, 8, PAR_H, PAR_T, matStair);
  addSolidBox( 6, DECK_Y,  OFF_Z - PAR_T/2, 8, PAR_H, PAR_T, matStair);
  addSolidBox(-6, DECK_Y, -OFF_Z + PAR_T/2, 8, PAR_H, PAR_T, matStair);
  addSolidBox( 6, DECK_Y, -OFF_Z + PAR_T/2, 8, PAR_H, PAR_T, matStair);
  // East railed; WEST deliberately open over a 3.6 m drop — a one-way exit
  // under pressure, and the reason the deck is not a safe place to camp.
  addSolidBox(OFF_X - PAR_T/2, DECK_Y, 0, PAR_T, PAR_H, 2*OFF_Z, matStair);
}

// ---------- B. Racking — the map's lanes ----------
// Six rows along z. Aisle arithmetic, all at or over AISLE_MIN:
//   office outer face 10 -> rack 14.5           = 4.5
//   rack 17.5          -> rack 24.5             = 7
//   rack 27.5          -> rack 34.5             = 7
//   rack 37.5          -> perimeter inner 59    = 21.5   (the flank lane)
// and the two cross-aisles between segments are 6 m each.
//
// Each row is three segments rather than one long box so the lanes are
// permeable; one box per segment rather than a modelled frame of posts and
// shelves, which would be ~72 colliders for the same silhouette and would
// show up in nav.ts's build time.

/** Centre x of each rack row, mirrored to negative x. */
const RACK_X = [16, 26, 36];
/** Centre z of each segment within a row. */
const RACK_Z = [-16, 0, 16];
/** Row thickness across the aisle (m). */
const RACK_W = 3;
/** Segment length along the aisle (m). */
const RACK_D = 10;
/** Inner and mid rows: over a ground eye (1.7), under a mezzanine eye (5.5). */
const RACK_H_LOW = 4.0;
/** Outer rows: over the mezzanine eye too, so the flank lanes stay concealed from the deck. */
const RACK_H_TALL = 6.0;

function buildRacking(): void {
  for (const bx of RACK_X) {
    const h = bx === 36 ? RACK_H_TALL : RACK_H_LOW;
    for (const bz of RACK_Z) {
      addSolidBox( bx, 0, bz, RACK_W, h, RACK_D, matRack);
      addSolidBox(-bx, 0, bz, RACK_W, h, RACK_D, matRack);
    }
  }
}

// ---------- C. Loading docks — both ends ----------
// A 1.2 m lip to fight off, backing onto the end wall. 1.2 is jump-up height,
// so the flights are not decoration: without them bots could never get up, and
// half the depth of each spawn band would be dead ground to them.

/** Dock top; over STEP_HEIGHT, under the jump apex — hence the flights. */
const DOCK_H = 1.2;

function buildDocks(): void {
  for (const s of [1, -1] as const) {
    // x [-30,30], z from the perimeter inner face at 59 out to 45.
    addSolidBox(0, 0, s * 52, 60, DOCK_H, 14, matDeck);
    // 4 x 0.3 = 1.2, 4 x 0.75 = 3 m of run: 42 + 3 = 45, flush with the face.
    // Two per dock so a bot arriving down either flank finds one.
    addStairs( 24, 0, s * 42, 6, STEP_H, STEP_D, 4, matStair, s > 0 ? 'z+' : 'z-');
    addStairs(-24, 0, s * 42, 6, STEP_H, STEP_D, 4, matStair, s > 0 ? 'z+' : 'z-');
  }
}

// ---------- D. Conveyors — the player-only shortcut ----------
// Two per flank, spanning from x = 42 out to the perimeter, so the only way
// past them on foot is the 4.5 m gap at the racking's outer edge (37.5 -> 42,
// over AISLE_MIN) or the pocket route between them. A player vaults straight
// over; a bot cannot, and takes the long way. That asymmetry is the point —
// it is the same construction as maps/elevation.ts's jump-only hops, and it
// holds only while BrainIntent stays { step, wantShoot } with no jump.

/** Over collision.ts:STEP_HEIGHT (0.3), under the ~1.45 m jump apex. */
const CONVEYOR_H = 0.9;

function buildConveyors(): void {
  for (const sx of [1, -1] as const) {
    for (const sz of [1, -1] as const) {
      addSolidBox(sx * 50.5, 0, sz * 12, 17, CONVEYOR_H, 1.5, matSteel);
    }
  }
}

// ---------- E. Pallet stacks ----------
// Cover for the open ground only — the dock yards and the flank lanes. None
// in the aisles: an aisle is a route, and a 3 m crate in a 7 m aisle leaves
// 2 m either side, under AISLE_MIN, which would cost the lane its nav cells.
//
// Typed as pairs so the destructured x/z are numbers, not number | undefined
// under noUncheckedIndexedAccess (same reason as arena.ts).
function buildPallets(): void {
  const spots: [number, number][] = [
    // South dock yard
    [-14, 30], [-11, 33], [-12.5, 31.5],
    [ 14, 30], [ 17, 33], [ 15.5, 31.5],
    [  0, 26], [  3, 24],
    // North dock yard
    [-14, -30], [-11, -33], [-12.5, -31.5],
    [ 14, -30], [ 17, -33], [ 15.5, -31.5],
    [  0, -26], [  3, -24],
    // Flank lanes
    [ 46, 30], [-46, 30], [ 46, -30], [-46, -30],
    [ 46,  0], [-46,  0],
  ];
  spots.forEach(([x, z]) => addSolidBox(x, 0, z, 3, 3, 3, matCrate));
  // Second tier, reachable by jump only, so bots stay on the ground beside
  // them. A 6 m perch sees over the 4.0 m rows into the mid — strong, and
  // paid for with no cover of its own.
  addSolidBox(-12.5, 3,  31.5, 3, 3, 3, matCrate);
  addSolidBox( 15.5, 3, -31.5, 3, 3, 3, matCrate);
}

// ---------- Aisle check ----------
// Loud, not fatal, and DEV-only — the same shape as main.ts's weapon
// validation, and statically dead in production builds.
//
// The lanes are what this map IS, and the failure mode is quiet: an aisle
// narrowed under AISLE_MIN still looks walkable and still lets the PLAYER
// through, but stops holding sampled nav cells, so bots simply never use it
// and the map slowly reads as "the AI is broken" instead of "a rack moved
// 2 m". Widths are derived from the same constants the geometry is built
// from, so this cannot drift from what was actually placed.

/** Perimeter wall inner face on the +x side. */
const SHELL_INNER = W - T / 2;
/** Inner (low-x) end of a flank conveyor — see buildConveyors. */
const CONVEYOR_INNER = 42;

function checkAisles(): void {
  const edge = (i: number, side: -1 | 1) => RACK_X[i]! + side * RACK_W / 2;
  const lanes: [string, number][] = [
    ['office to inner rack', edge(0, -1) - OFF_X],
    ['inner to mid rack', edge(1, -1) - edge(0, 1)],
    ['mid to outer rack', edge(2, -1) - edge(1, 1)],
    ['outer rack to conveyor mouth', CONVEYOR_INNER - edge(2, 1)],
    ['flank lane', SHELL_INNER - edge(2, 1)],
    ['cross-aisle', (RACK_Z[1]! - RACK_D / 2) - (RACK_Z[0]! + RACK_D / 2)],
    ['office doorway', 2 * OFF_X - 2 * 8],
  ];
  for (const [name, width] of lanes) {
    if (width < AISLE_MIN) {
      console.error(`[warehouse1] ${name} is ${width} m, under AISLE_MIN ${AISLE_MIN}`
        + ' — bots will not route through it');
    }
  }
}
