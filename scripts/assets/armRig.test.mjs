import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Vector3, Euler } from 'three';
import { createArmRig, poseHand } from '../../src/core/weaponHands.ts';

async function asset() {
  const bytes = readFileSync(new URL('../../public/assets/arms.glb', import.meta.url));
  const buffer = new ArrayBuffer(bytes.length);
  new Uint8Array(buffer).set(bytes);
  return (await new GLTFLoader().parseAsync(buffer, '')).scene;
}
test('cloned skeletons pose independently and reach a valid grip', async () => {
  const source = await asset();
  const a = createArmRig(source), b = createArmRig(source);
  expect(a.right.wrist).not.toBe(b.right.wrist);
  const before = b.right.wrist.quaternion.clone();
  const shoulder = new Vector3(.2, -.4, -.39), grip = new Vector3(.1, -.2, -.7);
  poseHand(a.right, grip, new Euler(.1,.2,.3), 1, shoulder, new Vector3(1,-1,0));
  a.root.updateMatrixWorld(true);
  expect(a.right.wrist.getWorldPosition(new Vector3()).distanceTo(grip)).toBeLessThan(1e-6);
  expect(b.right.wrist.quaternion.equals(before)).toBe(true);
  expect(a.right.wrist.quaternion.equals(before)).toBe(false);
});
test('missing bones fail before a viewmodel is usable', async () => {
  const source = await asset();
  const bone = source.getObjectByName('left_upper');
  if (!bone) throw new Error('Fixture missing upper arm');
  bone.name = 'incompatible';
  expect(() => createArmRig(source)).toThrow('missing bone left_upper');
});
