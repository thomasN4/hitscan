// First-person prop assembly, independent of input, firing and the engine.
// Coordinates are metres: the muzzle points down -z. The outer group owns poses.
import * as THREE from 'three';
import { createCelMaterial } from './materials';
import { BASE_FOV, CAMERA_NEAR, type WeaponId } from './state';
import { hipHold, rotateYawPitch, slideToClear, type Vec3 } from '../sim/viewmodelHold';
import { attachmentPoint, createAuthoredWeaponRig, type AuthoredWeaponRig, type WeaponAssets } from './weaponAssets';
import { createArrowModel } from './arrowModel';

/** A body pose: camera-space position of the model origin, and its rotation. */
interface BodyPose { position: THREE.Vector3; quaternion: THREE.Quaternion }

export interface WeaponViewModel {
  authored: AuthoredWeaponRig;
  group: THREE.Group;
  body: THREE.Group;
  mechanisms: Partial<Record<'hinge' | 'shellLeft' | 'shellRight' | 'magazine' | 'pump' | 'cylinder' | 'rotor' | 'hammer' | 'bolt' | 'slide' | 'shell'
    | 'limbUpper' | 'limbLower' | 'stringUpper' | 'stringLower' | 'nockedArrow', THREE.Object3D>>;
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
/** Depth (m) of the stock's rear taken as its butt: the SMG's pad alone is ~4 cm. */
const BUTT_PLATE = 0.05;
/** View bob can raise the hip weapon this much (m): player.ts's walking bobAmt. */
const HIP_BOB = 0.02;
/**
 * The longbow's arrow pass, camera space (m). At the hip the bow is carried
 * low and left, canted so the upper limb leaves the frame near its top centre
 * instead of crossing the crosshair. Raised, the arrow runs under the eye to
 * a mouth-corner anchor, as an instinctive archer's does: at full draw the
 * nock and fletching sit below the frame, the shaft rises out of its lower
 * edge to the pass just under the crosshair, and the cant keeps the stave a
 * few degrees clear of it on the bow-hand side.
 */
const BOW_HIP = { x: -0.14, y: -0.13, z: -0.70 };
const BOW_HIP_ROLL = -0.25;
const BOW_AIM = { x: 0.015, y: -0.085, z: -0.80 };
const BOW_AIM_ROLL = -0.22;
/**
 * The arming sword's grip, camera space (m), in a plow guard: hilt low right
 * where the hand is, the point driven in and up toward the crosshair,
 * converging SWORD_CONVERGENCE out — inside thrust reach, and short of the
 * crosshair on screen so the blade frames a target rather than covering it.
 * A little edge-cant, as a wrist holds it.
 */
export const SWORD_GRIP = { x: 0.24, y: -0.29, z: -0.44 };
const SWORD_CONVERGENCE = 2.5;
const SWORD_ROLL = -0.3;

/** Model-space vertices of every mesh under `root` (unparented) with z beyond `z`. */
function verticesBehind(root: THREE.Object3D, z: number): Vec3[] {
  root.updateMatrixWorld(true);
  const out: Vec3[] = [];
  const v = new THREE.Vector3();
  root.traverse(node => {
    if (!(node instanceof THREE.Mesh)) return;
    const mesh = node as THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>;
    const position = mesh.geometry.getAttribute('position');
    for (let i = 0; i < position.count; i++) {
      v.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
      if (v.z > z) out.push({ x: v.x, y: v.y, z: v.z });
    }
  });
  return out;
}

function required(node: THREE.Object3D | undefined, id: WeaponId): THREE.Object3D {
  if (!node) throw new Error(`Viewmodel: ${id} has no muzzle or point to hold by`);
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
  const buttPlate = SHOULDERED.has(id) ? verticesBehind(authored.root, butt - BUTT_PLATE) : [];
  body.add(authored.root);
  // Authored sight height above the model origin; scaled with each model to
  // real size (scripts/assets/real-size.py).
  const sightLine = id === 'pistol' ? -0.0028 : id === 'revolver' ? 0.03145 : id === 'shotgun' ? .03128 : id === 'sawnOff' ? .0064 : 0;
  let hold: WeaponViewModel['hold'];
  let aimOffset: WeaponViewModel['aimOffset'];
  if (id === 'longbow') {
    // Hip: the arrow line converges on the crosshair like every bore does,
    // with the cant added about the arrow pass (the model origin) so it does
    // not swing the arrow off that line. The bow never changes its hand
    // between the poses; ADS carries it by aimOffset alone.
    authored.root.updateMatrixWorld(true);
    const pass = attachmentPoint(required(authored.muzzle, id), authored.root);
    const hip = hipHold(pass, { x: pass.x, y: pass.y, z: pass.z - 1 }, BOW_HIP, HIP_CONVERGENCE);
    const position = new THREE.Vector3(hip.position.x, hip.position.y, hip.position.z);
    hold = {
      hip: { position, quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(hip.pitch, hip.yaw, BOW_HIP_ROLL, 'YXZ')) },
      aim: { position, quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, BOW_AIM_ROLL, 'YXZ')) },
    };
    aimOffset = { x: BOW_AIM.x - pass.x - position.x, y: BOW_AIM.y - pass.y - position.y, z: BOW_AIM.z - pass.z - position.z };
  } else if (id === 'armingSword') {
    // Never aimed (RMB slashes), so both poses are the guard.
    authored.root.updateMatrixWorld(true);
    const grip = attachmentPoint(authored.grip, authored.root);
    const tip = attachmentPoint(required(authored.bladeTip, id), authored.root);
    const guard = hipHold(grip, tip, SWORD_GRIP, SWORD_CONVERGENCE);
    const pose = { position: new THREE.Vector3(guard.position.x, guard.position.y, guard.position.z),
      quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(guard.pitch, guard.yaw, SWORD_ROLL, 'YXZ')) };
    hold = { hip: pose, aim: pose };
    aimOffset = { x: 0, y: 0, z: 0 };
  } else if (id === 'knife') {
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
    // A stock shorter than the others (the real-sized SMG's) would end inside
    // the frame's lower edge with the grip on the shared hand point; draw it
    // back along its bore until the butt plate is out of view. Measured, so a
    // stock that already runs off the frame does not move.
    const slide = slideToClear(buttPlate, hip, Math.tan(BASE_FOV * Math.PI / 360), CAMERA_NEAR, HIP_BOB);
    const back = rotateYawPitch({ x: 0, y: 0, z: 1 }, hip.yaw, hip.pitch);
    // Straight, with the grip still on the hand point: ADS unwinds the cant
    // about the hand rather than swinging the gun about the eye.
    const aim = new THREE.Vector3(HIP_GRIP.x - grip.x, HIP_GRIP.y - grip.y, HIP_GRIP.z - grip.z);
    // Shouldered, the butt ends on the eye plane — a cheek weld — so the
    // stock runs out of view below the eye instead of standing in the frame.
    const depth = SHOULDERED.has(id) ? butt : HANDGUN_ADS_DEPTH;
    hold = {
      hip: { position: new THREE.Vector3(hip.position.x, hip.position.y, hip.position.z).addScaledVector(new THREE.Vector3(back.x, back.y, back.z), slide),
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
  if (id === 'longbow') {
    // The string and the nocked arrow follow the draw every frame
    // (bowPresentation.ts), so they are built here rather than authored.
    const linen = createCelMaterial({ color: 0xe8dfc4 });
    for (const key of ['stringUpper', 'stringLower'] as const) {
      const geometry = new THREE.CylinderGeometry(0.0013, 0.0013, 1, 6);
      geometry.translate(0, 0.5, 0); // base at the origin, unit length up +y
      const string = new THREE.Mesh(geometry, linen);
      body.add(string);
      mechanisms[key] = string;
    }
    const arrow = createArrowModel();
    body.add(arrow);
    mechanisms.nockedArrow = arrow;
  }
  const rest: WeaponViewModel['rest'] = new Map();
  for (const [key, node] of Object.entries(mechanisms)) {
    node.name = `weapon-mechanism-${key}`;
    rest.set(node, { position: node.position.clone(), rotation: node.rotation.clone() });
  }
  return { authored, group, body, mechanisms, rest, hold, aimOffset };
}
