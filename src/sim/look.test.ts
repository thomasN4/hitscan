import { describe, expect, test } from 'vitest';
import { applyLook, accelGain, blendLook, ACCEL_CAP_PXS, ACCEL_REF_PXS, PITCH_LIMIT } from './look';

describe('applyLook', () => {
  test('rightward and downward deltas turn right and look down', () => {
    const r = applyLook(0, 0, 10, 10, 0.002, 1);
    expect(r.yaw).toBeCloseTo(-0.02);
    expect(r.pitch).toBeCloseTo(-0.02);
  });

  test('zoomScale scales both axes', () => {
    const r = applyLook(0, 0, 10, 10, 0.002, 0.25);
    expect(r.yaw).toBeCloseTo(-0.005);
    expect(r.pitch).toBeCloseTo(-0.005);
  });

  test('pitch clamps short of vertical; yaw does not wrap or clamp', () => {
    expect(applyLook(0, 0, 0, -1e6, 0.002, 1).pitch).toBe(PITCH_LIMIT);
    expect(applyLook(0, 0, 0, 1e6, 0.002, 1).pitch).toBe(-PITCH_LIMIT);
    expect(applyLook(0, 0, -1e4, 0, 0.002, 1).yaw).toBeCloseTo(20);
  });
});

describe('accelGain', () => {
  test('is exactly 1 with no acceleration, at any speed', () => {
    expect(accelGain(0, 0)).toBe(1);
    expect(accelGain(5000, 0)).toBe(1);
  });

  test('grows linearly with speed and doubles at the reference speed for accel 1', () => {
    expect(accelGain(ACCEL_REF_PXS, 1)).toBeCloseTo(2);
    expect(accelGain(ACCEL_REF_PXS / 2, 1)).toBeCloseTo(1.5);
    expect(accelGain(ACCEL_REF_PXS, 0.5)).toBeCloseTo(1.5);
  });

  test('caps at ACCEL_CAP_PXS and ignores negative speeds', () => {
    expect(accelGain(ACCEL_CAP_PXS * 10, 1)).toBeCloseTo(accelGain(ACCEL_CAP_PXS, 1));
    expect(accelGain(-100, 1)).toBe(1);
  });
});

describe('blendLook', () => {
  const hip = { sens: 1, accel: 0.5 };
  const ads = { sens: 0.5, accel: 0 };

  test('endpoints are the pure tunings, midway is the average', () => {
    expect(blendLook(hip, ads, 0)).toEqual(hip);
    expect(blendLook(hip, ads, 1)).toEqual(ads);
    expect(blendLook(hip, ads, 0.5)).toEqual({ sens: 0.75, accel: 0.25 });
  });

  test('clamps the blend factor', () => {
    expect(blendLook(hip, ads, 2)).toEqual(ads);
    expect(blendLook(hip, ads, -1)).toEqual(hip);
  });
});
