// arena.ts — builds the de_dust-inspired arena geometry.
//
// Placement lives in ./arenaSpec.ts: buildArena attaches that spec to the
// world (kind -> material), scripts/mapSvg.mjs draws it to docs/maps/arena.svg.
// All geometry still goes through world.ts, which registers each solid as both
// a raycast target and a movement AABB. Do not add meshes to the scene
// directly: that is how you get walk-through / shoot-through bugs.
import * as THREE from 'three';
import { createCelMaterial } from '../core/materials';
import { scene } from '../core/engine';
import { addSolidBox, addStairs, colliders, coplanarTopOverlaps, registerSolid } from '../world';
import { ARENA_HALF, arenaSpec } from './arenaSpec';
import type { MapBoxKind } from './mapSpec';

const matWall   = createCelMaterial({ color: 0xc9a86c });
const matWall2  = createCelMaterial({ color: 0xa8895a });
const matCrate  = createCelMaterial({ color: 0x8a6d3f });
const matGround = createCelMaterial({ color: 0xb59a67 });
// Semantic tags for the opt-in illustration pass; no gameplay consumer.
matCrate.name = 'arena-crate';

/**
 * Spec kinds to the materials they wear in game. Partial on purpose: a kind
 * the spec grows that this map cannot paint is a loud startup error, not a
 * fallback material nobody chose.
 */
const ARENA_MATS: Partial<Record<MapBoxKind, THREE.Material>> = {
  wall: matWall,
  wall2: matWall2,
  crate: matCrate,
  stair: matWall,
};

function materialFor(kind: MapBoxKind): THREE.Material {
  const mat = ARENA_MATS[kind];
  if (!mat) throw new Error(`[arena] spec box kind '${kind}' has no material — extend ARENA_MATS`);
  return mat;
}

/** Build the de_dust-inspired arena. Called once, via the maps/index.ts registry. */
export function buildArena(): void {
  const spec = arenaSpec();
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(ARENA_HALF * 2, ARENA_HALF * 2), matGround);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  registerSolid(ground); // raycast target only — walking is bounded by the perimeter walls

  for (const b of spec.boxes) addSolidBox(b.x, b.y, b.z, b.w, b.h, b.d, materialFor(b.kind));
  for (const f of spec.flights) {
    // This map builds solid flights only; an open flight in the spec is a
    // spec/builder disagreement, not a second code path.
    if (f.open) throw new Error('[arena] open flight in spec — wire addOpenStairs before adding one');
    addStairs(f.x, f.y, f.z, f.width, f.stepH, f.stepD, f.count, materialFor(f.kind), f.dir);
  }

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
