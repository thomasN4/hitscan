import * as THREE from 'three';
import { scene, solids, colliders } from './core.js';

const matWall   = new THREE.MeshLambertMaterial({ color: 0xc9a86c });
const matWall2  = new THREE.MeshLambertMaterial({ color: 0xa8895a });
const matCrate  = new THREE.MeshLambertMaterial({ color: 0x8a6d3f });
const matGround = new THREE.MeshLambertMaterial({ color: 0xb59a67 });

function addBox(x, y, z, w, h, d, mat) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y + h / 2, z);
  m.castShadow = m.receiveShadow = true;
  scene.add(m);
  colliders.push(new THREE.Box3().setFromObject(m));
  solids.push(m);
  return m;
}

export function buildMap() {
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), matGround);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  solids.push(ground);

  // Perimeter walls
  const W = 60, T = 2, H = 8;
  addBox(0, 0,  W, 2*W+T*2, H, T, matWall2);
  addBox(0, 0, -W, 2*W+T*2, H, T, matWall2);
  addBox( W, 0, 0, T, H, 2*W, matWall2);
  addBox(-W, 0, 0, T, H, 2*W, matWall2);

  // Long mid wall with a gap (doorway)
  addBox(-25, 0, 0, 55, 6, 2, matWall);
  addBox(35, 0, 0, 40, 6, 2, matWall);

  // Buildings / blocks
  addBox(-42, 0, -42, 24, 10, 24, matWall);
  addBox( 42, 0, -42, 20, 12, 20, matWall2);
  addBox(-42, 0,  42, 26, 9, 26, matWall2);
  addBox( 44, 0,  44, 22, 11, 22, matWall);

  // Crates for cover
  const crateSpots = [
    [-12,-20],[ -8,-23],[-10,-21.4], [15,-18], [18,-15],
    [ 25, 20],[ 28, 17],[ 26.5, 19], [-20, 25], [-24, 22],
    [ 5, 38], [ 8, 35], [ 6.5, 36.5], [-32,-8], [30,-30]
  ];
  crateSpots.forEach(([x,z]) => addBox(x, 0, z, 3, 3, 3, matCrate));
  // Stacked crates
  addBox(-9, 3, -21.4, 3, 3, 3, matCrate);
  addBox(27, 3, 18.5, 3, 3, 3, matCrate);
}
