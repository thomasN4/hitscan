import { describe, expect, test } from 'vitest';
import { viewmodelTransform, type ViewmodelInput } from './viewmodelTransform';
import { viewmodelRecoil } from './recoil';
import { WEAPONS, RECOIL_CAP, RECOIL_YAW_CAP } from '../core/state';

// The smg's real hip -> ADS delta: core/weaponModels.ts builds it as
// { x: -offset.x, y: offset.y - sightLine } with z=0.10, from offset (0.25, 0.14) and a zero
// sight line. now = 10 lands the bob mid-swing; the last case below pins that,
// because a phase on a zero of Math.sin(now * 10) would make the ADS assertions
// pass against the ungated code too.
const still: ViewmodelInput = {
  aimOffset: { x: -0.25, y: 0.14, z: 0.10 },
  ads: 0, visualRecoil: 0, recoilYaw: 0, bobAmt: 0, now: 10,
};

// A player walking through a sustained smg burst: every term this stage owns is
// non-zero at once. bobAmt 0.02 is player.ts's standing-walk value.
const smg = WEAPONS.smg;
const moving = {
  bobAmt: 0.02,
  visualRecoil: viewmodelRecoil(RECOIL_CAP, smg.recoilKick),
  recoilYaw: 1.5,
};

/** Roughly where an iron sight sits down the view axis (weaponModels body.z). */
const SIGHT_M = 0.53;
const deg = (rad: number) => rad * 180 / Math.PI;

describe('viewmodelTransform', () => {
  const at = (ads: number, over: Partial<ViewmodelInput> = {}) =>
    viewmodelTransform({ ...still, ...moving, ads, ...over });

  test('at full ADS nothing but the depth punch survives', () => {
    const t = at(1);
    // Exact equality, not toBeCloseTo: the ADS offset must land untouched.
    expect(t.position.x).toBe(still.aimOffset.x);
    expect(t.position.y).toBe(still.aimOffset.y);
    // Math.abs, because 1.5 * 0.01 * 0 is -0 and Object.is(-0, 0) is false. The
    // assertion is still exact: Math.abs(-0) is +0.
    expect(Math.abs(t.rotation.x)).toBe(0);
    expect(Math.abs(t.rotation.y)).toBe(0);
  });

  test('and holds still across a bob cycle and a whole spray', () => {
    // The invariant stated as invariance, which is what "the sights do not move"
    // actually means: sample the four inputs that vary within a frame sequence
    // and require the transform not to.
    const anchor = at(1);
    const samples: Partial<ViewmodelInput>[] = [
      { now: 10.1, visualRecoil: 0, recoilYaw: 0 },
      { now: 10.35, visualRecoil: viewmodelRecoil(smg.recoilKick, smg.recoilKick), recoilYaw: -RECOIL_YAW_CAP },
      { now: 10.62, visualRecoil: viewmodelRecoil(RECOIL_CAP, smg.recoilKick), recoilYaw: RECOIL_YAW_CAP },
      { now: 10.94, bobAmt: 0.03, recoilYaw: 0.4 }, // sprint-heavy bob
    ];
    for (const sample of samples) {
      const t = at(1, sample);
      const where = JSON.stringify(sample);
      expect(t.position.x, where).toBe(anchor.position.x);
      expect(t.position.y, where).toBe(anchor.position.y);
      expect(Math.abs(t.rotation.x), where).toBe(0);
      expect(Math.abs(t.rotation.y), where).toBe(0);
    }
  });

  test('the depth punch is kept, because it is NDC-neutral', () => {
    // z moves the weapon ALONG the view axis. With x and y at their ADS values
    // the sight sits on that axis, and an on-axis point stays on it: the weapon
    // grows and shrinks, the sight picture does not shift.
    expect(at(1).position.z).toBeCloseTo(moving.visualRecoil * 0.012 + still.aimOffset.z, 12);
    expect(at(1).position.z).toBeGreaterThan(at(1, { visualRecoil: 0 }).position.z);
  });

  test('hip fire keeps every term it had before the gate', () => {
    const t = at(0);
    expect(t.position.x).toBeCloseTo(0, 12);
    expect(t.position.y).toBeCloseTo(Math.sin(still.now * 10) * moving.bobAmt, 12);
    expect(t.position.z).toBeCloseTo(moving.visualRecoil * 0.012, 12);
    expect(t.rotation.x).toBeCloseTo(moving.visualRecoil * 0.015, 12);
    expect(t.rotation.y).toBeCloseTo(-moving.recoilYaw * 0.01, 12);
  });

  test('the gate is linear in adsLerp, so pulling in cannot snap', () => {
    // weapons.ts eases adsLerp over ~0.1 s; a threshold gate would pop the
    // weapon mid-blend. Half ADS is exactly half the hip-fire kick.
    expect(at(0.5).rotation.x).toBeCloseTo(at(0).rotation.x / 2, 12);
    expect(at(0.5).rotation.y).toBeCloseTo(at(0).rotation.y / 2, 12);
    expect(at(0.5).position.y - still.aimOffset.y * 0.5).toBeCloseTo(at(0).position.y / 2, 12);
  });

  test('the ungated expressions move the sights by more than a degree', () => {
    // Non-vacuity (review lesson 7), kept in-suite as documentation: this
    // asserts nothing about viewmodelTransform. It inlines the pre-gate
    // expressions from player.ts and shows they displace the sights by a
    // visible angle at the very sample the ADS cases above pin to zero.
    const ungatedY = Math.sin(still.now * 10) * moving.bobAmt;
    const ungatedPitch = moving.visualRecoil * 0.015;
    const ungatedYaw = -moving.recoilYaw * 0.01;
    expect(Math.abs(ungatedY)).toBeGreaterThan(0.005); // the phase is mid-swing
    // Each independently, not summed: at this phase they have opposite signs and
    // a signed sum would understate both.
    expect(deg(Math.abs(ungatedPitch))).toBeGreaterThan(1.5);
    expect(deg(Math.abs(ungatedY) / SIGHT_M)).toBeGreaterThan(1);
    expect(deg(Math.abs(ungatedYaw))).toBeGreaterThan(0.5);
    // For scale: the smg's ENTIRE full-spray aim climb is RECOIL_CAP * punchRad,
    // and the recoil kick alone is a quarter of it again on top.
    expect(deg(Math.abs(ungatedPitch))).toBeGreaterThan(0.2 * deg(RECOIL_CAP * smg.punchRad));
  });
});
