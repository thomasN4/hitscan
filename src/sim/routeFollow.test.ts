import { describe, expect, test } from 'vitest';
import { consumeReached, furthestWalkable, shouldAbandonRoute } from './routeFollow';

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

describe('furthestWalkable', () => {
  /** Six nodes in a straight line, one metre apart — the graph's own rhythm. */
  const straight = [
    { x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 },
    { x: 3, z: 0 }, { x: 4, z: 0 }, { x: 5, z: 0 },
  ];
  const open = (): boolean => false;
  /** A blocked disc — the stand-in for a wall the gate would refuse. */
  const disc = (cx: number, cz: number, r: number) => (x: number, z: number): boolean =>
    Math.hypot(x - cx, z - cz) < r;

  test('steers at the furthest waypoint within range on open ground', () => {
    // Range 3 covers nodes 1..3 from the origin; the shortcut takes node 3
    // rather than turning at 1 and 2 on the way there.
    expect(furthestWalkable(straight, [], 0, { x: 0, z: 0 }, 3, open)).toBe(3);
  });

  test('stops at the path end rather than overrunning it', () => {
    expect(furthestWalkable(straight, [], 0, { x: 0, z: 0 }, 99, open)).toBe(5);
  });

  test('a blocked line is skipped, never steered through', () => {
    // A wall sitting on node 2: every line past it samples blocked, so the
    // shortcut holds at node 1 — the last clear line — instead of cutting
    // the corner through geometry.
    expect(furthestWalkable(straight, [], 0, { x: 0, z: 0 }, 5, disc(2, 0, 0.6))).toBe(1);
  });

  test('a clear later line past a blocked joint is still taken', () => {
    // The joint at (1,0) is walled, but the lines past it round the disc
    // cleanly: skipping ends the scan only for boardings, so the shortcut
    // aims at the furthest clear line rather than stopping dead behind the
    // blocked joint.
    const corner = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 2, z: 1 }, { x: 2, z: 2 }];
    expect(furthestWalkable(corner, [], 0, { x: 0, z: 0 }, 5, disc(1.2, 0, 0.5))).toBe(4);
  });

  test('never aims past an elevator boarding leg', () => {
    // The boarding at node 2 ends the scan even though nodes past it are
    // nearer than the range and walkable: aiming past the mouth steers around
    // the deck instead of onto it.
    const transport = [{}, {}, { elevatorId: 'e' }, {}, {}];
    expect(furthestWalkable(straight, transport, 0, { x: 0, z: 0 }, 99, open)).toBe(1);
  });

  test('waypoints beyond range are skipped, nearer later ones still taken', () => {
    // A far excursion mid-path must not end the scan: the excursion is out of
    // range, but the nearer node past it is a legitimate shortcut.
    const zigzag = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 1, z: 0 }];
    expect(furthestWalkable(zigzag, [], 0, { x: 0, z: 0 }, 3, open)).toBe(2);
  });

  test('an empty path and an overrun leg stay put', () => {
    expect(furthestWalkable([], [], 0, { x: 0, z: 0 }, 3, open)).toBe(0);
    expect(furthestWalkable(straight, [], 9, { x: 5, z: 0 }, 3, open)).toBe(5);
  });
});

describe('consumeReached', () => {
  const REACHED = 1;
  const straight = [
    { x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 },
    { x: 3, z: 0 }, { x: 4, z: 0 }, { x: 5, z: 0 },
  ];

  test('walks one reached waypoint at a time, as before', () => {
    // Standing on node 1 with node 2 a metre off: consume 1, stop at 2.
    expect(consumeReached(straight, [], 1, 1, { x: 1, z: 0 }, REACHED)).toBe(2);
    // Nothing within reach: the leg holds.
    expect(consumeReached(straight, [], 1, 1, { x: 0, z: 3 }, REACHED)).toBe(1);
  });

  test('a shortcut past the current leg still consumes the legs it reached', () => {
    // Aimed at node 3, the bot cut wide of node 1 (1.2 m off) and now
    // stands on node 3. Strict-order consumption would freeze leg at 1;
    // the bot has plainly got past it.
    expect(consumeReached(straight, [], 1, 3, { x: 3, z: 0 }, REACHED)).toBe(4);
  });

  test('a shove off the current leg does not freeze consumption', () => {
    // Shoved 1.5 m beside node 1 while aimed at node 2, then on top of 2.
    expect(consumeReached(straight, [], 1, 2, { x: 1, z: 1.5 }, REACHED)).toBe(1);
    expect(consumeReached(straight, [], 1, 2, { x: 2, z: 0.2 }, REACHED)).toBe(3);
  });

  test('never consumes a waypoint it was not steered at', () => {
    // A path doubling back: node 4 sits beside node 0. Standing on node 0,
    // aimed at 1, the bot must not jump to leg 5 through the wall between.
    const hairpin = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 2, z: 0.6 }, { x: 0.2, z: 0.6 }, { x: -1, z: 0.6 }];
    expect(consumeReached(hairpin, [], 0, 1, { x: 0.2, z: 0 }, REACHED)).toBe(2);
    // Steered at node 4 (the caller verified the line), it may.
    expect(consumeReached(hairpin, [], 0, 4, { x: 0.2, z: 0 }, REACHED)).toBe(5);
  });

  test('never consumes a boarding leg or anything past it', () => {
    const transport = [{}, {}, { elevatorId: 'e' }, {}, {}, {}];
    // Reaching node 2 (the boarding leg) while aimed past it: leg stops at 2.
    expect(consumeReached(straight, transport, 1, 4, { x: 1.8, z: 0 }, REACHED)).toBe(2);
    expect(consumeReached(straight, transport, 2, 4, { x: 3, z: 0 }, REACHED)).toBe(2);
  });

  test('never consumes the final waypoint', () => {
    expect(consumeReached(straight, [], 4, 9, { x: 4.5, z: 0 }, REACHED)).toBe(5);
    expect(consumeReached(straight, [], 5, 9, { x: 5, z: 0 }, REACHED)).toBe(5);
  });

  test('an aimed index behind the leg scans only the current leg', () => {
    expect(consumeReached(straight, [], 3, 0, { x: 3, z: 0 }, REACHED)).toBe(4);
    expect(consumeReached(straight, [], 3, 0, { x: 4, z: 0 }, REACHED)).toBe(3);
  });

  test('an empty path stays at leg 0', () => {
    expect(consumeReached([], [], 0, 0, { x: 0, z: 0 }, REACHED)).toBe(0);
  });
});
