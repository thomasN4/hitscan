import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import { createCelMaterial } from './materials';
import { solveArmIK } from '../sim/armIK';

export interface HandRig {
  upper: THREE.Bone;
  forearm: THREE.Bone;
  wrist: THREE.Bone;
  thumb: THREE.Bone;
  fingers: THREE.Bone[];
  upperLength: number;
  forearmLength: number;
}
export interface ArmRig {
  root: THREE.Object3D;
  right: HandRig;
  left: HandRig;
}
function requireBone(root: THREE.Object3D, name: string): THREE.Bone {
  const node = root.getObjectByName(name);
  if (!(node instanceof THREE.Bone)) throw new Error(`Arms asset: missing bone ${name}`);
  return node;
}
function hand(root: THREE.Object3D, side: 'right' | 'left'): HandRig {
  const upper = requireBone(root, `${side}_upper`);
  const forearm = requireBone(root, `${side}_forearm`);
  const wrist = requireBone(root, `${side}-hand`);
  const fingers = Array.from({ length: 12 }, (_, i) => requireBone(root, `${side}_finger_${Math.floor(i / 3)}_${i % 3}`));
  if (forearm.parent !== upper || wrist.parent !== forearm
    || Math.abs(forearm.position.y - .30) > 1e-5 || Math.abs(wrist.position.y - .29) > 1e-5)
    throw new Error(`Arms asset: incompatible ${side} bone hierarchy or dimensions`);
  return { upper, forearm, wrist, fingers, thumb: requireBone(root, `${side}_thumb`),
    upperLength: forearm.position.length(), forearmLength: wrist.position.length() };
}
export function createArmRig(asset: THREE.Object3D): ArmRig {
  const root = clone(asset);
  return { root, right: hand(root, 'right'), left: hand(root, 'left') };
}
/** Explicit startup I/O; the caller owns the loaded template. */
export async function loadArmAsset(url: string): Promise<THREE.Object3D> {
  const { scene } = await new GLTFLoader().loadAsync(url);
  hand(scene, 'right'); hand(scene, 'left');
  const palette: Record<string, number> = { sleeve: 0x626954, glove: 0x343b3c, panel: 0x525b58 };
  const materials = new Map<string, THREE.MeshToonMaterial>();
  let meshes = 0;
  scene.traverse(node => {
    if (!(node instanceof THREE.Mesh)) return;
    if (!(node instanceof THREE.SkinnedMesh)) throw new Error(`Arms asset: unskinned mesh ${node.name}`);
    const mesh = node as THREE.SkinnedMesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>;
    if (!mesh.geometry.hasAttribute('skinIndex') || !mesh.geometry.hasAttribute('skinWeight'))
      throw new Error(`Arms asset: missing skin attributes ${node.name}`);
    const convert = (material: THREE.Material): THREE.MeshToonMaterial => {
      const colour = palette[material.name];
      if (colour === undefined) throw new Error(`Arms asset: unknown material ${material.name}`);
      let cel = materials.get(material.name);
      if (!cel) { cel = createCelMaterial({ color: colour }); cel.name = material.name; materials.set(material.name, cel); }
      material.dispose();
      return cel;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(convert) : convert(mesh.material);
    node.frustumCulled = false; // Rest-pose bounds do not contain all IK poses in Three r160.
    node.name = `weapon-arm-${node.name}`;
    meshes++;
  });
  if (!meshes) throw new Error('Arms asset contains no skinned meshes');
  return scene;
}

/** The skeleton root is identity in weapon body space. Bone lengths never scale. */
export function poseHand(hand: HandRig, target: THREE.Vector3, rotation: THREE.Euler, grasp: number,
  shoulder: THREE.Vector3, pole: THREE.Vector3): void {
  const { elbow, wrist } = solveArmIK(shoulder, target, pole, hand.upperLength, hand.forearmLength);
  const up = new THREE.Vector3(0, 1, 0);
  const upperRotation = new THREE.Quaternion().setFromUnitVectors(up, elbow.clone().sub(shoulder).normalize());
  const foreRotation = new THREE.Quaternion().setFromUnitVectors(up, wrist.clone().sub(elbow).normalize());
  hand.upper.position.copy(shoulder);
  hand.upper.quaternion.copy(upperRotation);
  hand.forearm.quaternion.copy(upperRotation).invert().multiply(foreRotation);
  hand.wrist.quaternion.copy(foreRotation).invert().multiply(new THREE.Quaternion().setFromEuler(rotation));
  hand.fingers.forEach((joint, i) => { joint.rotation.set(-(i % 3 === 0 ? .7 : 1) * grasp, 0, 0); });
  hand.thumb.rotation.set(-.7 * grasp, 0, hand.upper.name.startsWith('right') ? -.5 : .5);
}
