// The longbow's draw on the viewmodel: limbs flex, the string follows its nock
// back, the nocked arrow slides with it. Presentation only — sim/bow.ts and
// weapons.ts own when the arrow actually leaves.
import * as THREE from 'three';
import type { WeaponViewModel } from './weaponModels';
import type { WeaponPose } from '../sim/weaponAnimation';
import { attachmentPoint } from './weaponAssets';
import { ARROW_LENGTH } from './arrowModel';

/**
 * Nock travel (m) from brace to full draw: a 28 in draw from the back of the
 * bow, less the 0.19 m the string already stands behind it at brace.
 */
const DRAW_TRAVEL = 0.52;
/** Limb rotation (rad) at full draw; carries each tip ~0.13 m toward the archer. */
const LIMB_FLEX = 0.15;

const UP = new THREE.Vector3(0, 1, 0);
const FORWARD = new THREE.Vector3(0, 0, -1);
const top = new THREE.Vector3();
const bottom = new THREE.Vector3();
const nock = new THREE.Vector3();
const pass = new THREE.Vector3();
const dir = new THREE.Vector3();

function stretch(segment: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3): void {
  dir.subVectors(to, from);
  segment.position.copy(from);
  segment.scale.set(1, dir.length(), 1);
  segment.quaternion.setFromUnitVectors(UP, dir.normalize());
}

export function poseBow(vm: WeaponViewModel, pose: WeaponPose): void {
  const { mechanisms: m, authored, body } = vm;
  if (!m.limbUpper || !m.limbLower || !m.stringUpper || !m.stringLower || !m.nockedArrow
    || !authored.stringTop || !authored.stringBottom || !authored.muzzle)
    throw new Error('Viewmodel: longbow is missing its limbs, string or arrow');
  // The nocking point is where the BRACED string crosses the arrow's height,
  // found before the limbs flex: the draw is measured from the bow, so the
  // tips coming in must not add to it.
  top.copy(attachmentPoint(authored.stringTop, body));
  bottom.copy(attachmentPoint(authored.stringBottom, body));
  pass.copy(attachmentPoint(authored.muzzle, body));
  nock.lerpVectors(bottom, top, (pass.y - bottom.y) / (top.y - bottom.y));
  nock.z += DRAW_TRAVEL * pose.bowDraw;
  m.limbUpper.rotation.x += LIMB_FLEX * pose.bowDraw;
  m.limbLower.rotation.x -= LIMB_FLEX * pose.bowDraw;
  top.copy(attachmentPoint(authored.stringTop, body));
  bottom.copy(attachmentPoint(authored.stringBottom, body));
  stretch(m.stringUpper, nock, top);
  stretch(m.stringLower, nock, bottom);
  // Nock on the string, shaft across the arrow pass: the tip rides forward of
  // the bow at brace and comes back to just past it at full draw.
  m.nockedArrow.visible = !pose.stringEmpty;
  dir.subVectors(pass, nock).normalize();
  m.nockedArrow.position.copy(nock).addScaledVector(dir, ARROW_LENGTH);
  m.nockedArrow.quaternion.setFromUnitVectors(FORWARD, dir);
}

/**
 * Where the nocked arrow's tip is, in world space, this frame — the point a
 * loosed arrow is drawn from before it settles onto its true flight line.
 */
export function nockedArrowTip(vm: WeaponViewModel, out: THREE.Vector3): THREE.Vector3 {
  const arrow = vm.mechanisms.nockedArrow;
  if (!arrow) throw new Error('Viewmodel: longbow has no nocked arrow');
  return arrow.getWorldPosition(out);
}
