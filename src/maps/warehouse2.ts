// warehouse2.ts — "vertical stack": a roofed shed with a catwalk ring, inside
// a fenced yard.
//
// Placement lives in ./warehouse2Spec.ts: buildWarehouse2 attaches that spec
// to the world (kind -> material), scripts/mapSvg.mjs draws it to
// docs/maps/warehouse2.svg. All geometry still goes through world.ts.
//
// The third full combat map, and the first whose spatial grammar is VERTICAL:
// an 8 m catwalk ring runs the full perimeter at 5.1 m, and the 44 x 24 middle
// is cut away entirely, so the ring looks down on the floor and the floor
// looks up at the ring. Five ideas hold it together — the ring sees everything
// and hides nothing (rail tops out at 6.2, under a deck eye at 7.0); the shell
// wall is two registers with independent gaps; the main flights stand in the
// open void and are OPEN; the cargo lifts cycle floor <-> ring; spawns are
// ASYMMETRIC (CTs in the yard, Ts already on the ring). Numbers behind each
// live beside the geometry in the spec file.
import * as THREE from 'three';
import { createCelMaterial } from '../core/materials';
import { scene } from '../core/engine';
import {
  addSolidBox, addOpenStairs, addElevator, registerSolid, registerGroupParts,
  createSolidBox, colliders, coplanarTopOverlaps,
} from '../world';
import { STEP_HEIGHT, HEAD_HEIGHT } from '../collision';
import {
  SHELL_X, SHELL_Z, YARD_X, YARD_Z, DECK_Y, SLAB_T, STEP_H, RISERS, STEP_D,
  INNER_X, INNER_Z, VOID_X, VOID_Z, RACK_Z, RACK_D, RACK_W, CORNER_X, CORNER_SIZE,
  CORNER_H, PAD_H, PAD_W, LIFT_GAP_MARGIN, ROOF_Y, FLIGHT_MOUTH_X,
  DOOR_N, DOOR_S, DOOR_W, DOOR_E, warehouse2Spec,
} from './warehouse2Spec';
import type { MapBox, MapBoxKind } from './mapSpec';

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

/**
 * Minimum clear width of anything meant to be walked down (same reasoning as
 * warehouse1: nav.ts samples at CELL = 1 m with NAV_RADIUS = 0.5). Enforced by
 * checkClearances() below.
 */
const AISLE_MIN = 4;

/**
 * Spec kinds to the materials they wear in game. Partial on purpose: a kind
 * the spec grows that this map cannot paint is a loud startup error, not a
 * fallback material nobody chose.
 */
const WAREHOUSE2_MATS: Partial<Record<MapBoxKind, THREE.Material>> = {
  wall: matShell,
  deck: matSlab,
  rail: matRail,
  stair: matStair,
  rack: matRack,
  crate: matCrate,
  fence: matFence,
  post: matFence,
  roof: matRoof,
  glass: matGlass,
  beam: matBeam,
};

function materialFor(kind: MapBoxKind): THREE.Material {
  const mat = WAREHOUSE2_MATS[kind];
  if (!mat) throw new Error(`[warehouse2] spec box kind '${kind}' has no material — extend WAREHOUSE2_MATS`);
  return mat;
}

/** Build the vertical-stack warehouse. Called once, via the maps/index.ts registry. */
export function buildWarehouse2(): void {
  const spec = warehouse2Spec();

  // Two ground planes, both raycast-only: movement is bounded by the fence, and
  // a rotated PlaneGeometry has no usable AABB anyway (world.ts:registerSolid).
  // The shell floor is lifted 1 cm so it wins the depth test against the yard
  // rather than z-fighting it.
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

  // The fence is BLOCKING BUT NOT SHOOTABLE — the inverse of the range
  // target's post, and the other half of why registerGroupParts takes the two
  // lists separately. Chain-link stops a body and not a bullet, and panels in
  // `solids` would also block bot line-of-sight through them. The posts are
  // solid steel and go in both. Shadow flags match the old hand-built fence:
  // posts cast, panels do not.
  const fenceGroup = new THREE.Group();
  const fencePanels: THREE.Mesh[] = [];
  const fencePosts: THREE.Mesh[] = [];
  const attachBox = (b: MapBox): void => {
    if (b.kind === 'fence' || b.kind === 'post') {
      const mesh = createSolidBox(b.x, b.y, b.z, b.w, b.h, b.d, materialFor(b.kind));
      mesh.castShadow = b.kind === 'post';
      mesh.receiveShadow = false;
      fenceGroup.add(mesh);
      (b.kind === 'post' ? fencePosts : fencePanels).push(mesh);
      return;
    }
    const mesh = addSolidBox(b.x, b.y, b.z, b.w, b.h, b.d, materialFor(b.kind));
    // The glazed strips admit the sun like skylights: solid to bullets and
    // bodies, but not shadow casters — a fully opaque roof leaves the interior
    // lit by the hemisphere alone, at less than half warehouse1's brightness.
    if (b.kind === 'glass') mesh.castShadow = false;
  };
  for (const b of spec.boxes) attachBox(b);
  scene.add(fenceGroup);
  registerGroupParts(fenceGroup, { shootable: fencePosts, blocking: [...fencePanels, ...fencePosts] });

  for (const f of spec.flights) {
    // This map builds open flights only (thin treads, walk-under).
    if (!f.open || f.treadT === undefined) {
      throw new Error('[warehouse2] solid flight in spec — wire addStairs before adding one');
    }
    addOpenStairs(f.x, f.y, f.z, f.width, f.stepH, f.stepD, f.count, f.treadT, materialFor(f.kind), f.dir);
  }

  for (const l of spec.lifts) {
    addElevator({
      id: l.id, x: l.x, z: l.z, width: l.width, depth: l.depth, thickness: l.thickness,
      lowerY: l.lowerY, upperY: l.upperY, speed: l.speed, dwell: l.dwell,
      lowerLanding: new THREE.Vector3(...l.lowerLanding),
      upperLanding: new THREE.Vector3(...l.upperLanding),
      material: matLift,
    });
  }

  if (import.meta.env.DEV) checkClearances(spec.lifts.map((l) => l.z));
}

// ---------- Clearance check ----------
// Loud, not fatal, and DEV-only — the same shape as warehouse1's checkAisles,
// and statically dead in production builds. See the spec file for what each
// number means; everything below is derived from the spec constants the
// geometry is built from, compared against the ENGINE constants themselves
// rather than copies, so neither side can drift.
function checkClearances(liftPadZs: number[]): void {
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

  // A docked deck is step-on-able below and flush with the ring above.
  atLeast('lift rail clearance', LIFT_GAP_MARGIN, 0.25);
  atLeast('lift headroom at upper stop', ROOF_Y - DECK_Y, HEAD_HEIGHT);
  for (const padZ of liftPadZs) {
    if (Math.abs(Math.abs(padZ) + PAD_W / 2 - VOID_Z) > 1e-6) {
      problems.push('lift deck is not flush with the void lip');
    }
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
  // not of any one number.
  for (const o of coplanarTopOverlaps(colliders)) {
    problems.push(
      `coplanar top faces at y=${o.y.toFixed(2)} over ${o.area.toFixed(2)} m2 ` +
      `(x ${o.minX.toFixed(2)}..${o.maxX.toFixed(2)}, z ${o.minZ.toFixed(2)}..${o.maxZ.toFixed(2)})`);
  }

  for (const p of problems) console.error(`[warehouse2] ${p}`);
}
