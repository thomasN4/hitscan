// Procedural glove articulation; all coordinates are local to the weapon body.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { createCelMaterial } from './materials';

export interface HandRig {
  wrist: THREE.Group;
  sleeve: THREE.Mesh;
  fingers: THREE.Group[];
  side: 1 | -1;
}

export function createHandRig(side: 1 | -1): HandRig {
  const wrist = new THREE.Group();
  wrist.name = side === 1 ? 'right-hand' : 'left-hand';
  const glove = createCelMaterial({ color: 0x343b3c });
  const panel = createCelMaterial({ color: 0x525b58 });
  const cloth = createCelMaterial({ color: 0x626954 });
  function pad(w: number, h: number, d: number, x: number, y: number, z: number,
    parent: THREE.Object3D, material = glove): THREE.Mesh {
    const mesh = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 2, Math.min(w, h, d) * 0.3), material);
    mesh.name = 'weapon-part';
    mesh.position.set(x, y, z);
    parent.add(mesh);
    return mesh;
  }
  pad(0.058, 0.065, 0.026, 0, 0.038, 0, wrist);
  pad(0.042, 0.043, 0.004, 0, 0.042, 0.014, wrist, panel);
  pad(0.051, 0.024, 0.030, 0, -0.003, 0, wrist);
  const fingers: THREE.Group[] = [];
  for (let i = 0; i < 4; i++) {
    const knuckle = new THREE.Group();
    knuckle.position.set((i - 1.5) * 0.014, 0.063, 0);
    wrist.add(knuckle);
    let parent = knuckle;
    const length = i === 3 ? 0.017 : 0.021;
    for (let j = 0; j < 3; j++) {
      if (j > 0) {
        const joint = new THREE.Group();
        joint.position.y = length;
        parent.add(joint);
        parent = joint;
      }
      fingers.push(parent);
      pad(0.012, length + 0.003, 0.014, 0, length / 2, 0, parent);
    }
  }
  const thumb = new THREE.Group();
  thumb.position.set(-side * 0.03, 0.023, -0.005);
  thumb.rotation.set(-0.75, 0, side * 0.65);
  wrist.add(thumb);
  pad(0.020, 0.037, 0.020, 0, 0.013, 0, thumb);
  pad(0.018, 0.028, 0.019, 0, 0.034, -0.012, thumb);
  const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.049, 1, 12), cloth);
  sleeve.name = `weapon-forearm-${side === 1 ? 'right' : 'left'}`;
  return { wrist, sleeve, fingers, side };
}

/** Wrist targets are in body space; the forearm reaches an off-screen elbow. */
export function poseHand(hand: HandRig, position: THREE.Vector3, rotation: THREE.Euler, grasp: number, elbow: THREE.Vector3): void {
  hand.wrist.position.copy(position);
  hand.wrist.rotation.copy(rotation);
  hand.fingers.forEach((joint, i) => { joint.rotation.x = -(i % 3 === 0 ? 0.7 : 1.0) * grasp; });
  const direction = position.clone().sub(elbow);
  hand.sleeve.position.copy(elbow).add(position).multiplyScalar(0.5);
  hand.sleeve.scale.y = direction.length();
  hand.sleeve.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
}
