// botBrains.ts — bot decision policies as an engine-free seam.
//
// Division of labor with the concrete Bot (bots.ts): a BotBrain DECIDES,
// the Bot EXECUTES. Each frame the executor builds a passive BrainView
// (positions, distances, a lazy line-of-sight thunk, collision feedback),
// hands it to decide(), then realizes the returned BrainIntent: applies
// the movement step under world collision and fires if told to. Nothing in
// here may import the engine, world, audio or DOM — that is what keeps the
// policies unit-testable in plain Node (botBrains.test.ts), the same seam
// pattern as recoil.ts:convertOnSwap.
//
// The default policy: approach beyond farBand, back off inside nearBand,
// always drift perpendicular at strafeFactor weight with random jukes; fire
// only when a cooldown expires AND seeTarget() passes, retrying soon when
// sight is blocked so bullets respect cover like the player's do.
//
// STEERING IS PLANAR, RANGING IS NOT. `toTarget`/`dist` are y-stripped
// because a step only ever moves in x/z — the executor's shared vertical
// resolver owns height. But every RANGE decision (the bands, engageRange,
// which candidate to chase) reads the true 3D numbers, `dist3` and `rise`.
// Mixing those up is what made a target on a deck overhead read as "in my
// face at dist ~ 0" and pushed bots away from the stairs that reach it.
import * as THREE from 'three';

/** Tunables of a reactive policy. Lengths in metres, times in seconds. */
export interface BrainParams {
  /** Closer than this (3D): back off. */
  nearBand: number;
  /** Farther than this (3D): approach. */
  farBand: number;
  /** Perpendicular drift weight vs the radial band blend. */
  strafeFactor: number;
  /** Mean strafe-direction flips per second (the juke). */
  jukeRate: number;
  /** Never shoot beyond this 3D range. */
  engageRange: number;
  /** Cooldown while sight is blocked — a soon re-check, not a shot. */
  retryCooldown: number;
  /** Post-shot cooldown lower bound. */
  cooldownMin: number;
  /** Post-shot cooldown random span added to cooldownMin. */
  cooldownSpan: number;
  /** Spawn stagger lower bound (first-shot delay). */
  firstDelayMin: number;
  /** Spawn stagger random span added to firstDelayMin. */
  firstDelaySpan: number;
  /**
   * Rise (m) above which a target counts as on ANOTHER LEVEL rather than
   * merely up a kerb — above what the executor's feet-aware step-up
   * (collision.ts:STEP_HEIGHT) resolves by walking into it. Gates the
   * back-off suppression below, and entry into route mode.
   */
  climbThreshold: number;
  /**
   * Rise (m) at which routing stops. Deliberately far below climbThreshold:
   * a bot partway up a flight has already closed most of the gap, and exiting
   * at the entry threshold drops it back to band steering with a metre still
   * to climb — which is precisely where bots used to stall, one step short of
   * the deck.
   */
  climbExit: number;
  /**
   * Seconds of sustained step rejection before a routing bot decides it is
   * jammed rather than brushing past something.
   */
  stuckTime: number;
  /** Seconds a jammed bot commits to sliding one way along whatever blocks it. */
  commitTime: number;
  /**
   * Seconds a bot may fail to CLOSE on its target beyond farBand before it
   * stops trusting band steering and routes on the flat — the flat analogue
   * of climbThreshold's job: evidence gathered, not anticipation.
   */
  noProgressTime: number;
  /**
   * Closure (m), measured against where distance stood when the stall timer
   * last reset, that counts as progress. Deliberately several frames' worth:
   * real approach shrinks dist by selfSpeed·dt each frame (~0.06 m), and a
   * per-frame test would demand an epsilon below that and jitter would arm
   * the timer mid-approach.
   */
  noProgressEpsilon: number;
  /**
   * Growth (m) beyond that same baseline read as the GOAL FLEEING rather
   * than as stagnation: re-baseline and give steering a fresh chance.
   * Without it, chasing anything faster latches routing permanently even
   * though nothing is blocked.
   */
  fleeReset: number;
  /**
   * How much a metre of height counts against a metre of ground when
   * ranking targets. Above 1 because height is not distance: reaching it
   * costs a detour to whatever flight serves that level.
   */
  verticalWeight: number;
  /** Hit chance at point-blank. */
  hitChanceNear: number;
  /** Hit-chance falloff divisor: chance = near − dist / this. */
  hitChanceDivisor: number;
  /** Hit-chance floor — distant bots stay mostly noise, never harmless. */
  hitChanceMin: number;
  /** Damage of a landed bullet: lower bound… */
  damageMin: number;
  /** …plus rng()·span. */
  damageSpan: number;
}

/** The shipped bot behavior. */
export const DEFAULT_BRAIN_PARAMS: BrainParams = {
  nearBand: 7,
  farBand: 14,
  strafeFactor: 0.7,
  jukeRate: 0.5,
  engageRange: 45,
  retryCooldown: 0.3,
  cooldownMin: 0.7,
  cooldownSpan: 1.2,
  firstDelayMin: 1,
  firstDelaySpan: 2,
  climbThreshold: 1.5, // ≈ 5 risers; well clear of STEP_HEIGHT's 0.3
  climbExit: 0.45,     // just over one riser — keep routing to the last step
  stuckTime: 0.25,
  commitTime: 0.5,
  noProgressTime: 1.5,   // ~2 juke swings would be 4 s; 1.5 s is already patient
  noProgressEpsilon: 0.25, // ≈ 4 frames of full-speed closure
  fleeReset: 2,          // a target 2 m farther than the best seen is running, not stalling
  verticalWeight: 2,   // a deck 3.6 m up ranks like 7.2 m of extra ground
  hitChanceNear: 0.65,
  hitChanceDivisor: 80,
  hitChanceMin: 0.12,
  damageMin: 8,
  damageSpan: 14,
};

/**
 * Hit chance of a bot bullet at eye-to-eye 3D `dist`: linear falloff from
 * close range clamped to a floor, so distant bots are mostly noise.
 */
export function botHitChance(dist: number, params: BrainParams): number {
  return Math.max(params.hitChanceMin, params.hitChanceNear - dist / params.hitChanceDivisor);
}

/** Damage of a landed bot bullet, drawn via `rng` over [damageMin, damageMin + damageSpan]. */
export function botDamageRoll(rng: () => number, params: BrainParams): number {
  return params.damageMin + rng() * params.damageSpan;
}

/** A targetable entity as the executor presents it: position + liveness. */
export interface OpposingCandidate {
  /**
   * World-space FEET position to chase and range against. Feet, not eyes:
   * `pos.y` is compared against the bot's own feet to derive rise, so an
   * executor handing over an eye position injects phantom height.
   */
  pos: THREE.Vector3;
  alive: boolean;
}

/** How a brain ranks candidate targets; lower wins. Squared units. */
export type TargetScorer = (dx: number, dy: number, dz: number) => number;

/** Ground-only ranking: the pre-3D behavior, and the default here. */
const planarScore: TargetScorer = (dx, _dy, dz) => dx * dx + dz * dz;

/**
 * Best ALIVE candidate from `origin` under `score`, or undefined when
 * nothing is alive. Corpses never draw fire.
 *
 * The scorer is a parameter because "which enemy is worth chasing" is
 * policy, and policy lives in brains — see BotBrain.targetScore. It
 * defaults to flat ground distance so callers with no opinion (and the
 * pre-3D tests) get the original behavior.
 */
export function nearestOpposing<T extends OpposingCandidate>(
  origin: THREE.Vector3,
  candidates: readonly T[],
  score: TargetScorer = planarScore,
): T | undefined {
  let best: T | undefined;
  let bestScore = Infinity;
  for (const c of candidates) {
    if (!c.alive) continue;
    const s = score(c.pos.x - origin.x, c.pos.y - origin.y, c.pos.z - origin.z);
    if (s < bestScore) {
      bestScore = s;
      best = c;
    }
  }
  return best;
}

/** What a brain may know about the world this frame — all executor-supplied. */
export interface BrainView {
  /**
   * Planar vector from the bot to its target (y stripped). The STEERING
   * basis: a step only moves in x/z, and both the approach direction and the
   * perpendicular drift are derived from this vector. Ranging uses
   * dist3/rise instead.
   */
  toTarget: THREE.Vector3;
  /**
   * Planar distance to the target (=== toTarget.length()). Ground distance,
   * NOT the steering basis (that is the vector above) and no longer what the
   * bands read — they moved to dist3. Kept because ground distance is the
   * right measure of whether a bot is making headway toward its target —
   * what stuck detection and the flat-routing stall tracker both read.
   */
  dist: number;
  /** True eye-to-eye 3D distance — the same range the hit die rolls on. */
  dist3: number;
  /** Target feet minus this bot's feet (m). Positive: the target is above. */
  rise: number;
  /**
   * Resting on support this frame; false while airborne. Read by the jam
   * recovery below, which must not fire mid-fall: a falling bot's steps are
   * refused for reasons no amount of sliding sideways will fix.
   */
  onGround: boolean;
  targetAlive: boolean;
  /**
   * Line-of-sight probe to the target. A THUNK on purpose: the raycast
   * against world solids is only worth paying when the trigger is otherwise
   * ready, so the default policy calls it at most once per cooldown window.
   */
  seeTarget(): boolean;
  /** Movement speed (m/s) the executor can realize this frame. */
  selfSpeed: number;
  /** Whether LAST frame's step was rejected by world collision. */
  moveBlocked: boolean;
  /**
   * Planar vector to the next waypoint on the executor's route, or null when
   * it has none. A THUNK for the same reason seeTarget is: pathfinding is the
   * expensive thing here, so it is only asked for when the policy has already
   * decided it wants to travel.
   *
   * Relative, like toTarget — a brain never learns where it is, only which
   * way to go.
   */
  nextWaypoint(): THREE.Vector3 | null;
}

/**
 * What a brain is doing this frame, in one word.
 *
 * Reported for OBSERVABILITY, not consumed by the executor: hud.ts renders it
 * in the DEV bot readout, because "why is that bot doing that" is otherwise
 * only answerable by pausing in devtools.
 */
export type BrainMode = 'engage' | 'route';

/** What a brain wants done this frame. */
export interface BrainIntent {
  /** World-space displacement to attempt (already includes selfSpeed·dt). */
  step: THREE.Vector3;
  /** Loose a shot THIS frame; the executor owes it when true. */
  wantShoot: boolean;
  /** What the brain thinks it is doing; display only. */
  mode: BrainMode;
}

/** The decision half of a bot. Instances own per-bot state; executors are stateless shells. */
export interface BotBrain {
  decide(view: BrainView, dt: number): BrainIntent;
  /**
   * Clear per-life policy state.
   *
   * Brains outlive their bodies: the executor holds ONE brain per bot and
   * revives the mesh around it, so without this a respawned bot inherits
   * whatever shot cooldown its corpse was carrying. The staggered first shot
   * — the thing that stops a wave volleying in unison — then applies exactly
   * once per match, at construction, and never again.
   */
  onRespawn(): void;
  /** Rank a candidate target by its offset from this bot; lower wins. */
  targetScore: TargetScorer;
  /** Hit probability for a shot at eye-to-eye 3D `dist` under this brain's accuracy. */
  hitChance(dist: number): number;
  /** Draw one hit/miss outcome for a shot at eye-to-eye 3D `dist` from this
   *  brain's rng stream — ALL of a bot's dice come from the brain, never a
   *  global. */
  rollHit(dist: number): boolean;
  /** Draw one landed-shot damage from this brain's ballistic params. */
  rollDamage(): number;
  /**
   * Whether a target at eye-to-eye 3D `dist` passes this brain's engage
   * gate — the same exclusive comparison decide()'s trigger applies before
   * it ever probes sight. Exposed so a display-only consumer can report
   * "would fire" without reading params, like hitChance above.
   */
  inRange(dist: number): boolean;
}

/** The shipped bot policy, parameterized for future variants. */
export class DefaultBrain implements BotBrain {
  private strafeDir: 1 | -1;
  private cooldown: number;
  /** True while following the executor's route rather than steering at the target. */
  private routing = false;
  /** Seconds of CONSECUTIVE refused steps while routing; any frame that moves resets it. */
  private blockedFor = 0;
  /** Seconds left on a committed sideways slide past whatever is jamming us. */
  private commitLeft = 0;
  /** Which way the last slide went; the next one takes the other. */
  private slideDir: 1 | -1 = 1;
  /**
   * Planar distance to the target when the stall tracker last reset — the
   * baseline closure is measured against. Infinity until a real reading
   * adopts it, so the first frame of any life counts as progress.
   */
  private stallBase = Infinity;
  /** Seconds spent beyond farBand without closing on that baseline. */
  private stalledFor = 0;
  /**
   * The flat-routing latch, raised when stalledFor reaches noProgressTime
   * and held until dist3 comes back inside farBand — the same
   * evidence-then-hand-over shape as the climb gate's hysteresis, with the
   * band boundary doing what climbExit does there.
   */
  private flatRouted = false;
  /**
   * Whether LAST frame's step was rejected by geometry. The drift reversal
   * is EDGE-triggered on this (#43): a level-triggered flip re-reverses
   * every frame a bot rests against a wall, and ~60 reversals a second
   * cancel the perpendicular component to zero while the radial term keeps
   * pushing in — the wall-grind playtesters watched.
   */
  private wasBlocked = false;
  /**
   * Sight state from the trigger's most recent probe (#45). While blocked,
   * the juke is suppressed so the strafe COMMITS one way instead of pacing
   * across the face of whatever is occluding — the trap where a bot holds
   * band range forever, re-probing every retryCooldown and never rounding
   * the corner between it and its target. Cleared by any successful probe,
   * or when the target leaves the trigger's range/alive gate.
   */
  private sightBlocked = false;

  constructor(
    private readonly params: BrainParams = DEFAULT_BRAIN_PARAMS,
    private rng: () => number = Math.random,
  ) {
    this.strafeDir = this.rng() < 0.5 ? -1 : 1;
    // Staggered first shot so a fresh wave doesn't volley in unison.
    this.cooldown = this.params.firstDelayMin + this.rng() * this.params.firstDelaySpan;
  }

  /**
   * Bound so the executor can hand it straight to nearestOpposing without
   * losing `this` (and without allocating a closure every frame).
   */
  targetScore: TargetScorer = (dx, dy, dz) => {
    const weighted = this.params.verticalWeight * dy;
    return dx * dx + dz * dz + weighted * weighted;
  };

  /**
    * Re-arm the spawn stagger from this brain's own rng, like the constructor
    * does. One draw, taken outside decide() so the per-frame draw sequence
    * the tests script against is untouched.
    */
  onRespawn(): void {
    this.cooldown = this.params.firstDelayMin + this.rng() * this.params.firstDelaySpan;
    this.routing = false;
    this.blockedFor = 0;
    this.commitLeft = 0;
    this.flatRouted = false;
    this.stalledFor = 0;
    this.stallBase = Infinity;
    this.wasBlocked = false;
    this.sightBlocked = false;
  }

  hitChance(dist: number): number {
    return botHitChance(dist, this.params);
  }

  rollHit(dist: number): boolean {
    return this.rng() < botHitChance(dist, this.params);
  }

  rollDamage(): number {
    return botDamageRoll(this.rng, this.params);
  }

  inRange(dist: number): boolean {
    return dist < this.params.engageRange;
  }

  /**
   * Walk the route: straight at the waypoint, with an explicit recovery when
   * geometry keeps refusing the step.
   *
   * NO perpendicular drift here, unlike engage. Measured on the elevation map
   * over four start positions: steering at waypoints with the shipped 0.7
   * drift jams approaching the external stair, 0.15–0.2 jams on the internal
   * flight's west edge, and only ~0.1 cleared every route — a single magic
   * value holding by luck. Drift is combat maneuvering that happens to
   * unstick things; it is not a recovery, and leaning on it as one is what
   * made the working value so narrow.
   *
   * The designed recovery is below: sustained rejection commits the bot to
   * sliding one way along whatever blocks it, alternating side between
   * attempts. With it, all four routes complete at zero drift.
   */
  private travel(step: THREE.Vector3, waypoint: THREE.Vector3, view: BrainView, dt: number): void {
    if (view.moveBlocked) this.blockedFor += dt;
    else this.blockedFor = 0;

    if (this.commitLeft > 0) {
      this.commitLeft -= dt;
    } else if (this.blockedFor >= this.params.stuckTime && view.onGround) {
      // Airborne is excluded: a falling bot's steps are refused for reasons
      // sliding sideways cannot fix.
      this.commitLeft = this.params.commitTime;
      this.slideDir = this.slideDir === 1 ? -1 : 1;
    }

    const heading = waypoint.clone().setY(0).normalize();
    if (this.commitLeft > 0) {
      step.set(-heading.z * this.slideDir, 0, heading.x * this.slideDir);
    } else {
      step.copy(heading);
    }
    step.normalize().multiplyScalar(view.selfSpeed * dt);
  }

  decide(view: BrainView, dt: number): BrainIntent {
    const dir = view.toTarget.clone().normalize();

    // Collision feedback from LAST frame's application: bumped geometry
    // reverses the drift, starting with this frame's step (the original
    // flipped between frames, not within one). EDGE-triggered (#43): a run
    // of blocked frames is ONE contact event and flips once — flipping per
    // frame re-reverses ~60×/s against a wall face and the perpendicular
    // component cancels itself out while the radial term keeps pushing in.
    // One flip gives a committed direction to clear the obstacle in, the
    // same principle travel()'s slide commits use for routing bots.
    if (view.moveBlocked && !this.wasBlocked) this.strafeDir = this.strafeDir === 1 ? -1 : 1;
    this.wasBlocked = view.moveBlocked;

    // Route when the target is a level up and the executor has a way there.
    // Hysteresis is wide on purpose: entry needs climbThreshold, but exit
    // waits for climbExit, because a bot partway up a flight still reads a
    // rise of a metre or so and dropping it back to band steering there is
    // exactly the stall this replaces — orbiting one step short of the deck.
    const climbWants = this.routing
      ? view.rise > this.params.climbExit
      : view.rise > this.params.climbThreshold;

    // The flat analogue (issue #44): band steering has no representation of
    // obstacles, so when it demonstrably cannot close — pacing beyond
    // farBand with planar distance pinned against a baseline — hand the
    // problem to the graph. Tracking is gated on being OUTSIDE farBand:
    // in-band pacing at constant radius is engagement, not failure (#45's
    // pure-strafe hold), and arming here would route-mode every firefight.
    // Closure is measured over several frames' worth of movement
    // (noProgressEpsilon) rather than per frame, so ordinary approach never
    // reads as stalled; growth past fleeReset re-baselines instead of
    // arming, because a fleeing goal is not stagnation.
    if (this.flatRouted) {
      if (!climbWants && view.dist3 <= this.params.farBand) {
        // Back inside the band: steering owns the problem again. Re-baseline
        // so a fresh wedge has to earn a fresh latch.
        this.flatRouted = false;
        this.stalledFor = 0;
        this.stallBase = view.dist;
      }
    } else if (!climbWants) {
      if (view.dist3 <= this.params.farBand || view.dist <= this.stallBase - this.params.noProgressEpsilon) {
        this.stallBase = view.dist;
        this.stalledFor = 0;
      } else if (view.dist >= this.stallBase + this.params.fleeReset) {
        this.stallBase = view.dist;
        this.stalledFor = 0;
      } else {
        this.stalledFor += dt;
        if (this.stalledFor >= this.params.noProgressTime) {
          this.flatRouted = true;
          this.stalledFor = 0;
          this.stallBase = view.dist;
        }
      }
    }

    const wantRoute = climbWants || this.flatRouted;
    const waypoint = wantRoute ? view.nextWaypoint() : null;
    this.routing = waypoint !== null;

    const step = new THREE.Vector3();
    if (this.routing) {
      this.travel(step, waypoint!, view, dt);
    } else {
      this.blockedFor = 0;
      this.commitLeft = 0;
      // Movement blend: radial band preference plus a perpendicular drift
      // component, normalized and scaled to the realized speed.
      //
      // The band reads dist3, not the planar dist: a target on a deck 3.6 m up
      // is 3.6 m away even when standing on your head, and ranging it as 0
      // is what made bots retreat from the building they needed to enter.
      // Back-off is suppressed outright while the target is a level above —
      // you cannot reverse away from something overhead, and trying only
      // widens the gap to whatever flight reaches it.
      const overhead = view.rise > this.params.climbThreshold;
      if (view.dist3 > this.params.farBand || overhead) step.add(dir);
      else if (view.dist3 < this.params.nearBand) step.sub(dir);
      const strafe = new THREE.Vector3(-view.toTarget.z, 0, view.toTarget.x)
        .normalize()
        .multiplyScalar(this.strafeDir * this.params.strafeFactor);
      step.add(strafe).normalize().multiplyScalar(view.selfSpeed * dt);
    }

    // Random juke (~jukeRate flips/sec); drawn after the step like the
    // original statement order, so it steers from the NEXT frame on.
    // SUPPRESSED while sight is blocked (#45): a coin-flip drift across the
    // face of the cover that occludes paces forever — the corner trap —
    // while a committed one walks around it. The draw is still consumed so
    // the rng stream the tests script against is unchanged either way.
    if (this.rng() < dt * this.params.jukeRate && !this.sightBlocked) {
      this.strafeDir = this.strafeDir === 1 ? -1 : 1;
    }

    // Trigger: cooldown-gated, range-gated, target-gated, LOS-gated. The
    // range gate reads dist3 so it agrees with the die rollHit rolls on;
    // gating on planar distance let a bot on a tower open up on something
    // its own accuracy curve had already written off. Blocked sight retries
    // on the short retryCooldown instead of firing through cover — and each
    // blocked retry records sightBlocked for the movement policy above, so
    // the strafe commits while the probe cadence (0.3 s) keeps the reading
    // fresh. A target outside the range/alive gate is not being probed, so it
    // cannot keep an old blocked result latched. One-frame lag is deliberate:
    // the observation lands after this frame's step, like moveBlocked.
    let wantShoot = false;
    this.cooldown -= dt;
    const targetEligible = view.dist3 < this.params.engageRange && view.targetAlive;
    if (!targetEligible) {
      this.sightBlocked = false;
    } else if (this.cooldown <= 0) {
      if (view.seeTarget()) {
        this.sightBlocked = false;
        this.cooldown = this.params.cooldownMin + this.rng() * this.params.cooldownSpan;
        wantShoot = true;
      } else {
        this.sightBlocked = true;
        this.cooldown = this.params.retryCooldown;
      }
    }

    return { step, wantShoot, mode: this.routing ? 'route' : 'engage' };
  }
}
