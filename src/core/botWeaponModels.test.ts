// botWeaponModels.test.ts — third-person mounts over mock authored assets.
// No GLB loading: the markers createAuthoredWeaponRig requires are built by
// hand, which is also what proves the mount only depends on the documented
// marker contract rather than any one .glb.
import { describe, expect, test, vi } from 'vitest';
import * as THREE from 'three';
import {
  botShotKick,
  createBotWeaponRig,
  initBotWeaponModels,
  poseBotWeaponRig,
  type BotWeaponRig,
} from './botWeaponModels';
import type { WeaponAssets } from './weaponAssets';
import type { WeaponId } from './state';

function marker(name: string, pos: readonly [number, number, number], parent: THREE.Object3D): THREE.Object3D {
  const node = new THREE.Object3D();
  node.name = name;
  node.position.set(pos[0], pos[1], pos[2]);
  parent.add(node);
  return node;
}

/** Mock asset satisfying createAuthoredWeaponRig's per-weapon marker contract. */
function mockAsset(id: WeaponId): THREE.Object3D {
  const root = new THREE.Group();
  root.name = `mock-${id}`;
  marker('grip_right', [0.1, -0.05, 0.05], root);
  // A body mesh standing in for the gun's bulk: Box3 (the stock-clearance
  // slide) measures geometry, not bare markers. Primaries overhang behind
  // the grip like real stocks; sidearms and the blade stay short of it.
  const primary = id === 'smg' || id === 'sniper' || id === 'shotgun';
  const bodyLength = id === 'sniper' ? 1.05 : id === 'shotgun' ? 0.8 : id === 'smg' ? 0.7 : 0.3;
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, bodyLength));
  // Span ends at one stock-overhang behind the grip (asset +z is rearward):
  // primaries overhang 0.3 like real stocks, the rest 0.03.
  body.position.set(0, 0, 0.05 + (primary ? 0.3 : 0.03) - bodyLength / 2);
  root.add(body);
  if (id === 'knife') {
    marker('blade_tip', [0.1, -0.05, -0.3], root);
    return root;
  }
  marker('Muzzle', [0.1, 0.02, -0.6], root);
  if (id === 'shotgun') {
    const pump = marker('mechanism_pump', [0, -0.05, -0.2], root);
    marker('grip_left', [0, -0.02, 0], pump);
    marker('reload_port', [0, -0.08, -0.1], root);
    return root;
  }
  if (id === 'revolver') {
    const cylinder = marker('mechanism_cylinder', [0, 0, -0.1], root);
    marker('reload_port', [0, 0, 0], cylinder);
    marker('mechanism_rotor', [0, 0, 0], cylinder);
    marker('mechanism_hammer', [0, 0.03, 0.1], root);
    return root;
  }
  // Detachable-magazine firearms: slide/bolt + magazine with a valid travel
  // (straight down 15 cm, within the validated magazine path).
  marker('mechanism_magazine', [0, -0.1, 0], root);
  marker(id === 'sniper' ? 'mechanism_bolt' : 'mechanism_slide', [0, 0.03, -0.1], root);
  marker('grip_left', [-0.05, -0.05, -0.15], root);
  marker('reload_port', [0, -0.1, 0], root);
  // Straight down for smg/sniper; the pistol's grip cavity slopes rearward
  // (+z), which the validated magazine path requires (weaponAssets.ts).
  marker('magazine_out', id === 'pistol' ? [0, -0.25, 0.05] : [0, -0.25, 0], root);
  return root;
}

const IDS: readonly WeaponId[] = ['shotgun', 'revolver', 'pistol', 'smg', 'sniper', 'knife'];

function initMocks(): void {
  const assets = Object.fromEntries(IDS.map(id => [id, mockAsset(id)])) as WeaponAssets;
  initBotWeaponModels(assets);
}

function gripOf(rig: BotWeaponRig): THREE.Object3D {
  const grip = rig.mount.getObjectByName('grip_right');
  if (!grip) throw new Error('mock asset lost its grip_right');
  return grip;
}

describe('botWeaponModels', () => {
  test('rig construction before init is a named error, not a fallback', async () => {
    vi.resetModules();
    const fresh = await import('./botWeaponModels');
    expect(() => fresh.createBotWeaponRig('smg')).toThrow(/initBotWeaponModels/);
  });

  test('grips seat on the hinge; long stocks slide forward to clear it', () => {
    initMocks();
    const hinge = new THREE.Group();
    hinge.position.set(1, 2, 3);
    hinge.rotation.y = 0.7;
    for (const id of IDS) {
      const rig = createBotWeaponRig(id);
      // Rear clearance is baked at build time, so assert it while the mount
      // is still detached and identity: world reads directly in mount space.
      // (Under a rotated hinge only the component-wise world minimum exists,
      // which is no single corner mapped back.)
      expect(new THREE.Box3().setFromObject(rig.mount).min.z).toBeGreaterThanOrEqual(-0.05 - 1e-9);
      hinge.add(rig.mount);
    }
    hinge.updateMatrixWorld(true);
    for (const mount of [...hinge.children]) {
      const id = mount.name.replace('bot-weapon-', '');
      const grip = mount.getObjectByName('grip_right');
      if (!grip) throw new Error('mock asset lost its grip_right');
      // The clearance slide runs along the barrel only: lateral and vertical
      // seating stays exact, and the grip never ends up behind the hinge.
      const gripLocal = mount.worldToLocal(grip.getWorldPosition(new THREE.Vector3()));
      expect(Math.hypot(gripLocal.x, gripLocal.y)).toBeLessThan(1e-6);
      expect(gripLocal.z).toBeGreaterThanOrEqual(-1e-9);
      // Primaries overhang the limit and ride forward; short weapons stay
      // exactly grip-seated.
      if (id === 'smg' || id === 'sniper' || id === 'shotgun') expect(gripLocal.z).toBeGreaterThan(0.1);
      else expect(gripLocal.z).toBeLessThan(1e-9);
    }
  });

  test('muzzle marker present on firearms, absent on the knife', () => {
    initMocks();
    expect(createBotWeaponRig('smg').muzzle?.name).toBe('Muzzle');
    expect(createBotWeaponRig('sniper').muzzle?.name).toBe('Muzzle');
    expect(createBotWeaponRig('knife').muzzle).toBeNull();
  });

  test('clones are independent of each other and of the source asset', () => {
    initMocks();
    const a = createBotWeaponRig('smg');
    const b = createBotWeaponRig('smg');
    const slideA = a.mechanisms.slide;
    const slideB = b.mechanisms.slide;
    if (!slideA || !slideB) throw new Error('smg mock lost its slide');
    expect(slideA).not.toBe(slideB);
    expect(slideA.name).toBe('bot-weapon-mechanism-slide');
    const restZ = slideB.position.z;
    slideA.position.z += 0.4;
    expect(slideB.position.z).toBeCloseTo(restZ, 10);
  });

  test('firing kick displaces the slide and decays back to rest', () => {
    initMocks();
    const rig = createBotWeaponRig('pistol');
    const slide = rig.mechanisms.slide;
    if (!slide) throw new Error('pistol mock lost its slide');
    const restZ = slide.position.z;
    poseBotWeaponRig(rig, { shotAge: 0, reloadBlend: 0 });
    expect(slide.position.z).toBeCloseTo(restZ + 0.045, 10);
    poseBotWeaponRig(rig, { shotAge: 10, reloadBlend: 0 });
    expect(slide.position.z).toBeCloseTo(restZ, 10);
    expect(botShotKick(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  test('reload blend seats the magazine at its extraction marker', () => {
    initMocks();
    const rig = createBotWeaponRig('smg');
    const hinge = new THREE.Group();
    hinge.add(rig.mount);
    const magazine = rig.mechanisms.magazine;
    const out = rig.magazineOut;
    if (!magazine || !out) throw new Error('smg mock lost its magazine path');
    const rest = magazine.position.clone();
    poseBotWeaponRig(rig, { shotAge: 10, reloadBlend: 1 });
    hinge.updateMatrixWorld(true);
    const magWorld = magazine.getWorldPosition(new THREE.Vector3());
    const outWorld = out.getWorldPosition(new THREE.Vector3());
    expect(magWorld.distanceTo(outWorld)).toBeLessThan(1e-6);
    poseBotWeaponRig(rig, { shotAge: 10, reloadBlend: 0 });
    hinge.updateMatrixWorld(true);
    expect(magazine.position.distanceTo(rest)).toBeLessThan(1e-9);
  });

  test('reload blend swings the revolver cylinder out', () => {
    initMocks();
    const rig = createBotWeaponRig('revolver');
    const cylinder = rig.mechanisms.cylinder;
    if (!cylinder) throw new Error('revolver mock lost its cylinder');
    poseBotWeaponRig(rig, { shotAge: 10, reloadBlend: 1 });
    expect(cylinder.rotation.z).toBeCloseTo(1.60, 10);
    poseBotWeaponRig(rig, { shotAge: 10, reloadBlend: 0 });
    expect(cylinder.rotation.z).toBeCloseTo(0, 10);
  });

  test('knife rig poses without throwing', () => {
    initMocks();
    const rig = createBotWeaponRig('knife');
    expect(() => poseBotWeaponRig(rig, { shotAge: 0, reloadBlend: 1 })).not.toThrow();
  });

  test('gripOf helper reaches the hinge-seated grip', () => {
    initMocks();
    const rig = createBotWeaponRig('shotgun');
    expect(gripOf(rig).name).toBe('grip_right');
  });
});
