import { describe, expect, test } from 'vitest';
import { isLowAmmo, roundInterval, roundTransfer, planReload } from './ammo';
import { WEAPONS, type WeaponId } from '../core/state';

/** Catalog weapons with real ammo semantics (the knife's mag holds nothing). */
function firearms(): typeof WEAPONS[WeaponId][] {
  return Object.values(WEAPONS).filter(w => w.magSize > 0);
}

describe('isLowAmmo', () => {
  test('a FULL mag is never low — the issue #10 regression', () => {
    for (const w of firearms()) {
      expect(isLowAmmo(w.magSize, w.magSize)).toBe(false);
    }
  });

  test('empty mag is always low', () => {
    for (const w of firearms()) {
      expect(isLowAmmo(0, w.magSize)).toBe(true);
    }
  });

  test('a zero-capacity weapon has no ammo semantics and is never low', () => {
    // The knife never reloads; classifying its perpetual 0/0 as "low" would
    // advertise a reload that cannot happen.
    expect(isLowAmmo(0, WEAPONS.knife.magSize)).toBe(false);
  });

  test('smg threshold stays at its historical 10', () => {
    expect(isLowAmmo(10, WEAPONS.smg.magSize)).toBe(true);
    expect(isLowAmmo(11, WEAPONS.smg.magSize)).toBe(false);
  });

  test('sniper prompts below a third of its 10-round mag (floor → <=3)', () => {
    expect(isLowAmmo(3, WEAPONS.sniper.magSize)).toBe(true);
    expect(isLowAmmo(4, WEAPONS.sniper.magSize)).toBe(false);
  });
});

describe('planReload', () => {
  // A live SMG mid-mag: the everything-fine baseline every refusal flips.
  const live = { started: true, alive: true, reloading: false, mag: 10, magSize: 30, reserve: 90, aiming: false };

  test('a partial mag with reserve starts reloading', () => {
    expect(planReload(live)).toEqual({ start: true, dropAim: false });
  });

  test.each([
    ['unstarted match', { started: false }],
    ['dead player', { alive: false }],
    ['reload already running', { reloading: true }],
    ['full mag', { mag: 30 }],
    ['dry reserve', { reserve: 0 }],
  ])('%s refuses — and never touches the aim', (_name, mut) => {
    const d = planReload({ ...live, aiming: true, ...mut });
    expect(d).toEqual({ start: false, dropAim: false });
  });

  test('starting a reload while the sights are up DROPS them', () => {
    expect(planReload({ ...live, aiming: true })).toEqual({ start: true, dropAim: true });
  });

  test('the drop rides the START decision, not the button', () => {
    // Same held RMB, but nothing to reload: aim stays exactly as it was.
    expect(planReload({ ...live, aiming: true, mag: live.magSize })).toEqual({ start: false, dropAim: false });
  });
});

describe('per-round reload', () => {
  test('interval spreads reloadTime evenly — empty-to-full total is unchanged', () => {
    // The playtest-round-2 contract: chunked, not slower.
    for (const id of ['shotgun', 'revolver'] as const) {
      const def = WEAPONS[id];
      expect(roundInterval(def.reloadTime, def.magSize) * def.magSize).toBeCloseTo(def.reloadTime, 12);
    }
    expect(roundInterval(3.2, 7)).toBeCloseTo(3.2 / 7, 12);
  });

  test('one round moves per transfer', () => {
    expect(roundTransfer(0, 7, 28)).toEqual({ mag: 1, reserve: 27, done: false });
    expect(roundTransfer(5, 6, 18)).toEqual({ mag: 6, reserve: 17, done: true }); // fills the last chamber
  });

  test('a FULL mag transfers nothing and reports done', () => {
    expect(roundTransfer(7, 7, 28)).toEqual({ mag: 7, reserve: 28, done: true });
  });

  test('a dry reserve never overdraws and reports done', () => {
    expect(roundTransfer(2, 7, 0)).toEqual({ mag: 2, reserve: 0, done: true });
    expect(roundTransfer(2, 7, -1)).toEqual({ mag: 2, reserve: -1, done: true }); // defensive: no crash, no transfer
  });

  test('loading a whole shotgun from empty takes exactly magSize transfers', () => {
    let state = { mag: 0, reserve: 28 };
    let steps = 0;
    let done = false;
    while (!done && steps < 100) {
      const t = roundTransfer(state.mag, 7, state.reserve);
      state = { mag: t.mag, reserve: t.reserve };
      done = t.done;
      steps++;
    }
    expect(done).toBe(true);
    expect(steps).toBe(7);
    expect(state).toEqual({ mag: 7, reserve: 21 });
  });
});
