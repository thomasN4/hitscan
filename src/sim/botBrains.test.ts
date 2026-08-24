// botBrains.test.ts — pins the default bot policy extracted from bots.ts.
//
// The expected values below are restated independently (longhand vector
// arithmetic), NOT by mirroring decide()'s code paths — a transcription
// slip in the seam must fail here. Time-dependent behavior (first-shot
// stagger, post-shot cadence, blocked-sight retries) is tested by REPLAYING
// frames against a queued RNG, not by seeding internal state directly
// (review lessons 6/19/20).
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  DEFAULT_BRAIN_PARAMS,
  DefaultBrain,
  botDamageRoll,
  botHitChance,
  nearestOpposing,
  type BrainParams,
  type BrainView,
  type OpposingCandidate,
} from './botBrains';

const DT = 1 / 60;

/**
 * Deterministic rng consuming a scripted sequence, then falling back to a
 * permanently passive draw (0.9 never jukes). Script only the draws whose
 * VALUE matters (constructor seeds, post-shot rerolls); the every-frame juke
 * draw rides the fallback unless a test pins it explicitly.
 */
function queueRng(values: number[]): () => number {
  let i = 0;
  return () => {
    const v = i < values.length ? values[i]! : 0.9;
    i++;
    return v;
  };
}

/** Never-juking, never-firing rng: every draw lands on the passive side. */
const calmRng = () => 0.9;

/** Movement-only params: engageRange 0 keeps the trigger branch (and its reroll draw) out of the way. */
function moveParams(): BrainParams {
  return { ...DEFAULT_BRAIN_PARAMS, engageRange: 0 };
}

/** Canonical view: target due +x, mid-band, alive, visible, 4 m/s. */
function view(overrides: Partial<BrainView> = {}): BrainView {
  return {
    toTarget: new THREE.Vector3(1, 0, 0),
    dist: 10,
    targetAlive: true,
    seeTarget: () => true,
    selfSpeed: 4,
    moveBlocked: false,
    ...overrides,
  };
}

/** Fresh brain strafing +x-perpendicular: constructor draws [dir, cooldown] = [0.9, 0.9]. */
function calmBrain(params: BrainParams = moveParams()): DefaultBrain {
  return new DefaultBrain(params, calmRng);
}

describe('DefaultBrain movement blend', () => {
  it('approaches beyond farBand: radial + perpendicular drift, normalized to speed·dt', () => {
    const brain = calmBrain();
    const { step } = brain.decide(view({ dist: 20 }), DT);
    // raw blend = (1,0,0) + 0.7·(0,0,1); expected scaled longhand:
    const len = Math.sqrt(1 + 0.7 * 0.7);
    expect(step.length()).toBeCloseTo(4 * DT, 12);
    expect(step.x).toBeCloseTo((1 / len) * 4 * DT, 12);
    expect(step.y).toBeCloseTo(0, 12);
    expect(step.z).toBeCloseTo((0.7 / len) * 4 * DT, 12);
  });

  it('backs off inside nearBand: negated radial plus the same drift', () => {
    const brain = calmBrain();
    const { step } = brain.decide(view({ dist: 5 }), DT);
    const len = Math.sqrt(1 + 0.7 * 0.7);
    expect(step.x).toBeCloseTo((-1 / len) * 4 * DT, 12);
    expect(step.z).toBeCloseTo((0.7 / len) * 4 * DT, 12);
  });

  it('holds the band as pure perpendicular drift', () => {
    const brain = calmBrain();
    const { step } = brain.decide(view({ dist: 10 }), DT);
    expect(step.x).toBeCloseTo(0, 12);
    expect(step.z).toBeCloseTo(4 * DT, 12); // strafeDir +1
  });

  it('band boundaries are exclusive: hold AT farBand/nearBand, blend beyond/inward', () => {
    const brain = calmBrain();
    // AT the bands: pure strafe → zero radial (x) component.
    expect(brain.decide(view({ dist: 14 }), DT).step.x).toBeCloseTo(0, 12);
    expect(brain.decide(view({ dist: 7 }), DT).step.x).toBeCloseTo(0, 12);
    // Just outside/inside: radial component appears.
    expect(brain.decide(view({ dist: 14.000001 }), DT).step.x).toBeGreaterThan(0);
    expect(brain.decide(view({ dist: 6.999999 }), DT).step.x).toBeLessThan(0);
  });

  it('respects overridden bands', () => {
    const brain = calmBrain({ ...moveParams(), nearBand: 2, farBand: 5 });
    // dist 8 is beyond THIS brain's farBand despite being mid-default-band.
    expect(brain.decide(view({ dist: 8 }), DT).step.x).toBeGreaterThan(0);
  });

  it('initial strafe direction follows the constructor draw', () => {
    const plus = new DefaultBrain(moveParams(), queueRng([0.9, 0.9]));
    expect(plus.decide(view(), DT).step.z).toBeCloseTo(4 * DT, 12);
    const minus = new DefaultBrain(moveParams(), queueRng([0.1, 0.9]));
    expect(minus.decide(view(), DT).step.z).toBeCloseTo(-4 * DT, 12);
  });
});

describe('DefaultBrain strafe steering', () => {
  it('reverses drift when last frame was collision-blocked', () => {
    const brain = calmBrain();
    expect(brain.decide(view(), DT).step.z).toBeCloseTo(4 * DT, 12);
    expect(brain.decide(view({ moveBlocked: true }), DT).step.z).toBeCloseTo(-4 * DT, 12);
    // The flip persists while unblocked.
    expect(brain.decide(view(), DT).step.z).toBeCloseTo(-4 * DT, 12);
  });

  it('jukes at jukeRate·dt probability, affecting movement from the NEXT frame', () => {
    // Draws: [dir+, cooldown]; F1 juke 0.4 < 0.5·1 → flip AFTER F1's step.
    const brain = new DefaultBrain(
      moveParams(),
      queueRng([0.9, 0.9, /* F1 */ 0.4, /* F2 */ 0.9]),
    );
    const dt = 1; // juke threshold becomes 0.5
    expect(brain.decide(view(), dt).step.z).toBeCloseTo(4 * dt, 12);
    expect(brain.decide(view(), dt).step.z).toBeCloseTo(-4 * dt, 12);
  });

  it('does not juke when the draw clears the threshold', () => {
    const brain = new DefaultBrain(moveParams(), queueRng([0.9, 0.9, 0.5, 0.9]));
    const dt = 1;
    expect(brain.decide(view(), dt).step.z).toBeCloseTo(4 * dt, 12);
    expect(brain.decide(view(), dt).step.z).toBeCloseTo(4 * dt, 12);
  });
});

describe('DefaultBrain trigger', () => {
  /** dt 0.25 makes the hand-computed frame arithmetic exact quarters. */
  const CADENCE_DT = 0.25;

  it('fires the first shot exactly when the staggered delay expires', () => {
    // Full script pins the draw contract: one juke per frame, one reroll on
    // fire (the juke precedes the reroll within a frame). cd hits 0 at F4.
    const brain = new DefaultBrain(
      DEFAULT_BRAIN_PARAMS,
      queueRng([
        0.9, 0,                                  // dir+, stagger 1 s
        /* F1 */ 0.9, /* F2 */ 0.9, /* F3 */ 0.9,
        /* F4 */ 0.9, 0.5,                       // juke, reroll → cd 1.3
      ]),
    );
    const v = view({ dist: 10 });
    expect(brain.decide(v, CADENCE_DT).wantShoot).toBe(false); // cd 0.75
    expect(brain.decide(v, CADENCE_DT).wantShoot).toBe(false); // cd 0.50
    expect(brain.decide(v, CADENCE_DT).wantShoot).toBe(false); // cd 0.25
    expect(brain.decide(v, CADENCE_DT).wantShoot).toBe(true);  // cd 0 → fire
  });

  it('re-fires once the drawn post-shot cooldown expires', () => {
    // First shot F4 (cd 1.3); next due 6 frames later, F10.
    const brain = new DefaultBrain(
      DEFAULT_BRAIN_PARAMS,
      queueRng([
        0.9, 0,                                  // dir+, stagger
        /* F1 */ 0.9, /* F2 */ 0.9, /* F3 */ 0.9,
        /* F4 */ 0.9, 0.5,                       // juke, reroll → 1.3
        /* F5 */ 0.9, /* F6 */ 0.9, /* F7 */ 0.9,
        /* F8 */ 0.9, /* F9 */ 0.9,
        /* F10 */ 0.9, 0.5,                      // juke, reroll
      ]),
    );
    const v = view({ dist: 10 });
    const shots: number[] = [];
    for (let f = 1; f <= 10; f++) {
      if (brain.decide(v, CADENCE_DT).wantShoot) shots.push(f);
    }
    expect(shots).toEqual([4, 10]);
  });

  it('never shoots through blocked sight; re-probes on the short retry cooldown', () => {
    // cd hits 0 at F4, sight blocked → cd=0.3 → next probe F6, F8, ... F20.
    const brain = new DefaultBrain(DEFAULT_BRAIN_PARAMS, queueRng([0.9, 0]));
    let probes = 0;
    const v = view({ dist: 10, seeTarget: () => { probes++; return false; } });
    for (let f = 1; f <= 20; f++) {
      expect(brain.decide(v, CADENCE_DT).wantShoot, `frame ${f}`).toBe(false);
    }
    expect(probes).toBe(9); // F4, F6, F8, …, F20
  });

  it('spends no LOS raycast while the trigger is cold or out of range', () => {
    let probes = 0;
    const probing = (): BrainView => view({ dist: 10, seeTarget: () => { probes++; return true; } });

    // Expired cooldown but beyond engageRange: the range gate short-circuits
    // before the probe, so an unreachable target costs no raycasts at all.
    const ranged = new DefaultBrain(DEFAULT_BRAIN_PARAMS, queueRng([0.9, 0]));
    const far = view({ dist: 50, seeTarget: () => { probes++; return true; } });
    for (let f = 0; f < 8; f++) expect(ranged.decide(far, CADENCE_DT).wantShoot).toBe(false);
    expect(probes).toBe(0);

    // In range but inside the staggered first-shot delay: still cold.
    const fresh = new DefaultBrain(DEFAULT_BRAIN_PARAMS, queueRng([0.9, 0.99])); // cd ≈ 2.98 s
    for (let f = 0; f < 4; f++) expect(fresh.decide(probing(), CADENCE_DT).wantShoot).toBe(false);
    expect(probes).toBe(0);
  });

  it('does not shoot a dead target even with sight and range', () => {
    const brain = new DefaultBrain(DEFAULT_BRAIN_PARAMS, queueRng([0.9, 0]));
    let probes = 0;
    const v = view({ dist: 10, targetAlive: false, seeTarget: () => { probes++; return true; } });
    for (let f = 0; f < 4; f++) expect(brain.decide(v, CADENCE_DT).wantShoot).toBe(false);
    expect(probes).toBe(0);
  });
});

describe('ballistic rolls', () => {
  it('hit chance falls off linearly and clamps to its floor (default params)', () => {
    const p = DEFAULT_BRAIN_PARAMS;
    expect(botHitChance(0, p)).toBeCloseTo(p.hitChanceNear, 12);
    expect(botHitChance(40, p)).toBeCloseTo(0.15, 12); // 0.65 − 40/80
    expect(botHitChance(80, p)).toBeCloseTo(p.hitChanceMin, 12);
    expect(botHitChance(800, p)).toBeCloseTo(p.hitChanceMin, 12);
    let prev = Infinity;
    for (let d = 0; d <= 100; d += 5) {
      const c = botHitChance(d, p);
      expect(c).toBeLessThanOrEqual(prev);
      prev = c;
    }
  });

  it('damage roll spans [damageMin, damageMin + damageSpan] (default params)', () => {
    const p = DEFAULT_BRAIN_PARAMS;
    expect(botDamageRoll(() => 0, p)).toBeCloseTo(p.damageMin, 12);
    expect(botDamageRoll(() => 0.5, p)).toBeCloseTo(15, 12);
    expect(botDamageRoll(() => 1, p)).toBeCloseTo(p.damageMin + p.damageSpan, 12);
  });

  it('brain delegates consume the same rng stream and read the same params', () => {
    const brain = new DefaultBrain(DEFAULT_BRAIN_PARAMS, queueRng([/* dir */ 0.9, /* cd */ 0.9, /* dmg */ 0.25]));
    expect(brain.hitChance(0)).toBe(DEFAULT_BRAIN_PARAMS.hitChanceNear);
    expect(brain.rollDamage()).toBeCloseTo(DEFAULT_BRAIN_PARAMS.damageMin + 0.25 * DEFAULT_BRAIN_PARAMS.damageSpan, 12);
  });
});

describe('nearestOpposing', () => {
  const at = (x: number, z: number, y = 0): THREE.Vector3 => new THREE.Vector3(x, y, z);
  const cand = (x: number, z: number, alive = true, y = 0): OpposingCandidate & { tag: string } => ({
    pos: at(x, z, y),
    alive,
    tag: `${x},${z}`,
  });
  const origin = at(0, 0);

  it('returns undefined with no candidates or none alive', () => {
    expect(nearestOpposing(origin, [])).toBeUndefined();
    expect(nearestOpposing(origin, [cand(1, 1, false), cand(50, 50, false)])).toBeUndefined();
  });

  it('picks the planar-nearest alive candidate; height cannot outrank ground distance', () => {
    // The (2,0) entry is nearer in the GROUND plane even though the high one
    // would win a 3D comparison.
    const near = cand(2, 0);
    const farButLowY = cand(5, 0, true, 100);
    expect(nearestOpposing(origin, [farButLowY, near])).toBe(near);
  });

  it('skips corpses between the bot and its prey', () => {
    const corpseBetween = cand(1, 0, false);
    const prey = cand(4, 0);
    expect(nearestOpposing(origin, [corpseBetween, prey])).toBe(prey);
  });
});
