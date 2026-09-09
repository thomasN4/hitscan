import { describe, expect, test } from 'vitest';
import { shouldAbandonRoute } from './routeFollow';

/**
 * Abandon distance is bots.ts:ROUTE_ABANDON's value, passed as a parameter —
 * the helper takes every input explicitly, so the test names the number it
 * asserts against rather than importing executor tuning.
 */
const ABANDON = 6;

/** The warehouse2 stair trap (docs/warehouse2-bot-playtest.md section 4). */
const LIP = { x: -21.67, z: -7.68 };
const FOOT = { x: -9.68, z: -6.68 };
const ON_FLIGHT = { x: -20.6, z: -7.85 };

describe('shouldAbandonRoute', () => {
  test('keeps a path whose previous waypoint was just consumed across a link edge', () => {
    // The trap geometry: the lip node is ~1.1 m away (just consumed), the
    // foot node ~11 m. The old current-leg-only check read the 11 m and
    // dropped the path every frame; the bot keeps walking it now.
    expect(shouldAbandonRoute([LIP, FOOT], 1, ON_FLIGHT, ABANDON)).toBe(false);
  });

  test('still abandons a path left far behind', () => {
    // A respawn across the map, or a shove off an edge: far from the current
    // leg AND from its predecessor. This is the case the check exists for,
    // and the true half that keeps the suite non-vacuous.
    const far = { x: 40, z: 30 };
    expect(shouldAbandonRoute([LIP, FOOT], 1, far, ABANDON)).toBe(true);
  });

  test('keeps a path whose current waypoint is near', () => {
    // Ordinary walking: the current leg is within reach, whatever came before.
    expect(shouldAbandonRoute([LIP, FOOT], 1, { x: -10.5, z: -6.9 }, ABANDON)).toBe(false);
    expect(shouldAbandonRoute([LIP, FOOT], 0, { x: -21.0, z: -7.6 }, ABANDON)).toBe(false);
  });

  test('abandons on the first leg with no previous waypoint to consult', () => {
    // leg 0 has no predecessor, so the current waypoint decides alone — a
    // stale route held across a respawn still resets on the first check.
    expect(shouldAbandonRoute([LIP, FOOT], 0, { x: 40, z: 30 }, ABANDON)).toBe(true);
  });

  test('a far current leg beside a near previous one is an arrival, not drift', () => {
    // Generalised beyond the trap's coordinates: standing on any consumed
    // waypoint suppresses abandonment of the inherited leg.
    const path = [{ x: 0, z: 0 }, { x: 20, z: 0 }, { x: 40, z: 0 }];
    expect(shouldAbandonRoute(path, 1, { x: 0.5, z: 0 }, ABANDON)).toBe(false);
    expect(shouldAbandonRoute(path, 2, { x: 20.5, z: 0 }, ABANDON)).toBe(false);
    // …while midway between two far-apart waypoints, far from both, abandons.
    expect(shouldAbandonRoute(path, 2, { x: 30, z: 0 }, ABANDON)).toBe(true);
  });

  test('the boundary itself does not abandon', () => {
    // The executor's contract is strictly-greater-than; the seam keeps it.
    expect(shouldAbandonRoute([{ x: 0, z: 0 }], 0, { x: ABANDON, z: 0 }, ABANDON)).toBe(false);
    expect(shouldAbandonRoute([{ x: 0, z: 0 }], 0, { x: ABANDON + 0.01, z: 0 }, ABANDON)).toBe(true);
  });

  test('an empty path is never abandoned', () => {
    // The caller only asks about non-empty paths; a total function beats a
    // throw for the case that cannot arrive.
    expect(shouldAbandonRoute([], 0, ON_FLIGHT, ABANDON)).toBe(false);
  });

  test('a leg past the end clamps to the final waypoint', () => {
    // Defensive: the caller clamps already, but the decision must stay total
    // if a future caller does not.
    expect(shouldAbandonRoute([LIP, FOOT], 9, ON_FLIGHT, ABANDON)).toBe(false);
    expect(shouldAbandonRoute([LIP, FOOT], 9, { x: 40, z: 30 }, ABANDON)).toBe(true);
  });
});
