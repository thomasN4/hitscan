import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { meleeSwing, type MeleeCandidate } from './melee';

/** Eye at the origin looking down -z (the arena's default facing). */
const EYE = new THREE.Vector3(0, 1.7, 0);
const FORWARD = new THREE.Vector3(0, 0, -1);

function candidate(payload: string, zone: 'head' | 'torso' | 'legs', at: THREE.Vector3): MeleeCandidate<string> {
  return { payload, zone, at };
}

describe('meleeSwing', () => {
  test('connects with a point dead ahead inside range', () => {
    const hit = meleeSwing(EYE, FORWARD, 2.0, 0.6, [
      candidate('bot', 'torso', new THREE.Vector3(0, EYE.y, -1.5)),
    ]);
    expect(hit?.payload).toBe('bot');
    expect(hit?.part).toBe('torso');
    expect(hit?.distance).toBeCloseTo(1.5, 5);
  });

  test('a point beyond range misses', () => {
    const hit = meleeSwing(EYE, FORWARD, 2.0, 0.6, [
      candidate('bot', 'torso', new THREE.Vector3(0, 1.4, -2.01)),
    ]);
    expect(hit).toBeUndefined();
  });

  test('range boundary is inclusive', () => {
    const hit = meleeSwing(EYE, FORWARD, 2.0, 0.6, [
      candidate('bot', 'torso', new THREE.Vector3(0, 1.7, -2.0)),
    ]);
    expect(hit?.distance).toBeCloseTo(2.0, 5);
  });

  test('a point outside the arc misses — even at zero distance cost', () => {
    // ~1 m ahead but ~45° off-axis: beyond arcRad/2 = 17°.
    const hit = meleeSwing(EYE, FORWARD, 2.0, 0.6, [
      candidate('bot', 'torso', new THREE.Vector3(1, 1.4, -1)),
    ]);
    expect(hit).toBeUndefined();
  });

  test('arc boundary is inclusive', () => {
    // Exactly arcRad/2 = 0.3 rad off-axis at unit-ish distance.
    const d = 1.5;
    const at = new THREE.Vector3(Math.sin(0.3) * d, EYE.y, -Math.cos(0.3) * d);
    const hit = meleeSwing(EYE, FORWARD, 2.0, 0.6, [candidate('bot', 'legs', at)]);
    expect(hit?.payload).toBe('bot');
  });

  test('nothing behind the eye connects, whatever the range', () => {
    const hit = meleeSwing(EYE, FORWARD, 50, Math.PI, [
      candidate('bot', 'torso', new THREE.Vector3(0, 1.4, +1)),
    ]);
    expect(hit).toBeUndefined();
  });

  test('the nearest candidate wins among several', () => {
    const hit = meleeSwing(EYE, FORWARD, 2.0, 0.6, [
      candidate('far', 'torso', new THREE.Vector3(0, 1.4, -1.8)),
      candidate('near', 'head', new THREE.Vector3(0, 1.9, -1.2)),
      candidate('other', 'legs', new THREE.Vector3(0, 0.6, -1.5)),
    ]);
    expect(hit?.payload).toBe('near');
    expect(hit?.part).toBe('head');
  });

  test('ties go to the first candidate encountered', () => {
    const at = new THREE.Vector3(0, 1.7, -1.5);
    const hit = meleeSwing(EYE, FORWARD, 2.0, 0.6, [
      candidate('first', 'torso', at),
      candidate('second', 'torso', at.clone()),
    ]);
    expect(hit?.payload).toBe('first');
  });

  test('no candidates, no hit', () => {
    expect(meleeSwing(EYE, FORWARD, 2.0, 0.6, [])).toBeUndefined();
  });

  test('payload rides through untouched', () => {
    const bot = { name: 'T-3' };
    const hit = meleeSwing(EYE, FORWARD, 2.0, 0.6, [
      { payload: bot, zone: 'torso', at: new THREE.Vector3(0, 1.4, -1) },
    ]);
    expect(hit?.payload).toBe(bot);
  });
});
