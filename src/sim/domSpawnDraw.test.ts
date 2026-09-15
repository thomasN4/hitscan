import { describe, expect, test } from 'vitest';
import {
  DOM_RING_INNER,
  DOM_RING_OUTER,
  drawRingPoint,
  drawZonePoint,
  pickDomZoneIndex,
} from './domSpawnDraw';

/** Scripted draw stream: yields the values in order, holding the last. */
function scripted(...values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)]!;
}

/** Deterministic PRNG (LCG) for distribution checks. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe('pickDomZoneIndex', () => {
  test('no owned flags means the home zone, whatever the draw', () => {
    expect(pickDomZoneIndex(0, scripted(0))).toBe(0);
    expect(pickDomZoneIndex(0, scripted(0.999))).toBe(0);
  });

  test('two owned flags split the stream into thirds', () => {
    expect(pickDomZoneIndex(2, scripted(0))).toBe(0);
    expect(pickDomZoneIndex(2, scripted(0.33))).toBe(0);
    expect(pickDomZoneIndex(2, scripted(0.34))).toBe(1);
    expect(pickDomZoneIndex(2, scripted(0.66))).toBe(1);
    expect(pickDomZoneIndex(2, scripted(0.67))).toBe(2);
    expect(pickDomZoneIndex(2, scripted(0.999))).toBe(2);
  });

  test('three owned flags split into quarters', () => {
    expect(pickDomZoneIndex(3, scripted(0.24))).toBe(0);
    expect(pickDomZoneIndex(3, scripted(0.25))).toBe(1);
    expect(pickDomZoneIndex(3, scripted(0.75))).toBe(3);
  });
});

describe('drawZonePoint', () => {
  const zone = { minX: 10, maxX: 50, minZ: -55, maxZ: -30, y: 0 };

  test('fractions map onto the rect at the zone feet height', () => {
    expect(drawZonePoint(zone, scripted(0, 0))).toEqual({ x: 10, y: 0, z: -55 });
    expect(drawZonePoint(zone, scripted(0.5, 0.5))).toEqual({ x: 30, y: 0, z: -42.5 });
  });
});

describe('drawRingPoint', () => {
  const flag = { x: 0, y: 3.6, z: 0 };

  test('radius fraction 0 hugs the inner edge, 1 the outer', () => {
    // Angle fraction 0 aims +x; the point carries the flag's feet height.
    expect(drawRingPoint(flag, scripted(0, 0))).toEqual({ x: DOM_RING_INNER, y: 3.6, z: 0 });
    const outer = drawRingPoint(flag, scripted(0, 1));
    expect(outer.x).toBeCloseTo(DOM_RING_OUTER, 9);
    expect(outer.y).toBe(3.6);
    expect(outer.z).toBeCloseTo(0, 9);
  });

  test('radius is sqrt-sampled, so equal areas are equally likely', () => {
    // u = 0.25 lands at sqrt(0.25*(100-16)+16) = sqrt(37), not at 4+0.25*6.
    const p = drawRingPoint(flag, scripted(0, 0.25));
    expect(p.x).toBeCloseTo(Math.sqrt(37), 9);
  });

  test('seeded draws stay inside the band at flag height', () => {
    const rng = lcg(7);
    for (let i = 0; i < 500; i++) {
      const p = drawRingPoint(flag, rng);
      const d = Math.hypot(p.x - flag.x, p.z - flag.z);
      expect(d).toBeGreaterThanOrEqual(DOM_RING_INNER - 1e-9);
      expect(d).toBeLessThanOrEqual(DOM_RING_OUTER + 1e-9);
      expect(p.y).toBe(flag.y);
    }
  });

  test('mean squared radius matches the area-uniform value, not the linear one', () => {
    // Area-uniform E[r^2] = (outer^2+inner^2)/2 = 58; a uniform radius would
    // give (1000-64)/(3*6) = 52 instead, so this discriminates the two.
    const rng = lcg(21);
    const n = 2000;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const p = drawRingPoint(flag, rng);
      const d = Math.hypot(p.x - flag.x, p.z - flag.z);
      sum += d * d;
    }
    expect(sum / n).toBeGreaterThan(56);
    expect(sum / n).toBeLessThan(60);
  });
});

describe('zone shares', () => {
  test('two owned flags deal ~1/3 each over seeded draws', () => {
    const rng = lcg(99);
    const counts = [0, 0, 0];
    const n = 3000;
    for (let i = 0; i < n; i++) counts[pickDomZoneIndex(2, rng)]!++;
    for (const c of counts) expect(c / n).toBeGreaterThan(0.28);
    for (const c of counts) expect(c / n).toBeLessThan(0.39);
  });
});
