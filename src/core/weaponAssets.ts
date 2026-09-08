import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createCelMaterial } from './materials';

export type AuthoredWeaponId = 'shotgun' | 'revolver';
export type WeaponAssets = Record<AuthoredWeaponId, THREE.Object3D>;
export interface AuthoredWeaponRig {
  root: THREE.Object3D;
  grip: THREE.Object3D;
  support: THREE.Object3D;
  port: THREE.Object3D;
  muzzle: THREE.Object3D;
  mechanisms: Partial<Record<'pump' | 'cylinder' | 'rotor' | 'hammer', THREE.Object3D>>;
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
  const mechanisms: AuthoredWeaponRig['mechanisms'] = id === 'shotgun'
    ? { pump: required(root, 'mechanism_pump') }
    : { cylinder: required(root, 'mechanism_cylinder'), rotor: required(root, 'mechanism_rotor'), hammer: required(root, 'mechanism_hammer') };
  const support = id === 'shotgun' ? required(root, 'grip_left') : grip;
  const port = required(root, 'reload_port');
  if (id === 'shotgun' && support.parent !== mechanisms.pump
    || id === 'revolver' && (port.parent !== mechanisms.cylinder || mechanisms.rotor?.parent !== mechanisms.cylinder))
    throw new Error(`Weapon asset: incompatible ${id} mechanism hierarchy`);
  return { root, grip, support, port, muzzle: required(root, 'Muzzle'), mechanisms };
}
export async function loadWeaponAssets(base: string): Promise<WeaponAssets> {
  async function load(id: AuthoredWeaponId): Promise<THREE.Object3D> {
    const { scene } = await new GLTFLoader().loadAsync(`${base}assets/${id}.glb`);
    createAuthoredWeaponRig(id, scene);
    const palette: Record<string, number> = {
      'Charcoal blued steel': 0x2b2b2b, 'Recess / rubber': 0x111111,
      'Warm walnut': 0x4a331f, 'Walnut end grain': 0x302015,
      'Brushed steel': 0xb9bdc6, Brass: 0xc6994f,
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
  const [shotgun, revolver] = await Promise.all([load('shotgun'), load('revolver')]);
  return { shotgun, revolver };
}
/** Evaluate an authored marker in body coordinates, including moving parents. */
export function attachmentPoint(node: THREE.Object3D, body: THREE.Object3D): THREE.Vector3 {
  body.updateWorldMatrix(true, true);
  return body.worldToLocal(node.getWorldPosition(new THREE.Vector3()));
}
