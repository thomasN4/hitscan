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
  chambers?: readonly [THREE.Object3D, THREE.Object3D];
  magazineOut?: THREE.Object3D;
  /** Bow only: where the string meets each limb tip. Children of the limbs, so the flex carries them. */
  stringTop?: THREE.Object3D;
  stringBottom?: THREE.Object3D;
  /** Full-stroke travel (m) of the slide, pump or bolt along authored +z; 0 without one. */
  actionTravel: number;
  mechanisms: Partial<Record<'hinge' | 'pump' | 'cylinder' | 'rotor' | 'hammer' | 'slide' | 'magazine' | 'bolt' | 'limbUpper' | 'limbLower', THREE.Object3D>>;
}
/**
 * Action stroke per weapon, sized to the real-sized models
 * (scripts/assets/real-size.py): scaled with the gun it moves, so a shrunken
 * slide does not overshoot its frame. Shared by the viewmodel and bot mounts,
 * which make the same motion from either side.
 */
const ACTION_TRAVEL: Record<AuthoredWeaponId, number> = {
  pistol: 0.032, smg: 0.036, ak47: 0.042, shotgun: 0.087, sniper: 0.105,
  revolver: 0, sawnOff: 0, knife: 0, longbow: 0, armingSword: 0,
};
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
    sawnOff: ['hinge'], shotgun: ['pump'], revolver: ['cylinder', 'rotor', 'hammer'], pistol: ['slide', 'magazine'],
    ak47: ['slide', 'magazine'], smg: ['slide', 'magazine'], sniper: ['bolt', 'magazine'], knife: [],
    longbow: ['limbUpper', 'limbLower'], armingSword: [],
  };
  const mechanisms: AuthoredWeaponRig['mechanisms'] = {};
  for (const key of mechanismNames[id]) mechanisms[key] = required(root, `mechanism_${key}`);
  // Blades share the knife's contract: one grip, a blade tip, no muzzle or port.
  const blade = id === 'knife' || id === 'armingSword';
  const support = id !== 'revolver' && !blade && id !== 'longbow' ? required(root, 'grip_left') : grip;
  const port = blade || id === 'longbow' ? undefined : required(root, 'reload_port');
  if (id === 'shotgun' && support.parent !== mechanisms.pump
    || id === 'revolver' && (port?.parent !== mechanisms.cylinder || mechanisms.rotor?.parent !== mechanisms.cylinder))
    throw new Error(`Weapon asset: incompatible ${id} mechanism hierarchy`);
  const chambers = id === 'sawnOff'
    ? [required(root, 'chamber_left'), required(root, 'chamber_right')] as const : undefined;
  if (chambers && (mechanisms.hinge?.parent !== root || grip.parent !== root
    || [support, port, required(root, 'Muzzle'), ...chambers].some(node => node?.parent !== mechanisms.hinge)))
    throw new Error('Weapon asset: incompatible sawnOff mechanism hierarchy');
  const magazineOut = id === 'pistol' || id === 'smg' || id === 'ak47' || id === 'sniper' ? required(root, 'magazine_out') : undefined;
  if (magazineOut) {
    const magazine = mechanisms.magazine;
    const action = id === 'sniper' ? mechanisms.bolt : mechanisms.slide;
    if (!port || !magazine || !action || magazine.parent !== root || action.parent !== root
      || port.parent !== root || magazineOut.parent !== root || grip.parent !== root || support.parent !== root)
      throw new Error(`Weapon asset: incompatible ${id} mechanism hierarchy`);
    const travel = magazineOut.position.clone().sub(port.position);
    if (![...travel.toArray()].every(Number.isFinite) || Math.abs(travel.x) > 1e-6
      || travel.y >= -0.10 || (id === 'pistol' ? travel.z <= 0 : Math.abs(travel.z) > 1e-6) || travel.length() > .3)
      throw new Error(`Weapon asset: invalid ${id} magazine path`);
  }
  if (blade && (grip.parent !== root || required(root, 'blade_tip').parent !== root))
    throw new Error(`Weapon asset: incompatible ${id} attachment hierarchy`);
  const stringTop = id === 'longbow' ? required(root, 'string_top') : undefined;
  const stringBottom = id === 'longbow' ? required(root, 'string_bottom') : undefined;
  if (id === 'longbow' && (grip.parent !== root || stringTop?.parent !== mechanisms.limbUpper
    || stringBottom?.parent !== mechanisms.limbLower || mechanisms.limbUpper?.parent !== root
    || mechanisms.limbLower?.parent !== root))
    throw new Error('Weapon asset: incompatible longbow limb hierarchy');
  return { root, grip, support, port, magazineOut, chambers, stringTop, stringBottom, actionTravel: ACTION_TRAVEL[id],
    muzzle: blade ? undefined : required(root, 'Muzzle'),
    bladeTip: blade ? required(root, 'blade_tip') : undefined, mechanisms };
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
      'Yew sapwood': 0xc99a5b, 'Yew heartwood': 0x8a4220, 'Grip leather': 0x3b2415, Horn: 0xd6ccb2,
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
  const [shotgun, revolver, pistol, smg, sniper, knife, ak47, sawnOff, longbow, armingSword] = await Promise.all([
    load('shotgun'), load('revolver'), load('pistol'), load('smg'), load('sniper'), load('knife'), load('ak47'), load('sawnOff'),
    load('longbow'), load('armingSword'),
  ]);
  return { shotgun, revolver, pistol, smg, sniper, knife, ak47, sawnOff, longbow, armingSword };
}
/** Evaluate an authored marker in body coordinates, including moving parents. */
export function attachmentPoint(node: THREE.Object3D, body: THREE.Object3D): THREE.Vector3 {
  body.updateWorldMatrix(true, true);
  return body.worldToLocal(node.getWorldPosition(new THREE.Vector3()));
}
