// map.js — builds the arena geometry.
//
// All geometry goes through world.js, which registers each solid as both a
// raycast target and a movement AABB. Do not add meshes to the scene
// directly: that is how you get walk-through / shoot-through bugs.
import * as THREE from 'three';
import { scene } from './core/engine';
import { addSolidBox, registerSolid } from './world';

const matWall   = new THREE.MeshLambertMaterial({ color: 0xc9a86c });
const matWall2  = new THREE.MeshLambertMaterial({ color: 0xa8895a });
const matCrate  = new THREE.MeshLambertMaterial({ color: 0x8a6d3f });
const matGround = new THREE.MeshLambertMaterial({ color: 0xb59a67 });

/** Build the de_dust-inspired arena. Called once from main.js. */
export function buildMap() {
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), matGround);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  registerSolid(ground); // raycast target only — walking is bounded by the perimeter walls

  // Perimeter walls
  const W = 60, T = 2, H = 8;
  addSolidBox(0, 0,  W, 2*W+T*2, H, T, matWall2);
  addSolidBox(0, 0, -W, 2*W+T*2, H, T, matWall2);
  addSolidBox( W, 0, 0, T, H, 2*W, matWall2);
  addSolidBox(-W, 0, 0, T, H, 2*W, matWall2);

  // Long mid wall with a gap (doorway) — splits the map into two halves;
  // bots spawn on the far side and path through the gap toward the player.
  addSolidBox(-25, 0, 0, 55, 6, 2, matWall);
  addSolidBox(35, 0, 0, 40, 6, 2, matWall);

  // Buildings / corner blocks
  addSolidBox(-42, 0, -42, 24, 10, 24, matWall);
  addSolidBox( 42, 0, -42, 20, 12, 20, matWall2);
  addSolidBox(-42, 0,  42, 26, 9, 26, matWall2);
  addSolidBox( 44, 0,  44, 22, 11, 22, matWall);

  // Crates for cover. Clusters of three are arranged so a crouching player
  // can hide behind the pair while using the stacked crate as a firing step.
  const crateSpots = [
    [-12,-20],[ -8,-23],[-10,-21.4], [15,-18], [18,-15],
    [ 25, 20],[ 28, 17],[ 26.5, 19], [-20, 25], [-24, 22],
    [ 5, 38], [ 8, 35], [ 6.5, 36.5], [-32,-8], [30,-30]
  ];
  crateSpots.forEach(([x,z]) => addSolidBox(x, 0, z, 3, 3, 3, matCrate));
  // Stacked crates (second tier, reachable by jump)
  addSolidBox(-9, 3, -21.4, 3, 3, 3, matCrate);
  addSolidBox(27, 3, 18.5, 3, 3, 3, matCrate);
}
