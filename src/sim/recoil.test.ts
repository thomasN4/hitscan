import { describe, expect, test } from 'vitest';
import { aimPitch, aimYaw, convertOnSwap, decayRecoil, decaySpray, decayToward } from './recoil';
import { WEAPONS, RECOIL_CAP, RECOIL_YAW_CAP } from '../core/state';
import type { WeaponDef } from '../core/state';

describe('aimPitch', () => {
  test('at rest is exactly the look pitch', () => {
    expect(aimPitch(0.3, 0, 0.012)).toBe(0.3);
  });

  test('climbs by punchRad per recoil unit', () => {
    expect(aimPitch(0, 3, 0.012)).toBeCloseTo(0.036, 12);
  });

  test('a full smg spray climbs to roughly 4 degrees', () => {
    const deg = aimPitch(0, RECOIL_CAP, WEAPONS.smg.punchRad) * 180 / Math.PI;
    expect(deg).toBeGreaterThan(3.5);
    expect(deg).toBeLessThan(4.5);
  });

  test('one sniper shot kicks roughly 4.6 degrees', () => {
    const sniper = WEAPONS.sniper;
    const deg = aimPitch(0, sniper.recoilKick, sniper.punchRad) * 180 / Math.PI;
    expect(deg).toBeGreaterThan(4.0);
    expect(deg).toBeLessThan(5.2);
  });
});

describe('aimYaw', () => {
  test('at rest is exactly the look yaw', () => {
    expect(aimYaw(1.2, 0, 0.012)).toBe(1.2);
  });

  test('mirrors aimPitch — same punchRad, same units', () => {
    expect(aimYaw(0, 2.5, 0.012)).toBeCloseTo(aimPitch(0, 2.5, 0.012), 12);
  });

  test('is signed, unlike the vertical climb', () => {
    // recoilYaw wanders both ways; recoil only ever accumulates upward.
    expect(aimYaw(0, -2, 0.012)).toBeCloseTo(-0.024, 12);
  });

  test('a maxed-out smg walk stays around 2 degrees of wander', () => {
    const deg = aimYaw(0, RECOIL_YAW_CAP, WEAPONS.smg.punchRad) * 180 / Math.PI;
    expect(deg).toBeGreaterThan(1.5);
    expect(deg).toBeLessThan(2.5);
  });
});

describe('decayRecoil', () => {
  test('never goes negative', () => {
    expect(decayRecoil(0.1, 1, 100)).toBe(0);
  });

  test('drains at the given rate', () => {
    expect(decayRecoil(6, 0.5, 6)).toBeCloseTo(3, 12);
  });

  test('the smg clears a full climb in about a second', () => {
    const smg = WEAPONS.smg;
    let recoil = RECOIL_CAP;
    let elapsed = 0;
    const dt = 1 / 60;
    while (recoil > 0 && elapsed < 5) {
      recoil = decayRecoil(recoil, dt, smg.recoilRecover);
      elapsed += dt;
    }
    expect(elapsed).toBeGreaterThan(0.8);
    expect(elapsed).toBeLessThan(1.3);
  });
});

describe('decaySpray', () => {
  test('floors at 1, the RESTING multiplier — never 0', () => {
    // Draining below 1 would make sustained fire IMPROVE accuracy.
    expect(decaySpray(1.05, 1, 100)).toBe(1);
    expect(decaySpray(1, 1, 100)).toBe(1);
  });

  test('drains at the given rate', () => {
    expect(decaySpray(3, 1, 0.5)).toBeCloseTo(2.5, 12);
  });

  test('a full smg magazine blooms the cone to about 2.15x', () => {
    // Simulated against the REAL fire loop, not a hand-seeded end state: decay
    // runs concurrently with fire, so the net per shot is
    // sprayKick − sprayRecover × fireRate, well under sprayKick. An earlier
    // version of this test seeded 1 + 30 × sprayKick = 2.8 and measured pure
    // decay from there — a value the game could not produce, which is how a
    // spray that only reached 1.28 shipped green. (Figure updated for the
    // 800 RPM rate: net ≈ +0.0383/shot × 30 rounds.)
    const smg = WEAPONS.smg;
    expect(magazineSprayPeak(smg)).toBeCloseTo(2.15, 1);
  });

  test('that bloom settles back in about four seconds', () => {
    const smg = WEAPONS.smg;
    let spray = magazineSprayPeak(smg);
    let elapsed = 0;
    const dt = 1 / 60;
    while (spray > 1 && elapsed < 10) {
      spray = decaySpray(spray, dt, smg.sprayRecover);
      elapsed += dt;
    }
    expect(elapsed).toBeGreaterThan(3.6);
    expect(elapsed).toBeLessThan(4.4);
  });

  test('a sustained smg spray outruns its own recovery', () => {
    // The invariant two commits fixed by hand: recover must stay under the
    // per-second input, or the spray never accumulates at all. Necessary but
    // NOT sufficient — 0.45 satisfied it and still barely bloomed, which is
    // what the magazine simulation above exists to catch.
    const smg = WEAPONS.smg;
    expect(smg.sprayRecover).toBeLessThan(smg.sprayKick / smg.fireRate);
  });
});

/** Peak spray after emptying a magazine, kicking and decaying as weapons.ts does. */
function magazineSprayPeak(def: WeaponDef) {
  const dt = 1 / 60;
  let spray = 1, t = 0, nextShot = 0, fired = 0;
  while (fired < def.magSize) {
    if (t >= nextShot) {
      spray = Math.min(spray + def.sprayKick, def.sprayCap);
      nextShot += def.fireRate;
      fired++;
    }
    spray = decaySpray(spray, dt, def.sprayRecover);
    t += dt;
  }
  return spray;
}

describe('decayToward', () => {
  test('pulls a positive value down to exactly 0', () => {
    expect(decayToward(0.5, 1, 100)).toBe(0);
  });

  test('pulls a negative value up to exactly 0 — no sign flip', () => {
    // A naive `value - rate*dt` would overshoot into the opposite sign and
    // oscillate; the walk has to settle, not ring.
    expect(decayToward(-0.5, 1, 100)).toBe(0);
  });

  test('drains at the given rate from both sides', () => {
    expect(decayToward(3, 0.5, 2)).toBeCloseTo(2, 12);
    expect(decayToward(-3, 0.5, 2)).toBeCloseTo(-2, 12);
  });

  test('a maxed sniper walk settles in well under a second', () => {
    const sniper = WEAPONS.sniper;
    let yaw = RECOIL_YAW_CAP;
    let elapsed = 0;
    const dt = 1 / 60;
    while (yaw !== 0 && elapsed < 3) {
      yaw = decayToward(yaw, dt, sniper.yawRecover);
      elapsed += dt;
    }
    expect(elapsed).toBeLessThan(0.5);
  });
});

/** Deterministic uniform in [-1, 1) — the walk's Math.random lives in weapons.ts. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 * 2 - 1; };
}

/**
 * Replay weapons.ts's fire loop for one full magazine and return |recoilYaw|
 * AS SAMPLED AT EACH SHOT — the offset each bullet actually leaves with.
 *
 * Sampling at fire time is the whole point: the kick is applied after the
 * shot's ray is built, so a rate that drains the walk back to 0 between shots
 * still shows a lively recoilYaw mid-interval while displacing nothing.
 */
function magazineYawAtShots(def: WeaponDef, seed: number): number[] {
  const rand = lcg(seed);
  const dt = 1 / 60;
  let yaw = 0, t = 0, nextShot = 0, fired = 0;
  const atShots = [];
  while (fired < def.magSize) {
    if (t >= nextShot) {
      atShots.push(Math.abs(yaw));
      yaw = Math.max(-RECOIL_YAW_CAP,
        Math.min(RECOIL_YAW_CAP, yaw + rand() * def.yawKick));
      nextShot += def.fireRate;
      fired++;
    }
    yaw = decayToward(yaw, dt, def.yawRecover);
    t += dt;
  }
  return atShots;
}

describe('yawRecover — the horizontal walk actually walks', () => {
  const smg = WEAPONS.smg;
  const deg = (units: number) => units * smg.punchRad * 180 / Math.PI;

  test('the drain per shot stays under the MEAN kick, not the max', () => {
    // The walk is zero-mean, so this is NOT decayRecoil's constraint: sizing
    // yawRecover against recoilKick/fireRate (or against recoilRecover, which
    // is how this shipped) drains 0.63 per shot against a 0.4 max kick and
    // returns recoilYaw to exactly 0 before every shot.
    expect(smg.yawRecover * smg.fireRate).toBeLessThan(smg.yawKick / 2);
  });

  test('most shots in a magazine leave off-centre', () => {
    let offCentre = 0, total = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const shots = magazineYawAtShots(smg, seed * 7919);
      offCentre += shots.filter(v => v !== 0).length;
      total += shots.length;
    }
    // ~88% at the shipped tuning; 0% if the walk drains at recoilRecover.
    // (The first round is always dead-on by design, so this cannot reach 100.)
    expect(offCentre / total).toBeGreaterThan(0.75);
  });

  test('the worst offset in a magazine lands in the documented band', () => {
    const worsts = [];
    for (let seed = 1; seed <= 200; seed++) {
      worsts.push(deg(Math.max(...magazineYawAtShots(smg, seed * 7919))));
    }
    worsts.sort((a, b) => a - b);
    const median = worsts[Math.floor(worsts.length / 2)]!;
    // state.ts documents ~0.6° worst-in-mag, ~1° in the tail.
    expect(median).toBeGreaterThan(0.3);
    expect(median).toBeLessThan(1.0);
  });

  test('the sniper deliberately settles between shots — every shot dead-on', () => {
    // The semiAuto exemption AGENTS.md records for recoilRecover applies here
    // too: a 1.1 s bolt cycle against a 13/s drain means the jolt is visual
    // only. Pinned as intent so it reads as a choice, not the bug above.
    const sniper = WEAPONS.sniper;
    expect(sniper.yawRecover * sniper.fireRate).toBeGreaterThan(sniper.yawKick);
    expect(magazineYawAtShots(sniper, 12345).every(v => v === 0)).toBe(true);
  });
});

/** The angle the player actually sees: recoil units become degrees via punchRad. */
function punchDeg(recoil: number, def: WeaponDef): number {
  return recoil * def.punchRad * 180 / Math.PI;
}

const CAPS = { recoil: RECOIL_CAP, recoilYaw: RECOIL_YAW_CAP };

describe('convertOnSwap — the view punch survives a weapon swap', () => {
  const smg = WEAPONS.smg;
  const sniper = WEAPONS.sniper;
  const rest = { recoil: 0, recoilYaw: 0, spray: 1 };

  test('the rendered angle is unchanged, which is the whole contract', () => {
    // recoil units are meaningless on their own — only recoil × punchRad is
    // visible. Seeded below the cap so nothing clips and the equality is exact.
    const before = { ...rest, recoil: 3 };
    const after = convertOnSwap(before, smg, sniper, CAPS);
    expect(punchDeg(after.recoil, sniper)).toBeCloseTo(punchDeg(before.recoil, smg), 12);
  });

  test('and the two ratio directions are observably different, so the choice matters', () => {
    // Non-vacuity per review lesson 7, kept in-suite as documentation: this
    // asserts nothing about convertOnSwap, only that `f5fcb6a`'s inverted
    // incoming ÷ outgoing lands somewhere else entirely (4.13° -> 6.88°). It
    // is what makes the assertion above capable of failing; the tests that
    // actually pin the implementation's direction are the two below.
    const before = { ...rest, recoil: 3 };
    const inverted = before.recoil * (sniper.punchRad / smg.punchRad);
    expect(punchDeg(inverted, sniper)).not.toBeCloseTo(punchDeg(before.recoil, smg), 2);
  });

  test('the conversion itself is lossless — an instant 1-2-1 round-trips exactly', () => {
    // Scoped deliberately: this pins the CONVERSION, with no time passing. It
    // says nothing about what a real 1-2-1 returns — see the decay cases below,
    // which is the distinction this test originally blurred by calling itself
    // "no free cancel". Under the inverted ratio it returned 3.6 from 6.
    const start = { ...rest, recoil: RECOIL_CAP };
    const onSniper = convertOnSwap(start, smg, sniper, CAPS);
    const back = convertOnSwap(onSniper, sniper, smg, CAPS);
    expect(back.recoil).toBeCloseTo(start.recoil, 12);
  });

  test('smg -> sniper scales recoil DOWN, so a full climb never reaches the cap', () => {
    // The sharpest discriminator: the sniper's bigger punchRad means fewer
    // units render the same angle. The inverted ratio scales UP instead and
    // clips at RECOIL_CAP, which is what made the round trip lossy.
    const after = convertOnSwap({ ...rest, recoil: RECOIL_CAP }, smg, sniper, CAPS);
    expect(after.recoil).toBeLessThan(RECOIL_CAP);
    expect(after.recoil).toBeCloseTo(RECOIL_CAP * (smg.punchRad / sniper.punchRad), 12);
  });

  test('sniper -> smg can hit the cap, and clipping there is by design', () => {
    // The reverse direction genuinely loses state: 6 units of sniper climb
    // want 10 smg units to render the same angle. Pinned as intent, not a leak.
    const after = convertOnSwap({ ...rest, recoil: RECOIL_CAP }, sniper, smg, CAPS);
    expect(after.recoil).toBe(RECOIL_CAP);
  });

  test('recoilYaw rides the same ratio and keeps its sign', () => {
    // recoilYaw is signed and shares punchRad with the vertical climb, so it
    // took the inverted ratio too — the second wrong line in `f5fcb6a`.
    const after = convertOnSwap({ ...rest, recoilYaw: -1.5 }, smg, sniper, CAPS);
    expect(after.recoilYaw).toBeCloseTo(-1.5 * (smg.punchRad / sniper.punchRad), 12);
  });

  test('recoilYaw clamps symmetrically at ±RECOIL_YAW_CAP', () => {
    const up = convertOnSwap({ ...rest, recoilYaw: RECOIL_YAW_CAP }, sniper, smg, CAPS);
    const down = convertOnSwap({ ...rest, recoilYaw: -RECOIL_YAW_CAP }, sniper, smg, CAPS);
    expect(up.recoilYaw).toBe(RECOIL_YAW_CAP);
    expect(down.recoilYaw).toBe(-RECOIL_YAW_CAP);
  });

  test('spray re-clamps to the incoming cap instead of rescaling', () => {
    // spray is a weapon-agnostic multiplier, so it must NOT take the ratio —
    // it is only bounded differently per weapon.
    const after = convertOnSwap({ ...rest, spray: 3.5 }, smg, sniper, CAPS);
    expect(after.spray).toBe(sniper.sprayCap);
  });

  test('spray below the incoming cap rides across untouched', () => {
    const after = convertOnSwap({ ...rest, spray: 2.2 }, smg, sniper, CAPS);
    expect(after.spray).toBe(2.2);
  });
});

/**
 * Replay a 1-2-1 the way it is actually played: convert onto the sniper, hold
 * it for `hold` seconds with decay running at the SNIPER's recoilRecover (which
 * is what switchWeapon copies into `weapon`), then convert back.
 *
 * The decay is the half the zero-duration cases above cannot see — review
 * lesson 6 from the other side. Lesson 6 is about hand-seeding an accumulation;
 * this is about hand-seeding a duration.
 */
function roundTripRecoil(hold: number, startRecoil = RECOIL_CAP): number {
  let s = convertOnSwap({ recoil: startRecoil, recoilYaw: 0, spray: 1 }, smgDef, sniperDef, CAPS);
  const dt = 1 / 60;
  for (let t = 0; t < hold; t += dt) {
    s = { ...s, recoil: decayRecoil(s.recoil, dt, sniperDef.recoilRecover) };
  }
  return convertOnSwap(s, sniperDef, smgDef, CAPS).recoil;
}

const smgDef = WEAPONS.smg;
const sniperDef = WEAPONS.sniper;

describe('convertOnSwap — what a swap actually returns once decay runs', () => {
  test('the incoming weapon owns the drain, so its rate is what erases the climb', () => {
    // NOT the conversion — that is lossless (see above). switchWeapon copies
    // the incoming def's recoilRecover into `weapon`, and updateWeapon decays
    // wpn.recoil at it. Derived from the constants rather than the literal
    // 0.277 s, so a retune moves this test with the tuning instead of failing.
    const carried = RECOIL_CAP * (smgDef.punchRad / sniperDef.punchRad);
    const expected = carried / sniperDef.recoilRecover;

    let recoil = carried;
    let elapsed = 0;
    const dt = 1 / 60;
    while (recoil > 0 && elapsed < 5) {
      recoil = decayRecoil(recoil, dt, sniperDef.recoilRecover);
      elapsed += dt;
    }
    expect(elapsed).toBeCloseTo(expected, 1);
  });

  test('that drain outruns any human swap, so 1-2-1 IS a free recoil cancel', () => {
    // KNOWN GAP, pinned as behavior rather than fixed: see issue #15. The fix
    // is for switching to cost time, which is a gameplay change and does not
    // belong in the TypeScript migration. Pre-existing on main — the inverted
    // ratio shipped in PR #14 actually MASKED it slightly, inflating the
    // carried units to the cap so they took 0.46 s to drain instead of 0.28 s.
    //
    // This test is the tripwire: when a draw/holster delay lands, it fails and
    // whoever adds it has to decide about this deliberately.
    expect(roundTripRecoil(0.5)).toBe(0);
    expect(roundTripRecoil(0.3)).toBe(0);
  });

  test('only an inhumanly fast tap keeps any of it', () => {
    // The boundary, so the numbers in issue #15 stay honest: a 100 ms swap
    // retains a bit over half the climb, 200 ms about a fifth.
    const full = RECOIL_CAP;
    expect(roundTripRecoil(0.1) / full).toBeGreaterThan(0.5);
    expect(roundTripRecoil(0.2) / full).toBeLessThan(0.25);
    expect(roundTripRecoil(0.2)).toBeGreaterThan(0);
  });
});
