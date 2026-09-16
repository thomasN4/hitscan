// warehouse1.ts — a distribution-warehouse combat map.
//
// Placement lives in ./warehouse1Spec.ts: buildWarehouse1 attaches that spec
// to the world (kind -> material), scripts/mapSvg.mjs draws it to
// docs/maps/warehouse1.png. All geometry still goes through world.ts. Every
// staircase still goes through addStairs specifically, which is also what
// publishes its NavLink — a hand-built flight is one bots cannot see.
import * as THREE from 'three';
import { createCelMaterial } from '../core/materials';
import { scene } from '../core/engine';
import { addSolidBox, addStairs, colliders, coplanarTopOverlaps, registerSolid } from '../world';
import {
  WAREHOUSE1_CONVEYOR_INNER, WAREHOUSE1_HALF, WAREHOUSE1_OFF, WAREHOUSE1_RACK,
  WAREHOUSE1_SHELL_INNER, warehouse1Spec,
} from './warehouse1Spec';
import type { MapBoxKind } from './mapSpec';

const matFloor   = createCelMaterial({ color: 0x7a7c80 }); // sealed concrete
const matShell   = createCelMaterial({ color: 0x8d9199 }); // corrugated shed wall
const matOffice  = createCelMaterial({ color: 0xa8adb4 });
const matRack    = createCelMaterial({ color: 0x3f6a8c }); // painted steel racking
const matDeck    = createCelMaterial({ color: 0x848b91 }); // mezzanine + dock slabs
// Galvanised, and kept well clear of matFloor's value on purpose: stairs
// and parapets are the geometry a player most needs to pick out at a
// glance, and at close values they vanish into the concrete.
const matStair   = createCelMaterial({ color: 0x9aa2ab });
const matCrate   = createCelMaterial({ color: 0x8a6d3f }); // pallet stacks
const matSteel   = createCelMaterial({ color: 0xb0b4bb }); // conveyors

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

/**
 * Spec kinds to the materials they wear in game. Partial on purpose: a kind
 * the spec grows that this map cannot paint is a loud startup error, not a
 * fallback material nobody chose.
 */
const WAREHOUSE1_MATS: Partial<Record<MapBoxKind, THREE.Material>> = {
  wall: matShell,
  wall2: matOffice,
  deck: matDeck,
  rail: matStair,
  stair: matStair,
  rack: matRack,
  crate: matCrate,
  conveyor: matSteel,
};

function materialFor(kind: MapBoxKind): THREE.Material {
  const mat = WAREHOUSE1_MATS[kind];
  if (!mat) throw new Error(`[warehouse1] spec box kind '${kind}' has no material — extend WAREHOUSE1_MATS`);
  return mat;
}

/** Build the warehouse. Called once, via the maps/index.ts registry. */
export function buildWarehouse1(): void {
  const spec = warehouse1Spec();
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(WAREHOUSE1_HALF * 2, WAREHOUSE1_HALF * 2), matFloor);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  registerSolid(ground); // raycast target only — walking is bounded by the perimeter walls

  for (const b of spec.boxes) addSolidBox(b.x, b.y, b.z, b.w, b.h, b.d, materialFor(b.kind));
  for (const f of spec.flights) {
    // This map builds solid flights only; an open flight in the spec is a
    // spec/builder disagreement, not a second code path.
    if (f.open) throw new Error('[warehouse1] open flight in spec — wire addOpenStairs before adding one');
    addStairs(f.x, f.y, f.z, f.width, f.stepH, f.stepD, f.count, materialFor(f.kind), f.dir);
  }

  if (import.meta.env.DEV) checkAisles();
}

// ---------- Aisle check ----------
// Loud, not fatal, and DEV-only — the same shape as main.ts's weapon
// validation, and statically dead in production builds.
//
// The lanes are what this map IS, and the failure mode is quiet: an aisle
// narrowed under AISLE_MIN still looks walkable and still lets the PLAYER
// through, but stops holding sampled nav cells, so bots simply never use it
// and the map slowly reads as "the AI is broken" instead of "a rack moved
// 2 m". Widths are derived from the same spec constants the geometry is built
// from, so this cannot drift from what was actually placed.
function checkAisles(): void {
  const RACK = WAREHOUSE1_RACK;
  const edge = (i: number, side: -1 | 1) => RACK.x[i]! + side * RACK.w / 2;
  const lanes: [string, number][] = [
    ['office to inner rack', edge(0, -1) - WAREHOUSE1_OFF.x],
    ['inner to mid rack', edge(1, -1) - edge(0, 1)],
    ['mid to outer rack', edge(2, -1) - edge(1, 1)],
    ['outer rack to conveyor mouth', WAREHOUSE1_CONVEYOR_INNER - edge(2, 1)],
    ['flank lane', WAREHOUSE1_SHELL_INNER - edge(2, 1)],
    ['cross-aisle', (RACK.z[1]! - RACK.d / 2) - (RACK.z[0]! + RACK.d / 2)],
    ['office doorway', 2 * WAREHOUSE1_OFF.x - 2 * 8],
  ];
  for (const [name, width] of lanes) {
    if (width < AISLE_MIN) {
      console.error(`[warehouse1] ${name} is ${width} m, under AISLE_MIN ${AISLE_MIN}`
        + ' — bots will not route through it');
    }
  }
  for (const o of coplanarTopOverlaps(colliders)) {
    console.error(`[warehouse1] coplanar top faces at y=${o.y.toFixed(2)} over ${o.area.toFixed(2)} m2 ` +
      `(x ${o.minX.toFixed(2)}..${o.maxX.toFixed(2)}, z ${o.minZ.toFixed(2)}..${o.maxZ.toFixed(2)})`);
  }
}
