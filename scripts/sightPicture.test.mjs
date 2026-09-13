// scripts/sightPicture.test.mjs — nothing may stand between the eye and the sights.
//
// The revolver's hammer sat over the crosshair for 37% of every shot cycle while
// weapon-animation-check.mjs's `hammerTop < -0.005` passed, because "the topmost
// hammer vertex is below the view axis" is not "the aiming point is clear": the
// hammer is only 21.7 mrad wide but it is centred on x = 0, and it stood proud of
// both sights. This asks the question directly instead, by raycasting from the
// eye — which is also why it does not project anything. A projected bounding box
// cannot answer it: the stock legitimately sits beside the camera, so vertices
// near the near plane project to garbage, and the depth punch on z legitimately
// rescales everything.
//
// It lives in scripts/ as a *.test.mjs because vitest's default include collects
// those (there is no vitest config) so it gates CI, while the puppeteer scripts
// do not — and because eslint.config.js bans src/**/*.test.ts from importing
// browser-side modules like core/weaponModels. Same arrangement as
// scripts/shotgunPresentation.test.mjs, whose harness this copies.
import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Box3, Group, Raycaster, Triangle, Vector3 } from 'three';
import { viewmodelRecoil } from '../src/sim/recoil.ts';
import { WEAPONS, RECOIL_CAP, BASE_FOV } from '../src/core/state.ts';
import { createWeaponViewModel } from '../src/core/weaponModels.ts';
import { poseWeapon } from '../src/core/weaponPresentation.ts';
import { weaponPose } from '../src/sim/weaponAnimation.ts';
import { viewmodelTransform } from '../src/sim/viewmodelTransform.ts';

async function asset(id) {
  const bytes = readFileSync(new URL(`../public/assets/${id}.glb`, import.meta.url));
  const buffer = new ArrayBuffer(bytes.length);
  new Uint8Array(buffer).set(bytes);
  return (await new GLTFLoader().parseAsync(buffer, '')).scene;
}
const assets = Object.fromEntries(await Promise.all(['smg','sniper','shotgun','pistol','revolver','knife','ak47'].map(async id => [id, await asset(id)])));

function poseFor(id, cycle) {
  return weaponPose({
    id, now: 10, shotAt: 10 - cycle * WEAPONS[id].fireRate, fireInterval: WEAPONS[id].fireRate,
    switchedAt: -100, hasOutgoing: false, aiming: true, reloading: false,
    reloadStartedAt: -100, reloadT: 0, roundInterval: 1, lastRound: false,
    emptyReload: false, closeAt: -100, closeBlend: 0,
  });
}

/**
 * The weapon posed as the player sees it, with the eye at the origin looking
 * down -z. gunGroup's transform comes from the real seam rather than a
 * hand-copied offset, so an aim-offset change cannot silently invalidate this.
 */
function rig(id, ads, cycle, visualRecoil = 0) {
  const vm = createWeaponViewModel(id, assets);
  const pose = poseFor(id, cycle);
  poseWeapon(vm, id, pose, 10, ads, 0);
  const t = viewmodelTransform({ aimOffset: vm.aimOffset, ads, visualRecoil, recoilYaw: 0, bobAmt: 0, now: 10 });
  const gun = new Group();
  gun.position.set(t.position.x, t.position.y, t.position.z);
  gun.rotation.set(t.rotation.x, t.rotation.y, 0);
  gun.add(vm.group);
  gun.updateMatrixWorld(true);
  return { gun, vm, pose };
}

/**
 * Raycaster.intersectObject tests object.layers and NEVER object.visible
 * (three/src/core/Raycaster.js), so the hidden reload shell would count as an
 * obstruction. Collect what is actually drawn.
 */
function visibleMeshes(root) {
  const out = [];
  root.traverse(node => {
    if (!node.isMesh) return;
    for (let p = node; p; p = p.parent) if (!p.visible) return;
    out.push(node);
  });
  return out;
}

const EYE = new Vector3(0, 0, 0);
const CONE_MRAD = 20; // half-angle; the revolver hammer alone is 21.7 mrad wide
const STEP_MRAD = 2;
const FIRE_CYCLES = Array.from({ length: 21 }, (_, i) => i / 20);

/** Nearest thing any ray in the upper aim cone touches, in metres from the eye. */
function nearestInAimCone(gun) {
  const meshes = visibleMeshes(gun);
  const caster = new Raycaster();
  let nearest = Infinity;
  for (let up = 0; up <= CONE_MRAD; up += STEP_MRAD) {
    for (let side = -CONE_MRAD; side <= CONE_MRAD; side += STEP_MRAD) {
      if (up * up + side * side > CONE_MRAD * CONE_MRAD) continue;
      caster.set(EYE, new Vector3(side / 1000, up / 1000, -1).normalize());
      const hit = caster.intersectObjects(meshes, false)[0];
      if (hit) nearest = Math.min(nearest, hit.distance);
    }
  }
  return nearest;
}

// Only the UPPER half-cone plus the axis. Every front sight here sits at or
// below the aim point by construction — the smg's post crest and the shotgun's
// bead are exactly on the axis — so a full disc would report the sight you are
// meant to be looking at as an obstruction.
//
// Stations are the nearest thing each weapon may legitimately have in the cone,
// measured against the shipped assets across the fire cycle. Infinity means the
// cone is empty at every phase.
const AIM_STATION = {
  ak47: 0.91, // front sight crest beyond the clear rear notch (0.924 m).
  smg: 0.73,       // front post crest, on the axis (0.736)
  sniper: 0.66,    // scope body during the ADS blend (0.668), not a sight — see below
  shotgun: 0.97,   // brass bead, on the axis (0.976)
  pistol: Infinity,
  revolver: 0.40,  // aligned rear shoulders at 0.407; the old hammer answers 0.392
  knife: Infinity,
};

for (const id of ['smg', 'sniper', 'shotgun', 'pistol', 'revolver', 'knife', 'ak47']) {
  // The sniper is the only scopedOverlay weapon: weapons.ts hides gunGroup
  // entirely above adsLerp 0.85, so its obstruction window is the blend, not the
  // settled scope. The knife never reaches ADS at all (aiming is gated on
  // !def.melee), so it is checked at the hip through its swing.
  const ads = id === 'sniper' ? 0.85 : id === 'knife' ? 0 : 1;
  // Authored meshes make the full 21-pose sweep exceed one test's 5 s CI
  // budget. Give each pose its own case while retaining every ray and station.
  test.each(FIRE_CYCLES)(`${id}: aim cone stays clear at fire-cycle phase %s`, cycle => {
    if (id === 'sniper') expect(WEAPONS.sniper.scopedOverlay).toBe(true);
    if (id === 'knife') expect(WEAPONS.knife.melee).toBe(true);
    const nearest = nearestInAimCone(rig(id, ads, cycle).gun);
    expect(nearest, `${id} at cycle ${cycle}`).toBeGreaterThanOrEqual(AIM_STATION[id]);
  });
}

test('the check can see the weapons at all', () => {
  // Guard against a silent pass: a wrong transform, a hidden group or an empty
  // scene would clear every cone above by touching nothing.
  const caster = new Raycaster();
  for (const id of ['smg', 'sniper', 'shotgun', 'pistol', 'revolver', 'ak47']) {
    const meshes = visibleMeshes(rig(id, id === 'sniper' ? 0.85 : 1, 0).gun);
    let hits = 0;
    for (let up = -150; up <= 150; up += 10) {
      for (let side = -150; side <= 150; side += 10) {
        caster.set(EYE, new Vector3(side / 1000, up / 1000, -1).normalize());
        if (caster.intersectObjects(meshes, false).length) hits++;
      }
    }
    expect(hits, `${id} probe fan`).toBeGreaterThan(100);
  }
});

test('the check is not vacuous: the old hammer signature fails it', () => {
  // Re-applies the shipped `-=` by hand at the phase where it peaked. Without
  // this, a future change that quietly zeroed pose.hammer would keep the
  // revolver case green for the wrong reason.
  const { gun, vm, pose } = rig('revolver', 1, 0.25);
  const hammer = vm.mechanisms.hammer;
  // Absolute, not a delta off the shipped pose: written as a delta this would
  // double-negate when run against a tree where the sign is already wrong.
  hammer.rotation.x = vm.rest.get(hammer).rotation.x - 0.5 * pose.hammer;
  gun.updateMatrixWorld(true);
  expect(pose.hammer, 'the mutation must have something to rotate').toBeGreaterThan(0.5);
  expect(nearestInAimCone(gun)).toBeLessThan(AIM_STATION.revolver);
});


test('pistol sight feet connect to the slide instead of leaving sky gaps', () => {
  const { gun, vm } = rig('pistol', 1, 0);
  const caster = new Raycaster();
  for (const [y,z] of [[-.0185,-.126],[-.0195,.088]]) {
    const origin = vm.body.localToWorld(new Vector3(.1,y,z));
    caster.set(origin, new Vector3(-1,0,0));
    const hit = caster.intersectObjects(visibleMeshes(gun),false)[0];
    expect(hit, `sight support at z=${z}`).toBeDefined();
    expect(hit.distance).toBeLessThan(.101);
  }
});

test('revolver front crest is visible through the rear notch throughout firing', () => {
  for (let i=0;i<=20;i++) {
    const { gun } = rig('revolver',1,i/20);
    // Just below the aiming axis: a clear axis alone cannot detect a solid rear block.
    const caster = new Raycaster(EYE,new Vector3(0,-.0002,-.575).normalize());
    const hit = caster.intersectObjects(visibleMeshes(gun),false)[0];
    expect(hit, `front blade at cycle ${i/20}`).toBeDefined();
    expect(hit.distance).toBeGreaterThan(.63);
    expect(hit.distance).toBeLessThan(.66);
  }
});

// The stock may pass behind the near plane, provided the cut stays outside
// the visible frame. Export batches parts by material, so intersect the actual
// triangles rather than assuming there is a separately named stock mesh.
test('SMG near-plane cuts stay outside the frame through ADS and recoil', () => {
  const triangle = new Triangle();
  const near = 0.1;
  for (let step = 0; step <= 20; step++) {
    const ads = step / 20;
    const fov = BASE_FOV + (WEAPONS.smg.zoomFovs[0] - BASE_FOV) * ads;
    const halfHeight = near * Math.tan(fov * Math.PI / 360);
    // Ultrawide is conservative: narrower aspects see a subset of this slice.
    const halfWidth = halfHeight * 32 / 9;
    const slice = new Box3(new Vector3(-halfWidth, -halfHeight, -near),
      new Vector3(halfWidth, halfHeight, -near));
    for (const recoil of [0, viewmodelRecoil(RECOIL_CAP, WEAPONS.smg.recoilKick)]) {
      const { gun } = rig('smg', ads, 0, recoil);
      let intersections = 0;
      for (const mesh of visibleMeshes(gun)) {
        const positions = mesh.geometry.getAttribute('position');
        const index = mesh.geometry.index;
        for (let i = 0; i < (index ? index.count : positions.count); i += 3) {
          for (const [offset, point] of [triangle.a, triangle.b, triangle.c].entries()) {
            point.fromBufferAttribute(positions, index ? index.getX(i + offset) : i + offset)
              .applyMatrix4(mesh.matrixWorld);
          }
          if (slice.intersectsTriangle(triangle)) intersections++;
        }
      }
      expect(intersections, `ADS=${ads}, recoil=${recoil}`).toBe(0);
    }
  }
});

test('SMG butt-pad rear stays below the ADS frame', () => {
  const slope = Math.tan(WEAPONS.smg.zoomFovs[0] * Math.PI / 360);
  for (const recoil of [0, viewmodelRecoil(RECOIL_CAP, WEAPONS.smg.recoilKick)]) {
    const { gun, vm } = rig('smg', 1, 0, recoil);
    let rearVertices = 0;
    for (const mesh of visibleMeshes(gun)) {
      const positions = mesh.geometry.getAttribute('position');
      for (let i = 0; i < positions.count; i++) {
        const point = new Vector3().fromBufferAttribute(positions, i).applyMatrix4(mesh.matrixWorld);
        // The exported stock/pad rear occupies body-local z >= 0.4 m.
        if (vm.body.worldToLocal(point.clone()).z < 0.4) continue;
        rearVertices++;
        expect(point.y - point.z * slope, `rear vertex ${i}`).toBeLessThan(0);
      }
    }
    expect(rearVertices).toBeGreaterThan(100);
  }
});
