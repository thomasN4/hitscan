// elevation.ts — a playtest map for watching how bots cope with height.
//
// Placement lives in ./elevationSpec.ts: buildElevation attaches that spec to
// the world (kind -> material), scripts/mapSvg.mjs draws it to
// docs/maps/elevation.svg. All geometry still goes through world.ts, as
// always — never scene.add a solid here.
import * as THREE from 'three';
import { createCelMaterial } from '../core/materials';
import { scene } from '../core/engine';
import { addSolidBox, addStairs, colliders, coplanarTopOverlaps, registerSolid } from '../world';
import { ELEVATION_HALF, elevationSpec } from './elevationSpec';
import type { MapBoxKind } from './mapSpec';

const matWall   = createCelMaterial({ color: 0xc9a86c });
const matWall2  = createCelMaterial({ color: 0xa8895a });
const matCrate  = createCelMaterial({ color: 0x8a6d3f });
const matGround = createCelMaterial({ color: 0xb59a67 });
const matSlab   = createCelMaterial({ color: 0x8f8577 }); // floors/decks read cooler than walls

/**
 * Spec kinds to the materials they wear in game. Partial on purpose: a kind
 * the spec grows that this map cannot paint is a loud startup error, not a
 * fallback material nobody chose. Parapets (kind 'rail') wear the tower's
 * wall finish.
 */
const ELEVATION_MATS: Partial<Record<MapBoxKind, THREE.Material>> = {
  wall: matWall,
  wall2: matWall2,
  crate: matCrate,
  deck: matSlab,
  rail: matWall2,
};

function materialFor(kind: MapBoxKind): THREE.Material {
  const mat = ELEVATION_MATS[kind];
  if (!mat) throw new Error(`[elevation] spec box kind '${kind}' has no material — extend ELEVATION_MATS`);
  return mat;
}

/** Build the elevation playtest map. Called once, via the maps/index.ts registry. */
export function buildElevation(): void {
  const spec = elevationSpec();
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(ELEVATION_HALF * 2, ELEVATION_HALF * 2), matGround);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  registerSolid(ground); // raycast target only — walking is bounded by the perimeter walls

  for (const b of spec.boxes) addSolidBox(b.x, b.y, b.z, b.w, b.h, b.d, materialFor(b.kind));
  for (const f of spec.flights) {
    // This map builds solid flights only; an open flight in the spec is a
    // spec/builder disagreement, not a second code path.
    if (f.open) throw new Error('[elevation] open flight in spec — wire addOpenStairs before adding one');
    addStairs(f.x, f.y, f.z, f.width, f.stepH, f.stepD, f.count, materialFor(f.kind), f.dir);
  }

  if (import.meta.env.DEV) checkCoplanarTops();
}

// DEV-only: two up-facing tops sharing a plane and a footprint z-fight.
// Loud, not fatal, and statically dead in production — same shape as
// maps/warehouse2.ts:checkClearances.
function checkCoplanarTops(): void {
  for (const o of coplanarTopOverlaps(colliders)) {
    console.error(`[elevation] coplanar top faces at y=${o.y.toFixed(2)} over ${o.area.toFixed(2)} m2 ` +
      `(x ${o.minX.toFixed(2)}..${o.maxX.toFixed(2)}, z ${o.minZ.toFixed(2)}..${o.maxZ.toFixed(2)})`);
  }
}
