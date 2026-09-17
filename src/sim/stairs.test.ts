// stairs.test.ts — the shared flight-landing arithmetic.
//
// stairTop is what world.ts:stairLink and scripts/mapSvg.mjs:flightTop both
// delegate to, so this pins the formula itself; the map-promise coordinates
// stay owned by world.test.ts:stairLink and scripts/mapSvgs.test.mjs.
import { describe, expect, test } from 'vitest';
import { stairTop } from './stairs';

describe('stairTop', () => {
  test('ascends z+ by count treads and risers', () => {
    const top = stairTop(4, 0, -9, 0.3, 0.75, 12, 'z+');
    expect(top.x).toBeCloseTo(4, 12);
    expect(top.y).toBeCloseTo(3.6, 12);
    expect(top.z).toBeCloseTo(0, 12);
  });

  test('ascends x- into negative x', () => {
    const top = stairTop(-19.5, 0, -30, 0.3, 0.75, 10, 'x-');
    expect(top.x).toBeCloseTo(-27, 12);
    expect(top.y).toBeCloseTo(3, 12);
    expect(top.z).toBeCloseTo(-30, 12);
  });

  test('a flight based above ground carries its base', () => {
    const top = stairTop(0, 5, 0, 0.3, 0.75, 4, 'x+');
    expect(top.x).toBeCloseTo(3, 12);
    expect(top.y).toBeCloseTo(6.2, 12);
    expect(top.z).toBeCloseTo(0, 12);
  });
});
