import { describe, expect, test } from 'vitest';
import { crossedCue, weaponPose, type WeaponAnimationInput } from './weaponAnimation';
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
    for (const id of ['smg', 'pistol', 'sniper'] as const) {
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
    expect(pose.reach).toBe(0);
  });

  test('aiming and firing override the cosmetic draw', () => {
    const drawing = { ...idle, switchedAt: 10 };
    expect(weaponPose(drawing).draw).toBe(1);
    expect(weaponPose({ ...drawing, aiming: true }).draw).toBe(0);
    expect(weaponPose({ ...drawing, shotAt: 10 }).draw).toBe(0);
  });

  test('cosmetic holster yields to an immediate shot or aim, with no readiness gate', () => {
    const input = { ...idle, hasOutgoing: true, switchedAt: 9.96 };
    expect(weaponPose(input).holster).toBe(true);
    expect(weaponPose({ ...input, shotAt: 10 }).holster).toBe(false);
    expect(weaponPose({ ...input, aiming: true }).holster).toBe(false);
    expect(weaponPose({ ...input, now: 10.3 }).draw).toBe(0);
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
