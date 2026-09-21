// range.ts — shooting range map for testing accuracy and recoil patterns.
//
// A fully enclosed lane (floor, side walls, rear wall, back berm) with
// distance markers painted on the floor and bot-silhouette targets (same
// body-part dimensions as Bot in bots.ts, so headshot practice transfers)
// decorated with elliptical bullseye rings. Nothing here shoots back.
// Geometry positions and extents live in ./rangeSpec.ts: buildRange attaches
// that spec to the world, scripts/mapSvg.mjs draws it to docs/maps/range.png.
// Canvas-only detail (label/bullseye textures, silhouette part dims matching
// bots.ts) stays here.
//
// Geometry goes through world.ts. This file used to keep its own copy of the
// registration logic, and that copy shipped without the `colliders` push —
// the whole range map was no-clip (`431ac6e`). There is now one
// implementation to get wrong.
import * as THREE from 'three';
import { createCelMaterial } from '../core/materials';
import { scene } from '../core/engine';
import { addSolidBox, colliders, coplanarTopOverlaps, registerSolid, registerGroupParts } from '../world';
import { LANE_CZ, LANE_D, LANE_W, rangeSpec } from './rangeSpec';
import type { MapBoxKind } from './mapSpec';

const matWall   = createCelMaterial({ color: 0xb0a48c });
const matWall2  = createCelMaterial({ color: 0x968a72 });
const matGround = createCelMaterial({ color: 0xb59a67 });
const matPost   = createCelMaterial({ color: 0x6b5a3e });

/**
 * Spec kinds to the materials they wear in game. Partial on purpose: a kind
 * the spec grows that this map cannot paint is a loud startup error, not a
 * fallback material nobody chose.
 */
const RANGE_MATS: Partial<Record<MapBoxKind, THREE.Material>> = {
  wall: matWall,
  wall2: matWall2,
};

function materialFor(kind: MapBoxKind): THREE.Material {
  const mat = RANGE_MATS[kind];
  if (!mat) throw new Error(`[range] spec box kind '${kind}' has no material — extend RANGE_MATS`);
  return mat;
}

/** Options for makeTextTexture — all optional, with the shipped defaults. */
interface TextTextureOpts {
  width?: number;
  height?: number;
  font?: string;
  color?: string;
}

/** Render text to a canvas and return it as a texture. */
function makeTextTexture(text: string, { width = 256, height = 128, font = 'bold 72px sans-serif', color = '#3a3226' }: TextTextureOpts = {}): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas context unavailable — makeTextTexture cannot label the range');
  ctx.fillStyle = color;
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, width / 2, height / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4; // keep labels legible at grazing angles
  return tex;
}

/** Flat label plane lying on the floor at (x, z). */
function addFloorLabel(text: string, x: number, z: number, size = 4): void {
  const tex = makeTextTexture(text);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(size * 2, size), new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
  m.rotation.x = -Math.PI / 2; // texture 'up' ends up pointing -z: reads correctly from the firing line
  m.position.set(x, 0.02, z); // slight lift avoids z-fighting with the floor
  scene.add(m);
}

/**
 * Elliptical bullseye face texture: concentric ellipses (taller than wide,
 * IPSC-style) centered on the chest area of a silhouette torso.
 */
function makeBullseyeTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 512;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas context unavailable — makeBullseyeTexture cannot draw targets');

  // Silhouette tan base
  ctx.fillStyle = '#8a6b2e';
  ctx.fillRect(0, 0, 256, 512);

  // Elliptical scoring rings centered on the chest (upper-middle)
  const cx = 128, cy = 200;
  const rings = [
    { rx: 90, ry: 150, fill: '#c8b28a' },
    { rx: 66, ry: 110, fill: '#a8875a' },
    { rx: 44, ry: 74,  fill: '#8a6b2e' },
    { rx: 24, ry: 40,  fill: '#b03a2e' }, // bullseye
  ];
  for (const r of rings) {
    ctx.beginPath();
    ctx.ellipse(cx, cy, r.rx, r.ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = r.fill;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#3a3226';
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;
  return tex;
}

// Same part dimensions as bots.ts so training transfers 1:1. Each part is a
// separate solid -> separate decal surface + headshot-sized hitbox.
interface TargetOpts {
  /** Platform height under the target (0 = ground level). */
  height?: number;
  /** yaw 0 = facing firing line */
  yaw?: number;
}

function addTarget(x: number, z: number, { height = 0, yaw = 0 }: TargetOpts = {}): THREE.Group {
  const bullseyeMat = createCelMaterial({ map: makeBullseyeTexture() });
  const matBody  = createCelMaterial({ color: 0x8a6b2e });
  const matHead  = createCelMaterial({ color: 0xd8c39a });
  const matLegs  = createCelMaterial({ color: 0x4d4436 });

  const g = new THREE.Group();

  const post = new THREE.Mesh(new THREE.BoxGeometry(0.15, height + 0.05, 0.15), matPost);
  post.position.y = -(height + 0.05) / 2 + 0.025;

  // Part y-offsets match bots.ts exactly (torso 1.18, head 1.63, legs 0.425)
  const legs  = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.85, 0.28), matLegs);
  legs.position.y = 0.425;
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.66, 0.3), [matBody, matBody, matBody, matBody, bullseyeMat, matBody]);
  torso.position.y = 1.18;
  const head  = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.24, 0.24), matHead);
  head.position.y = 1.63;

  [post, legs, torso, head].forEach(p => { p.castShadow = true; g.add(p); });
  g.position.set(x, height, z);
  g.rotation.y = yaw;
  scene.add(g);
  // The post blocks walking but is NOT a bullet target, so the two lists
  // differ. registerGroupParts flushes the group's world matrix before
  // measuring — without that every AABB lands at the map origin (`faa52c5`).
  // Raised targets' floating leg boxes also block walking under them —
  // accepted as realistic.
  registerGroupParts(g, {
    shootable: [head, torso, legs],
    blocking: [post, head, torso, legs],
  });
  return g;
}

/** Build the shooting range. Called once, via the maps/index.ts registry. */
export function buildRange(): void {
  const spec = rangeSpec();
  // The far edge stays hidden behind the backstop + fog.
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(LANE_W, LANE_D), matGround);
  ground.rotation.x = -Math.PI / 2;
  ground.position.z = LANE_CZ;
  ground.receiveShadow = true;
  scene.add(ground);
  registerSolid(ground); // raycast target only — the lane walls bound movement

  for (const b of spec.boxes) {
    // The firing-line strip is paint, not geometry: unregistered, as before.
    if (b.kind === 'marker') {
      const line = new THREE.Mesh(new THREE.BoxGeometry(b.w, b.h, b.d), createCelMaterial({ color: 0x3a3226 }));
      line.position.set(b.x, b.y + b.h / 2, b.z);
      scene.add(line);
      continue;
    }
    addSolidBox(b.x, b.y, b.z, b.w, b.h, b.d, materialFor(b.kind));
  }

  for (const l of spec.labels) addFloorLabel(l.text, l.x, l.z);
  for (const t of spec.targets) addTarget(t.x, t.z, { height: t.height, yaw: t.yaw });

  if (import.meta.env.DEV) checkCoplanarTops();
}

// DEV-only: two up-facing tops sharing a plane and a footprint z-fight.
// Loud, not fatal, and statically dead in production — same shape as
// maps/warehouse2.ts:checkClearances.
function checkCoplanarTops(): void {
  for (const o of coplanarTopOverlaps(colliders)) {
    console.error(`[range] coplanar top faces at y=${o.y.toFixed(2)} over ${o.area.toFixed(2)} m2 ` +
      `(x ${o.minX.toFixed(2)}..${o.maxX.toFixed(2)}, z ${o.minZ.toFixed(2)}..${o.maxZ.toFixed(2)})`);
  }
}
