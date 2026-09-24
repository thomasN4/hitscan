// First-person prop assembly, independent of input, firing and the engine.
// Coordinates are metres: the muzzle points down -z. The outer group owns poses.
import * as THREE from 'three';
import { createCelMaterial } from './materials';
import type { WeaponId } from './state';
import { hipHold } from '../sim/viewmodelHold';
import { attachmentPoint, createAuthoredWeaponRig, type AuthoredWeaponRig, type WeaponAssets } from './weaponAssets';

/** A body pose: camera-space position of the model origin, and its rotation. */
interface BodyPose { position: THREE.Vector3; quaternion: THREE.Quaternion }

export interface WeaponViewModel {
  authored: AuthoredWeaponRig;
  group: THREE.Group;
  body: THREE.Group;
  mechanisms: Partial<Record<'hinge' | 'shellLeft' | 'shellRight' | 'magazine' | 'pump' | 'cylinder' | 'rotor' | 'hammer' | 'bolt' | 'slide' | 'shell', THREE.Object3D>>;
  rest: Map<THREE.Object3D, { position: THREE.Vector3; rotation: THREE.Euler }>;
  /**
   * Body pose at the hip and just before ADS; weaponPresentation.ts:poseWeapon
   * blends between them by ads. The aim pose is straight, so aimOffset alone
   * then puts the sight line on the view axis.
   */
  hold: { hip: BodyPose; aim: BodyPose };
  aimOffset: { x: number; y: number; z: number };
}

/**
 * Where every firearm's grip sits at the hip, camera space (m): low right,
 * where the hand is. One point for all of them, so each shows at its real size.
 */
const HIP_GRIP = { x: 0.22, y: -0.26, z: -0.44 };
/**
 * Hip bores cross the crosshair this far out (m). Far enough that the cant is a
 * few degrees — a long gun still reads as held forward — and the same for every
 * weapon, so none of them points somewhere the others do not.
 */
const HIP_CONVERGENCE = 3;
/** Handgun sight-line origin distance at full ADS (m), arms extended. */
const HANDGUN_ADS_DEPTH = 0.44;
const SHOULDERED: ReadonlySet<WeaponId> = new Set(['smg', 'ak47', 'sniper', 'shotgun']);

function required(node: THREE.Object3D | undefined, id: WeaponId): THREE.Object3D {
  if (!node) throw new Error(`Viewmodel: ${id} has no muzzle to hold by`);
  return node;
}

/** Build a fresh model; caller owns it for the page's lifetime. */
export function createWeaponViewModel(id: WeaponId, weaponAssets: WeaponAssets): WeaponViewModel {
  const group = new THREE.Group();
  group.name = `viewmodel-${id}`;
  const body = new THREE.Group();
  body.rotation.order = 'YXZ';
  group.add(body);
  const authored = createAuthoredWeaponRig(id, weaponAssets[id]);
  // Measured while the root is still unparented, so the box is in model space.
  const butt = new THREE.Box3().setFromObject(authored.root).max.z;
  body.add(authored.root);
  // Authored sight height above the model origin; scaled with each model to
  // real size (scripts/assets/real-size.py).
  const sightLine = id === 'pistol' ? -0.0028 : id === 'revolver' ? 0.03145 : id === 'shotgun' ? .03128 : id === 'sawnOff' ? .0064 : 0;
  let hold: WeaponViewModel['hold'];
  let aimOffset: WeaponViewModel['aimOffset'];
  if (id === 'knife') {
    // Held parallel to the view axis, the knife showed its pommel end-on and
    // read as a pencil aimed at the horizon. A forward grip instead: the handle
    // rises from below the frame's lower-right edge, where the hand would be, and
    // the blade is tipped up and in to aim at the crosshair ~1.5 m out, inside
    // melee reach (issue #143). Yaw/pitch are derived from that aim point, so a
    // position change must re-derive them. It never aims, so both poses match.
    const pose = { position: new THREE.Vector3(0.25, -0.27, -0.46),
      quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(0.278, 0.228, -0.25, 'YXZ')) };
    hold = { hip: pose, aim: pose };
    aimOffset = { x: 0, y: 0, z: 0 };
  } else {
    authored.root.updateMatrixWorld(true);
    const grip = attachmentPoint(authored.grip, authored.root);
    const muzzle = attachmentPoint(required(authored.muzzle, id), authored.root);
    const hip = hipHold(grip, muzzle, HIP_GRIP, HIP_CONVERGENCE);
    // Straight, with the grip still on the hand point: ADS unwinds the cant
    // about the hand rather than swinging the gun about the eye.
    const aim = new THREE.Vector3(HIP_GRIP.x - grip.x, HIP_GRIP.y - grip.y, HIP_GRIP.z - grip.z);
    // Shouldered, the butt ends on the eye plane — a cheek weld — so the
    // stock runs out of view below the eye instead of standing in the frame.
    const depth = SHOULDERED.has(id) ? butt : HANDGUN_ADS_DEPTH;
    hold = {
      hip: { position: new THREE.Vector3(hip.position.x, hip.position.y, hip.position.z),
        quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(hip.pitch, hip.yaw, 0, 'YXZ')) },
      aim: { position: aim, quaternion: new THREE.Quaternion() },
    };
    aimOffset = { x: -aim.x, y: -sightLine - aim.y, z: -depth - aim.z };
  }
  body.position.copy(hold.hip.position);
  body.quaternion.copy(hold.hip.quaternion);
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
  return { authored, group, body, mechanisms, rest, hold, aimOffset };
}
