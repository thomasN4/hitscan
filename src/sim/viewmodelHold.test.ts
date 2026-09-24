import { describe, expect, test } from 'vitest';
import { Euler, Vector3 } from 'three';
import { hipHold, rotateYawPitch } from './viewmodelHold';

const anchor = { x: 0.22, y: -0.26, z: -0.44 };
// A rifle and a pistol, grip and muzzle markers in model space (m).
const weapons = {
  rifle: { grip: { x: 0, y: -0.136, z: 0.108 }, muzzle: { x: 0, y: -0.044, z: -0.346 } },
  pistol: { grip: { x: 0, y: -0.112, z: 0.069 }, muzzle: { x: 0, y: -0.031, z: -0.107 } },
};

describe('hipHold', () => {
  test('rotateYawPitch matches a three.js YXZ Euler', () => {
    const v = { x: 0.1, y: -0.2, z: -0.7 };
    const r = rotateYawPitch(v, 0.3, -0.2);
    const expected = new Vector3(v.x, v.y, v.z).applyEuler(new Euler(-0.2, 0.3, 0, 'YXZ'));
    expect(r.x).toBeCloseTo(expected.x, 12);
    expect(r.y).toBeCloseTo(expected.y, 12);
    expect(r.z).toBeCloseTo(expected.z, 12);
  });

  for (const [name, { grip, muzzle }] of Object.entries(weapons)) {
    test(`${name}: grip lands on the anchor and the bore crosses the axis at the convergence`, () => {
      const hold = hipHold(grip, muzzle, anchor, 3);
      const place = (p: typeof grip) => {
        const r = rotateYawPitch(p, hold.yaw, hold.pitch);
        return { x: hold.position.x + r.x, y: hold.position.y + r.y, z: hold.position.z + r.z };
      };
      const g = place(grip);
      expect(g.x).toBeCloseTo(anchor.x, 12);
      expect(g.y).toBeCloseTo(anchor.y, 12);
      expect(g.z).toBeCloseTo(anchor.z, 12);
      // Follow the bore from the muzzle to the plane z = -3.
      const m = place(muzzle);
      const d = rotateYawPitch({ x: 0, y: 0, z: -1 }, hold.yaw, hold.pitch);
      const t = (-3 - m.z) / d.z;
      expect(Math.abs(m.x + d.x * t)).toBeLessThan(1e-6);
      expect(Math.abs(m.y + d.y * t)).toBeLessThan(1e-6);
      // Right of and below the axis, it turns in (left) and up.
      expect(hold.yaw).toBeGreaterThan(0);
      expect(hold.pitch).toBeGreaterThan(0);
    });
  }
});
