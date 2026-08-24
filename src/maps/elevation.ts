// elevation.ts — a playtest map for watching how bots cope with height.
//
// Unlike arena.ts (a place to fight) this is an INSTRUMENT: every feature exists
// to make one bot behavior observable. Bot navigation is reactive steering with
// no pathfinding (sim/botBrains.ts) — a bot beelines at its target, backs off
// inside nearBand, drifts perpendicular, and reverses that drift when geometry
// rejects a step. It climbs stairs only because it shares the player's
// resolveVertical, and it cannot jump at all (BrainIntent is { step, wantShoot }).
// So the questions this map is built to answer are:
//
//   - does a bot ever find a staircase, and which one?
//   - what does it do when its target is directly overhead? (BrainView.dist is
//     PLANAR — bots.ts strips y — so "above me" reads as dist ~ 0 and the bot
//     backs off instead of seeking stairs)
//   - does it walk off unrailed edges, and does it survive?
//   - the jump-only hops (section D) are the control: no bot can ever use them,
//     so a bot ON the bridge proves it took a stair.
//
// Every dimension below is pinned to a collision constant; see the header
// comments on each section before moving anything. Geometry goes through
// world.ts, as always — never scene.add a solid here.
import * as THREE from 'three';
import { scene } from '../core/engine';
import { addSolidBox, addStairs, registerSolid } from '../world';

const matWall   = new THREE.MeshLambertMaterial({ color: 0xc9a86c });
const matWall2  = new THREE.MeshLambertMaterial({ color: 0xa8895a });
const matCrate  = new THREE.MeshLambertMaterial({ color: 0x8a6d3f });
const matGround = new THREE.MeshLambertMaterial({ color: 0xb59a67 });
const matSlab   = new THREE.MeshLambertMaterial({ color: 0x8f8577 }); // floors/decks read cooler than walls

// ---------- Elevation constants ----------
// The whole map is built from these four numbers so a change stays consistent.
/** Riser height of every flight. MUST stay <= collision.ts:STEP_HEIGHT (0.3) or the treads become walls. */
const STEP_H = 0.3;
/** Tread depth of every flight. */
const STEP_D = 0.75;
/**
 * Walk surface of every upper level.
 *
 * 3.6 = 12 risers exactly, and it clears the ~1.45 m jump apex (JUMP_VEL 8 /
 * GRAVITY 22) by a wide margin — resolveVertical does no head-bump check while
 * rising, so a walkable top within one jump of the floor below could be jumped
 * THROUGH and landed on.
 */
const DECK_Y = 3.6;
/** Slab thickness; DECK_Y - SLAB_T = 3.2 m of headroom underneath, well over collision.ts:HEAD_HEIGHT (2.0). */
const SLAB_T = 0.4;

/** Build the elevation playtest map. Called once, via the maps/index.ts registry. */
export function buildElevation(): void {
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), matGround);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  registerSolid(ground); // raycast target only — walking is bounded by the perimeter walls

  // Perimeter walls, same footprint as the arena so the hardcoded bot spawn
  // bands in bots.ts (x +-45, |z| 20..55) stay valid without a code change.
  const W = 60, T = 2, H = 8;
  addSolidBox(0, 0,  W, 2*W+T*2, H, T, matWall2);
  addSolidBox(0, 0, -W, 2*W+T*2, H, T, matWall2);
  addSolidBox( W, 0, 0, T, H, 2*W, matWall2);
  addSolidBox(-W, 0, 0, T, H, 2*W, matWall2);

  buildTwoStoryBuilding();
  buildBridgeAndTower();
  buildPlateau();
  buildJumpOnlyRoute();
  buildCover();
}

// ---------- A. Two-story building — map centre, x [-14,14], z [-12,12] ----------
// Straddles the mid-line, so neither team can cross the map without meeting it.
// Two independent routes to floor 2 (an internal flight through a stairwell
// hole, an external flight up the south face) — that is what lets a playtest
// distinguish "bots only ever use the outside stair" from "bots never go up".
const BLD_X = 14, BLD_Z = 12;
/** Ground-floor wall height; the slab sits on top of it. */
const BLD_WALL_H = DECK_Y - SLAB_T; // 3.2

function buildTwoStoryBuilding(): void {
  // Ground floor: doorways at N/S x [-2,2] and W z [-2,2]; east face solid.
  addSolidBox(-8, 0, -BLD_Z, 12, BLD_WALL_H, 1, matWall);
  addSolidBox( 8, 0, -BLD_Z, 12, BLD_WALL_H, 1, matWall);
  addSolidBox(-8, 0,  BLD_Z, 12, BLD_WALL_H, 1, matWall);
  addSolidBox( 8, 0,  BLD_Z, 12, BLD_WALL_H, 1, matWall);
  addSolidBox(-BLD_X, 0, -7, 1, BLD_WALL_H, 10, matWall);
  addSolidBox(-BLD_X, 0,  7, 1, BLD_WALL_H, 10, matWall);
  addSolidBox( BLD_X, 0,  0, 1, BLD_WALL_H, 24, matWall);

  // Second-floor slab, in four pieces around a stairwell hole at
  // x [2,6], z [-9,0]. The slab edges either side of the hole act as
  // stairwell walls for anyone drifting off the flight — intended.
  addSolidBox(-6, BLD_WALL_H, 0, 16, SLAB_T, 24, matSlab);
  addSolidBox(10, BLD_WALL_H, 0,  8, SLAB_T, 24, matSlab);
  addSolidBox( 4, BLD_WALL_H,  6, 4, SLAB_T, 12, matSlab);
  addSolidBox( 4, BLD_WALL_H, -10.5, 4, SLAB_T, 3, matSlab);

  // Internal flight: 12 x 0.3 tops out at exactly DECK_Y, flush with the
  // slab's south edge at z = 0.
  addStairs(4, 0, -9, 4, STEP_H, STEP_D, 12, matWall2, 'z+');

  // External flight up the south face, arriving at the parapet gap x [6,10].
  // Ascends 'z-', so the tall end lands against the building at z = 12.5.
  // Join caveat: top tread and deck never touch — the wall top shows through
  // a 0.5-deep notch, SLAB_T under deck level. It holds because a walker's
  // circle (player 0.45 / bot 0.5) bridges the notch while moving; shrink a
  // radius or grow SLAB_T and re-check this join and the tower flight's slot.
  addStairs(8, 0, 21.5, 4, STEP_H, STEP_D, 12, matWall2, 'z-');

  // Parapet: 1.0 m is chosen, not arbitrary. Above STEP_HEIGHT so it contains
  // walkers, but below a standing eye (feet 3.6 + 1.9 = 5.5 vs top 4.6) so
  // line of sight works BOTH ways — you can watch and shoot bots upstairs from
  // the ground, and they can answer.
  const PARAPET_H = 1.0, PARAPET_T = 0.5;
  // South: gap x [6,10] receives the external stair.
  addSolidBox(-4, DECK_Y,  BLD_Z, 20, PARAPET_H, PARAPET_T, matWall2);
  addSolidBox(12, DECK_Y,  BLD_Z,  4, PARAPET_H, PARAPET_T, matWall2);
  // North and west gaps are OPEN EDGES over a 3.6 m drop — the fall test.
  addSolidBox(-8, DECK_Y, -BLD_Z, 12, PARAPET_H, PARAPET_T, matWall2);
  addSolidBox( 8, DECK_Y, -BLD_Z, 12, PARAPET_H, PARAPET_T, matWall2);
  addSolidBox(-BLD_X, DECK_Y, -7, PARAPET_T, PARAPET_H, 10, matWall2);
  addSolidBox(-BLD_X, DECK_Y,  7, PARAPET_T, PARAPET_H, 10, matWall2);
  // East gap z [-2,2] is the bridge mouth.
  addSolidBox( BLD_X, DECK_Y, -7, PARAPET_T, PARAPET_H, 10, matWall2);
  addSolidBox( BLD_X, DECK_Y,  7, PARAPET_T, PARAPET_H, 10, matWall2);
}

// ---------- B. Bridge + tower — narrow high traverse ----------
function buildBridgeAndTower(): void {
  // Deliberately unrailed and only 4 m wide: a bot crossing at strafeFactor 0.7
  // will eventually drift off the side. Underside at 3.2 m clears HEAD_HEIGHT,
  // so the ground below stays walkable and the bridge doubles as overhead cover.
  addSolidBox(22, DECK_Y - SLAB_T, 0, 16, SLAB_T, 4, matSlab);

  // Tower deck, flush with the bridge at x = 30.
  addSolidBox(35, 0, 0, 10, DECK_Y, 12, matWall2);

  // Tower stair, ascending 'z-' so the tall end abuts the tower's south face
  // at z = 6.5. ('z+' from z = 6.5 would build the flight backwards — tall end
  // pointing away from the thing it is supposed to reach.)
  addStairs(35, 0, 15.5, 4, STEP_H, STEP_D, 12, matWall2, 'z-');
}

// ---------- C. West plateau — long shallow ascent over the T spawn band ----------
function buildPlateau(): void {
  // 3.0 m rather than DECK_Y: a second, lower tier makes "bot shooting down at
  // a bot on another tier" testable without either being at deck height.
  addSolidBox(-38, 0, -30, 22, 3.0, 22, matWall2);
  // 10 x 0.3 = 3.0, flush with the plateau's east face at x = -27.
  addStairs(-19.5, 0, -30, 6, STEP_H, STEP_D, 10, matWall, 'x-');
}

// ---------- D. Jump-only route — the control case ----------
function buildJumpOnlyRoute(): void {
  // 1.2 m hops: over STEP_HEIGHT so nobody walks up them, under the ~1.45 m
  // jump apex so the PLAYER can. Bots have no jump in BrainIntent at all, so
  // this route is player-exclusive by construction — which is what makes a bot
  // seen on the bridge proof that it climbed a stair.
  addSolidBox(18, 0, 8, 4, 1.2, 4, matCrate);  // ground -> 1.2
  addSolidBox(18, 0, 4, 4, 2.4, 4, matCrate);  // 1.2 -> 2.4, then 2.4 -> bridge (3.6)
}

// ---------- E. Cover ----------
function buildCover(): void {
  // Typed as pairs so the destructured x/z are numbers, not number | undefined
  // under noUncheckedIndexedAccess (same reason as arena.ts).
  const crateSpots: [number, number][] = [
    [-22, -14], [-25, -11], [-23.5, -12.5],
    [ 24, -18], [ 27, -21],
    [-30,  16], [-33,  19], [-31.5, 17.5],
    [ 40,  26], [ 43,  23],
    [ -6,  30], [ -3,  33],
    [ 46, -14], [-46,   4],
  ];
  crateSpots.forEach(([x, z]) => addSolidBox(x, 0, z, 3, 3, 3, matCrate));
  // Second tier, reachable by jump only — bots stay on the ground beside them.
  addSolidBox(-23.5, 3, -12.5, 3, 3, 3, matCrate);
  addSolidBox(-31.5, 3,  17.5, 3, 3, 3, matCrate);
}
