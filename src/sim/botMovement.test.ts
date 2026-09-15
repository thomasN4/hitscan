// Replay real policy and collision together: isolated feeler/timer tests cannot
// see the speed eaten by repeated partial slides in an inside corner.
import { expect, test } from 'vitest';
import * as THREE from 'three';
import { collidesAt, slideMoveXZ } from '../collision';
import { WEAPONS } from '../core/state';
import { DefaultBrain, DEFAULT_BRAIN_PARAMS, type BrainParams } from './botBrains';
import { makeBotLoadout } from './botWeapons';

function corner(params: BrainParams, hz: number): { loss: number; stall: number } {
  let seed = 103;
  const rng = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const brain = new DefaultBrain(params, rng, makeBotLoadout('smg', 'pistol', id => WEAPONS[id], rng));
  const walls = [
    new THREE.Box3(new THREE.Vector3(-1.7, 0, -15), new THREE.Vector3(-0.7, 4, 15)),
    new THREE.Box3(new THREE.Vector3(-15, 0, -1.7), new THREE.Vector3(15, 4, -0.7)),
  ];
  const feet = new THREE.Vector3(), target = new THREE.Vector3(4, 0, 4);
  let blocked = false, intended = 0, lost = 0, stall = 0, longest = 0;
  const dt = 1 / hz;
  for (let frame = 0; frame < hz * 12; frame++) {
    const dist = target.distanceTo(feet);
    const intent = brain.decide({ selfFeet: feet, facing: target.clone().sub(feet).normalize(),
      visual: { id: 'player', feet: target, eye: target.clone().setY(1.7), dist, dist3: Math.hypot(dist, 0.2), rise: 0 },
      onGround: true, selfSpeed: 3.9, moveBlocked: blocked, heard: [],
      canStandAt: (x, z) => !collidesAt(new THREE.Vector3(x, 0, z), 0.5, 0, walls),
      nextWaypoint: () => null, nextPatrolWaypoint: () => null, objective: null,
    }, dt);
    expect(intent.mode).toBe('engage');
    const before = feet.clone();
    slideMoveXZ(feet, intent.step.x, intent.step.z, 0.5, 0, walls);
    const actual = feet.distanceTo(before), requested = intent.step.length();
    intended += requested;
    lost += Math.max(0, requested - actual);
    blocked = actual < requested * 0.25;
    stall = blocked ? stall + dt : 0;
    longest = Math.max(longest, stall);
    expect(collidesAt(feet, 0.5, 0, walls)).toBe(false);
  }
  return { loss: lost / intended, stall: longest };
}

test.each([20, 60, 120])('escapes an engaged inside corner without grinding at %i Hz', hz => {
  const tuned = corner(DEFAULT_BRAIN_PARAMS, hz);
  const previous = corner({ ...DEFAULT_BRAIN_PARAMS, stuckTime: 0.25, commitTime: 0.5 }, hz);
  expect(tuned.loss).toBeLessThan(0.2);
  expect(tuned.loss).toBeLessThan(previous.loss * 0.7);
  expect(tuned.stall).toBeLessThanOrEqual(0.1 + 1 / hz + 1e-9);
});
