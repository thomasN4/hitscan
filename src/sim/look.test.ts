import { describe, expect, test } from 'vitest';
import { applyLook, PITCH_LIMIT } from './look';

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
