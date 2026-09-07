import { describe, expect, test } from 'vitest';
import { Vector3 } from 'three';
import { solveArmIK } from './armIK';

describe('fixed-length arm IK', () => {
  test.each([new Vector3(.2, .3, -.2), new Vector3(10, 0, 0), new Vector3(), new Vector3(0, 1e-12, 0)])('preserves lengths for target %s', target => {
    const shoulder = new Vector3();
    const { elbow, wrist } = solveArmIK(shoulder, target, new Vector3(0, -1, 0), .3, .29);
    expect(elbow.distanceTo(shoulder)).toBeCloseTo(.3, 6);
    expect(wrist.distanceTo(elbow)).toBeCloseTo(.29, 6);
    expect([...elbow.toArray(), ...wrist.toArray()].every(Number.isFinite)).toBe(true);
  });
  test('reaches valid targets exactly and clamps distant targets', () => {
    const target = new Vector3(.1, .2, -.3);
    const result = solveArmIK(new Vector3(), target, new Vector3(1,-1,0), .3,.29);
    expect(result.wrist.distanceTo(target)).toBeLessThan(1e-8);
    expect(result.clamped).toBe(false);
    expect(solveArmIK(new Vector3(), target.multiplyScalar(10), new Vector3(), .3,.29).clamped).toBe(true);
  });
  test('mirrors elbow placement', () => {
    const right = solveArmIK(new Vector3(.2,0,0), new Vector3(.1,.3,-.2), new Vector3(1,-1,0), .3,.29);
    const left = solveArmIK(new Vector3(-.2,0,0), new Vector3(-.1,.3,-.2), new Vector3(-1,-1,0), .3,.29);
    expect(right.elbow.x).toBeCloseTo(-left.elbow.x);
    expect(right.elbow.y).toBeCloseTo(left.elbow.y);
    expect(right.elbow.z).toBeCloseTo(left.elbow.z);
  });
  test('handles equal lengths with coincident target and rejects invalid inputs', () => {
    const r = solveArmIK(new Vector3(),new Vector3(),new Vector3(),.3,.3);
    expect(r.elbow.distanceTo(r.wrist)).toBeCloseTo(.3, 6);
    expect(() => solveArmIK(new Vector3(),new Vector3(),new Vector3(),0,.3)).toThrow();
    expect(() => solveArmIK(new Vector3(NaN,0,0),new Vector3(),new Vector3(),.3,.3)).toThrow();
  });
});
