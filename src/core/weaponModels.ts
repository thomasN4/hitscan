// First-person prop assembly, independent of input, firing and the engine.
// Coordinates are metres: the muzzle points down -z. The outer group owns poses.
import * as THREE from 'three';
import { createCelMaterial } from './materials';
import type { WeaponId } from './state';
import { createAuthoredWeaponRig, type AuthoredWeaponRig, type WeaponAssets } from './weaponAssets';

export interface WeaponViewModel {
  authored: AuthoredWeaponRig;
  group: THREE.Group;
  body: THREE.Group;
  mechanisms: Partial<Record<'magazine' | 'pump' | 'cylinder' | 'rotor' | 'hammer' | 'bolt' | 'slide' | 'shell', THREE.Object3D>>;
  rest: Map<THREE.Object3D, { position: THREE.Vector3; rotation: THREE.Euler }>;
  aimOffset: { x: number; y: number };
}

/** Build a fresh model; caller owns it for the page's lifetime. */
export function createWeaponViewModel(id: WeaponId, weaponAssets: WeaponAssets): WeaponViewModel {
  const group = new THREE.Group();
  group.name = `viewmodel-${id}`;
  const body = new THREE.Group();
  const offset = id === 'sniper' ? { x: 0.26, y: 0.12 }
    : id === 'shotgun' ? { x: 0.25, y: 0.105 }
      : id === 'smg' ? { x: 0.25, y: 0.14 } : { x: 0.24, y: 0.15 };
  const sightLine = id === 'pistol' ? -0.004 : id === 'revolver' ? 0.037 : id === 'shotgun' ? .034 : 0;
  body.position.set(offset.x, -offset.y, id === 'pistol' || id === 'revolver' ? -0.43 : id === 'shotgun' ? -.53 : -0.57);
  group.add(body);
  const authored = createAuthoredWeaponRig(id, weaponAssets[id]);
  body.add(authored.root);
  const mechanisms: WeaponViewModel['mechanisms'] = { ...authored.mechanisms };
  // Loose reload cartridges remain lightweight effects, separate from weapon assets.
  function cartridge(radius: number, length: number, color: number): THREE.Mesh {
    const geometry = new THREE.CylinderGeometry(radius, radius, length, 20);
    geometry.rotateX(Math.PI / 2);
    const mesh = new THREE.Mesh(geometry, createCelMaterial({ color }));
    mesh.name = 'weapon-part';
    return mesh;
  }
  if (id === 'shotgun' || id === 'revolver') {
    const shell = id === 'shotgun' ? cartridge(.011, .055, 0xa94d39) : cartridge(.008, .034, 0xc6994f);
    if (id === 'shotgun') {
      const base = cartridge(.012, .009, 0xc6994f);
      base.position.z = .027;
      shell.add(base);
    }
    body.add(shell);
    mechanisms.shell = shell;
    shell.visible = false;
  }
  const rest: WeaponViewModel['rest'] = new Map();
  for (const [key, node] of Object.entries(mechanisms)) {
    node.name = `weapon-mechanism-${key}`;
    rest.set(node, { position: node.position.clone(), rotation: node.rotation.clone() });
  }
  return { authored, group, body, mechanisms, rest,
    aimOffset: { x: -offset.x, y: offset.y - sightLine } };
}
