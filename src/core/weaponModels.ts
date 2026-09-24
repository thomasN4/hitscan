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
  mechanisms: Partial<Record<'hinge' | 'shellLeft' | 'shellRight' | 'magazine' | 'pump' | 'cylinder' | 'rotor' | 'hammer' | 'bolt' | 'slide' | 'shell', THREE.Object3D>>;
  rest: Map<THREE.Object3D, { position: THREE.Vector3; rotation: THREE.Euler }>;
  aimOffset: { x: number; y: number; z: number };
}

/** Build a fresh model; caller owns it for the page's lifetime. */
export function createWeaponViewModel(id: WeaponId, weaponAssets: WeaponAssets): WeaponViewModel {
  const group = new THREE.Group();
  group.name = `viewmodel-${id}`;
  const body = new THREE.Group();
  const offset = id === 'sniper' ? { x: 0.26, y: 0.12 }
    : id === 'shotgun' ? { x: 0.20, y: 0.105 }
      : (id === 'smg' || id === 'ak47') ? { x: 0.25, y: 0.14 } : { x: 0.24, y: 0.15 };
  // Authored sight height above the model origin; scaled with each model to
  // real size (scripts/assets/real-size.py).
  const sightLine = id === 'pistol' ? -0.0028 : id === 'revolver' ? 0.03145 : id === 'shotgun' ? .03128 : id === 'sawnOff' ? .0064 : 0;
  body.position.set(offset.x, -offset.y, id === 'pistol' || id === 'revolver' || id === 'sawnOff' ? -0.50 : id === 'shotgun' ? -.46 : -0.57);
  // Held parallel to the view axis, the knife showed its pommel end-on and
  // read as a pencil aimed at the horizon. A forward grip instead: the handle
  // rises from below the frame's lower-right edge, where the hand would be, and
  // the blade is tipped up and in to aim at the crosshair ~1.5 m out, inside
  // melee reach (issue #143). Yaw/pitch are derived from that aim point, so a
  // position change must re-derive them.
  if (id === 'knife') {
    body.position.set(0.25, -0.27, -0.46);
    body.rotation.set(0.278, 0.228, -0.25, 'YXZ');
  }
  group.add(body);
  const authored = createAuthoredWeaponRig(id, weaponAssets[id]);
  // Measured while the root is still unparented, so the box is in model space.
  const butt = new THREE.Box3().setFromObject(authored.root).max.z;
  body.add(authored.root);
  const mechanisms: WeaponViewModel['mechanisms'] = { ...authored.mechanisms };
  // Loose reload cartridges remain lightweight effects, separate from weapon
  // assets, sized to the real-sized chambers they feed.
  function cartridge(radius: number, length: number, color: number): THREE.Mesh {
    const geometry = new THREE.CylinderGeometry(radius, radius, length, 20);
    geometry.rotateX(Math.PI / 2);
    const mesh = new THREE.Mesh(geometry, createCelMaterial({ color }));
    mesh.name = 'weapon-part';
    return mesh;
  }
  if (id === 'shotgun' || id === 'revolver') {
    const shell = id === 'shotgun' ? cartridge(.0101, .0506, 0xa94d39) : cartridge(.0051, .0289, 0xc6994f);
    if (id === 'shotgun') {
      const base = cartridge(.011, .0083, 0xc6994f);
      base.position.z = .0248;
      shell.add(base);
    }
    body.add(shell);
    mechanisms.shell = shell;
    shell.visible = false;
  }
  if (id === 'sawnOff') {
    for (const key of ['shellLeft', 'shellRight'] as const) {
      const shell = cartridge(.008, .044, 0xa94d39);
      const base = cartridge(.0088, .0072, 0xc6994f);
      base.position.z = .0216;
      shell.add(base);
      body.add(shell);
      mechanisms[key] = shell;
      shell.visible = false;
    }
  }
  const rest: WeaponViewModel['rest'] = new Map();
  for (const [key, node] of Object.entries(mechanisms)) {
    node.name = `weapon-mechanism-${key}`;
    rest.set(node, { position: node.position.clone(), rotation: node.rotation.clone() });
  }
  return { authored, group, body, mechanisms, rest,
    // Shouldered, the butt ends on the eye plane (a cheek weld), so the stock
    // runs out of view below the eye; the real-sized SMG's stock is too short
    // to clear the frame any further forward.
    aimOffset: { x: -offset.x, y: offset.y - sightLine,
      z: (id === 'smg' || id === 'ak47') ? 0.57 - butt : 0.06 } };
}
