import { describe, expect, test } from 'vitest';
import {
  CAPTURE_TIME_S,
  TICK_POINTS_PER_SEC,
  assignDomObjectives,
  countFlagBodies,
  holderRanks,
  isBodyInRing,
  tickDomScores,
  updateFlagCapture,
  type MutableDomFlag,
} from './domination';
import { decideDomWinner, reachesDomLimit } from './match';

function flag(over: Partial<MutableDomFlag> = {}): MutableDomFlag {
  return {
    id: 'A',
    pos: { x: 0, y: 0, z: 0 },
    radius: 4.5,
    owner: null,
    progress: 0,
    challenger: null,
    ...over,
  };
}

describe('countFlagBodies', () => {
  const f = flag();
  test('counts planar-inside bodies per side', () => {
    const counts = countFlagBodies(f, [
      { team: 'T', x: 1, feetY: 0, z: 1 },
      { team: 'T', x: 4, feetY: 0, z: 0 },
      { team: 'CT', x: -2, feetY: 0, z: -2 },
      { team: 'CT', x: 40, feetY: 0, z: 0 },
    ]);
    expect(counts).toEqual({ t: 2, ct: 1 });
  });

  test('the deck flag ignores the floor below (and vice versa)', () => {
    const deck = flag({ pos: { x: 0, y: 3.6, z: 0 } });
    const counts = countFlagBodies(deck, [
      { team: 'T', x: 0, feetY: 3.6, z: 0 },
      { team: 'CT', x: 0, feetY: 0, z: 0 },
    ]);
    expect(counts).toEqual({ t: 1, ct: 0 });
  });
});

describe('isBodyInRing', () => {
  const f = flag();
  test('inside the planar ring at grade counts', () => {
    expect(isBodyInRing(f, { team: 'T', x: 1, feetY: 0, z: 1 })).toBe(true);
  });

  test('outside the planar ring does not count, even at grade', () => {
    expect(isBodyInRing(f, { team: 'T', x: 40, feetY: 0, z: 0 })).toBe(false);
  });

  test('the vertical window binds both ways: deck body, ground flag', () => {
    const deck = flag({ pos: { x: 0, y: 3.6, z: 0 } });
    expect(isBodyInRing(deck, { team: 'T', x: 0, feetY: 3.6, z: 0 })).toBe(true);
    expect(isBodyInRing(deck, { team: 'CT', x: 0, feetY: 0, z: 0 })).toBe(false);
  });

  test('agrees with countFlagBodies on every body it counts', () => {
    const bodies = [
      { team: 'T' as const, x: 1, feetY: 0, z: 1 },
      { team: 'T' as const, x: 4, feetY: 0, z: 0 },
      { team: 'CT' as const, x: -2, feetY: 0, z: -2 },
      { team: 'CT' as const, x: 40, feetY: 0, z: 0 },
    ];
    const counts = countFlagBodies(f, bodies);
    const inRing = bodies.filter(b => isBodyInRing(f, b));
    expect(inRing.filter(b => b.team === 'T')).toHaveLength(counts.t);
    expect(inRing.filter(b => b.team === 'CT')).toHaveLength(counts.ct);
  });
});

describe('holderRanks', () => {
  const f = flag();
  const body = (id: number, team: 'T' | 'CT', x = 0, feetY = 0, z = 0) => ({ id, team, x, feetY, z });

  test('a lone holder ranks zero', () => {
    expect(holderRanks(f, [body(3, 'T')]).get(3)).toBe(0);
  });

  test('the lowest id holds while higher ids escort, in arrival-independent order', () => {
    const ranks = holderRanks(f, [body(7, 'T'), body(2, 'T'), body(5, 'T')]);
    expect(ranks.get(2)).toBe(0);
    expect(ranks.get(5)).toBe(1);
    expect(ranks.get(7)).toBe(2);
  });

  test('ranks are per team: enemies share no ladder', () => {
    const ranks = holderRanks(f, [body(1, 'T'), body(2, 'CT')]);
    expect(ranks.get(1)).toBe(0);
    expect(ranks.get(2)).toBe(0);
  });

  test('bodies outside the ring (planar or vertical) rank nobody and appear nowhere', () => {
    const deck = flag({ pos: { x: 0, y: 3.6, z: 0 } });
    const ranks = holderRanks(deck, [
      body(1, 'T', 0, 3.6, 0),
      body(2, 'T', 40, 3.6, 0),
      body(3, 'T', 0, 0, 0),
    ]);
    expect(ranks.get(1)).toBe(0);
    expect(ranks.has(2)).toBe(false);
    expect(ranks.has(3)).toBe(false);
  });

  test('an empty ring ranks nobody', () => {
    expect(holderRanks(f, []).size).toBe(0);
  });
});

describe('updateFlagCapture', () => {
  test('uncontested presence fills then flips the flag', () => {
    const f = flag();
    expect(updateFlagCapture(f, 1, 0, CAPTURE_TIME_S / 2)).toBeNull();
    expect(f.challenger).toBe('T');
    expect(updateFlagCapture(f, 1, 0, CAPTURE_TIME_S / 2)).toBe('T');
    expect(f.owner).toBe('T');
    expect(f.challenger).toBeNull();
    expect(f.progress).toBe(0);
  });

  test('contested presence freezes progress', () => {
    const f = flag();
    updateFlagCapture(f, 1, 0, 1);
    const held = f.progress;
    expect(updateFlagCapture(f, 1, 1, 5)).toBeNull();
    expect(f.progress).toBe(held);
    expect(f.challenger).toBe('T');
  });

  test('an empty point decays challenger progress to neutral', () => {
    const f = flag();
    updateFlagCapture(f, 1, 0, 2);
    expect(updateFlagCapture(f, 0, 0, 1)).toBeNull();
    expect(f.progress).toBeLessThan(2 / CAPTURE_TIME_S);
    updateFlagCapture(f, 0, 0, CAPTURE_TIME_S);
    expect(f.progress).toBe(0);
    expect(f.challenger).toBeNull();
  });

  test('the owner standing alone holds without capturing', () => {
    const f = flag({ owner: 'CT' });
    expect(updateFlagCapture(f, 0, 2, 3)).toBeNull();
    expect(f.owner).toBe('CT');
    expect(f.progress).toBe(0);
  });

  test('switching challengers restarts from zero', () => {
    const f = flag();
    updateFlagCapture(f, 1, 0, 4);
    updateFlagCapture(f, 0, 1, 1);
    expect(f.challenger).toBe('CT');
    expect(f.progress).toBe(1 / CAPTURE_TIME_S);
  });
});

describe('tickDomScores', () => {
  test('each owned flag ticks the rate; neutral flags tick nothing', () => {
    const scores = { ct: 0, t: 0 };
    tickDomScores([{ owner: 'CT' }, { owner: 'T' }, { owner: null }], scores, 10);
    expect(scores.ct).toBe(10 * TICK_POINTS_PER_SEC);
    expect(scores.t).toBe(10 * TICK_POINTS_PER_SEC);
  });
});

describe('decideDomWinner / reachesDomLimit', () => {
  test('higher ticked score wins, ties draw', () => {
    expect(decideDomWinner(200, 150)).toBe('CT');
    expect(decideDomWinner(90, 200)).toBe('T');
    expect(decideDomWinner(100, 100)).toBe('draw');
  });

  test('the limit fires at and past the boundary, never below', () => {
    expect(reachesDomLimit(199.9, 200)).toBe(false);
    expect(reachesDomLimit(200, 200)).toBe(true);
    expect(reachesDomLimit(203.5, 200)).toBe(true);
  });
});

describe('assignDomObjectives', () => {
  const flags = [
    { id: 'A', x: 0, z: -30, owner: null as 'T' | 'CT' | null },
    { id: 'B', x: 0, z: 0, owner: null as 'T' | 'CT' | null },
    { id: 'C', x: 0, z: 30, owner: null as 'T' | 'CT' | null },
  ];

  test('bots split across nearby flags instead of stacking', () => {
    const bots = [
      { id: 1, team: 'T' as const, x: 0, z: -40 },
      { id: 2, team: 'T' as const, x: 0, z: -38 },
      { id: 3, team: 'T' as const, x: 0, z: 40 },
    ];
    const assigned = assignDomObjectives(bots, flags, new Map());
    expect(assigned.get(1)).toBe('A');
    expect(assigned.get(2)).toBe('A');
    expect(assigned.get(3)).toBe('C');
  });

  test('a defender stays on the owned flag while attackers take neutral ground', () => {
    const owned = [
      { id: 'A', x: 0, z: -30, owner: 'T' as const },
      { id: 'B', x: 0, z: 0, owner: null as 'T' | 'CT' | null },
      { id: 'C', x: 0, z: 30, owner: null as 'T' | 'CT' | null },
    ];
    const bots = [
      { id: 1, team: 'T' as const, x: 0, z: -30 },
      { id: 2, team: 'T' as const, x: 0, z: -10 },
      { id: 3, team: 'T' as const, x: 0, z: 0 },
      { id: 4, team: 'T' as const, x: 0, z: 10 },
    ];
    const assigned = assignDomObjectives(bots, owned, new Map());
    expect(assigned.get(1)).toBe('A');
    // Nobody stacks the owned flag past its defender: the rest go neutral.
    const onA = [...assigned.values()].filter(v => v === 'A');
    expect(onA.length).toBe(1);
  });

  test('stickiness survives a re-dispatch between equidistant flags', () => {
    const bots = [{ id: 1, team: 'CT' as const, x: 0, z: 15 }];
    const first = assignDomObjectives(bots, flags, new Map());
    const second = assignDomObjectives(bots, flags, first);
    expect(second.get(1)).toBe(first.get(1));
  });

  test('no flags means no assignments', () => {
    expect(assignDomObjectives([{ id: 1, team: 'T', x: 0, z: 0 }], [], new Map()).size).toBe(0);
  });
});
