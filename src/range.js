// range.js — shooting range map for testing accuracy and recoil patterns.
//
// A fully enclosed lane (floor, side walls, rear wall, back berm) with
// distance markers painted on the floor and bot-silhouette targets (same
// body-part dimensions as Bot in bots.js, so headshot practice transfers)
// decorated with elliptical bullseye rings.
// All target parts are registered as `solids` so bullet-hole decals work
// on them; nothing here shoots back.
//
// Geometry goes through world.js. This file used to keep its own copy of the
// registration logic, and that copy shipped without the `colliders` push —
// the whole range map was no-clip (`431ac6e`). There is now one
// implementation to get wrong.
import * as THREE from 'three';
import { scene } from './core/engine.js';
import { addSolidBox, registerSolid, registerGroupParts } from './world.js';

const matWall   = new THREE.MeshLambertMaterial({ color: 0xb0a48c });
const matWall2  = new THREE.MeshLambertMaterial({ color: 0x968a72 });
const matGround = new THREE.MeshLambertMaterial({ color: 0xb59a67 });
const matPost   = new THREE.MeshLambertMaterial({ color: 0x6b5a3e });

/** Render text to a canvas and return it as a texture. */
function makeTextTexture(text, { width = 256, height = 128, font = 'bold 72px sans-serif', color = '#3a3226' } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
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
function addFloorLabel(text, x, z, size = 4) {
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
function makeBullseyeTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 512;
  const ctx = canvas.getContext('2d');

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

// Same part dimensions as bots.js so training transfers 1:1. Each part is a
// separate solid -> separate decal surface + headshot-sized hitbox.
function addTarget(x, z, { height = 0, yaw = 0 } = {}) { // yaw 0 = facing firing line
  const bullseyeMat = new THREE.MeshLambertMaterial({ map: makeBullseyeTexture() });
  const matBody  = new THREE.MeshLambertMaterial({ color: 0x8a6b2e });
  const matHead  = new THREE.MeshLambertMaterial({ color: 0xd8c39a });
  const matLegs  = new THREE.MeshLambertMaterial({ color: 0x4d4436 });

  const g = new THREE.Group();

  const post = new THREE.Mesh(new THREE.BoxGeometry(0.15, height + 0.05, 0.15), matPost);
  post.position.y = -(height + 0.05) / 2 + 0.025;

  // Part y-offsets match bots.js exactly (torso 1.35, head 2.0, legs 0.45)
  const legs  = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.9, 0.35), matLegs);
  legs.position.y = 0.45;
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.9, 0.4), [matBody, matBody, matBody, matBody, bullseyeMat, matBody]);
  torso.position.y = 1.35;
  const head  = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.34, 0.34), matHead);
  head.position.y = 2.0;

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

/** Build the shooting range. Called once from main.js instead of buildMap. */
export function buildRange() {
  // Floor spans the full lane: z from -95 to +35, so every wall, target and
  // marker stands on it; the far edge stays hidden behind the backstop + fog.
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(30, 130), matGround);
  ground.rotation.x = -Math.PI / 2;
  ground.position.z = -30;
  ground.receiveShadow = true;
  scene.add(ground);
  registerSolid(ground); // raycast target only — the lane walls bound movement

  // Lane walls run continuously from the backstop (z=-80.5) to the rear wall
  // (z=20) — no gaps, so no void is visible anywhere from inside the lane.
  addSolidBox(-10, 0, -30, 1, 4, 101, matWall2);  // left wall
  addSolidBox( 10, 0, -30, 1, 4, 101, matWall2);  // right wall
  addSolidBox(0, 0, 20, 21, 4, 1, matWall2);      // rear wall behind firing line
  addSolidBox(0, 0, -80.5, 21, 5, 1, matWall);    // backstop

  // Firing-line marker strip across the floor
  const line = new THREE.Mesh(new THREE.BoxGeometry(18, 0.02, 0.4), new THREE.MeshLambertMaterial({ color: 0x3a3226 }));
  line.position.set(0, 0.01, 5);
  scene.add(line);

  // Distance markers down the center of each half-lane (60 M flanks the
  // centered far target like the closer pairs do).
  for (const d of [10, 20, 30, 40, 50, 60]) {
    addFloorLabel(`${d} M`, -5, 5 - d);
    addFloorLabel(`${d} M`,  5, 5 - d);
  }

  // Targets: staggered distances and heights on both halves of the lane,
  // angled slightly toward the firing line. Near ones for spray control,
  // far ones for accuracy.
  addTarget(-4.5, -5,  { });        // 10 m
  addTarget( 4.5, -15, { height: 1.0 });  // 20 m, raised
  addTarget(-5.5, -25, { });        // 30 m
  addTarget( 5.5, -35, { height: 0.6 });  // 40 m, slightly raised
  addTarget( 0,   -55, { });        // 60 m — full-lane accuracy test
}
