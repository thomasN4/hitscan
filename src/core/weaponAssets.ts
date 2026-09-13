import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createCelMaterial } from './materials';
import type { WeaponId } from './state';

export type AuthoredWeaponId = WeaponId;
export type WeaponAssets = Record<AuthoredWeaponId, THREE.Object3D>;
export interface AuthoredWeaponRig {
  root: THREE.Object3D;
  grip: THREE.Object3D;
  support: THREE.Object3D;
  port?: THREE.Object3D;
  muzzle?: THREE.Object3D;
  bladeTip?: THREE.Object3D;
  magazineOut?: THREE.Object3D;
  mechanisms: Partial<Record<'pump' | 'cylinder' | 'rotor' | 'hammer' | 'slide' | 'magazine' | 'bolt', THREE.Object3D>>;
}
function required(root: THREE.Object3D, name: string): THREE.Object3D {
  const matches: THREE.Object3D[] = [];
  root.traverse(node => { if (node.name === name) matches.push(node); });
  if (matches.length !== 1 || !matches[0]) throw new Error(`Weapon asset: missing/duplicate ${name}`);
  return matches[0];
}
export function createAuthoredWeaponRig(id: AuthoredWeaponId, asset: THREE.Object3D): AuthoredWeaponRig {
  const root = asset.clone(true);
  const grip = required(root, 'grip_right');
  const mechanismNames: Record<AuthoredWeaponId, ReadonlyArray<keyof AuthoredWeaponRig['mechanisms']>> = {
    shotgun: ['pump'], revolver: ['cylinder', 'rotor', 'hammer'], pistol: ['slide', 'magazine'],
    ak47: ['slide', 'magazine'], smg: ['slide', 'magazine'], sniper: ['bolt', 'magazine'], knife: [],
  };
  const mechanisms: AuthoredWeaponRig['mechanisms'] = {};
  for (const key of mechanismNames[id]) mechanisms[key] = required(root, `mechanism_${key}`);
  const support = id !== 'revolver' && id !== 'knife' ? required(root, 'grip_left') : grip;
  const port = id === 'knife' ? undefined : required(root, 'reload_port');
  if (id === 'shotgun' && support.parent !== mechanisms.pump
    || id === 'revolver' && (port?.parent !== mechanisms.cylinder || mechanisms.rotor?.parent !== mechanisms.cylinder))
    throw new Error(`Weapon asset: incompatible ${id} mechanism hierarchy`);
  const magazineOut = id === 'pistol' || id === 'smg' || id === 'ak47' || id === 'sniper' ? required(root, 'magazine_out') : undefined;
  if (magazineOut) {
    const magazine = mechanisms.magazine;
    const action = id === 'sniper' ? mechanisms.bolt : mechanisms.slide;
    if (!port || !magazine || !action || magazine.parent !== root || action.parent !== root
      || port.parent !== root || magazineOut.parent !== root || grip.parent !== root || support.parent !== root)
      throw new Error(`Weapon asset: incompatible ${id} mechanism hierarchy`);
    const travel = magazineOut.position.clone().sub(port.position);
    if (![...travel.toArray()].every(Number.isFinite) || Math.abs(travel.x) > 1e-6
      || travel.y >= -0.13 || (id === 'pistol' ? travel.z <= 0 : Math.abs(travel.z) > 1e-6) || travel.length() > .3)
      throw new Error(`Weapon asset: invalid ${id} magazine path`);
  }
  if (id === 'knife' && (grip.parent !== root || required(root, 'blade_tip').parent !== root))
    throw new Error('Weapon asset: incompatible knife attachment hierarchy');
  return { root, grip, support, port, magazineOut,
    muzzle: id === 'knife' ? undefined : required(root, 'Muzzle'),
    bladeTip: id === 'knife' ? required(root, 'blade_tip') : undefined, mechanisms };
}
export async function loadWeaponAssets(base: string): Promise<WeaponAssets> {
  async function load(id: AuthoredWeaponId): Promise<THREE.Object3D> {
    const { scene } = await new GLTFLoader().loadAsync(`${base}assets/${id}.glb`);
    createAuthoredWeaponRig(id, scene);
    const palette: Record<string, number> = {
      'Charcoal blued steel': 0x2b2b2b, 'Recess / rubber': 0x111111,
      'Warm walnut': 0x4a331f, 'Walnut end grain': 0x302015,
      'Satin graphite slide': 0x59666e, 'Slate grip panels': 0x28343c, 'Ivory sight inserts': 0xe7d6ac,
      'Olive composite': 0x24301f, 'Brushed steel': 0xb9bdc6, Brass: 0xc6994f,
    };
    const materials = new Map<string, THREE.MeshToonMaterial>();
    let meshes = 0;
    scene.traverse(node => {
      if (!(node instanceof THREE.Mesh)) return;
      const mesh = node as THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>;
      const position = mesh.geometry.getAttribute('position');
      if (!position || position.count === 0) throw new Error(`Weapon asset: empty mesh ${node.name}`);
      const convert = (material: THREE.Material): THREE.MeshToonMaterial => {
        const color = palette[material.name];
        if (color === undefined) throw new Error(`Weapon asset: unknown material ${material.name}`);
        let cel = materials.get(material.name);
        if (!cel) { cel = createCelMaterial({ color }); materials.set(material.name, cel); }
        material.dispose();
        return cel;
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(convert) : convert(mesh.material);
      mesh.name = 'weapon-part';
      meshes++;
    });
    if (!meshes) throw new Error(`Weapon asset: ${id} contains no meshes`);
    return scene;
  }
  const [shotgun, revolver, pistol, smg, sniper, knife, ak47] = await Promise.all([
    load('shotgun'), load('revolver'), load('pistol'), load('smg'), load('sniper'), load('knife'), load('ak47'),
  ]);
  return { shotgun, revolver, pistol, smg, sniper, knife, ak47 };
}
/** Evaluate an authored marker in body coordinates, including moving parents. */
export function attachmentPoint(node: THREE.Object3D, body: THREE.Object3D): THREE.Vector3 {
  body.updateWorldMatrix(true, true);
  return body.worldToLocal(node.getWorldPosition(new THREE.Vector3()));
}
