// botBrains.test.ts — pins the default bot policy extracted from bots.ts.
//
// The expected values below are restated independently (longhand vector
// arithmetic), NOT by mirroring decide()'s code paths — a transcription
// slip in the seam must fail here. Time-dependent behavior (first-shot
// stagger, post-shot cadence) is tested by REPLAYING frames against a queued
// RNG, not by seeding internal state directly (review lessons 6/19/20).
//
// Since the perception seam, the brain's only target knowledge is the frame's
// zero-or-one VisualObservation: the view builder fabricates observations
// whose geometry matches what the executor's acquisition would produce.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  DEFAULT_BRAIN_PARAMS,
  DefaultBrain,
  botDamageRoll,
  botHitChance,
  type BrainParams,
  type BrainView,
} from './botBrains';
import type { PerceptionId, VisualObservation } from './perception';

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

/**
 * A visual observation the executor could have produced: a target due +x at
 * planar `dist`, feet at `rise`, eye 1.9 m above its feet (matching the
 * executor's eye convention), both eyes level so dist3 closes to the planar
 * distance unless a test overrides it.
 */
function visualAt(dist = 10, rise = 0, dist3 = Math.hypot(dist, rise), id: PerceptionId = 'player'): VisualObservation {
  return {
    id,
    feet: new THREE.Vector3(dist, rise, 0),
    eye: new THREE.Vector3(dist, rise + 1.9, 0),
    dist,
    dist3,
    rise,
  };
}

/** Options for the canonical view builder; `visual: null` is the hold case. */
interface ViewOpts {
  dist?: number;
  dist3?: number;
  rise?: number;
  visualId?: PerceptionId;
  /** Explicit null = no observation this frame (hold); omitted = build one. */
  visual?: VisualObservation | null;
  onGround?: boolean;
  moveBlocked?: boolean;
  selfSpeed?: number;
  facing?: THREE.Vector3;
  nextWaypoint?: (goal: THREE.Vector3) => THREE.Vector3 | undefined | null;
}

/** Canonical view: observed target due +x, mid-band, LEVEL, 4 m/s. */
function view(o: ViewOpts = {}): BrainView {
  const visual = o.visual === undefined
    ? visualAt(o.dist ?? 10, o.rise ?? 0, o.dist3, o.visualId)
    : o.visual;
  return {
    selfFeet: new THREE.Vector3(0, 0, 0),
    facing: o.facing ?? new THREE.Vector3(1, 0, 0),
    visual,
    onGround: o.onGround ?? true,
    selfSpeed: o.selfSpeed ?? 4,
    moveBlocked: o.moveBlocked ?? false,
    // No route by default: every pre-routing test describes a bot fighting
    // where it stands, and the brain only asks when it wants to travel.
    nextWaypoint: o.nextWaypoint ?? (() => null),
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

  it('flips once per CONTACT EVENT, not once per blocked frame', () => {
    // Level-triggered flipping was issue #43: against a wall face the drift
    // reversed ~60×/s, cancelled itself to zero, and the bot ground along
    // the wall instead of peeling off. Edge-triggering gives one committed
    // direction per contact — the principle travel()'s slide already uses.
    const brain = calmBrain();
    expect(brain.decide(view(), DT).step.z).toBeCloseTo(4 * DT, 12);
    expect(brain.decide(view({ moveBlocked: true }), DT).step.z).toBeCloseTo(-4 * DT, 12);
    for (let f = 1; f <= 5; f++) {
      expect(
        brain.decide(view({ moveBlocked: true }), DT).step.z,
        `held frame ${f}`,
      ).toBeCloseTo(-4 * DT, 12);
    }
    brain.decide(view(), DT); // released
    // A fresh contact event flips again.
    expect(brain.decide(view({ moveBlocked: true }), DT).step.z).toBeCloseTo(4 * DT, 12);
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

// Stage 1 of visual awareness: the brain's only target knowledge is the
// frame's visual observation. No observation -> hold: stand still, keep the
// body's facing, expose no lookAt, never fire. Memory and scanning (the
// `search` mode) are stage 2 and have no tests yet by design.
describe('DefaultBrain hold without a visual', () => {
  const held = view({ visual: null });

  it('stands still and reports hold', () => {
    const intent = calmBrain().decide(held, DT);
    expect(intent.mode).toBe('hold');
    expect(intent.step.length()).toBe(0);
  });

  it('never requests a shot, even with an expired cooldown', () => {
    // Constructor draw 0: the staggered first shot is already due.
    const brain = new DefaultBrain(DEFAULT_BRAIN_PARAMS, queueRng([0.9, 0]));
    for (let f = 1; f <= 5; f++) {
      expect(brain.decide(held, DT).wantShoot, `frame ${f}`).toBe(false);
    }
  });

  it('exposes no lookAt and preserves the body facing', () => {
    const v = view({ visual: null, facing: new THREE.Vector3(0, 0, 1) });
    const intent = calmBrain().decide(v, DT);
    expect(intent.lookAt).toBeNull();
    expect(intent.facing.x).toBeCloseTo(0, 12);
    expect(intent.facing.z).toBeCloseTo(1, 12);
  });

  it('retains the observed identity as focus across sight loss', () => {
    const brain = calmBrain();
    const seen = brain.decide(view({ visualId: 3 }), DT);
    expect(seen.focusId).toBe(3);
    expect(brain.focusId).toBe(3);
    const lost = brain.decide(held, DT);
    expect(lost.focusId).toBe(3);
    expect(brain.focusId).toBe(3);
  });

  it('onRespawn clears the focus', () => {
    const brain = calmBrain();
    brain.decide(view({ visualId: 3 }), DT);
    expect(brain.focusId).toBe(3);
    brain.onRespawn();
    expect(brain.focusId).toBeNull();
  });
});

describe('DefaultBrain visual intent', () => {
  it('focuses the observed identity and looks at a COPY of its eye point', () => {
    const brain = calmBrain();
    const v = view({ visualId: 'player' });
    const intent = brain.decide(v, DT);
    expect(intent.focusId).toBe('player');
    expect(intent.lookAt).not.toBeNull();
    expect(intent.lookAt!.equals(v.visual!.eye)).toBe(true);
    // A copy: mutating the intent must not corrupt the observation the
    // executor still reads this frame.
    expect(intent.lookAt).not.toBe(v.visual!.eye);
    intent.lookAt!.set(999, 999, 999);
    expect(v.visual!.eye.x).toBe(10);
  });

  it('faces the visible point, planar-normalized', () => {
    // Visual at (30, 40) planar: facing must be that direction normalized.
    const target = new THREE.Vector3(30, 0, 40);
    const vis = visualAt(0);
    vis.feet.copy(target);
    vis.eye.set(target.x, 1.9, target.z);
    vis.dist = Math.hypot(30, 40);
    vis.dist3 = 50;
    const intent = calmBrain().decide(view({ visual: vis, facing: new THREE.Vector3(0, 0, 1) }), DT);
    expect(intent.facing.x).toBeCloseTo(0.6, 12);
    expect(intent.facing.z).toBeCloseTo(0.8, 12);
  });

  it('falls back to the body facing for a degenerate (zero planar offset) visual', () => {
    const vis = visualAt(0);
    vis.feet.set(0, 0, 0);
    vis.eye.set(0, 1.9, 0);
    vis.dist = 0;
    const intent = calmBrain().decide(view({ visual: vis, facing: new THREE.Vector3(0, 0, 1) }), DT);
    expect(intent.facing.z).toBeCloseTo(1, 12);
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
  const onRoute = (overrides: ViewOpts = {}): BrainView =>
    view({ dist: 20, rise: 3.6, nextWaypoint: () => NORTH(), ...overrides });

  it('walks the waypoint, not the target, and adds no drift', () => {
    const { step, mode } = calmBrain().decide(onRoute(), STEP_DT);
    expect(mode).toBe('route');
    // Pure heading: the waypoint is due +z, so a drift-free step is too.
    expect(step.x).toBeCloseTo(0, 12);
    expect(step.z).toBeCloseTo(4 * STEP_DT, 12);
  });

  it('asks the route for a path TO THE OBSERVED FEET', () => {
    // The brain knows its own feet and names a world-space goal, while the
    // route answer is relative. The goal must be what it SAW, not inferred.
    let got: THREE.Vector3 | null = null;
    const v = onRoute({ nextWaypoint: (goal) => { got = goal.clone(); return NORTH(); } });
    calmBrain().decide(v, STEP_DT);
    expect(got!.equals(v.visual!.feet)).toBe(true);
  });

  it('ignores a route while the target is on this level', () => {
    let asked = 0;
    const level = view({ dist: 20, rise: 0, nextWaypoint: () => { asked++; return NORTH(); } });
    const { step, mode } = calmBrain().decide(level, STEP_DT);
    expect(mode).toBe('engage');
    expect(step.x).toBeGreaterThan(0); // approaching the target, with drift
    // Lazy like the old seeTarget: no path is asked for when none is wanted.
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

// The flat-routing latch (issue #44): evidence that band steering cannot
// close hands the problem to the graph. Same replay style as the routing
// describes; CADENCE_DT makes the hand-computed timer arithmetic exact
// quarters (noProgressTime 0.5 is two frames).
describe('DefaultBrain flat-routing latch', () => {
  const CADENCE_DT = 0.25;
  const NORTH = (): THREE.Vector3 => new THREE.Vector3(0, 0, 4);
  /** Same-level target beyond farBand, graph available. */
  const stalled = (overrides: ViewOpts = {}): BrainView =>
    view({ dist: 20, rise: 0, nextWaypoint: () => NORTH(), ...overrides });
  const latchParams = (): BrainParams => ({ ...moveParams(), noProgressTime: 0.5 });

  // Latch timing, hand-derived: the FIRST stalled frame only ADOPTS the
  // baseline (from Infinity), so with noProgressTime 0.5 the accrual reaches
  // it on the THIRD cadence frame (0.25 + 0.25). Two frames can never arm.
  it('routes once closure stalls beyond farBand', () => {
    const brain = calmBrain(latchParams());
    expect(brain.decide(stalled(), CADENCE_DT).mode).toBe('engage'); // baseline adopted
    expect(brain.decide(stalled(), CADENCE_DT).mode).toBe('engage'); // 0.25
    const routed = brain.decide(stalled(), CADENCE_DT);              // 0.50 → latch
    expect(routed.mode).toBe('route');
    // Heads at the WAYPOINT (due +z), drift-free — travel(), not band steering.
    expect(routed.step.x).toBeCloseTo(0, 12);
    expect(routed.step.z).toBeCloseTo(4 * CADENCE_DT, 12);
  });

  it('ordinary approach outruns the timer: real-speed closure never routes', () => {
    // Full-speed approach shrinks dist by selfSpeed·dt (~0.067 m) per frame;
    // the baseline crossing lands every ~4th frame, well inside the 1.5 s a
    // default timer needs. This is the false-positive pin.
    const brain = calmBrain();
    let d = 20;
    for (let f = 1; f <= 200; f++) {
      d -= 4 * DT;
      expect(brain.decide(view({ dist: d }), DT).mode, `frame ${f}`).toBe('engage');
    }
  });

  it('closure past the epsilon re-arms the accrual mid-chase', () => {
    const brain = calmBrain(latchParams());
    let d = 20;
    for (let f = 1; f <= 12; f++) {
      d -= 0.5; // clears noProgressEpsilon every frame
      expect(brain.decide(view({ dist: d }), CADENCE_DT).mode, `frame ${f}`).toBe('engage');
    }
  });

  it('a goal pulling away re-baselines instead of arming', () => {
    const brain = calmBrain(latchParams());
    let d = 20;
    for (let f = 1; f <= 12; f++) {
      d += 3; // ≥ fleeReset every frame: running, not stalling
      expect(brain.decide(view({ dist: d }), CADENCE_DT).mode, `frame ${f}`).toBe('engage');
    }
  });

  it('slow drift backward (under fleeReset) still counts as stalled', () => {
    const brain = calmBrain(latchParams());
    let d = 20;
    expect(brain.decide(stalled({ dist: d }), CADENCE_DT).mode).toBe('engage'); // baseline
    // 0.5 m farther is neither closure nor flight: the accrual survives…
    d += 0.5;
    brain.decide(stalled({ dist: d }), CADENCE_DT);
    // …and holding there routes, proving fleeReset is not "any growth resets".
    expect(brain.decide(stalled({ dist: d }), CADENCE_DT).mode).toBe('route');
  });

  it('in-band pacing is engagement, not stagnation', () => {
    const brain = calmBrain(latchParams());
    for (let f = 1; f <= 12; f++) {
      // Constant-radius strafing (#45's hold) must never read as failure.
      expect(brain.decide(view({ dist: 10 }), CADENCE_DT).mode, `frame ${f}`).toBe('engage');
    }
  });

  it('the latch releases inside farBand and needs fresh evidence to re-arm', () => {
    const brain = calmBrain(latchParams());
    brain.decide(stalled(), CADENCE_DT);
    brain.decide(stalled(), CADENCE_DT);
    expect(brain.decide(stalled(), CADENCE_DT).mode).toBe('route');
    // Arrived into the band: steering owns it again, pure strafe hold.
    const released = brain.decide(view({ dist: 13, rise: 0, nextWaypoint: () => NORTH() }), CADENCE_DT);
    expect(released.mode).toBe('engage');
    expect(released.step.x).toBeCloseTo(0, 12);
    expect(released.step.z).toBeCloseTo(4 * CADENCE_DT, 12);
    // Re-baselined AT THE IN-BAND DISTANCE (13): the first stalled frame
    // reads as fleeReset (20 ≥ 13+2) and only re-baselines…
    expect(brain.decide(stalled(), CADENCE_DT).mode).toBe('engage');
    // …the second accrues, the third latches again.
    expect(brain.decide(stalled(), CADENCE_DT).mode).toBe('engage');
    expect(brain.decide(stalled(), CADENCE_DT).mode).toBe('route');
  });

  it('onRespawn clears the latch', () => {
    const brain = calmBrain(latchParams());
    brain.decide(stalled(), CADENCE_DT);
    brain.decide(stalled(), CADENCE_DT);
    expect(brain.decide(stalled(), CADENCE_DT).mode).toBe('route');
    brain.onRespawn();
    expect(brain.decide(stalled(), CADENCE_DT).mode).toBe('engage');
  });

  it('the jam recovery is reachable from an engage-origin route', () => {
    const brain = calmBrain(latchParams());
    brain.decide(stalled(), CADENCE_DT);
    brain.decide(stalled(), CADENCE_DT);
    expect(brain.decide(stalled(), CADENCE_DT).mode).toBe('route');
    // Geometry refuses the waypoint step long enough to be a jam, not a
    // brush: stuckTime 0.25 is one cadence frame…
    const slide = brain.decide(stalled({ moveBlocked: true }), CADENCE_DT);
    // …which commits the slide: perpendicular to the heading, all x.
    expect(Math.abs(slide.step.x)).toBeCloseTo(4 * CADENCE_DT, 12);
    expect(slide.step.z).toBeCloseTo(0, 12);
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

  it('holds fire on a visual beyond engage range, but still moves on it', () => {
    // The gate reads dist3, so a planar-close target high above is out of
    // range too — and agrees with the die rollHit rolls on. Movement is NOT
    // gated: the bot approaches what it sees whatever the range.
    const brain = new DefaultBrain(DEFAULT_BRAIN_PARAMS, queueRng([0.9, 0]));
    const far = view({ dist: 2, dist3: 50, rise: 50 });
    for (let f = 1; f <= 8; f++) {
      const intent = brain.decide(far, CADENCE_DT);
      expect(intent.wantShoot, `frame ${f}`).toBe(false);
      expect(intent.mode).toBe('engage');
      expect(intent.step.x).toBeGreaterThan(0);
    }
  });

  it('spends no shot while the staggered first-shot delay runs', () => {
    const fresh = new DefaultBrain(DEFAULT_BRAIN_PARAMS, queueRng([0.9, 0.99])); // cd ≈ 2.98 s
    for (let f = 1; f <= 4; f++) expect(fresh.decide(view(), CADENCE_DT).wantShoot).toBe(false);
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

  it('inRange mirrors the trigger\'s exclusive engageRange comparison', () => {
    // The executor requires this predicate to pass before realizing a shot,
    // so it must agree with decide() exactly — same bound, same exclusivity.
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

// Phase 2: memory pursuit, the scan search, and the direction-only
// incoming-fire reaction. All of it is replayed through decide() against a
// blind view — memory is private state, observable only through where the
// brain asks to route, where it looks and what it reports.
describe('DefaultBrain memory pursuit', () => {
  /** Goal vector the brain handed to nextWaypoint, cloned at the boundary. */
  function routeSpy(into: THREE.Vector3[], result: THREE.Vector3 | undefined | null = null) {
    return (goal: THREE.Vector3): THREE.Vector3 | undefined | null => {
      into.push(goal.clone());
      return result;
    };
  }

  it('freezes a COPY of the observation: mutating the source cannot drift the memory', () => {
    const brain = calmBrain();
    const vis = visualAt(10); // feet (10,0,0), eye (10,1.9,0)
    brain.decide(view({ visual: vis }), DT); // memory taken
    vis.feet.set(99, 5, 99); // the target "moves" by mangling the executor's record
    vis.eye.set(99, 99, 99);

    const goals: THREE.Vector3[] = [];
    const intent = brain.decide(view({ visual: null, nextWaypoint: routeSpy(goals, new THREE.Vector3(0.5, 0, 0)) }), DT);

    expect(goals).toHaveLength(1);
    expect(goals[0]!.x).toBeCloseTo(10, 12);
    expect(goals[0]!.y).toBeCloseTo(0, 12);
    expect(goals[0]!.z).toBeCloseTo(0, 12);
    expect(intent.lookAt!.x).toBeCloseTo(10, 12);
    expect(intent.lookAt!.y).toBeCloseTo(1.9, 12);
  });

  it('routes to the remembered FEET on sight loss and returns a copied lookAt', () => {
    const brain = calmBrain();
    brain.decide(view({ visual: visualAt(10) }), DT);

    const goals: THREE.Vector3[] = [];
    const first = brain.decide(view({ visual: null, nextWaypoint: routeSpy(goals, new THREE.Vector3(0.5, 0, 0)) }), DT);
    expect(goals[0]!.x).toBeCloseTo(10, 12);
    expect(first.lookAt!.clone()).toEqual(new THREE.Vector3(10, 1.9, 0));
    expect(first.wantShoot).toBe(false);
    expect(first.mode).toBe('route');

    // The returned lookAt is a copy: mangling it cannot corrupt the memory
    // the next blind frame reads back.
    first.lookAt!.set(0, 0, 0);
    const second = brain.decide(view({ visual: null, nextWaypoint: routeSpy(goals, new THREE.Vector3(0.5, 0, 0)) }), DT);
    expect(goals[1]!.x).toBeCloseTo(10, 12);
    expect(second.lookAt!.x).toBeCloseTo(10, 12);
    expect(second.lookAt!.y).toBeCloseTo(1.9, 12);
  });

  it('never orders a shot from memory, even with the cooldown long expired', () => {
    const brain = new DefaultBrain(
      { ...DEFAULT_BRAIN_PARAMS, cooldownMin: -5, cooldownSpan: 0 },
      calmRng,
    );
    brain.decide(view({ visual: visualAt(10) }), DT); // reroll parks cd at −5
    for (let f = 1; f <= 5; f++) {
      const intent = brain.decide(
        view({ visual: null, nextWaypoint: () => new THREE.Vector3(0.5, 0, 0) }),
        DT,
      );
      expect(intent.wantShoot, `frame ${f}`).toBe(false);
    }
  });

  it('waits in route on a deferred (undefined) waypoint: zero step, timer untouched', () => {
    const brain = calmBrain();
    brain.decide(view({ visual: visualAt(10) }), DT);
    for (let f = 1; f <= 5; f++) {
      const intent = brain.decide(view({ visual: null, nextWaypoint: () => undefined }), DT);
      expect(intent.mode).toBe('route');
      expect(intent.step.length()).toBe(0);
      expect(intent.wantShoot).toBe(false);
      expect(intent.focusId).toBe('player');
      expect(intent.lookAt!.clone()).toEqual(new THREE.Vector3(10, 1.9, 0));
    }
  });

  it('starts a search on a confirmed dead end, facing the remembered spot', () => {
    const brain = calmBrain();
    brain.decide(view({ visual: visualAt(10) }), DT);
    const intent = brain.decide(view({ visual: null, nextWaypoint: () => null }), DT);
    expect(intent.mode).toBe('search');
    expect(intent.step.length()).toBe(0);
    expect(intent.wantShoot).toBe(false);
    expect(intent.focusId).toBe('player'); // identity survives into the scan
    expect(intent.facing.x).toBeCloseTo(1, 12);
    expect(intent.facing.z).toBeCloseTo(0, 12);
    expect(intent.lookAt!.clone()).toEqual(new THREE.Vector3(1, 1.9, 0));
  });

  it('the inclusive 1 m arrival boundary starts a search without consulting the graph', () => {
    const brain = calmBrain();
    brain.decide(view({ visual: visualAt(1) }), DT); // memory exactly 1 m away
    let asked = 0;
    const intent = brain.decide(view({
      visual: null,
      nextWaypoint: () => { asked++; return null; },
    }), DT);
    expect(asked).toBe(0); // arrival is decided before the graph is ever asked
    expect(intent.mode).toBe('search');
    expect(intent.facing.x).toBeCloseTo(1, 12);
    expect(intent.lookAt!.clone()).toEqual(new THREE.Vector3(1, 1.9, 0));
  });

  it('a visual reacquisition refreshes the memory and exits an active search', () => {
    const brain = calmBrain();
    brain.decide(view({ visual: visualAt(10) }), DT);
    brain.decide(view({ visual: null, nextWaypoint: () => null }), DT); // search begins

    const reacquired = brain.decide(view({ visual: visualAt(20) }), DT);
    expect(reacquired.mode).toBe('engage');
    expect(reacquired.focusId).toBe('player');

    const goals: THREE.Vector3[] = [];
    brain.decide(view({ visual: null, nextWaypoint: routeSpy(goals, new THREE.Vector3(0.5, 0, 0)) }), DT);
    expect(goals[0]!.x).toBeCloseTo(20, 12); // NEW feet, not the stale (10,0,0)
  });

  it('memory pursuit arms the climb hysteresis for the next visible frame', () => {
    const brain = calmBrain();
    // Seen level (rise under climbThreshold): nothing wants a route yet.
    brain.decide(view({ visual: visualAt(10, 0) }), DT);

    // Sight lost, the graph hands over a real waypoint: memory pursuit is
    // routing, and that state must LATCH, not just move this frame.
    const pursued = brain.decide(view({
      visual: null,
      nextWaypoint: () => new THREE.Vector3(0.5, 0, 0),
    }), DT);
    expect(pursued.mode).toBe('route');

    // Reacquired at a rise strictly between climbExit (0.45) and
    // climbThreshold (1.5) — one that only CONTINUES a route. The latch the
    // memory pursuit raised must keep this frame routing; a fresh entry at
    // climbThreshold would read this as engage.
    const reacquired = brain.decide(view({
      visual: visualAt(10, 1),
      nextWaypoint: () => new THREE.Vector3(0.5, 0, 0),
    }), DT);
    expect(reacquired.mode).toBe('route');
  });
});

describe('DefaultBrain scan search', () => {
  /**
   * Enter a scan whose base bearing is due +x: see a target 10 m east, then
   * hit a confirmed dead end pursuing it. The entry frame itself is the
   * elapsed-zero heading; later frames age the timer by their dt.
   */
  function scanBrain(): { brain: DefaultBrain; entry: ReturnType<DefaultBrain['decide']> } {
    const brain = calmBrain();
    brain.decide(view({ visual: visualAt(10) }), DT);
    return { brain, entry: brain.decide(view({ visual: null, nextWaypoint: () => null }), DT) };
  }

  it('begins at elapsed zero with the base heading, then repeats +120°, −120°', () => {
    const { brain, entry } = scanBrain();
    // Elapsed zero: the entry heading IS the base bearing.
    expect(entry.facing.x).toBeCloseTo(1, 12);
    expect(entry.facing.z).toBeCloseTo(0, 12);
    expect(entry.lookAt!.clone()).toEqual(new THREE.Vector3(1, 1.9, 0));

    // dt = one full scan phase: each frame lands exactly on a phase boundary.
    // Three.js positive-Y rotation: +120° takes (1,0,0) to (cos120°, 0, −sin120°).
    const S = Math.sqrt(3) / 2;
    const f1 = brain.decide(view({ visual: null }), 0.75);
    expect(f1.facing.x).toBeCloseTo(-0.5, 12);
    expect(f1.facing.z).toBeCloseTo(-S, 12);
    expect(f1.lookAt!.y).toBeCloseTo(1.9, 12);
    expect(f1.lookAt!.x).toBeCloseTo(-0.5, 12);
    expect(f1.lookAt!.z).toBeCloseTo(-S, 12);

    const f2 = brain.decide(view({ visual: null }), 0.75);
    expect(f2.facing.x).toBeCloseTo(-0.5, 12);
    expect(f2.facing.z).toBeCloseTo(S, 12);
    expect(f2.lookAt!.y).toBeCloseTo(1.9, 12);
    expect(f2.lookAt!.x).toBeCloseTo(-0.5, 12);
    expect(f2.lookAt!.z).toBeCloseTo(S, 12);

    const f3 = brain.decide(view({ visual: null }), 0.75); // 2.25 s: full sweep repeats
    expect(f3.facing.x).toBeCloseTo(1, 12);
    expect(f3.facing.z).toBeCloseTo(0, 12);
  });

  it('never ages the forget timer while the route walks, and expires into hold exactly at 8 s of search', () => {
    const brain = calmBrain();
    brain.decide(view({ visual: visualAt(10) }), DT);
    // 10 s of routed memory pursuit — longer than forgetTime — must leave
    // the memory unexpired: every frame still routes.
    for (let f = 0; f < 40; f++) {
      const intent = brain.decide(
        view({ visual: null, nextWaypoint: () => new THREE.Vector3(0.5, 0, 0) }),
        0.25,
      );
      expect(intent.mode, `route frame ${f}`).toBe('route');
    }
    // Dead end: the scan starts fresh, with the full 8 s ahead of it.
    const entry = brain.decide(view({ visual: null, nextWaypoint: () => null }), 0.25);
    expect(entry.mode).toBe('search');

    // dt 0.25: frames at elapsed 0.25 … 7.75 still search; 8.0 forgets.
    for (let f = 1; f <= 31; f++) {
      expect(brain.decide(view({ visual: null }), 0.25).mode, `search frame ${f}`).toBe('search');
    }
    const hold = brain.decide(view({ visual: null }), 0.25);
    expect(hold.mode).toBe('hold');
    expect(hold.focusId).toBeNull(); // focus cleared into the forget
    expect(hold.lookAt).toBeNull();
    // The memory is gone with it: the next blind frame holds again rather
    // than resurrecting the pursuit.
    let asked = 0;
    const after = brain.decide(view({
      visual: null,
      nextWaypoint: () => { asked++; return null; },
    }), 0.25);
    expect(asked).toBe(0);
    expect(after.mode).toBe('hold');
  });
});

describe('DefaultBrain incoming fire', () => {
  /** Params that keep every cooldown pinned at/below zero except the spawn stagger. */
  function hotParams(): BrainParams {
    return {
      ...DEFAULT_BRAIN_PARAMS,
      firstDelayMin: 0,
      firstDelaySpan: 0,
      cooldownMin: -5,
      cooldownSpan: 0,
    };
  }

  it('copies and normalizes the bearing and never retains the caller’s vector', () => {
    const brain = calmBrain();
    const bearing = new THREE.Vector3(3, 7, 4); // planar (3,4), length 5
    brain.onIncomingFire(bearing);
    bearing.set(0, 0, 1); // the caller's vector is theirs alone

    const intent = brain.decide(view({ visual: null }), DT);
    expect(intent.mode).toBe('search');
    expect(intent.facing.x).toBeCloseTo(0.6, 12);
    expect(intent.facing.y).toBeCloseTo(0, 12);
    expect(intent.facing.z).toBeCloseTo(0.8, 12);
    // Direction-only: no memory, so the scan look rides the bot eye
    // convention off the bot's own feet.
    expect(intent.lookAt!.y).toBeCloseTo(1.9, 12);
    expect(intent.lookAt!.x).toBeCloseTo(0.6, 12);
    expect(intent.lookAt!.z).toBeCloseTo(0.8, 12);
  });

  it('outranks a simultaneous visual: search, focus cleared, no shot', () => {
    const brain = new DefaultBrain(hotParams(), calmRng);
    brain.decide(view({ visual: visualAt(10) }), DT); // would fire: cd ≤ 0
    brain.onIncomingFire(new THREE.Vector3(3, 0, 4));

    const intent = brain.decide(view({ visual: visualAt(10) }), DT);
    expect(intent.mode).toBe('search'); // not engage — the bearing outranks the look
    expect(intent.wantShoot).toBe(false);
    expect(intent.focusId).toBeNull(); // identity dropped
    expect(intent.facing.x).toBeCloseTo(0.6, 12);
    expect(intent.facing.z).toBeCloseTo(0.8, 12);
    expect(intent.step.length()).toBe(0);
  });

  it('never shoots during the damage search and a later visual reacquires normally', () => {
    const brain = new DefaultBrain(hotParams(), calmRng);
    brain.decide(view({ visual: visualAt(10) }), DT); // fires; reroll parks cd at −5
    brain.onIncomingFire(new THREE.Vector3(3, 0, 4));

    expect(brain.decide(view({ visual: visualAt(10) }), DT).wantShoot).toBe(false);
    const second = brain.decide(view({ visual: visualAt(10) }), DT); // bearing consumed
    expect(second.mode).toBe('engage');
    expect(second.wantShoot).toBe(true); // the look may fire again — memory is sight
    expect(second.focusId).toBe('player');
  });

  it('ignores a zero planar bearing defensively', () => {
    const brain = calmBrain();
    brain.onIncomingFire(new THREE.Vector3(0, 5, 0)); // all-vertical: no direction
    const intent = brain.decide(view({ visual: visualAt(10) }), DT);
    expect(intent.mode).toBe('engage'); // no damage search was queued
    expect(intent.focusId).toBe('player');
  });

  it('onRespawn clears active memory, search and a pending bearing', () => {
    const brain = calmBrain();
    brain.decide(view({ visual: visualAt(10) }), DT); // memory + focus
    brain.decide(view({ visual: null, nextWaypoint: () => null }), DT); // active search
    brain.onIncomingFire(new THREE.Vector3(1, 0, 0)); // pending damage stimulus
    brain.onRespawn();

    let asked = 0;
    const blind = brain.decide(view({
      visual: null,
      nextWaypoint: () => { asked++; return null; },
    }), DT);
    expect(blind.mode).toBe('hold'); // no search, no memory pursuit, no bearing
    expect(blind.focusId).toBeNull();
    expect(blind.lookAt).toBeNull();
    expect(asked).toBe(0);

    const seen = brain.decide(view({ visual: visualAt(10) }), DT);
    expect(seen.mode).toBe('engage'); // not a damage search
    expect(seen.focusId).toBe('player');
  });
});
