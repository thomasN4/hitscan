// arena.ts — builds the de_dust-inspired arena geometry.
//
// All geometry goes through world.ts, which registers each solid as both a
// raycast target and a movement AABB. Do not add meshes to the scene
// directly: that is how you get walk-through / shoot-through bugs.
import * as THREE from 'three';
import { createCelMaterial } from '../core/materials';
import { scene } from '../core/engine';
import { addSolidBox, addStairs, colliders, coplanarTopOverlaps, registerSolid } from '../world';

const matWall   = createCelMaterial({ color: 0xc9a86c });
const matWall2  = createCelMaterial({ color: 0xa8895a });
const matCrate  = createCelMaterial({ color: 0x8a6d3f });
const matGround = createCelMaterial({ color: 0xb59a67 });
// Semantic tags for the opt-in illustration pass; no gameplay consumer.
matCrate.name = 'arena-crate';

/** Build the de_dust-inspired arena. Called once, via the maps/index.ts registry. */
export function buildArena(): void {
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), matGround);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  registerSolid(ground); // raycast target only — walking is bounded by the perimeter walls

  // Perimeter walls — x-runs own the corners; z-runs stop at their inner
  // faces so the four corner tops butt-join instead of overlapping (issue #74).
  const W = 60, T = 2, H = 8;
  addSolidBox(0, 0,  W, 2*W+T*2, H, T, matWall2);
  addSolidBox(0, 0, -W, 2*W+T*2, H, T, matWall2);
  addSolidBox( W, 0, 0, T, H, 2*(W-T/2), matWall2);
  addSolidBox(-W, 0, 0, T, H, 2*(W-T/2), matWall2);

  // Long mid wall with a gap (doorway) — splits the map into two halves;
  // bots spawn on the far side and path through the gap toward the player.
  addSolidBox(-25, 0, 0, 55, 6, 2, matWall);
  addSolidBox(35, 0, 0, 40, 6, 2, matWall);

  // Buildings / corner blocks
  addSolidBox(-42, 0, -42, 24, 10, 24, matWall).name = 'arena-building';
  addSolidBox( 42, 0, -42, 20, 12, 20, matWall2).name = 'arena-building';
  addSolidBox(-42, 0,  42, 26, 9, 26, matWall2).name = 'arena-building';
  addSolidBox( 44, 0,  44, 22, 11, 22, matWall).name = 'arena-building';

  // Crates for cover. Clusters of three are arranged so a crouching player
  // can hide behind the pair while using the stacked crate as a firing step.
  // Typed as pairs so the destructured x/z are numbers, not
  // number | undefined under noUncheckedIndexedAccess.
  // The third crate in each trio is offset so its top butt-joins rather than
  // overlapping the pair — same cover silhouette, no shared top area (issue #74).
  const crateSpots: [number, number][] = [
    [-12,-20],[ -8,-23],[ -9,-20], [15,-18], [18,-15],
    [ 25, 20],[ 28, 17],[ 28, 20], [-20, 25], [-24, 22],
    [ 5, 38], [ 8, 35], [ 8, 38], [-32,-8], [30,-30]
  ];
  crateSpots.forEach(([x,z]) => addSolidBox(x, 0, z, 3, 3, 3, matCrate));
  // Stacked crates (second tier, reachable by jump) — moved with their ground
  // trio so they stay stacked on it.
  addSolidBox(-8, 3, -20, 3, 3, 3, matCrate);
  addSolidBox(28.5, 3, 19.5, 3, 3, 3, matCrate);

  // Raised platform with two access routes — the arena's elevation feature:
  //   south face: an 8-step stair flight (8 × 0.3 = 2.4 top riser flush with
  //     the platform top; collision.ts climbs each riser automatically)
  //   west face: a 1.2 m jump-up ledge — above walk-step height, below the
  //     ~1.45 m jump apex, so it is a second route for the mobile only
  addSolidBox(26, 0, 35, 10, 2.4, 10, matWall2);          // platform x[21,31] z[30,40]
  addStairs(26, 0, 24, 4, 0.3, 0.75, 8, matWall, 'z+');   // stairs x[24,28] z 24→30
  addSolidBox(19.5, 0, 35, 3, 1.2, 3, matCrate);          // ledge x[18,21] z[33.5,36.5]

  if (import.meta.env.DEV) checkCoplanarTops();
}

// DEV-only: two up-facing tops sharing a plane and a footprint z-fight.
// Loud, not fatal, and statically dead in production — same shape as
// maps/warehouse2.ts:checkClearances.
function checkCoplanarTops(): void {
  for (const o of coplanarTopOverlaps(colliders)) {
    console.error(`[arena] coplanar top faces at y=${o.y.toFixed(2)} over ${o.area.toFixed(2)} m2 ` +
      `(x ${o.minX.toFixed(2)}..${o.maxX.toFixed(2)}, z ${o.minZ.toFixed(2)}..${o.maxZ.toFixed(2)})`);
  }
}
