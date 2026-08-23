import { describe, expect, test } from 'vitest';
import { GameClock } from './gameClock';

describe('GameClock time base', () => {
  test('starts at 0 and accumulates advances', () => {
    const c = new GameClock();
    expect(c.now()).toBe(0);
    c.advance(0.016);
    c.advance(0.016);
    expect(c.now()).toBeCloseTo(0.032, 12);
  });

  test('does not move without advance (paused)', () => {
    const c = new GameClock();
    c.advance(1);
    expect(c.now()).toBe(1);
    // No further calls — e.g. the loop is paused.
    expect(c.now()).toBe(1);
  });

  test('rejects negative dt (would rewind the epoch)', () => {
    const c = new GameClock();
    expect(() => c.advance(-0.01)).toThrow(/>= 0/);
  });

  test('rejects NaN dt (would corrupt the epoch and invert the drain guard)', () => {
    const c = new GameClock();
    let fired = 0;
    c.schedule(10, () => fired++);
    expect(() => c.advance(Number.NaN)).toThrow();
    c.advance(11);
    expect(fired).toBe(1); // the poisoned call must not have drained anything
  });
});

describe('GameClock scheduler', () => {
  test('fires a job once, at its due time, not before', () => {
    const c = new GameClock();
    let fired = 0;
    c.schedule(0.5, () => fired++);
    c.advance(0.25);
    expect(fired).toBe(0);
    c.advance(0.25);
    expect(fired).toBe(1);
    c.advance(1);
    expect(fired).toBe(1);
  });

  test('nothing fires without advance', () => {
    const c = new GameClock();
    let fired = 0;
    c.schedule(0.001, () => fired++);
    expect(fired).toBe(0);
  });

  test('zero-delay job waits for the next advance (not synchronous)', () => {
    const c = new GameClock();
    let fired = 0;
    c.schedule(0, () => fired++);
    expect(fired).toBe(0);
    c.advance(0);
    expect(fired).toBe(1);
  });

  test('negative delay clamps to due-now', () => {
    const c = new GameClock();
    let fired = 0;
    c.schedule(-5, () => fired++);
    expect(fired).toBe(0);
    c.advance(0.016);
    expect(fired).toBe(1);
  });

  test('fires overlapping jobs in due order, ties in schedule order', () => {
    const order: string[] = [];
    const c = new GameClock();
    c.advance(1);
    c.schedule(2, () => order.push('b')); // due at t=3
    c.schedule(1, () => order.push('a')); // due at t=2
    c.schedule(2, () => order.push('c')); // due at t=3, scheduled after b
    c.advance(1); // t=2
    expect(order).toEqual(['a']);
    c.advance(1); // t=3
    expect(order).toEqual(['a', 'b', 'c']);
  });

  test('one large advance drains every due job', () => {
    const c = new GameClock();
    let fired = 0;
    for (let i = 1; i <= 5; i++) c.schedule(i * 0.1, () => fired++);
    c.advance(10);
    expect(fired).toBe(5);
  });

  test('cancel prevents firing', () => {
    const c = new GameClock();
    let fired = 0;
    const h = c.schedule(0.4, () => fired++);
    h.cancel();
    c.advance(1);
    expect(fired).toBe(0);
  });

  test('cancelling an already-fired job is a no-op', () => {
    const c = new GameClock();
    let fired = 0;
    const h = c.schedule(0.1, () => fired++);
    c.advance(0.2);
    expect(() => h.cancel()).not.toThrow();
    expect(fired).toBe(1);
  });

  test('cancel targets only its own job', () => {
    const c = new GameClock();
    let aFired = 0;
    let bFired = 0;
    const ha = c.schedule(0.1, () => aFired++);
    c.schedule(0.1, () => bFired++);
    ha.cancel();
    c.advance(0.2);
    expect(aFired).toBe(0);
    expect(bFired).toBe(1);
  });

  test('a job may schedule another job, including one already due', () => {
    const c = new GameClock();
    const order: string[] = [];
    c.schedule(0.1, () => {
      order.push('first');
      c.schedule(0, () => order.push('chained-now'));
      c.schedule(0.2, () => order.push('chained-later'));
    });
    c.advance(0.5);
    // dt lands BEFORE the drain (documented), so the chained 0 s job is due
    // immediately while the chained 0.2 s job waits past t = 0.5.
    expect(order).toEqual(['first', 'chained-now']);
    c.advance(0.2);
    expect(order).toEqual(['first', 'chained-now', 'chained-later']);
  });

  test('a due-now chain fires in the SAME advance even when a LATER-due job is pending', () => {
    // The adversarial queue state: after `mid` fires mid-drain, its zero-delay
    // child is appended BEHIND the still-pending later-due `far`. A single
    // up-front sort leaves that order, and a head check against `far` would
    // skip `chained` for the rest of the advance. (An empty-queue chaining
    // test cannot see this — there is nothing ahead of the child.)
    const c = new GameClock();
    const order: string[] = [];
    c.schedule(6, () => order.push('far')); // due 6; never due during this test
    c.advance(4);                           // t=4: far pending
    c.schedule(0.5, () => {
      order.push('mid');
      c.schedule(0, () => order.push('chained')); // due NOW at t=5
    });
    c.advance(1);                           // t=5
    expect(order).toEqual(['mid', 'chained']);
    expect(c.now()).toBe(5);
    c.advance(1); // t=6: only now does far come due
    expect(order).toEqual(['mid', 'chained', 'far']);
  });

  test('a job may cancel a pending sibling within the same drain', () => {
    const c = new GameClock();
    let bFired = 0;
    // Referencing `hb` inside the closure is fine: the job body runs during
    // advance(), long after this schedule() call returns the handle.
    c.schedule(0.1, () => hb.cancel());
    const hb = c.schedule(0.2, () => bFired++);
    c.advance(1);
    expect(bFired).toBe(0);
  });

  test('a 6 s job fires after the delay accrues across real frame sizes', () => {
    // Lesson 6: replay the actual cadence instead of one hand-seeded step.
    const c = new GameClock();
    let fired = 0;
    c.schedule(6, () => fired++); // the bot respawn delay
    for (let i = 0; i < 600; i++) c.advance(1 / 60);
    expect(fired).toBe(1);
    expect(c.now()).toBeCloseTo(10, 6);
  });

  test('pause mid-delay postpones the job rather than skipping it', () => {
    const c = new GameClock();
    let fired = 0;
    c.schedule(3, () => fired++);
    c.advance(2); // 2 s of play...
    // ...pause: NO advances happen while wall time passes. Nothing can fire
    // here by construction; the meaningful assertion is on resume below.
    c.advance(1); // resume: only 1 further second of GAME time
    expect(fired).toBe(1);
    expect(c.now()).toBe(3);
  });
});
