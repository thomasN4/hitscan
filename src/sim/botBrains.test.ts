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

/** Canonical view: target due +x, mid-band, LEVEL, alive, visible, 4 m/s. */
function view(overrides: Partial<BrainView> = {}): BrainView {
  const dist = overrides.dist ?? 10;
  return {
    toTarget: new THREE.Vector3(1, 0, 0),
    dist,
    // Level ground unless a test says otherwise: with rise 0 the eye-to-eye
    // range IS the planar range, so every band test that drives `dist` keeps
    // meaning exactly what it meant before the brain learned about height.
    dist3: dist,
    rise: 0,
    onGround: true,
    // No route by default: every pre-routing test describes a bot fighting
    // where it stands, and the brain only asks when it wants to travel.
    nextWaypoint: () => null,
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

  it('bands read the 3D range, not the planar one', () => {
    // Planar-close but 3D-far (a target up a tower): the radial term must
    // come from dist3, so this APPROACHES where the old planar brain would
    // have backed off.
    const brain = calmBrain();
    expect(brain.decide(view({ dist: 5, dist3: 20 }), DT).step.x).toBeGreaterThan(0);
  });

  it('approaches a target overhead instead of retreating from it', () => {
    // Standing under a 3.6 m deck: 0.5 m of ground between them, eye-to-eye
    // sqrt(0.5² + 3.6²) ≈ 3.634 — well inside nearBand. Backing off here is
    // the bug maps/elevation.ts was built to expose: it widens the gap to
    // the flight that reaches the deck.
    const overhead = view({ dist: 0.5, dist3: 3.634, rise: 3.6 });
    expect(calmBrain().decide(overhead, DT).step.x).toBeGreaterThan(0);
    // Same range on the LEVEL is still a back-off — the suppression is
    // rise-driven, not a blanket removal of the near band.
    const level = view({ dist: 3.634, dist3: 3.634, rise: 0 });
    expect(calmBrain().decide(level, DT).step.x).toBeLessThan(0);
  });

  it('climbThreshold is exclusive: a kerb still gets backed away from', () => {
    const p = moveParams(); // climbThreshold 1.5
    expect(calmBrain(p).decide(view({ dist: 3, dist3: 3, rise: 1.5 }), DT).step.x).toBeLessThan(0);
    expect(calmBrain(p).decide(view({ dist: 3, dist3: 3, rise: 1.500001 }), DT).step.x).toBeGreaterThan(0);
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

// Routing — following the executor's path instead of steering at the target.
//
// dt 0.1 makes the timers whole frames: stuckTime 0.25 is 3 frames (0.3 > 0.25),
// commitTime 0.5 is 5. The waypoint points due +z so a routing step reads on
// step.z alone, and any step.x at all would be drift that must not be there.
describe('DefaultBrain routing', () => {
  const STEP_DT = 0.1;
  const NORTH = (): THREE.Vector3 => new THREE.Vector3(0, 0, 4);
  /** Target a level up, with a route available. */
  const onRoute = (overrides: Partial<BrainView> = {}): BrainView =>
    view({ dist: 20, rise: 3.6, nextWaypoint: () => NORTH(), ...overrides });

  it('walks the waypoint, not the target, and adds no drift', () => {
    const { step, mode } = calmBrain().decide(onRoute(), STEP_DT);
    expect(mode).toBe('route');
    // Pure heading: the waypoint is due +z, so a drift-free step is too.
    expect(step.x).toBeCloseTo(0, 12);
    expect(step.z).toBeCloseTo(4 * STEP_DT, 12);
  });

  it('ignores a route while the target is on this level', () => {
    let asked = 0;
    const level = view({ dist: 20, rise: 0, nextWaypoint: () => { asked++; return NORTH(); } });
    const { step, mode } = calmBrain().decide(level, STEP_DT);
    expect(mode).toBe('engage');
    expect(step.x).toBeGreaterThan(0); // approaching the target, with drift
    // Lazy like seeTarget: no path is asked for when none is wanted.
    expect(asked).toBe(0);
  });

  it('falls back to engaging when the graph offers no route', () => {
    const { mode } = calmBrain().decide(onRoute({ nextWaypoint: () => null }), STEP_DT);
    expect(mode).toBe('engage');
  });

  it('keeps routing below the entry threshold, down to climbExit', () => {
    const brain = calmBrain();
    expect(brain.decide(onRoute(), STEP_DT).mode).toBe('route');
    // Partway up a flight: under climbThreshold (1.5) but well over climbExit
    // (0.45). Exiting here is the stall this replaced — one step short.
    expect(brain.decide(onRoute({ rise: 1.2 }), STEP_DT).mode).toBe('route');
    expect(brain.decide(onRoute({ rise: 0.5 }), STEP_DT).mode).toBe('route');
    // Arrived: rise closed.
    expect(brain.decide(onRoute({ rise: 0.4 }), STEP_DT).mode).toBe('engage');
  });

  it('does not start routing at a rise it would only continue at', () => {
    // The other half of the hysteresis: 1.2 continues a route but never starts one.
    expect(calmBrain().decide(onRoute({ rise: 1.2 }), STEP_DT).mode).toBe('engage');
  });

  it('slides sideways once geometry keeps refusing the step', () => {
    const brain = calmBrain();
    const jammed = onRoute({ moveBlocked: true });
    for (let f = 1; f <= 2; f++) {
      // Still pushing at the waypoint: a brush is not a jam.
      expect(brain.decide(jammed, STEP_DT).step.z, `frame ${f}`).toBeCloseTo(4 * STEP_DT, 12);
    }
    const slide = brain.decide(jammed, STEP_DT); // blockedFor reaches 0.3
    expect(slide.mode).toBe('route');
    // Perpendicular to the heading: all x, no forward component at all.
    expect(Math.abs(slide.step.x)).toBeCloseTo(4 * STEP_DT, 12);
    expect(slide.step.z).toBeCloseTo(0, 12);
  });

  it('commits to one side rather than re-deciding every frame', () => {
    const brain = calmBrain();
    const jammed = onRoute({ moveBlocked: true });
    for (let f = 1; f <= 3; f++) brain.decide(jammed, STEP_DT);
    const sides = [];
    for (let f = 4; f <= 7; f++) sides.push(Math.sign(brain.decide(jammed, STEP_DT).step.x));
    expect(new Set(sides).size).toBe(1);
  });

  it('tries the other side on the next attempt', () => {
    const brain = calmBrain();
    const jammed = onRoute({ moveBlocked: true });
    let first = 0;
    for (let f = 1; f <= 3; f++) first = Math.sign(brain.decide(jammed, STEP_DT).step.x);
    let second = first;
    for (let f = 4; f <= 12; f++) {
      const x = Math.sign(brain.decide(jammed, STEP_DT).step.x);
      if (x !== 0) second = x;
    }
    expect(second).toBe(-first);
  });

  it('never slides in mid-air', () => {
    const brain = calmBrain();
    const falling = onRoute({ moveBlocked: true, onGround: false });
    for (let f = 1; f <= 20; f++) {
      expect(brain.decide(falling, STEP_DT).step.z, `frame ${f}`).toBeCloseTo(4 * STEP_DT, 12);
    }
  });

  it('a frame that moves resets the jam counter', () => {
    const brain = calmBrain();
    for (let f = 1; f <= 2; f++) brain.decide(onRoute({ moveBlocked: true }), STEP_DT);
    brain.decide(onRoute(), STEP_DT); // one clean frame
    for (let f = 1; f <= 2; f++) {
      expect(brain.decide(onRoute({ moveBlocked: true }), STEP_DT).step.z).toBeCloseTo(4 * STEP_DT, 12);
    }
  });

  it('onRespawn drops a committed slide', () => {
    const brain = calmBrain();
    const jammed = onRoute({ moveBlocked: true });
    for (let f = 1; f <= 3; f++) brain.decide(jammed, STEP_DT);
    expect(Math.abs(brain.decide(jammed, STEP_DT).step.x)).toBeGreaterThan(0);
    brain.onRespawn();
    // Fresh body: back to pushing at the waypoint, not still sliding.
    expect(brain.decide(jammed, STEP_DT).step.z).toBeCloseTo(4 * STEP_DT, 12);
  });

  it('onRespawn resets the hysteresis to the entry threshold', () => {
    const brain = calmBrain();
    brain.decide(onRoute(), STEP_DT); // routing, entered at 3.6
    expect(brain.decide(onRoute({ rise: 1.2 }), STEP_DT).mode).toBe('route');
    brain.onRespawn();
    // A rise that only CONTINUES a route must not start one on a fresh life.
    expect(brain.decide(onRoute({ rise: 1.2 }), STEP_DT).mode).toBe('engage');
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

    // The gate reads dist3, so a planar-close target high above is out of
    // range too — and agrees with the die rollHit rolls on.
    const below = new DefaultBrain(DEFAULT_BRAIN_PARAMS, queueRng([0.9, 0]));
    const overhead = view({ dist: 2, dist3: 50, rise: 50, seeTarget: () => { probes++; return true; } });
    for (let f = 0; f < 8; f++) expect(below.decide(overhead, CADENCE_DT).wantShoot).toBe(false);
    expect(probes).toBe(0);

    // In range but inside the staggered first-shot delay: still cold.
    const fresh = new DefaultBrain(DEFAULT_BRAIN_PARAMS, queueRng([0.9, 0.99])); // cd ≈ 2.98 s
    for (let f = 0; f < 4; f++) expect(fresh.decide(probing(), CADENCE_DT).wantShoot).toBe(false);
    expect(probes).toBe(0);
  });

  it('re-arms the staggered first shot on respawn', () => {
    // Brains outlive their bodies. Without onRespawn a revived bot keeps
    // counting down whatever cooldown its corpse carried — here 1.3 s from
    // the shot it just took — instead of starting a fresh stagger.
    const brain = new DefaultBrain(DEFAULT_BRAIN_PARAMS, queueRng([
      0.9, 0,                                  // dir+, stagger = firstDelayMin = 1.0 s
      /* F1 */ 0.9, /* F2 */ 0.9, /* F3 */ 0.9,
      /* F4 */ 0.9, 0.5,                       // juke, post-shot reroll -> cd 1.3
      /* respawn */ 0,                         // fresh stagger -> 1.0 s again
    ]));
    const v = view({ dist: 10 });
    const first: number[] = [];
    for (let f = 1; f <= 4; f++) {
      if (brain.decide(v, CADENCE_DT).wantShoot) first.push(f);
    }
    expect(first).toEqual([4]); // 1.0 s at 0.25 s frames

    brain.onRespawn();
    const second: number[] = [];
    for (let f = 1; f <= 6; f++) {
      if (brain.decide(v, CADENCE_DT).wantShoot) second.push(f);
    }
    // Re-armed to 1.0 s, so the fourth frame again. The 1.3 s the corpse was
    // carrying would have held fire until the sixth.
    expect(second).toEqual([4]);
  });

  it('does not shoot a dead target even with sight and range', () => {
    const brain = new DefaultBrain(DEFAULT_BRAIN_PARAMS, queueRng([0.9, 0]));
    let probes = 0;
    const v = view({ dist: 10, targetAlive: false, seeTarget: () => { probes++; return true; } });
    for (let f = 0; f < 4; f++) expect(brain.decide(v, CADENCE_DT).wantShoot).toBe(false);
    expect(probes).toBe(0);
  });

  it('inRange mirrors the trigger\'s exclusive engageRange comparison', () => {
    // The DEV overlay reports this predicate as "could fire" (issue #46), so
    // it must agree with decide() exactly — same bound, same exclusivity.
    const brain = new DefaultBrain({ ...DEFAULT_BRAIN_PARAMS, engageRange: 45 }, calmRng);
    expect(brain.inRange(44.9)).toBe(true);
    expect(brain.inRange(45)).toBe(false);
    expect(brain.inRange(80)).toBe(false);
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

  it('rollHit draws from the brain rng and thresholds against hitChance', () => {
    // hitChance(0) = hitChanceNear = 0.65: a draw below lands, at/above misses.
    const p = DEFAULT_BRAIN_PARAMS;
    const brain = new DefaultBrain(p, queueRng([/* dir */ 0.9, /* cd */ 0.9, /* hit */ 0.649, /* hit */ 0.65, /* hit */ 0.9]));
    expect(brain.rollHit(0)).toBe(true);
    expect(brain.rollHit(0)).toBe(false);
    expect(brain.rollHit(0)).toBe(false);
    // hitChance never wins a draw the floor can't: at extreme range the same
    // low draw that would land near still lands iff below hitChanceMin.
    const far = new DefaultBrain(p, queueRng([0.9, 0.9, p.hitChanceMin - 0.001, p.hitChanceMin]));
    expect(far.rollHit(800)).toBe(true);
    expect(far.rollHit(800)).toBe(false);
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

  it('defaults to planar ranking: height cannot outrank ground distance', () => {
    // With no scorer the pre-3D behavior stands — the (2,0) entry is nearer
    // in the GROUND plane even though the high one wins a 3D comparison.
    const near = cand(2, 0);
    const farButLowY = cand(5, 0, true, 100);
    expect(nearestOpposing(origin, [farButLowY, near])).toBe(near);
  });

  it('skips corpses between the bot and its prey', () => {
    const corpseBetween = cand(1, 0, false);
    const prey = cand(4, 0);
    expect(nearestOpposing(origin, [corpseBetween, prey])).toBe(prey);
  });

  it('ranks by the supplied scorer, so the brain owns target choice', () => {
    const brain = new DefaultBrain(DEFAULT_BRAIN_PARAMS, calmRng);
    // verticalWeight 2: 3 m of height scores (2·3)² = 36, worse than 5 m of
    // flat ground at 25 — reaching the high one costs a stair detour.
    expect(brain.targetScore(5, 0, 0)).toBeCloseTo(25, 12);
    expect(brain.targetScore(0, 3, 0)).toBeCloseTo(36, 12);
    expect(brain.targetScore(0, -3, 0)).toBeCloseTo(36, 12); // below counts the same

    const flat = cand(5, 0);
    const high = cand(0, 0, true, 3);
    // Default (planar) scoring still prefers the one overhead…
    expect(nearestOpposing(origin, [flat, high])).toBe(high);
    // …and the brain's weighted scoring sends the bot after the reachable one.
    expect(nearestOpposing(origin, [flat, high], brain.targetScore)).toBe(flat);
  });
});
