import { describe, expect, test } from 'vitest';
import { crossedCue, weaponPose, shotgunPump, shotgunChambering, type WeaponAnimationInput } from './weaponAnimation';
import { SWAP_DELAY } from './weaponSwap';
import { freshWeaponAnimation, WEAPONS, type WeaponId } from '../core/state';

const idle: WeaponAnimationInput = {
  id: 'shotgun', now: 10, shotAt: -Infinity, fireInterval: 0.9, switchedAt: -Infinity, hasOutgoing: false,
  aiming: false, reloading: false, reloadStartedAt: -Infinity, reloadT: 0,
  roundInterval: 3.2 / 7, lastRound: false, emptyReload: false, closeAt: -Infinity, closeBlend: 0,
};

describe('weapon presentation timelines', () => {
  test('a fresh life has no stray shell, firing cycle, closing pose or draw', () => {
    const fresh = freshWeaponAnimation();
    for (const id of Object.keys(WEAPONS) as WeaponId[]) {
      const pose = weaponPose({ ...idle, ...fresh, id });
      expect(Object.values(pose).every(value => value === 0 || value === false)).toBe(true);
    }
  });

  test('pump completes before the next permitted shot', () => {
    const at = (phase: number) => weaponPose({ ...idle, shotAt: 10, now: 10 + phase * 0.9 });
    expect(at(0).pump).toBe(0);
    expect(at(0.4).pump).toBeCloseTo(1);
    expect(at(0.8).pump).toBe(0);
    expect(at(1).pump).toBe(0);
  });

  test('AK action reciprocates and closes before the next 600-RPM shot', () => {
    const at = (age: number) => weaponPose({ ...idle, id: 'ak47', shotAt: 10,
      fireInterval: WEAPONS.ak47.fireRate, now: 10 + age });
    expect(at(.03).slide).toBeCloseTo(1);
    expect(at(.095).slide).toBe(0);
    expect(at(.1).slide).toBe(0);
  });

  test('bolt unlocks before retracting and closes before the firing interval ends', () => {
    const at = (phase: number) => weaponPose({ ...idle, id: 'sniper', shotAt: 10,
      fireInterval: 1.1, now: 10 + phase * 1.1 });
    expect(at(0.26).boltLift).toBeCloseTo(1);
    expect(at(0.26).boltPull).toBe(0);
    expect(at(0.5).boltPull).toBeCloseTo(1);
    expect(at(0.76).boltPull).toBe(0);
    expect(at(0.95).boltLift).toBe(0);
  });

  test('revolver cylinder stays open across transfer boundaries, closing only on the last round', () => {
    const loading = { ...idle, id: 'revolver' as const, reloading: true, reloadStartedAt: 8 };
    expect(weaponPose({ ...loading, reloadT: 0.99 }).cylinder).toBe(1);
    expect(weaponPose({ ...loading, reloadT: 0 }).cylinder).toBe(1);
    expect(weaponPose({ ...loading, reloadT: 1, lastRound: true }).cylinder).toBe(0);
    expect(weaponPose({ ...loading, reloadT: 0.5 }).shell).toBe(true);
    expect(weaponPose({ ...loading, reloadT: 0.85 }).shell).toBe(false);
  });

  test('empty magazines charge after seating; partial reloads do not', () => {
    for (const id of ['ak47', 'smg', 'pistol', 'sniper'] as const) {
      const input = { ...idle, id, reloading: true, reloadStartedAt: 7, reloadT: 0.86 };
      expect(weaponPose({ ...input, emptyReload: true }).charge).toBeGreaterThan(0);
      expect(weaponPose({ ...input, emptyReload: true }).magazine).toBe(0);
      expect(weaponPose(input).charge).toBe(0);
    }
  });

  test('interrupting fire restores the firing pose immediately', () => {
    const pose = weaponPose({ ...idle, id: 'revolver', shotAt: 10, closeAt: -Infinity });
    expect(pose.cylinder).toBe(0);
    expect(pose.shell).toBe(false);
  });

  test('aiming and firing override the cosmetic draw', () => {
    const drawing = { ...idle, switchedAt: 10 };
    expect(weaponPose(drawing).draw).toBe(1);
    expect(weaponPose({ ...drawing, aiming: true }).draw).toBe(0);
    expect(weaponPose({ ...drawing, shotAt: 10 }).draw).toBe(0);
  });

  test('cosmetic holster yields to an immediate shot or aim; the fire gate lives outside the pose', () => {
    // weaponPose stays purely cosmetic: firing/aiming flags still suppress the
    // draw art. The actual readiness gate is gameplay-side (issue #15 —
    // shoot/tryReload/the scope gate read SWAP_DELAY via isDeploying), so a
    // shot timestamp dated after the swap still clears the pose here.
    const input = { ...idle, hasOutgoing: true, switchedAt: 9.96 };
    expect(weaponPose(input).holster).toBe(true);
    expect(weaponPose({ ...input, shotAt: 10 }).holster).toBe(false);
    expect(weaponPose({ ...input, aiming: true }).holster).toBe(false);
    // The draw now runs to SWAP_DELAY (0.4 s), not the old 0.24 s cosmetics.
    expect(weaponPose({ ...input, now: 10.3 }).draw).toBeGreaterThan(0);
    expect(weaponPose({ ...input, now: 10.5 }).draw).toBe(0);
  });

  test('the draw run matches the shared deploy window', () => {
    // Art and gate share one constant (issue #15): the viewmodel must still
    // be rising for as long as the weapon refuses to fire.
    const drawing = { ...idle, hasOutgoing: true, switchedAt: 10 };
    expect(weaponPose({ ...drawing, now: 10 }).draw).toBe(1);
    expect(weaponPose({ ...drawing, now: 10 + SWAP_DELAY - 0.01 }).draw).toBeGreaterThan(0);
    expect(weaponPose({ ...drawing, now: 10 + SWAP_DELAY }).draw).toBe(0);
    expect(weaponPose({ ...drawing, now: 10 + SWAP_DELAY + 0.1 }).draw).toBe(0);
  });

  test('cancellation closes from the current opening amount instead of snapping fully open', () => {
    const input = { ...idle, id: 'revolver' as const, closeAt: 10, closeBlend: 0.3 };
    expect(weaponPose(input).cylinder).toBeCloseTo(0.3);
    expect(weaponPose({ ...input, now: 10.2 }).cylinder).toBe(0);
  });

  test('skipped frames settle the pose without repeating mechanism cues', () => {
    const input = { ...idle, shotAt: 9.65 };
    expect(crossedCue(0.1, 0.5, 0.3)).toBe(true);
    expect(crossedCue(0.5, 0.5, 0.3)).toBe(false);
    expect(crossedCue(0.5, 0.6, 0.3)).toBe(false);
    expect(weaponPose({ ...input, now: 12 }).pump).toBe(0);
  });
});


test('revolver advances the cylinder only after the cartridge hand withdraws', () => {
  const loading = {...idle, id: 'revolver' as const, reloading: true, reloadStartedAt: 8};
  expect(weaponPose({...loading, reloadT: .8}).index).toBe(0);
  expect(weaponPose({...loading, reloadT: .91}).index).toBeGreaterThan(0);
  expect(weaponPose({...loading, reloadT: .99}).index).toBe(1);
});


describe('shotgun ADS chambering', () => {
  const at = (cycle: number, ads = 1, extra: Partial<WeaponAnimationInput> = {}) =>
    shotgunChambering(shotgunPump({ ...idle, shotAt: 10, now: 10 + cycle * .9, ...extra }), ads);

  test('idle, the initial kick and completed cycles retain their unmodified pose', () => {
    const rest = { dip: -0, roll: 0, recoilScale: 1 };
    expect(shotgunChambering(shotgunPump(idle), 1)).toEqual(rest);
    for (const cycle of [-1, 0, .1, .78, 1, 20]) expect(at(cycle)).toEqual(rest);
  });

  test('the rearward stroke dips 3 cm, rolls 6 degrees and leaves a quarter of cosmetic recoil', () => {
    const peak = at(.4);
    expect(peak.dip).toBeCloseTo(-.03);
    expect(peak.roll).toBeCloseTo(Math.PI / 30);
    expect(peak.recoilScale).toBeCloseTo(.25);
    expect(Math.abs(at(.65).dip)).toBeLessThan(Math.abs(peak.dip));
  });

  test('ADS transitions blend continuously and hip fire remains unchanged', () => {
    expect(at(.4, 0)).toEqual({ dip: -0, roll: 0, recoilScale: 1 });
    expect(at(.4, .5).dip).toBeCloseTo(at(.4).dip / 2);
    expect(at(.4, .5).roll).toBeCloseTo(at(.4).roll / 2);
    expect(at(.4, .5).recoilScale).toBeCloseTo(.625);
  });

  test('reloads, fresh animation state and other weapons cannot chamber', () => {
    for (const extra of [{ reloading: true }, { shotAt: -Infinity },
      ...(['ak47', 'smg', 'sniper', 'pistol', 'revolver', 'knife'] as const).map(id => ({ id }))]) {
      expect(at(.4, 1, extra)).toEqual({ dip: -0, roll: 0, recoilScale: 1 });
    }
  });
});
