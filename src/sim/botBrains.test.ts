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
import type { BotWeaponId } from '../core/state';
import type { FireController, ShotOutcome } from './botWeapons';
import {
  DEFAULT_BRAIN_PARAMS,
  DefaultBrain,
  pickHeardLead,
  type BrainParams,
  type BrainView,
} from './botBrains';
import type { PerceptionId, VisualObservation } from './perception';
import type { HeardSound } from './soundEvents';

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

/**
 * A stand-in weapon. It spends draws exactly where a real one does — one in
 * arm() for the spawn stagger, one per pull() for a burst-of-one's pause — so
 * every scripted sequence below still reads [strafeDir, stagger, F1 juke, …]
 * and the brain's draw contract is pinned by the same tests it always was.
 *
 * What it does NOT do is decide anything: `readyNow` is set by the test. That
 * is the point of testing the brain against a stub — cadence, magazine and
 * reload moved to sim/botWeapons.ts and are pinned there against the real
 * catalog, so asserting them through the brain would be testing a mechanism
 * the brain no longer owns (lesson 28, at the unit layer).
 */
class StubFire implements FireController {
  /** Mutable so a test can stand in for a dry swap under the brain. */
  weapon: BotWeaponId = 'smg';
  readonly resolution = 'ranged' as const;
  readonly magSize = 30;
  mag = 30;
  reserve = 90;
  reloading = false;
  /** Whether ready() answers true — the test's lever on the trigger. */
  readyNow = false;
  arms = 0;
  pulls = 0;
  resolves: number[] = [];
  /** Every tick this brain took, in order: the once-per-frame contract. */
  ticks: { dt: number; engaged: boolean }[] = [];
  /** How many times the brain re-derived its policy from this stub. */
  paramCalls: BrainParams[] = [];

  constructor(private readonly rng: () => number = calmRng) {}

  arm(): void { this.arms++; this.rng(); }
  tick(dt: number, engaged: boolean): void { this.ticks.push({ dt, engaged }); }
  ready(): boolean { return this.readyNow; }
  pull(): void { this.pulls++; this.rng(); }
  resolve(dist: number): ShotOutcome {
    this.resolves.push(dist);
    return { damage: 0, zone: null, rays: 1, hits: 0 };
  }
  hitChance(): number { return 0; }
  params(base: BrainParams): BrainParams { this.paramCalls.push(base); return base; }
}

/**
 * A brain whose weapon is permanently willing to fire. The strongest form of
 * every "must not shoot on this stimulus" claim: if the trigger is refused
 * here, nothing about cadence, magazine or reload is doing the refusing.
 */
function eagerBrain(params: BrainParams = DEFAULT_BRAIN_PARAMS): DefaultBrain {
  const fire = new StubFire();
  fire.readyNow = true;
  return brainOf(params, calmRng, fire);
}

/**
 * Build a brain on a stub weapon sharing its rng. Every construction site
 * below goes through this rather than `new DefaultBrain`, so the weapon and
 * the brain cannot accidentally end up on different rng streams.
 */
function brainOf(
  params: BrainParams,
  rng: () => number,
  fire: FireController = new StubFire(rng),
): DefaultBrain {
  return new DefaultBrain(params, rng, fire);
}

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
  /** Own feet; default the origin (grade under every at-grade test flag). */
  selfFeet?: THREE.Vector3;
  nextWaypoint?: (goal: THREE.Vector3) => THREE.Vector3 | undefined | null;
  /** Patrol thunk outcome, like nextWaypoint; default null = nothing usable. */
  nextPatrolWaypoint?: () => THREE.Vector3 | undefined | null;
  /** Hostile noises this frame, executor-filtered; default none. */
  heard?: readonly HeardSound[];
  /**
   * Assigned domination flag; default null = TDM or undispatched. Cover
   * defaults to zero — an uncovered push by the designated holder — unless
   * the test says otherwise.
   */
  objective?: {
    id: string;
    pos: THREE.Vector3;
    radius: number;
    cappingMates?: number;
    holdRank?: number;
  } | null;
  /** Standability feeler; default open ground — every pre-sense test walks nowhere near a wall. */
  canStandAt?: (x: number, z: number) => boolean;
  /** Footing probe; default ground everywhere — every pre-guard test stands on a floor. */
  hasFootingAt?: (x: number, z: number) => boolean;
}

/** Canonical view: observed target due +x, mid-band, LEVEL, 4 m/s. */
function view(o: ViewOpts = {}): BrainView {
  const visual = o.visual === undefined
    ? visualAt(o.dist ?? 10, o.rise ?? 0, o.dist3, o.visualId)
    : o.visual;
  return {
    selfFeet: o.selfFeet ?? new THREE.Vector3(0, 0, 0),
    facing: o.facing ?? new THREE.Vector3(1, 0, 0),
    visual,
    onGround: o.onGround ?? true,
    selfSpeed: o.selfSpeed ?? 4,
    moveBlocked: o.moveBlocked ?? false,
    // Silence by default: every pre-hearing test describes a frame in which
    // nothing audible happened.
    heard: o.heard ?? [],
    // No route by default: every pre-routing test describes a bot fighting
    // where it stands, and the brain only asks when it wants to travel.
    nextWaypoint: o.nextWaypoint ?? (() => null),
    // No patrol route by default either: the patrol tests pass their own
    // thunk, and the pause-before-patrol tests want a goalless answer (null).
    nextPatrolWaypoint: o.nextPatrolWaypoint ?? (() => null),
    // No objective by default: every pre-domination test describes a TDM bot.
    // Cover defaults to zero — an uncovered push by the designated holder —
    // unless the test says otherwise.
    objective: o.objective === undefined || o.objective === null ? null : {
      id: o.objective.id,
      pos: o.objective.pos,
      radius: o.objective.radius,
      cappingMates: o.objective.cappingMates ?? 0,
      holdRank: o.objective.holdRank ?? 0,
    },
    // Open ground by default: the sense tests pass their own walls.
    canStandAt: o.canStandAt ?? (() => true),
    // Ground everywhere by default: the footing tests pass their own edges.
    hasFootingAt: o.hasFootingAt ?? (() => true),
  };
}

/** Fresh brain strafing +x-perpendicular: constructor draws [dir, stagger] = [0.9, 0.9]. */
function calmBrain(params: BrainParams = moveParams()): DefaultBrain {
  return brainOf(params, calmRng);
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
    const plus = brainOf(moveParams(), queueRng([0.9, 0.9]));
    expect(plus.decide(view(), DT).step.z).toBeCloseTo(4 * DT, 12);
    const minus = brainOf(moveParams(), queueRng([0.1, 0.9]));
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
    const brain = brainOf(
      moveParams(),
      queueRng([0.9, 0.9, /* F1 */ 0.4, /* F2 */ 0.9]),
    );
    const dt = 1; // juke threshold becomes 0.5
    expect(brain.decide(view(), dt).step.z).toBeCloseTo(4 * dt, 12);
    expect(brain.decide(view(), dt).step.z).toBeCloseTo(-4 * dt, 12);
  });

  it('does not juke when the draw clears the threshold', () => {
    const brain = brainOf(moveParams(), queueRng([0.9, 0.9, 0.5, 0.9]));
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
    const brain = brainOf(DEFAULT_BRAIN_PARAMS, queueRng([0.9, 0]));
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
// Explicit fixture timers: stuckTime 0.25 is 3 frames (0.3 > 0.25),
// commitTime 0.5 is 5. Shipped tuning is exercised by botMovement.test.ts.
// The waypoint points due +z so a routing step reads on
// step.z alone, and any step.x at all would be drift that must not be there.
describe('DefaultBrain routing', () => {
  const STEP_DT = 0.1;
  const calmBrain = (): DefaultBrain => brainOf({ ...moveParams(), stuckTime: 0.25, commitTime: 0.5 }, calmRng);
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

// The travel wall-sense: diagonal feelers ease a routed step off a wall on
// one side before contact grinds speed off in the slide gate. Same replay
// style as the routing describes above — the waypoint is due +z from feet at
// the origin, so with range 1 the feelers sit at (±1, 0, 1) and a
// `x >= -0.5` probe walls exactly the -x one.
describe('DefaultBrain travel wall-sense', () => {
  const STEP_DT = 0.1;
  const NORTH = (): THREE.Vector3 => new THREE.Vector3(0, 0, 4);
  const onRoute = (overrides: ViewOpts = {}): BrainView =>
    view({ dist: 20, rise: 3.6, nextWaypoint: () => NORTH(), ...overrides });

  it('walks the line untouched when both feelers read open', () => {
    const { step, mode } = calmBrain().decide(onRoute(), STEP_DT);
    expect(mode).toBe('route');
    expect(step.x).toBeCloseTo(0, 12);
    expect(step.z).toBeCloseTo(4 * STEP_DT, 12);
  });

  it('eases away from a wall on one side, still mostly forward', () => {
    // Blend = heading (0,0,1) + push 0.5 along +x, normalized to speed·dt.
    const len = Math.sqrt(1 + 0.5 * 0.5);
    const { step } = calmBrain().decide(onRoute({ canStandAt: (x) => x >= -0.5 }), STEP_DT);
    expect(step.x).toBeCloseTo((0.5 / len) * 4 * STEP_DT, 12);
    expect(step.z).toBeCloseTo((1 / len) * 4 * STEP_DT, 12);
  });

  it('mirrors: a wall on the other side pushes the other way', () => {
    const { step } = calmBrain().decide(onRoute({ canStandAt: (x) => x <= 0.5 }), STEP_DT);
    expect(step.x).toBeLessThan(0);
    expect(step.z).toBeGreaterThan(0);
  });

  it('holds the line through a doorway, both feelers blocked', () => {
    // Picking a side inside a gap would steer into a jamb; the line holds.
    const { step } = calmBrain().decide(onRoute({ canStandAt: () => false }), STEP_DT);
    expect(step.x).toBeCloseTo(0, 12);
    expect(step.z).toBeCloseTo(4 * STEP_DT, 12);
  });

  it('a committed slide ignores the feelers', () => {
    // First refused frame arms the sideways commit (shipped stuckTime 0.1 at
    // STEP_DT 0.1); the feelers must not leak a forward component back into
    // the committed slide.
    const brain = calmBrain();
    const jammed = onRoute({ moveBlocked: true, canStandAt: (x) => x >= -0.5 });
    for (let f = 1; f <= 3; f++) brain.decide(jammed, STEP_DT);
    const slide = brain.decide(jammed, STEP_DT);
    expect(Math.abs(slide.step.x)).toBeCloseTo(4 * STEP_DT, 12);
    expect(slide.step.z).toBeCloseTo(0, 12);
  });

  it('engage steering reads only the strafe pair', () => {
    // Scoping pin, widened by the engage wall-sense: a mid-band firefight
    // takes exactly the two lateral feeler reads per frame — no diagonal
    // travel feelers, no per-joint wandering.
    let asked = 0;
    const v = view({ dist: 10, canStandAt: () => { asked++; return true; } });
    const { mode } = calmBrain().decide(v, STEP_DT);
    expect(mode).toBe('engage');
    expect(asked).toBe(2);
  });
});

// The engage wall-sense: corner contact used to flicker moveBlocked, and
// every flicker edge re-reversed the strafe — vibration with zero net lateral
// progress while the radial pinned the bot in. Same replay style as above:
// mid-band target due +x, so the strafe axis is ±z and a `z <= 0.5` probe
// walls exactly the side the calm brain strafes toward first.
describe('DefaultBrain engage wall-sense', () => {
  const STEP_DT = 0.1;
  /** Mid-band firefight, strafing +z first; never routes, never latches. */
  const duel = (overrides: ViewOpts = {}): BrainView => view({ dist: 10, ...overrides });

  it('flips the strafe before contact with a walled side', () => {
    // Blend after the flip: heading (0,0,-1) weighted 0.5 against nothing
    // radial — pure reversed strafe at full speed, the same frame.
    const { step, mode } = calmBrain().decide(duel({ canStandAt: (_x, z) => z <= 0.5 }), STEP_DT);
    expect(mode).toBe('engage');
    expect(step.x).toBeCloseTo(0, 12);
    expect(step.z).toBeCloseTo(-4 * STEP_DT, 12);
  });

  it('holds the strafe through a doorway, both feelers blocked', () => {
    const { step } = calmBrain().decide(duel({ canStandAt: () => false }), STEP_DT);
    expect(step.z).toBeCloseTo(4 * STEP_DT, 12);
  });

  it('debounces feeler flips so they cannot chatter', () => {
    // The wall swaps sides every frame; without the refractory period the
    // strafe would alternate with it. First frame flips, the next 0.4 s hold,
    // and the flip back lands once the 0.5 s cooldown spends (a frame of
    // float residue either way — the test polls past it rather than pinning
    // it).
    const brain = calmBrain();
    let wallPlusZ = true;
    const v = (): BrainView => duel({ canStandAt: (_x, z) => (wallPlusZ ? z <= 0.5 : z >= -0.5) });
    expect(brain.decide(v(), STEP_DT).step.z).toBeLessThan(0); // flipped
    for (let f = 1; f <= 4; f++) {
      wallPlusZ = false; // the far side is walled now — must NOT flip back yet
      expect(brain.decide(v(), STEP_DT).step.z, `frame ${f}`).toBeLessThan(0);
    }
    wallPlusZ = false;
    let flipped = false;
    for (let f = 1; f <= 3 && !flipped; f++) {
      flipped = brain.decide(v(), STEP_DT).step.z > 0;
    }
    expect(flipped).toBe(true);
  });

  it('sidesteps a sustained wedge without leaving engage or holding fire', () => {
    // First refused frame arms the same commit travel() uses (stuckTime 0.1
    // at STEP_DT 0.1); the step goes pure lateral while the band, the mode
    // and the trigger all still run.
    const fire = new StubFire();
    fire.readyNow = true;
    const brain = brainOf(DEFAULT_BRAIN_PARAMS, calmRng, fire);
    const wedged = duel({ moveBlocked: true });
    brain.decide(wedged, STEP_DT); // contact edge flips the strafe; already committed
    brain.decide(wedged, STEP_DT); // committed
    const slide = brain.decide(wedged, STEP_DT); // still committed
    expect(slide.mode).toBe('engage');
    expect(slide.step.x).toBeCloseTo(0, 12);
    expect(Math.abs(slide.step.z)).toBeCloseTo(4 * STEP_DT, 12);
    expect(slide.wantShoot).toBe(true);
    expect(fire.pulls).toBeGreaterThan(0);
    // …and the commit persists while the wedge does.
    const held = brain.decide(wedged, STEP_DT);
    expect(Math.abs(held.step.z)).toBeCloseTo(4 * STEP_DT, 12);
  });

  it('a patrol-armed commit does not steer the next firefight', () => {
    // Patrol geometry arms the shared timers, hold freezes them (it never
    // runs updateJam), and the next visual must re-enter engage fresh rather
    // than sliding on geometry it already left behind.
    const brain = brainOf({ ...moveParams(), patrolPause: 0 }, calmRng);
    const patrolBlocked = view({
      visual: null,
      moveBlocked: true,
      nextPatrolWaypoint: () => new THREE.Vector3(0, 0, 4),
    });
    brain.decide(patrolBlocked, STEP_DT); // arms commitLeft
    brain.decide(view({ visual: null, moveBlocked: true, nextPatrolWaypoint: () => null }), STEP_DT); // hold
    const { step, mode } = brain.decide(duel({ dist: 20, moveBlocked: false }), STEP_DT);
    expect(mode).toBe('engage');
    // Beyond farBand the band blend keeps a forward component; a leaked
    // commit would read pure lateral (all-z, no x).
    expect(step.x).toBeGreaterThan(0);
  });

  it('a brush never sidesteps: isolated rejections keep band steering', () => {
    // Beyond farBand so the radial leg discriminates: a committed sidestep
    // would read all-x, while the band blend keeps a forward component.
    const brain = calmBrain();
    const far = duel({ dist: 20 });
    const brush = duel({ dist: 20, moveBlocked: true });
    brain.decide(brush, DT);
    // One clean frame resets the jam counter — the wedge below starts over.
    brain.decide(far, DT);
    const { step, mode } = brain.decide(brush, DT);
    expect(mode).toBe('engage');
    // Radial 1 plus the 0.7 strafe, normalized: forward survives, so no
    // commit armed.
    const len = Math.sqrt(1 + 0.7 * 0.7);
    expect(step.x).toBeCloseTo((1 / len) * 4 * DT, 12);
    expect(step.z).toBeCloseTo((0.7 / len) * 4 * DT, 12);
  });
});

// The footing guard (#127): canStandAt reads true over a void, so a strafe or
// a back-off used to carry bots off flights and out of windows. Same geometry
// as the wall-sense above — target due +x, calm brain strafing +z first — with
// `hasFootingAt` cutting the ground away on one side.
describe('DefaultBrain engage footing', () => {
  const STEP_DT = 0.1;
  const SPEED_STEP = 4 * STEP_DT;
  const duel = (overrides: ViewOpts = {}): BrainView => view({ dist: 10, ...overrides });
  const noGroundPlusZ = (_x: number, z: number): boolean => z <= 0;

  it('drops a strafe that would leave the ground and reverses it next frame', () => {
    // In-band: the strafe is the whole step, so dropping it stands the bot
    // still for one frame; the next frame steps the other way at full speed.
    const brain = calmBrain();
    const first = brain.decide(duel({ hasFootingAt: noGroundPlusZ }), STEP_DT);
    expect(first.mode).toBe('engage');
    expect(first.step.length()).toBeCloseTo(0, 12);
    const next = brain.decide(duel({ hasFootingAt: noGroundPlusZ }), STEP_DT);
    expect(next.step.x).toBeCloseTo(0, 12);
    expect(next.step.z).toBeCloseTo(-SPEED_STEP, 12);
  });

  it('keeps the approach when the strafe is dropped, renormalized to full speed', () => {
    const { step } = calmBrain().decide(duel({ dist: 20, hasFootingAt: noGroundPlusZ }), STEP_DT);
    expect(step.x).toBeCloseTo(SPEED_STEP, 12);
    expect(step.z).toBeCloseTo(0, 12);
  });

  it('drops a back-off that would leave the ground and keeps the strafe', () => {
    // Inside nearBand the radial leg points -x, straight out of a window
    // behind the bot; the ground is only cut away behind it.
    const { step } = calmBrain().decide(duel({ dist: 5, hasFootingAt: (x) => x >= 0 }), STEP_DT);
    expect(step.x).toBeCloseTo(0, 12);
    expect(step.z).toBeCloseTo(SPEED_STEP, 12);
  });

  it('backs off as before while there is ground behind', () => {
    // Blend (-1, 0, 0.7) normalized: the guard changes nothing on a floor.
    const len = Math.sqrt(1 + 0.7 * 0.7);
    const { step } = calmBrain().decide(duel({ dist: 5, hasFootingAt: (x) => x <= 0 }), STEP_DT);
    expect(step.x).toBeCloseTo(-SPEED_STEP / len, 12);
    expect(step.z).toBeCloseTo((0.7 * SPEED_STEP) / len, 12);
  });

  it('never guards the approach: a bot may drop off a deck toward a target below', () => {
    const len = Math.sqrt(1 + 0.7 * 0.7);
    const { step } = calmBrain().decide(duel({ dist: 20, hasFootingAt: (x) => x <= 0 }), STEP_DT);
    expect(step.x).toBeCloseTo(SPEED_STEP / len, 12);
    expect(step.z).toBeCloseTo((0.7 * SPEED_STEP) / len, 12);
  });

  it('a wedge slide never steps onto the footless side, and still slides the other way', () => {
    // Both jam-slide sides and both strafe sides get exercised across the
    // replay; whichever the commit picks first, nothing may land on +z.
    const brain = calmBrain();
    let movedAway = false;
    for (let f = 0; f < 8; f++) {
      const { step, mode } = brain.decide(duel({ moveBlocked: true, hasFootingAt: noGroundPlusZ }), STEP_DT);
      expect(mode).toBe('engage');
      expect(step.z, `frame ${f}`).toBeLessThanOrEqual(1e-12);
      if (step.z < -1e-9) movedAway = true;
    }
    expect(movedAway).toBe(true);
  });

  it('a routed jam slide never steps onto the footless side', () => {
    // Waypoint due +z, so the committed slide runs along ±x.
    const brain = calmBrain();
    const jammed = view({
      dist: 20, rise: 3.6, moveBlocked: true,
      nextWaypoint: () => new THREE.Vector3(0, 0, 4),
      hasFootingAt: (x) => x <= 0,
    });
    let slid = false;
    for (let f = 0; f < 8; f++) {
      const { step, mode } = brain.decide(jammed, STEP_DT);
      expect(mode).toBe('route');
      expect(step.x, `frame ${f}`).toBeLessThanOrEqual(1e-12);
      if (step.x < -1e-9) slid = true;
    }
    expect(slid).toBe(true);
  });

  it('leaves the route heading to the graph: travel walks it with no ground probed', () => {
    let asked = 0;
    const { step, mode } = calmBrain().decide(view({
      dist: 20, rise: 3.6,
      nextWaypoint: () => new THREE.Vector3(0, 0, 4),
      hasFootingAt: () => { asked++; return false; },
    }), STEP_DT);
    expect(mode).toBe('route');
    expect(step.z).toBeCloseTo(SPEED_STEP, 12);
    expect(asked).toBe(0);
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
    // brush: the shipped stuckTime (0.1) is under one cadence frame (0.25),
    // so the first refused frame arms the commit…
    const slide = brain.decide(stalled({ moveBlocked: true }), CADENCE_DT);
    // …which commits the slide: perpendicular to the heading, all x.
    expect(Math.abs(slide.step.x)).toBeCloseTo(4 * CADENCE_DT, 12);
    expect(slide.step.z).toBeCloseTo(0, 12);
  });
});

describe('DefaultBrain trigger', () => {
  /** dt 0.25 makes the hand-computed frame arithmetic exact quarters. */
  const CADENCE_DT = 0.25;

  it('asks the weapon every frame and fires exactly when it says it may', () => {
    // The brain's whole remaining trigger responsibility: forward. WHEN the
    // weapon is ready — stagger, cadence, burst, magazine, reload — is
    // sim/botWeapons.ts's, pinned there against the real catalog.
    const rng = queueRng([0.9, 0.9]); // dir+, stagger
    const fire = new StubFire(rng);
    const brain = brainOf(DEFAULT_BRAIN_PARAMS, rng, fire);
    const v = view({ dist: 10 });

    expect(brain.decide(v, CADENCE_DT).wantShoot).toBe(false);
    expect(fire.pulls).toBe(0);

    fire.readyNow = true;
    expect(brain.decide(v, CADENCE_DT).wantShoot).toBe(true);
    expect(fire.pulls).toBe(1);

    fire.readyNow = false;
    expect(brain.decide(v, CADENCE_DT).wantShoot).toBe(false);
    expect(fire.pulls).toBe(1);
  });

  it('ticks the weapon exactly once per frame, in every mode', () => {
    // The magazine and the reload clock belong to the bot, not to the mode it
    // is in: a bot that breaks contact and routes away must arrive loaded.
    const fire = new StubFire();
    const brain = brainOf(DEFAULT_BRAIN_PARAMS, calmRng, fire);
    brain.decide(view({ dist: 10 }), DT);                       // engage
    brain.decide(view({ visual: null }), DT);                   // hold/patrol
    brain.decide(view({ visual: null, nextPatrolWaypoint: () => new THREE.Vector3(9, 0, 0) }), DT);
    brain.onIncomingFire(new THREE.Vector3(1, 0, 0));
    brain.decide(view({ visual: null }), DT);                   // damage search
    expect(fire.ticks).toHaveLength(4);
    for (const t of fire.ticks) expect(t.dt).toBe(DT);
  });

  it('reports a firefight only while a shootable visual owns the frame', () => {
    // `engaged` gates the opportunistic top-up, so it must mean "fighting
    // right now" and nothing looser.
    const fire = new StubFire();
    const brain = brainOf(DEFAULT_BRAIN_PARAMS, calmRng, fire);
    brain.decide(view({ dist: 10 }), DT);
    expect(fire.ticks.at(-1)?.engaged).toBe(true);
    brain.decide(view({ dist: 2, dist3: 50, rise: 50 }), DT);   // seen, out of range
    expect(fire.ticks.at(-1)?.engaged).toBe(false);
    brain.decide(view({ visual: null }), DT);                   // nothing seen
    expect(fire.ticks.at(-1)?.engaged).toBe(false);
  });

  it('a damage bearing is not a firefight, even over a same-frame visual', () => {
    // Priority 1 discards the look, so the frame cannot fire — and must not
    // claim to be engaged either, or a bot pinned by fire it cannot see would
    // refuse to top up its magazine.
    const fire = new StubFire();
    fire.readyNow = true;
    const brain = brainOf(DEFAULT_BRAIN_PARAMS, calmRng, fire);
    brain.onIncomingFire(new THREE.Vector3(1, 0, 0));
    const intent = brain.decide(view({ dist: 10 }), DT);
    expect(intent.wantShoot).toBe(false);
    expect(intent.mode).toBe('search');
    expect(fire.pulls).toBe(0);
    expect(fire.ticks.at(-1)?.engaged).toBe(false);
  });

  it('holds fire on a visual beyond engage range, but still moves on it', () => {
    // The gate reads dist3, so a planar-close target high above is out of
    // range too — and agrees with the die resolveShot rolls on. Movement is
    // NOT gated: the bot approaches what it sees whatever the range.
    const fire = new StubFire();
    fire.readyNow = true;
    const brain = brainOf(DEFAULT_BRAIN_PARAMS, calmRng, fire);
    const far = view({ dist: 2, dist3: 50, rise: 50 });
    for (let f = 1; f <= 8; f++) {
      const intent = brain.decide(far, CADENCE_DT);
      expect(intent.wantShoot, `frame ${f}`).toBe(false);
      expect(intent.mode).toBe('engage');
      expect(intent.step.x).toBeGreaterThan(0);
    }
    expect(fire.pulls).toBe(0);
  });

  it('never shoots on memory, search, hearing or patrol however ready the weapon', () => {
    // The structural claim tranche 6 rests on: only a CURRENT visual can
    // authorize a shot. A weapon that always says yes must change nothing.
    const fire = new StubFire();
    fire.readyNow = true;
    const brain = brainOf(DEFAULT_BRAIN_PARAMS, calmRng, fire);
    brain.decide(view({ dist: 10 }), DT);          // acquire, so memory exists
    const blind = { visual: null } as const;
    for (let f = 1; f <= 30; f++) {
      expect(brain.decide(view(blind), DT).wantShoot, `frame ${f}`).toBe(false);
    }
    expect(fire.pulls).toBe(1); // the one engage frame, and nothing since
  });

  it('arms the weapon at construction and again on respawn', () => {
    // Brains outlive their bodies: without this a revived bot inherits the
    // corpse's magazine and whatever cadence it was mid-way through.
    const fire = new StubFire();
    const brain = brainOf(DEFAULT_BRAIN_PARAMS, calmRng, fire);
    expect(fire.arms).toBe(1);
    brain.onRespawn();
    expect(fire.arms).toBe(2);
  });

  it('takes the construction draws in the documented order', () => {
    // [strafeDir, stagger] — the stagger is the weapon's draw, taken from the
    // brain's stream inside the constructor. A controller that drew when it
    // was BUILT would reverse these and shift every script in this file.
    const seen: number[] = [];
    const rng = (): number => { const v = [0.1, 0.42][seen.length] ?? 0.9; seen.push(v); return v; };
    const fire = new StubFire(rng);
    const brain = brainOf(moveParams(), rng, fire);
    expect(seen).toEqual([0.1, 0.42]);
    expect(fire.arms).toBe(1);
    // 0.1 < 0.5 selected the -1 strafe direction, so the drift runs -z.
    expect(brain.decide(view(), DT).step.z).toBeCloseTo(-4 * DT, 12);
  });

  it('resolveShot and hitChance read the weapon, not the brain', () => {
    const fire = new StubFire();
    const brain = brainOf(DEFAULT_BRAIN_PARAMS, calmRng, fire);
    expect(brain.resolveShot(12.5)).toEqual({ damage: 0, zone: null, rays: 1, hits: 0 });
    expect(fire.resolves).toEqual([12.5]);
    expect(brain.weapon).toBe('smg');
    expect(brain.magSize).toBe(30);
  });

  it('re-derives its bands when the loadout swaps weapons under it', () => {
    // The dry swap happens inside fire.tick(), so the brain learns about it by
    // watching `weapon` — a bot that fell back to its sidearm must fight at the
    // SIDEARM's range, not the rifle's it no longer holds.
    const fire = new StubFire();
    const brain = brainOf({ ...DEFAULT_BRAIN_PARAMS, engageRange: 45 }, calmRng, fire);
    expect(brain.inRange(44.9)).toBe(true);
    // The stub answers params() with a narrower engage range once it is the
    // pistol, exactly as botBrainParams would over the real tuning.
    fire.weapon = 'pistol';
    fire.params = (base) => ({ ...base, engageRange: 30 });
    brain.decide(view(), DT);
    expect(brain.inRange(44.9)).toBe(false);
    expect(brain.inRange(29.9)).toBe(true);
  });

  it('re-derives nothing while the weapon holds still', () => {
    // The resync is a change detector, not a per-frame allocation.
    const fire = new StubFire();
    const brain = brainOf(DEFAULT_BRAIN_PARAMS, calmRng, fire);
    const afterConstruction = fire.paramCalls.length;
    expect(afterConstruction).toBe(1);
    for (let i = 0; i < 10; i++) brain.decide(view(), DT);
    expect(fire.paramCalls.length).toBe(afterConstruction);
  });

  it('inRange mirrors the trigger\'s exclusive engageRange comparison', () => {
    // The executor requires this predicate to pass before realizing a shot,
    // so it must agree with decide() exactly — same bound, same exclusivity.
    const brain = brainOf({ ...DEFAULT_BRAIN_PARAMS, engageRange: 45 }, calmRng);
    expect(brain.inRange(44.9)).toBe(true);
    expect(brain.inRange(45)).toBe(false);
    expect(brain.inRange(80)).toBe(false);
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

  it('never orders a shot from memory, however willing the weapon', () => {
    const brain = eagerBrain();
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
    const brain = eagerBrain();
    brain.decide(view({ visual: visualAt(10) }), DT); // would fire: cd ≤ 0
    brain.onIncomingFire(new THREE.Vector3(3, 0, 4));

    const intent = brain.decide(view({ visual: visualAt(10) }), DT);
    expect(intent.mode).toBe('search'); // not engage — the bearing outranks the look
    expect(intent.wantShoot).toBe(false);
    expect(intent.focusId).toBeNull(); // identity dropped
    expect(intent.facing.x).toBeCloseTo(0.6, 12);
    expect(intent.facing.z).toBeCloseTo(0.8, 12);
    // The damage frame itself advances at normal speed along the bearing.
    expect(intent.step.x).toBeCloseTo(0.6 * 4 * DT, 12);
    expect(intent.step.z).toBeCloseTo(0.8 * 4 * DT, 12);
  });

  it('never shoots during the damage search and a later visual reacquires normally', () => {
    const brain = eagerBrain();
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

describe('pickHeardLead', () => {
  const ear = new THREE.Vector3(0, 0, 0);
  const g = (seq: number, x = 0, y = 0, z = 0): HeardSound =>
    ({ seq, t: seq / 60, kind: 'gunshot', pos: new THREE.Vector3(x, y, z) });
  const f = (seq: number, x = 0): HeardSound =>
    ({ seq, t: seq / 60, kind: 'footstep', pos: new THREE.Vector3(x, 0, 0) });

  it('returns null for silence', () => {
    expect(pickHeardLead([], ear)).toBeNull();
  });

  it('prefers a gunshot over a footstep, whichever arrived first', () => {
    expect(pickHeardLead([f(1), g(2)], ear)!.kind).toBe('gunshot');
    expect(pickHeardLead([g(1), f(2)], ear)!.kind).toBe('gunshot');
  });

  it('takes the NEAREST gunshot despite recency and batch order', () => {
    expect(pickHeardLead([g(9, 60), g(4, 1)], ear)!.seq).toBe(4);
    expect(pickHeardLead([g(4, 1), g(9, 60)], ear)!.seq).toBe(4);
  });

  it('measures nearness in 3D from the event position to the listener feet', () => {
    // Planar-near loses: (1, 40, 0) is 1 m away on the ground plane but ~40 m
    // in 3D, so the 10 m level event is the nearer lead.
    expect(pickHeardLead([g(4, 10), g(9, 1, 40)], ear)!.seq).toBe(4);
  });

  it('breaks an exact distance tie by newest sequence', () => {
    expect(pickHeardLead([g(4, 5), g(9, -5)], ear)!.seq).toBe(9);
  });

  it('takes the newest GUNSHOT even when a later footstep followed it', () => {
    // Ordering by kind first is the point: a footstep at seq 12 does not
    // outrank a gunshot at seq 11. Both gunshots sit at the same distance so
    // the tie falls to recency.
    expect(pickHeardLead([g(10, 3), g(11, 3), f(12)], ear)!.seq).toBe(11);
  });

  it('takes the newest footstep when no gunshot exists', () => {
    expect(pickHeardLead([f(4), f(9), f(7)], ear)!.seq).toBe(9);
  });

  it('never mutates an event or its position', () => {
    const a = g(4, 1);
    const b = g(9, 60);
    pickHeardLead([a, b], ear);
    expect(a.seq).toBe(4);
    expect(a.pos.x).toBe(1);
    expect(b.pos.x).toBe(60);
  });
});

describe('DefaultBrain hearing', () => {
  const gunshot = (seq: number, x: number, z = 0): HeardSound =>
    ({ seq, t: seq / 60, kind: 'gunshot', pos: new THREE.Vector3(x, 0, z) });
  const footstep = (seq: number, x: number, z = 0): HeardSound =>
    ({ seq, t: seq / 60, kind: 'footstep', pos: new THREE.Vector3(x, 0, z) });

  /** Goal vector the brain handed to nextWaypoint, cloned at the boundary. */
  function routeSpy(into: THREE.Vector3[], result: THREE.Vector3 | undefined | null = null) {
    return (goal: THREE.Vector3): THREE.Vector3 | undefined | null => {
      into.push(goal.clone());
      return result;
    };
  }

  it('routes to a heard position with a NULL focus', () => {
    const brain = calmBrain();
    const goals: THREE.Vector3[] = [];
    const intent = brain.decide(view({
      visual: null,
      heard: [gunshot(1, 12, 5)],
      nextWaypoint: routeSpy(goals, new THREE.Vector3(0.5, 0, 0)),
    }), DT);

    expect(intent.mode).toBe('route');
    expect(goals).toHaveLength(1);
    expect(goals[0]!.x).toBeCloseTo(12, 12);
    expect(goals[0]!.z).toBeCloseTo(5, 12);
    // The null focus is the whole shot gate: the executor can never match it
    // against an observation id, so nothing heard can authorize fire.
    expect(intent.focusId).toBeNull();
    expect(intent.wantShoot).toBe(false);
  });

  it('investigates the NEAREST gunshot, not the newest', () => {
    const brain = calmBrain();
    const goals: THREE.Vector3[] = [];
    const intent = brain.decide(view({
      visual: null,
      heard: [gunshot(2, 60, 0), gunshot(1, 5, 0)],
      nextWaypoint: routeSpy(goals, new THREE.Vector3(0.5, 0, 0)),
    }), DT);

    // The older event is 55 m closer to the listener at the origin, so it is
    // the adopted lead despite arriving first and sitting first in the batch.
    expect(intent.mode).toBe('route');
    expect(goals).toHaveLength(1);
    expect(goals[0]!.x).toBeCloseTo(5, 12);
  });

  it('copies the heard position: mutating the source cannot drift the goal', () => {
    const brain = calmBrain();
    const h = gunshot(1, 12, 5);
    const goals: THREE.Vector3[] = [];
    brain.decide(view({ visual: null, heard: [h], nextWaypoint: routeSpy(goals, new THREE.Vector3(0.5, 0, 0)) }), DT);
    h.pos.set(-99, -99, -99);
    brain.decide(view({ visual: null, nextWaypoint: routeSpy(goals, new THREE.Vector3(0.5, 0, 0)) }), DT);

    expect(goals[1]!.x).toBeCloseTo(12, 12);
    expect(goals[1]!.z).toBeCloseTo(5, 12);
  });

  it('looks at eye height ABOVE the heard spot, not at the ground', () => {
    const brain = calmBrain();
    const intent = brain.decide(view({
      visual: null,
      heard: [gunshot(1, 12, 0)],
      nextWaypoint: () => new THREE.Vector3(0.5, 0, 0),
    }), DT);
    // A noise leaves no eye to remember; 1.9 m above the spot is the bot eye
    // convention, and aiming at the floor 12 m out would read as a bug.
    expect(intent.lookAt!.x).toBeCloseTo(12, 12);
    expect(intent.lookAt!.y).toBeCloseTo(1.9, 12);
  });

  it('never orders a shot from a heard position, however willing the weapon', () => {
    const brain = eagerBrain();
    for (let f = 1; f <= 5; f++) {
      const intent = brain.decide(view({
        visual: null,
        // Inside engageRange, which changes nothing: range is not evidence.
        heard: f === 1 ? [gunshot(1, 5)] : [],
        nextWaypoint: () => new THREE.Vector3(0.5, 0, 0),
      }), DT);
      expect(intent.wantShoot, `frame ${f}`).toBe(false);
      expect(intent.focusId, `frame ${f}`).toBeNull();
    }
  });

  it('a visible opponent ignores sound entirely', () => {
    const brain = calmBrain();
    const goals: THREE.Vector3[] = [];
    const intent = brain.decide(view({
      dist: 10,
      heard: [gunshot(1, -40)],
      nextWaypoint: routeSpy(goals, new THREE.Vector3(0.5, 0, 0)),
    }), DT);

    expect(intent.mode).toBe('engage');
    expect(intent.focusId).toBe('player');
    // Nothing was routed anywhere: the noise was not adopted, not queued.
    expect(goals).toHaveLength(0);
  });

  it('an incoming-fire bearing outranks a same-frame noise', () => {
    const brain = calmBrain();
    brain.onIncomingFire(new THREE.Vector3(0, 0, -1));
    const intent = brain.decide(view({
      visual: null,
      heard: [gunshot(1, 40, 0)],
      nextWaypoint: () => new THREE.Vector3(0.5, 0, 0),
    }), DT);

    // The bearing wins, and that frame's noise is gone with the executor's
    // cursor — which is what keeps damage a DIRECTION rather than a place.
    expect(intent.mode).toBe('search');
    expect(intent.facing.z).toBeCloseTo(-1, 12);
    expect(intent.focusId).toBeNull();
  });

  it('a fresh noise does NOT replace an older visual memory', () => {
    const brain = calmBrain();
    brain.decide(view({ visual: visualAt(10) }), DT); // memory at (10,0,0)

    const goals: THREE.Vector3[] = [];
    brain.decide(view({ visual: null, nextWaypoint: routeSpy(goals, new THREE.Vector3(0.5, 0, 0)) }), DT);
    expect(goals[0]!.x).toBeCloseTo(10, 12);

    const intent = brain.decide(view({
      visual: null,
      heard: [gunshot(1, -20, 0)],
      nextWaypoint: routeSpy(goals, new THREE.Vector3(0.5, 0, 0)),
    }), DT);
    // Commitment wins: the visual-memory pursuit outranks the fresh noise,
    // which is discarded with the executor's cursor rather than queued.
    expect(goals[1]!.x).toBeCloseTo(10, 12);
    expect(intent.focusId).toBe('player');
    expect(intent.mode).toBe('route');
  });

  it('a fresh noise does NOT replace a previously heard pursuit', () => {
    const brain = calmBrain();
    const goals: THREE.Vector3[] = [];
    brain.decide(view({
      visual: null,
      heard: [gunshot(1, 20, 0)],
      nextWaypoint: routeSpy(goals, new THREE.Vector3(0.5, 0, 0)),
    }), DT);
    expect(goals[0]!.x).toBeCloseTo(20, 12);

    const intent = brain.decide(view({
      visual: null,
      heard: [gunshot(2, -20, 0)],
      nextWaypoint: routeSpy(goals, new THREE.Vector3(0.5, 0, 0)),
    }), DT);
    // Already travelling toward a heard goal: the later sound is ignored,
    // not queued behind it.
    expect(goals[1]!.x).toBeCloseTo(20, 12);
    expect(intent.focusId).toBeNull();
    expect(intent.mode).toBe('route');
  });

  it('a fresh noise does NOT interrupt an in-progress scan', () => {
    const brain = calmBrain();
    brain.onIncomingFire(new THREE.Vector3(1, 0, 0));
    brain.decide(view({ visual: null }), DT); // search entered

    const goals: THREE.Vector3[] = [];
    const intent = brain.decide(view({
      visual: null,
      heard: [footstep(1, 0, 9)],
      nextWaypoint: routeSpy(goals, new THREE.Vector3(0.5, 0, 0)),
    }), DT);

    // The active search owns the bot: the noise is discarded, the graph is
    // never asked for the heard point, and the scan heading holds.
    expect(intent.mode).toBe('search');
    expect(goals).toHaveLength(0);
    expect(intent.facing.x).toBeCloseTo(1, 12);
    expect(intent.facing.z).toBeCloseTo(0, 12);
  });

  it('arrives, scans, then forgets to hold — the same pipeline memory uses', () => {
    const brain = calmBrain();
    // Within memoryArrivalRadius (1 m) of the bot at the origin: arrival is
    // immediate, so no route is ever asked for.
    const arrived = brain.decide(view({ visual: null, heard: [gunshot(1, 0.5, 0)] }), DT);
    expect(arrived.mode).toBe('search');

    // forgetTime is 8 s from search ENTRY, and the entry frame itself accrues
    // nothing. A quarter-second step is exact in binary, so 32 frames is
    // exactly 8 s with no accumulated drift to hide the boundary.
    const STEP = 0.25;
    const frames = DEFAULT_BRAIN_PARAMS.forgetTime / STEP; // 32
    let intent = arrived;
    for (let f = 1; f < frames; f++) {
      intent = brain.decide(view({ visual: null }), STEP);
    }
    expect(intent.mode).toBe('search');
    intent = brain.decide(view({ visual: null }), STEP);
    expect(intent.mode).toBe('hold');
    expect(intent.focusId).toBeNull();
  });

  it('respawn drops a heard goal: the next silent frame patrols, not routes', () => {
    const brain = calmBrain();
    brain.decide(view({ visual: null, heard: [gunshot(1, 20, 0)], nextWaypoint: () => new THREE.Vector3(0.5, 0, 0) }), DT);
    brain.onRespawn();

    const goals: THREE.Vector3[] = [];
    const intent = brain.decide(view({ visual: null, nextWaypoint: routeSpy(goals, new THREE.Vector3(0.5, 0, 0)) }), DT);
    // The one-second patrol pause is what a fresh life starts in.
    expect(intent.mode).toBe('hold');
    expect(goals).toHaveLength(0);
  });

  it('sound outranks patrol: a noise ends the stand-down immediately', () => {
    const brain = calmBrain();
    let patrolAsked = 0;
    const goals: THREE.Vector3[] = [];
    const intent = brain.decide(view({
      visual: null,
      heard: [footstep(1, 6, 0)],
      nextWaypoint: routeSpy(goals, new THREE.Vector3(0.5, 0, 0)),
      nextPatrolWaypoint: () => { patrolAsked++; return new THREE.Vector3(0, 0, 4); },
    }), DT);

    expect(intent.mode).toBe('route');
    expect(goals[0]!.x).toBeCloseTo(6, 12);
    expect(patrolAsked).toBe(0);
  });
});

describe('DefaultBrain patrol', () => {
  it('waits one second after spawn before the first patrol request', () => {
    let asked = 0;
    const brain = calmBrain();
    const v = view({ visual: null, nextPatrolWaypoint: () => { asked++; return new THREE.Vector3(4, 0, 0); } });
    for (let f = 1; f <= 3; f++) {
      expect(brain.decide(v, 0.25).mode, `frame ${f}`).toBe('hold');
    }
    expect(asked).toBe(0); // the graph is never asked during the pause
    const walked = brain.decide(v, 0.25);
    expect(walked.mode).toBe('patrol'); // the pause ends; the request fires
    expect(walked.step.length()).toBeCloseTo(4 * 0.25, 12);
  });

  it('travels the patrol waypoint at normal speed, never shooting, null focus', () => {
    let asked = 0;
    const brain = calmBrain();
    const v = view({
      visual: null,
      nextPatrolWaypoint: () => { asked++; return new THREE.Vector3(3, 0, 4); },
    });
    for (let f = 1; f <= 4; f++) {
      const intent = brain.decide(v, 0.25);
      if (f < 4) expect(intent.mode, `frame ${f}`).toBe('hold');
    }
    expect(asked).toBe(1); // lazily asked exactly once — on the frame the pause ended
    const walked = brain.decide(v, 0.25);
    expect(walked.mode).toBe('patrol');
    expect(walked.wantShoot).toBe(false);
    expect(walked.focusId).toBeNull();
    // Normal travel speed, planar: (3,4)/5 · speed · dt.
    expect(walked.step.length()).toBeCloseTo(4 * 0.25, 12);
    expect(walked.step.x).toBeCloseTo(0.6 * 4 * 0.25, 12);
    expect(walked.step.z).toBeCloseTo(0.8 * 4 * 0.25, 12);
    // Looking one metre along the next waypoint at eye height.
    expect(walked.lookAt!.x).toBeCloseTo(0.6, 12);
    expect(walked.lookAt!.y).toBeCloseTo(1.9, 12);
    expect(walked.lookAt!.z).toBeCloseTo(0.8, 12);
  });

  it('a deferred budget keeps the bot in patrol without moving or re-asking', () => {
    const brain = calmBrain();
    const walking = view({
      visual: null,
      nextPatrolWaypoint: () => new THREE.Vector3(0.5, 0, 0),
    });
    for (let f = 1; f <= 4; f++) brain.decide(walking, 0.25); // pause spent on frame 4
    expect(brain.decide(walking, 0.25).mode).toBe('patrol'); // walking the leg
    let asked = 0;
    const intent = brain.decide(view({
      visual: null,
      nextPatrolWaypoint: () => { asked++; return undefined; },
    }), 0.25);
    expect(intent.mode).toBe('patrol');
    expect(intent.step.length()).toBe(0);
    expect(intent.wantShoot).toBe(false);
    expect(asked).toBe(1); // asked once, exactly like the walking leg above
    // Facing preserved, no endpoint to expose.
    expect(intent.lookAt).toBeNull();
    expect(intent.facing.x).toBeCloseTo(1, 12);
  });

  it('a null patrol answer restarts the one-second pause', () => {
    let asked = 0;
    const brain = calmBrain();
    for (let f = 1; f <= 4; f++) {
      brain.decide(view({ visual: null, nextPatrolWaypoint: () => { asked++; return null; } }), 0.25);
    }
    expect(asked).toBe(1);
    for (let f = 1; f <= 4; f++) {
      const intent = brain.decide(view({
        visual: null,
        nextPatrolWaypoint: () => { asked++; return null; },
      }), 0.25);
      expect(intent.mode, `restart frame ${f}`).toBe('hold');
    }
    expect(asked).toBe(2); // one fresh request after the full pause
  });

  it('search expiry stands down one second before the first patrol request', () => {
    const brain = calmBrain();
    brain.decide(view({ visual: visualAt(10) }), DT);
    // Enter a search via a confirmed dead end, then run out the 8 s forget.
    brain.decide(view({ visual: null, nextWaypoint: () => null }), 0.25);
    for (let f = 1; f <= 31; f++) brain.decide(view({ visual: null }), 0.25);
    const expired = brain.decide(view({ visual: null }), 0.25); // elapsed 8 s
    expect(expired.mode).toBe('hold');
    // The pause now gates the next patrol request for one more second.
    let asked = 0;
    for (let f = 1; f <= 3; f++) {
      expect(brain.decide(view({ visual: null, nextPatrolWaypoint: () => { asked++; return null; } }), 0.25).mode).toBe('hold');
    }
    expect(asked).toBe(0);
    const entered = brain.decide(view({ visual: null, nextPatrolWaypoint: () => new THREE.Vector3(0, 0, 4) }), 0.25);
    expect(entered.mode).toBe('patrol');
  });

  it('a memory-arrival search scans in place and never advances', () => {
    const brain = calmBrain();
    brain.decide(view({ visual: visualAt(1) }), DT); // memory exactly at the arrival radius
    const entry = brain.decide(view({
      visual: null,
      nextWaypoint: () => null,
      nextPatrolWaypoint: () => new THREE.Vector3(0, 0, 4), // irrelevant: arrival precedes the ask
    }), DT);
    expect(entry.mode).toBe('search');
    expect(entry.step.length()).toBe(0); // no advance outside a damage search
    expect(brain.decide(view({ visual: null }), 0.25).step.length()).toBe(0);
  });

  it('a visual interrupting patrol takes priority and the leg never returns', () => {
    const brain = calmBrain();
    const walking = view({
      visual: null,
      nextPatrolWaypoint: () => new THREE.Vector3(0.5, 0, 0),
    });
    for (let f = 1; f <= 4; f++) {
      brain.decide(walking, 0.25);
    }
    const walked = brain.decide(walking, 0.25);
    expect(walked.mode).toBe('patrol');
    expect(walked.wantShoot).toBe(false);
    expect(walked.lookAt).not.toBeNull(); // intent faces one metre along the waypoint
    // A visual lands: patrol loses immediately.
    const seen = brain.decide(view({ visual: visualAt(10) }), 0.25);
    expect(seen.mode).toBe('engage');
    expect(seen.focusId).toBe('player');
    expect(brain.focusId).toBe('player');
  });

  it('onRespawn re-arms the full one-second patrol pause', () => {
    const brain = calmBrain();
    for (let f = 1; f <= 4; f++) brain.decide(view({ visual: null }), 0.25); // pause spent, patrolling
    brain.onRespawn();
    let asked = 0;
    for (let f = 1; f <= 3; f++) {
      expect(brain.decide(view({
        visual: null,
        nextPatrolWaypoint: () => { asked++; return new THREE.Vector3(4, 0, 0); },
      }), 0.25).mode, `respawned frame ${f}`).toBe('hold');
    }
    expect(asked).toBe(0);
  });
});

describe('DefaultBrain damage advance', () => {
  const HALF_DT = 0.5; // whole-half frames: the 3 s boundary is exact


  /** Enter a damage search whose base bearing is due +x. */
  function advanceBrain(): { brain: DefaultBrain; entry: ReturnType<DefaultBrain['decide']> } {
    const brain = calmBrain();
    brain.onIncomingFire(new THREE.Vector3(1, 0, 0));
    return { brain, entry: brain.decide(view({ visual: null }), HALF_DT) };
  }

  it('the damage frame itself requests normal-speed movement along the bearing', () => {
    const { entry } = advanceBrain();
    expect(entry.mode).toBe('search');
    expect(entry.step.x).toBeCloseTo(4 * HALF_DT, 12);
    expect(entry.step.y).toBe(0);
    expect(entry.step.z).toBeCloseTo(0, 12);
    // ...while still facing the scan heading (the base bearing at elapsed 0).
    expect(entry.facing.x).toBeCloseTo(1, 12);
  });

  it('advances strictly before three seconds and stands at the boundary', () => {
    const { brain, entry } = advanceBrain();
    expect(entry.step.length()).toBeGreaterThan(0);
    // Frames at elapsed 0.5 … 2.5 still advance; 3.0 is the boundary.
    for (let f = 1; f <= 5; f++) {
      const intent = brain.decide(view({ visual: null }), 0.5);
      expect(intent.step.x, `advance frame ${f}`).toBeCloseTo(4 * 0.5, 12);
      expect(intent.mode).toBe('search');
    }
    const boundary = brain.decide(view({ visual: null }), 0.5);
    expect(boundary.step.length()).toBe(0); // 3.0 s elapsed: advance closed
    expect(boundary.mode).toBe('search');
  });

  it('faces the rotating scan headings while advancing, cadence intact', () => {
    const { brain } = advanceBrain();
    const f1 = brain.decide(view({ visual: null }), 0.75); // elapsed 0.75: heading +120°
    // The step stays on the STORED base bearing while the heading rotates.
    expect(f1.step.x).toBeCloseTo(4 * 0.75, 12);
    expect(f1.step.z).toBeCloseTo(0, 12);
    // +120°: (1,0,0) → (cos120°, 0, −sin120°)
    expect(f1.facing.x).toBeCloseTo(-0.5, 12);
    expect(f1.facing.z).toBeCloseTo(-Math.sqrt(3) / 2, 12);
  });

  it('a blocked step cancels only the advance; the scan finishes standing', () => {
    const { brain } = advanceBrain();
    brain.decide(view({ visual: null, moveBlocked: true }), 0.75); // blocked: advance cut
    const after = brain.decide(view({ visual: null }), 0.75);
    expect(after.mode).toBe('search');
    expect(after.step.length()).toBe(0); // no replanning — advance stays cut
  });

  it('a block inherited from before the hit does not suppress the entry step', () => {
    // moveBlocked describes LAST frame's step. On the entry frame that step
    // belonged to whatever the bot was doing before the hit — a patrol or
    // combat move — so it is not evidence the new advance is blocked: the
    // first damage frame must still request normal-speed movement.
    const brain = calmBrain();
    brain.onIncomingFire(new THREE.Vector3(1, 0, 0));
    const entry = brain.decide(view({ visual: null, moveBlocked: true }), 0.5);
    expect(entry.mode).toBe('search');
    expect(entry.step.x).toBeCloseTo(4 * 0.5, 12); // entry step NOT suppressed
    // The NEXT decision reports on the entry step itself — an advance step —
    // so a block there cancels the remainder of this search's advance.
    const next = brain.decide(view({ visual: null, moveBlocked: true }), 0.5);
    expect(next.mode).toBe('search');
    expect(next.step.length()).toBe(0);
    const after = brain.decide(view({ visual: null }), 0.5);
    expect(after.step.length()).toBe(0); // stays cut for this search
  });

  it('incoming damage interrupts an already-active patrol', () => {
    let patrolAsked = 0;
    const brain = calmBrain();
    const walking = view({
      visual: null,
      nextPatrolWaypoint: () => { patrolAsked++; return new THREE.Vector3(0.5, 0, 0); },
    });
    for (let f = 1; f <= 5; f++) brain.decide(walking, 0.25); // pause spent, leg walking
    expect(patrolAsked).toBeGreaterThanOrEqual(1);

    // A direction-only hit lands mid-leg: the bearing outranks the patrol.
    brain.onIncomingFire(new THREE.Vector3(1, 0, 0));
    const hit = brain.decide(view({ visual: null }), 0.25);
    expect(hit.mode).toBe('search');
    expect(hit.wantShoot).toBe(false);
    expect(hit.focusId).toBeNull();
    // The damage frame advances along the bearing, not the patrol leg.
    expect(hit.step.x).toBeCloseTo(4 * 0.25, 12);
    expect(hit.step.z).toBeCloseTo(0, 12);

    // The leg never resumes: the damage search runs its course instead, and
    // the patrol graph is not consulted for the rest of it.
    const askedAtHit = patrolAsked;
    for (let f = 1; f <= 4; f++) {
      expect(brain.decide(view({ visual: null }), 0.25).mode, `search frame ${f}`).toBe('search');
    }
    expect(patrolAsked).toBe(askedAtHit);
  });

  it('a later hit restarts the eight-second search and a fresh advance window', () => {
    const { brain } = advanceBrain();
    // The advance was cancelled by a blocked step one half-second in.
    brain.decide(view({ visual: null, moveBlocked: true }), 0.5);
    brain.decide(view({ visual: null }), 0.5);
    // A new bearing resets BOTH clocks: fresh 8 s search, fresh 3 s window.
    brain.onIncomingFire(new THREE.Vector3(-1, 0, 0));
    const fresh = brain.decide(view({ visual: null }), 0.5);
    expect(fresh.mode).toBe('search');
    expect(fresh.facing.x).toBeCloseTo(-1, 12); // the newest bearing
    expect(fresh.step.x).toBeCloseTo(-4 * 0.5, 12); // advancing again, new direction
    // The scan cadence restarted with it: one full scan phase later the
    // heading is the base rotated +120° — impossible unless elapsed restarted.
    const cadence = brain.decide(view({ visual: null }), 0.75);
    expect(cadence.facing.x).toBeCloseTo(0.5, 12);
    expect(cadence.facing.z).toBeCloseTo(Math.sqrt(3) / 2, 12);

    // The eight-second LIFETIME restarted too, not just the phase: elapsed
    // stood at 1.0 s when the new bearing landed (the re-hit entry frame
    // itself does not age it), so without the restart the search would forget
    // after only 6.25 more seconds — the 13th of these frames. With it,
    // elapsed after the cadence frame is 0.75 s, frames 1–14 (elapsed
    // 1.25…7.75) still search and only the 15th (8.25 s from the re-hit)
    // forgets.
    for (let f = 1; f <= 14; f++) {
      expect(brain.decide(view({ visual: null }), 0.5).mode, `lifetime frame ${f}`).toBe('search');
    }
    expect(brain.decide(view({ visual: null }), 0.5).mode).toBe('hold');
  });

  it('never fires during the advance without visual acquisition', () => {
    const brain = eagerBrain(); // the weapon is always willing
    brain.onIncomingFire(new THREE.Vector3(1, 0, 0));
    for (let f = 0; f < 5; f++) {
      expect(brain.decide(view({ visual: null }), 0.5).wantShoot, `frame ${f}`).toBe(false);
    }
  });

  it('expires into hold at the ordinary eight seconds, advance or not', () => {
    const { brain } = advanceBrain();
    // Entry + 31 frames of 0.25 s = 8.0 s: the last one forgets.
    expect(brain.decide(view({ visual: null }), 0.25).mode).toBe('search'); // elapsed 0.25
    for (let f = 2; f <= 31; f++) {
      expect(brain.decide(view({ visual: null }), 0.25).mode, `search frame ${f}`).toBe('search');
    }
    expect(brain.decide(view({ visual: null }), 0.25).mode).toBe('hold');
  });
});

describe('DefaultBrain domination objective', () => {
  const flag = { id: 'B', pos: new THREE.Vector3(0, 0, 20), radius: 4.5 };

  it('routes to the assigned flag when nothing outranks it', () => {
    const brain = calmBrain();
    const intent = brain.decide(view({
      visual: null,
      objective: flag,
      nextWaypoint: () => new THREE.Vector3(0, 0, 1),
    }), DT);
    expect(intent.mode).toBe('objective');
    expect(intent.wantShoot).toBe(false);
    expect(intent.focusId).toBeNull();
    expect(intent.step.length()).toBeGreaterThan(0);
  });

  it('captures on arrival: works the ring, watches, never shoots', () => {
    const brain = calmBrain();
    const close = { id: 'B', pos: new THREE.Vector3(0, 0, 1), radius: 4.5 };
    const first = brain.decide(view({ visual: null, objective: close }), DT);
    expect(first.mode).toBe('capture');
    // Drift, not statue stillness: a small fraction of travel speed.
    expect(first.step.length()).toBeCloseTo(4 * 0.35 * DT, 12);
    expect(first.wantShoot).toBe(false);
    // The watch rotates: a later frame faces elsewhere.
    const later = brain.decide(view({ visual: null, objective: close }), 2);
    expect(later.mode).toBe('capture');
    expect(later.facing.x).not.toBeCloseTo(first.facing.x, 2);
  });

  it('a bot a floor below its flag keeps routing instead of capturing', () => {
    // Elevation's B at deck height, the bot planar-inside the hold circle
    // but on the ground floor 3.6 m below: the census (isBodyInRing) does
    // not count it, so the brain must not capture-spot it either — or it
    // would hold a point it can never tick and never climb the stairs.
    const deck = { id: 'B', pos: new THREE.Vector3(0, 3.6, 1), radius: 4.5 };
    const brain = calmBrain();
    const intent = brain.decide(view({
      visual: null,
      objective: deck,
      selfFeet: new THREE.Vector3(0, 0, 0),
      nextWaypoint: () => new THREE.Vector3(0, 0, 1),
    }), DT);
    expect(intent.mode).toBe('objective');
    expect(intent.step.length()).toBeGreaterThan(0);
  });

  it('a bot on the flag deck captures: the vertical window binds both ways', () => {
    const deck = { id: 'B', pos: new THREE.Vector3(0, 3.6, 1), radius: 4.5 };
    const brain = calmBrain();
    const intent = brain.decide(view({
      visual: null,
      objective: deck,
      selfFeet: new THREE.Vector3(0, 3.6, 0),
    }), DT);
    expect(intent.mode).toBe('capture');
  });

  it('a below-deck holder-rank bot does not take the flag-hold branch', () => {
    // holdRank 0 planar-inside but a floor down, WITH cover (a mate holds):
    // isCapping is false, so the designated-holder shortcut in decide()
    // must not fire — the bearing owns this escort like any TDM bot and
    // starts a damage search, not a leashed dodge in `capture` mode.
    const deck = { id: 'B', pos: new THREE.Vector3(0, 3.6, 1), radius: 4.5, cappingMates: 1, holdRank: 0 };
    const brain = calmBrain();
    brain.onIncomingFire(new THREE.Vector3(1, 0, 0));
    const intent = brain.decide(view({
      visual: null,
      objective: deck,
      selfFeet: new THREE.Vector3(0, 0, 0),
      nextWaypoint: () => new THREE.Vector3(0, 0, 1),
    }), DT);
    expect(intent.mode).toBe('search');
  });

  it('a visual outranks the objective and the bot walks back after', () => {
    const brain = calmBrain();
    const seen = brain.decide(view({ dist: 10, objective: flag }), DT);
    expect(seen.mode).toBe('engage');
    const back = brain.decide(view({
      visual: null,
      objective: flag,
      nextWaypoint: () => new THREE.Vector3(0, 0, 1),
    }), DT);
    // Sight loss with an objective does NOT pursue the memory: priority 5
    // drops the remembered ghost and walks back to the flag, so `route` is
    // unreachable here and accepting it would hide the priority regressing.
    expect(back.mode).toBe('objective');
  });

  it('hearing never pulls a bot off its flag', () => {
    const brain = calmBrain();
    const noise = { seq: 1, t: 0, kind: 'gunshot' as const, pos: new THREE.Vector3(5, 0, 0) };
    const intent = brain.decide(view({
      visual: null,
      objective: flag,
      heard: [noise],
      nextWaypoint: () => new THREE.Vector3(0, 0, 1),
      nextPatrolWaypoint: () => new THREE.Vector3(0, 0, 1),
    }), DT);
    expect(intent.mode).toBe('objective');
  });

  it('an unreachable flag holds facing it instead of searching away', () => {
    const brain = calmBrain();
    for (let f = 0; f < 3; f++) {
      const intent = brain.decide(view({
        visual: null,
        objective: flag,
        nextWaypoint: () => null,
      }), 0.5);
      expect(intent.mode).toBe('objective');
      expect(intent.step.length()).toBe(0);
    }
  });

  it('sight loss with an objective skips the memory pursuit', () => {
    const brain = calmBrain();
    expect(brain.decide(view({ dist: 10 }), DT).mode).toBe('engage');
    // No memory route: straight back to the flag.
    const back = brain.decide(view({
      visual: null,
      objective: flag,
      nextWaypoint: () => new THREE.Vector3(0, 0, 1),
    }), DT);
    expect(back.mode).toBe('objective');
    // And the ghost is dropped, not shelved: with no objective the next
    // frame holds instead of routing to the remembered position.
    expect(brain.decide(view({ visual: null }), DT).mode).toBe('hold');
  });

  it('an ordinary scan yields to the objective and forgets the ghost', () => {
    const brain = calmBrain();
    brain.decide(view({ dist: 10 }), DT);
    // Dead end on the memory route: an ordinary (non-damage) search begins.
    const searching = brain.decide(view({ visual: null, nextWaypoint: () => null }), DT);
    expect(searching.mode).toBe('search');
    const preempted = brain.decide(view({
      visual: null,
      objective: flag,
      nextWaypoint: () => new THREE.Vector3(0, 0, 1),
    }), DT);
    expect(preempted.mode).toBe('objective');
    // The scan and the memory behind it are gone: no objective means the
    // patrol pause, not a resumed search.
    expect(brain.decide(view({ visual: null }), DT).mode).toBe('hold');
  });

  it('a damage-armed search keeps priority over the objective while covered', () => {
    // An escort (a mate already holding) hunts bearings like a TDM bot:
    // being shot at matters more than standing orders.
    const covered = { ...flag, cappingMates: 1 };
    const brain = calmBrain();
    brain.onIncomingFire(new THREE.Vector3(1, 0, 0));
    expect(brain.decide(view({ visual: null }), DT).mode).toBe('search');
    const reacting = brain.decide(view({
      visual: null,
      objective: covered,
      nextWaypoint: () => new THREE.Vector3(0, 0, 1),
    }), DT);
    expect(reacting.mode).toBe('search');
  });

  it('an uncovered pusher drops the bearing and walks on', () => {
    // Nobody holds the flag (mates default to zero): potshots must not kite
    // the push off the point. Facing stays on the flag, not the bearing.
    const brain = calmBrain();
    brain.onIncomingFire(new THREE.Vector3(-1, 0, 0));
    const intent = brain.decide(view({
      visual: null,
      objective: flag,
      nextWaypoint: () => new THREE.Vector3(0, 0, 1),
    }), DT);
    expect(intent.mode).toBe('objective');
    expect(intent.step.length()).toBeGreaterThan(0);
    // The bearing is consumed, not shelved: the next frame walks on too.
    const next = brain.decide(view({
      visual: null,
      objective: flag,
      nextWaypoint: () => new THREE.Vector3(0, 0, 1),
    }), DT);
    expect(next.mode).toBe('objective');
  });

  it('an uncovered pusher drops an ongoing damage search and walks back', () => {
    const brain = calmBrain();
    brain.onIncomingFire(new THREE.Vector3(1, 0, 0));
    expect(brain.decide(view({ visual: null }), DT).mode).toBe('search');
    const back = brain.decide(view({
      visual: null,
      objective: flag,
      nextWaypoint: () => new THREE.Vector3(0, 0, 1),
    }), DT);
    expect(back.mode).toBe('objective');
    // And the search behind it is gone: with no objective the next frame
    // holds instead of resuming the scan.
    expect(brain.decide(view({ visual: null }), DT).mode).toBe('hold');
  });

  it('a capper answers a bearing with a sidestep, never a scan', () => {
    // Bearing due +x, strafe +1: the dodge runs perpendicular at full speed.
    const close = { id: 'B', pos: new THREE.Vector3(0, 0, 1), radius: 4.5 };
    const brain = calmBrain();
    brain.onIncomingFire(new THREE.Vector3(1, 0, 0));
    const intent = brain.decide(view({ visual: null, objective: close }), DT);
    expect(intent.mode).toBe('capture');
    expect(intent.step.x).toBeCloseTo(0, 12);
    expect(intent.step.z).toBeCloseTo(4 * DT, 12);
    expect(intent.wantShoot).toBe(false);
  });

  it('the dodge expires back to drift after its window', () => {
    const close = { id: 'B', pos: new THREE.Vector3(0, 0, 1), radius: 4.5 };
    const brain = calmBrain();
    brain.onIncomingFire(new THREE.Vector3(1, 0, 0));
    brain.decide(view({ visual: null, objective: close }), DT); // entry dodges
    // The 0.5 s window is 30 frames: frames 2..30 still sidestep at speed.
    for (let f = 2; f <= 30; f++) {
      const intent = brain.decide(view({ visual: null, objective: close }), DT);
      expect(intent.mode, `frame ${f}`).toBe('capture');
      expect(intent.step.length(), `frame ${f}`).toBeCloseTo(4 * DT, 9);
    }
    // ...then the drift resumes — polling past one frame of float residue,
    // since 30 × (1/60) never lands exactly on the 0.5 s boundary.
    let after = brain.decide(view({ visual: null, objective: close }), DT);
    if (Math.abs(after.step.length() - 4 * DT) < 1e-9) {
      after = brain.decide(view({ visual: null, objective: close }), DT);
    }
    expect(after.mode).toBe('capture');
    expect(after.step.length()).toBeCloseTo(4 * 0.35 * DT, 9);
  });

  it('a blocked dodge step cancels the rest, but never the entry sidestep', () => {
    // moveBlocked reports on the PREVIOUS step: the entry frame's belonged to
    // whatever came before the hit, so the first sidestep always moves — the
    // same contract the damage advance keeps.
    const close = { id: 'B', pos: new THREE.Vector3(0, 0, 1), radius: 4.5 };
    const brain = calmBrain();
    brain.onIncomingFire(new THREE.Vector3(1, 0, 0));
    const entry = brain.decide(view({ visual: null, objective: close, moveBlocked: true }), DT);
    expect(entry.mode).toBe('capture');
    expect(entry.step.z).toBeCloseTo(4 * DT, 12);
    // The NEXT block describes the dodge step itself: dodge cut, drift resumes.
    const next = brain.decide(view({ visual: null, objective: close, moveBlocked: true }), DT);
    expect(next.mode).toBe('capture');
    expect(next.step.length()).toBeCloseTo(4 * 0.35 * DT, 9);
  });

  it('onRespawn clears an armed dodge', () => {
    const close = { id: 'B', pos: new THREE.Vector3(0, 0, 1), radius: 4.5 };
    const brain = calmBrain();
    brain.onIncomingFire(new THREE.Vector3(1, 0, 0));
    brain.decide(view({ visual: null, objective: close }), DT); // dodging
    brain.onRespawn();
    const intent = brain.decide(view({ visual: null, objective: close }), DT);
    expect(intent.mode).toBe('capture');
    expect(intent.step.length()).toBeCloseTo(4 * 0.35 * DT, 9);
  });

  it('drift never walks the holder out of the hold circle', () => {
    // Ten quiet seconds with the feet integrated by the test: still capping,
    // still inside, and actually displaced rather than vibrating in place.
    const close = { id: 'B', pos: new THREE.Vector3(0, 0, 1), radius: 4.5 };
    const brain = calmBrain();
    const feet = new THREE.Vector3(0, 0, 1);
    let travelled = 0;
    for (let f = 0; f < 600; f++) {
      const v = view({ visual: null, objective: close });
      v.selfFeet.copy(feet);
      const intent = brain.decide(v, DT);
      expect(intent.mode, `frame ${f}`).toBe('capture');
      feet.add(intent.step);
      travelled += intent.step.length();
      expect(Math.hypot(feet.x - 0, feet.z - 1), `frame ${f}`)
        .toBeLessThanOrEqual(4.5 * 0.7 + 1e-9);
    }
    expect(travelled).toBeGreaterThan(1);
  });

  it('bearing spam never dodges the holder out of the hold circle', () => {
    // A fresh bearing every frame: perpetual full-speed dodging, still leashed.
    const close = { id: 'B', pos: new THREE.Vector3(0, 0, 1), radius: 4.5 };
    const brain = calmBrain();
    const feet = new THREE.Vector3(0, 0, 1);
    const bearings = [
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(-1, 0, 0),
      new THREE.Vector3(0, 0, -1),
    ];
    for (let f = 0; f < 600; f++) {
      brain.onIncomingFire(bearings[f % 4]!);
      const v = view({ visual: null, objective: close });
      v.selfFeet.copy(feet);
      const intent = brain.decide(v, DT);
      expect(intent.mode, `frame ${f}`).toBe('capture');
      feet.add(intent.step);
      expect(Math.hypot(feet.x - 0, feet.z - 1), `frame ${f}`)
        .toBeLessThanOrEqual(4.5 * 0.7 + 1e-9);
    }
  });

  it('a capper drops an ongoing damage search instead of serving it', () => {
    const close = { id: 'B', pos: new THREE.Vector3(0, 0, 1), radius: 4.5 };
    const brain = calmBrain();
    brain.onIncomingFire(new THREE.Vector3(1, 0, 0));
    expect(brain.decide(view({ visual: null }), DT).mode).toBe('search');
    // Reaching the point mid-search ends the search: the ring owns the bot,
    // which drifts rather than stands.
    const held = brain.decide(view({ visual: null, objective: close }), DT);
    expect(held.mode).toBe('capture');
    expect(held.step.length()).toBeCloseTo(4 * 0.35 * DT, 12);
  });

  it('a capper shoots a visual on the move instead of leaving to engage', () => {
    const close = { id: 'B', pos: new THREE.Vector3(0, 0, 1), radius: 4.5 };
    const fire = new StubFire();
    fire.readyNow = true;
    const brain = brainOf(DEFAULT_BRAIN_PARAMS, calmRng, fire);
    const intent = brain.decide(view({ visual: visualAt(10), objective: close }), DT);
    expect(intent.mode).toBe('capture');
    expect(intent.step.length()).toBeCloseTo(4 * 0.35 * DT, 12);
    expect(intent.wantShoot).toBe(true);
    expect(intent.focusId).toBe('player');
    expect(intent.lookAt!.x).toBeCloseTo(10, 12);
    expect(fire.pulls).toBe(1);
  });

  it('a holder shoots while dodging a bearing', () => {
    const close = { id: 'B', pos: new THREE.Vector3(0, 0, 1), radius: 4.5 };
    const fire = new StubFire();
    fire.readyNow = true;
    const brain = brainOf(DEFAULT_BRAIN_PARAMS, calmRng, fire);
    brain.onIncomingFire(new THREE.Vector3(1, 0, 0));
    const intent = brain.decide(view({ visual: visualAt(10), objective: close }), DT);
    expect(intent.mode).toBe('capture');
    expect(intent.wantShoot).toBe(true);
    // Full-speed sidestep under fire, not the drift.
    expect(intent.step.length()).toBeCloseTo(4 * DT, 9);
    expect(fire.pulls).toBe(1);
  });

  it('a holder drops the focus when the sighting is lost', () => {
    // A focus outliving its sighting blinds the bot: the executor spends its
    // one LOS ray per frame on the focused candidate and probes nobody else
    // when that look fails (perception.ts:acquireVisual), so a target that
    // steps behind cover would hide every other attacker behind it.
    const close = { id: 'B', pos: new THREE.Vector3(0, 0, 1), radius: 4.5 };
    const brain = calmBrain();
    const seen = brain.decide(view({ visual: visualAt(10), objective: close }), DT);
    expect(seen.mode).toBe('capture');
    expect(brain.focusId).toBe('player');
    const lost = brain.decide(view({ visual: null, objective: close }), DT);
    expect(lost.mode).toBe('capture');
    expect(lost.focusId).toBeNull();
    expect(brain.focusId).toBeNull();
  });

  it('a dodge does not outlive the hold that armed it', () => {
    // The dodge clock is only spent on the hold path, so a bot that stops
    // holding mid-dodge must lose it rather than freeze it — otherwise the
    // leftover sidestep fires the next time it caps, from a stale bearing.
    const close = { id: 'B', pos: new THREE.Vector3(0, 0, 1), radius: 4.5 };
    const brain = calmBrain();
    brain.onIncomingFire(new THREE.Vector3(1, 0, 0));
    const dodging = brain.decide(view({ visual: null, objective: close }), DT);
    expect(dodging.step.length()).toBeCloseTo(4 * DT, 12); // full-speed sidestep
    // One frame away from the point (no objective at all), then back on it.
    brain.decide(view({ visual: null, nextPatrolWaypoint: () => null }), DT);
    const back = brain.decide(view({ visual: null, objective: close }), DT);
    expect(back.mode).toBe('capture');
    expect(back.step.length()).toBeCloseTo(4 * 0.35 * DT, 12); // the drift, not a dodge
  });

  it('a capper holds fire beyond engage range but still holds the ring', () => {
    const close = { id: 'B', pos: new THREE.Vector3(0, 0, 1), radius: 4.5 };
    const brain = eagerBrain(); // the weapon is always willing
    const intent = brain.decide(view({ visual: visualAt(10, 0, 50), objective: close }), DT);
    expect(intent.mode).toBe('capture');
    expect(intent.step.length()).toBeCloseTo(4 * 0.35 * DT, 12);
    expect(intent.wantShoot).toBe(false);
    // ...while still tracking the contact for acquisition and the readout.
    expect(intent.focusId).toBe('player');
  });

  it('the holder keeps holding while higher ranks are present', () => {
    // Rank 0 is the designation, not solitude: cover present changes nothing
    // for the holder — here mid-dodge, still on the point.
    const close = { id: 'B', pos: new THREE.Vector3(0, 0, 1), radius: 4.5, cappingMates: 2, holdRank: 0 };
    const brain = calmBrain();
    brain.onIncomingFire(new THREE.Vector3(1, 0, 0));
    const intent = brain.decide(view({ visual: null, objective: close }), DT);
    expect(intent.mode).toBe('capture');
    expect(intent.step.length()).toBeCloseTo(4 * DT, 12);
  });

  it('a non-holder standing the ring escorts: bearings own it like cover', () => {
    // Rank 1 with a mate holding: the damage search outranks the point, and
    // the bot leaves the ring to serve it instead of sitting beside the holder.
    const close = { id: 'B', pos: new THREE.Vector3(0, 0, 1), radius: 4.5, cappingMates: 1, holdRank: 1 };
    const brain = calmBrain();
    brain.onIncomingFire(new THREE.Vector3(1, 0, 0));
    const intent = brain.decide(view({ visual: null, objective: close }), DT);
    expect(intent.mode).toBe('search');
    expect(intent.step.length()).toBeGreaterThan(0);
  });

  it('a non-holder standing the ring engages a visual instead of holding', () => {
    const close = { id: 'B', pos: new THREE.Vector3(0, 0, 1), radius: 4.5, cappingMates: 1, holdRank: 1 };
    const intent = calmBrain().decide(view({ visual: visualAt(10), objective: close }), DT);
    expect(intent.mode).toBe('engage');
    expect(intent.focusId).toBe('player');
  });

  it('a non-holder idles on the point when nothing live happens', () => {
    // No bearing, no visual: the normal ladder reaches priority 5, which
    // returns the same drifting capture hold — presence still ticks while
    // idle, and the next live contact peels it off.
    const close = { id: 'B', pos: new THREE.Vector3(0, 0, 1), radius: 4.5, cappingMates: 1, holdRank: 1 };
    const intent = calmBrain().decide(view({ visual: null, objective: close }), DT);
    expect(intent.mode).toBe('capture');
    expect(intent.step.length()).toBeCloseTo(4 * 0.35 * DT, 12);
    expect(intent.wantShoot).toBe(false);
  });
});
