// botBrains.ts — bot decision policies as an engine-free seam.
//
// Division of labor with the concrete Bot (bots.ts): a BotBrain DECIDES,
// the Bot EXECUTES. Each frame the executor runs ONE visual acquisition
// (sim/perception.ts) over the opposing candidates and hands the brain a
// passive BrainView — own feet and facing, the frame's zero-or-one visual
// observation, movement feedback — then realizes the returned BrainIntent:
// applies the movement step under world collision, turns the body to the
// intent facing, aims the barrel at the intent lookAt, and realizes a shot
// only when the frame's observation agrees with the intent's focus. Nothing
// in here may import the engine, world, audio or DOM — that is what keeps
// the policies unit-testable in plain Node (botBrains.test.ts), the same
// seam pattern as recoil.ts:convertOnSwap.
//
// The default policy: with a current visual observation, engage — approach
// beyond farBand, back off inside nearBand, drift perpendicular with random
// jukes, route when the observation sits a level up or band steering
// demonstrably cannot close, fire on cooldown. On sight loss the LAST KNOWN
// position is pursued: the brain routes to the frozen remembered feet, and on
// arrival (or a confirmed dead end) switches to a three-heading scan
// (`search`) that forgets after `forgetTime`. A direction-only incoming-fire
// bearing (onIncomingFire) outranks everything for one frame and starts a
// search where the shot came from. Only a CURRENT visible observation can
// order a shot — memory, search and damage reactions never fire.
//
// STEERING IS PLANAR, RANGING IS NOT. The steering basis derived from the
// observation's feet is y-stripped because a step only ever moves in x/z —
// the executor's shared vertical resolver owns height. But every RANGE
// decision (the bands, engageRange) reads the true 3D numbers, `dist3` and
// `rise`. Mixing those up is what made a target on a deck overhead read as
// "in my face at dist ~ 0" and pushed bots away from the stairs that reach it.
import * as THREE from 'three';
import type { PerceptionId, VisualObservation } from './perception';

/** Shared +Y axis for the scan rotation (Three.js positive-Y convention). */
const UP_Y = new THREE.Vector3(0, 1, 0);

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
  /**
   * Planar distance (m) at which a memory pursuit counts as ARRIVED: the
   * search begins here without asking the graph again. Inclusive boundary.
   */
  memoryArrivalRadius: number;
  /** Seconds per heading of the three-phase search scan. */
  scanPhase: number;
  /** Seconds a search runs from ENTRY before the memory is dropped (hold). */
  forgetTime: number;
}

/** The shipped bot behavior. */
export const DEFAULT_BRAIN_PARAMS: BrainParams = {
  nearBand: 7,
  farBand: 14,
  strafeFactor: 0.7,
  jukeRate: 0.5,
  engageRange: 45,
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
  hitChanceNear: 0.65,
  hitChanceDivisor: 80,
  hitChanceMin: 0.12,
  damageMin: 8,
  damageSpan: 14,
  memoryArrivalRadius: 1, // planar; reached the remembered spot → scan here
  scanPhase: 0.75,        // per heading; the full sweep repeats every 2.25 s
  forgetTime: 8,          // drop the memory 8 s after the search began
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

/** What a brain may know about the world this frame — all executor-supplied. */
export interface BrainView {
  /**
   * This bot's own world-space FEET position. Read-only basis: the planar
   * steering vector and closure measure are derived from it and the
   * observation; the brain must not mutate it.
   */
  selfFeet: THREE.Vector3;
  /**
   * This bot's own normalized planar facing (its mesh yaw basis). The
   * degenerate-vector fallback for an intent facing, and the facing a
   * holding bot preserves.
   */
  facing: THREE.Vector3;
  /**
   * The frame's visual observation, or null when nothing was seen this
   * frame. This is the ONLY target knowledge a brain gets — no positions,
   * distances or liveness for anything the bot did not just look at.
   */
  visual: VisualObservation | null;
  /**
   * Resting on support this frame; false while airborne. Read by the jam
   * recovery below, which must not fire mid-fall: a falling bot's steps are
   * refused for reasons no amount of sliding sideways will fix.
   */
  onGround: boolean;
  /** Movement speed (m/s) the executor can realize this frame. */
  selfSpeed: number;
  /** Whether LAST frame's step was rejected by world collision. */
  moveBlocked: boolean;
  /**
   * Planar vector to the next waypoint on the executor's route toward
   * `goal`, with a THREE-way outcome so a policy can tell waiting from a
   * dead end without any extra pathfinding:
   *
   * - a `Vector3`: the next relative waypoint — walk it;
   * - `undefined`: the shared one-A-star-per-frame budget DEFERRED the
   *   request — nothing is known about the route, wait and ask again next
   *   frame;
   * - `null`: the graph was asked and confirmed there is NO route.
   *
   * Relative to the bot's own feet — a brain never learns where it is, only
   * which way to go.
   */
  nextWaypoint(goal: THREE.Vector3): THREE.Vector3 | undefined | null;
}

/**
 * What a brain is doing this frame, in one word.
 *
 * `engage` and `route` are the two active modes; `search` scans in place
 * from a remembered position's arrival, a routing dead end, or a
 * direction-only incoming-fire bearing; `hold` stands still on forget (or,
 * pre-memory, on plain sight loss). Reported for OBSERVABILITY, not
 * consumed by the executor: hud.ts renders it in the DEV bot readout,
 * because "why is that bot doing that" is otherwise only answerable by
 * pausing in devtools.
 */
export type BrainMode = 'hold' | 'search' | 'route' | 'engage';

/** What a brain wants done this frame. */
export interface BrainIntent {
  /** World-space displacement to attempt (already includes selfSpeed·dt). */
  step: THREE.Vector3;
  /** Loose a shot THIS frame; the executor owes it when true. */
  wantShoot: boolean;
  /** What the brain thinks it is doing; display only. */
  mode: BrainMode;
  /**
   * The identity the brain's attention is on — the observed one when a
   * visual exists, else the retained focus across temporary sight loss.
   * The executor only realizes a shot when the SAME frame's observation
   * carries this id.
   */
  focusId: PerceptionId | null;
  /**
   * World-space point to look at (a copy), or null when the brain has
   * nothing to look at — a holding bot exposes none and the executor keeps
   * the last barrel pose.
   */
  lookAt: THREE.Vector3 | null;
  /**
   * Normalized planar direction the body should face this frame: toward the
   * visible point when one exists, else the bot's own facing preserved.
   */
  facing: THREE.Vector3;
}

/** The decision half of a bot. Instances own per-bot state; executors are stateless shells. */
export interface BotBrain {
  decide(view: BrainView, dt: number): BrainIntent;
  /**
   * Direction-only "the shot came from this way" stimulus: `bearing` is a
   * planar victim-to-attacker direction, copied and normalized on receipt.
   * It becomes the NEXT decision's highest-priority stimulus — outranking a
   * same-frame visual — and starts a search at that bearing. No identity,
   * distance or destination travels with it; a zero planar vector is
   * ignored defensively.
   */
  onIncomingFire(bearing: THREE.Vector3): void;
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
  /**
   * The brain's current focus identity, read-only: which perceivable entity
   * its attention is on (null before the first observation of a life). The
   * executor feeds it back as acquisition's focus so a tracked identity is
   * probed first.
   */
  readonly focusId: PerceptionId | null;
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
   * it orders a shot. Exposed so the executor can require intent/observation
   * agreement before realizing one, and so a display-only consumer can
   * report "would fire" without reading params.
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
   * The identity this brain's attention is on: the last observed id, held
   * across temporary sight loss so acquisition probes it first when the
   * look could plausibly succeed again. Cleared by onRespawn — a new life
   * does not inherit the corpse's attention.
   */
  private focus: PerceptionId | null = null;
  /**
   * Frozen last-known position: cloned feet and eye from the most recent
   * visual observation. COPIES, never a live reference — the observation is
   * the executor's and the target moves. Pursued on sight loss; dropped by
   * the search expiry and onRespawn.
   */
  private memory: { feet: THREE.Vector3; eye: THREE.Vector3 } | null = null;
  /** True while an active search owns the bot (the forget timer runs). */
  private searching = false;
  /** Normalized planar base bearing of the active search; null when none. */
  private scanBase: THREE.Vector3 | null = null;
  /** Seconds since the active search began. */
  private scanElapsed = 0;
  /**
   * Copied normalized planar victim-to-attacker bearing awaiting the next
   * decision, or null. Set by onIncomingFire, consumed by the next decide().
   */
  private pendingBearing: THREE.Vector3 | null = null;

  constructor(
    private readonly params: BrainParams = DEFAULT_BRAIN_PARAMS,
    private rng: () => number = Math.random,
  ) {
    this.strafeDir = this.rng() < 0.5 ? -1 : 1;
    // Staggered first shot so a fresh wave doesn't volley in unison.
    this.cooldown = this.params.firstDelayMin + this.rng() * this.params.firstDelaySpan;
  }

  /** Read-only focus exposure for the executor's acquisition call. */
  get focusId(): PerceptionId | null {
    return this.focus;
  }

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
    this.focus = null;
    this.memory = null;
    this.searching = false;
    this.scanBase = null;
    this.scanElapsed = 0;
    this.pendingBearing = null;
  }

  /** See BotBrain.onIncomingFire. The bearing is copied and planar-normalized. */
  onIncomingFire(bearing: THREE.Vector3): void {
    const planar = new THREE.Vector3(bearing.x, 0, bearing.z);
    // Zero planar vector (or an all-vertical one): no direction to remember.
    if (planar.lengthSq() === 0) return;
    this.pendingBearing = planar.normalize();
  }

  /** Drop the routing/jam/stall machinery shared by the pursue and search handovers. */
  private clearPursuitState(): void {
    this.routing = false;
    this.blockedFor = 0;
    this.commitLeft = 0;
    this.flatRouted = false;
    this.stalledFor = 0;
    this.stallBase = Infinity;
    this.wasBlocked = false;
  }

  /** Begin a scan at `base`: elapsed zero, every pursuit state dropped. */
  private enterSearch(base: THREE.Vector3): void {
    this.searching = true;
    this.scanBase = base.clone();
    this.scanElapsed = 0;
    this.clearPursuitState();
  }

  /** Heading for the current scan phase: base, base+120°, base−120°, repeating. */
  private scanHeading(): THREE.Vector3 {
    const phase = Math.floor(this.scanElapsed / this.params.scanPhase) % 3;
    if (phase === 0) return this.scanBase!.clone();
    const offset = phase === 1 ? (2 * Math.PI) / 3 : -(2 * Math.PI) / 3;
    return this.scanBase!.clone().applyAxisAngle(UP_Y, offset);
  }

  /**
   * Intent for a search frame: stand still, face `heading`, look along it.
   * The lookAt point rides the FROZEN eye height while memory exists; a
   * direction-only damage search (memory already cleared) uses the bot eye
   * convention off the bot's own feet.
   */
  private searchFrameIntent(view: BrainView, heading: THREE.Vector3): BrainIntent {
    const eyeY = this.memory !== null ? this.memory.eye.y : view.selfFeet.y + 1.9;
    const lookAt = new THREE.Vector3(view.selfFeet.x + heading.x, eyeY, view.selfFeet.z + heading.z);
    return {
      step: new THREE.Vector3(),
      wantShoot: false,
      mode: 'search',
      focusId: this.focus,
      lookAt,
      facing: heading.clone(),
    };
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
    // One juke draw per frame and one reroll on fire, whatever the mode —
    // the draw contract the tests script against. (Drawn up front so every
    // path below consumes it.)
    const jukeDraw = this.rng();
    this.cooldown -= dt;

    // Priority 1: a pending incoming-fire bearing — even over a same-frame
    // visual. The shot's direction is ALL that is known: no identity, no
    // distance, no destination. Drop the focus and any remembered position,
    // and search where it came from; a later ordinary visual observation
    // replaces this normally.
    if (this.pendingBearing !== null) {
      const bearing = this.pendingBearing;
      this.pendingBearing = null;
      this.focus = null;
      this.memory = null;
      this.enterSearch(bearing);
      if (jukeDraw < dt * this.params.jukeRate) {
        this.strafeDir = this.strafeDir === 1 ? -1 : 1;
      }
      return this.searchFrameIntent(view, bearing);
    }

    const vis = view.visual;
    if (vis) {
      return this.visualIntent(view, vis, dt, jukeDraw);
    }

    // Priority 3a: an active scan continues — stand still, never shoot,
    // age the forget timer (which started only at search ENTRY, so route
    // walks and deferred frames never aged the memory).
    if (this.searching) {
      if (jukeDraw < dt * this.params.jukeRate) {
        this.strafeDir = this.strafeDir === 1 ? -1 : 1;
      }
      this.scanElapsed += dt;
      if (this.scanElapsed >= this.params.forgetTime) {
        // Forget: drop memory and every pursuit/scan state, hold facing.
        this.focus = null;
        this.memory = null;
        this.searching = false;
        this.scanBase = null;
        this.scanElapsed = 0;
        this.clearPursuitState();
        return {
          step: new THREE.Vector3(),
          wantShoot: false,
          mode: 'hold',
          focusId: null,
          lookAt: null,
          facing: view.facing.clone(),
        };
      }
      return this.searchFrameIntent(view, this.scanHeading());
    }

    // Priority 3b: sight lost with a remembered position — pursue it.
    if (this.memory !== null) {
      return this.memoryIntent(view, dt, jukeDraw);
    }

    // Nothing seen, nothing remembered: hold. Stand still, keep the facing
    // the body already has, expose no lookAt, never fire. The identity stays
    // tracked so acquisition probes it first once a look could plausibly
    // succeed again.
    if (jukeDraw < dt * this.params.jukeRate) {
      this.strafeDir = this.strafeDir === 1 ? -1 : 1;
    }
    return {
      step: new THREE.Vector3(),
      wantShoot: false,
      mode: 'hold',
      focusId: this.focus,
      lookAt: null,
      facing: view.facing.clone(),
    };
  }

  /**
   * Priority 2: a current visual observation. Refreshes the focus and the
   * cloned feet/eye memory, exits any active search, then runs the existing
   * visible engage/route policy — collision recovery, stagnation, juke,
   * fire cadence — unchanged.
   */
  private visualIntent(view: BrainView, vis: VisualObservation, dt: number, jukeDraw: number): BrainIntent {
    this.focus = vis.id;
    // Freeze the last-known position: COPIES of the observation's geometry —
    // the observation belongs to the executor and the target moves.
    this.memory = { feet: vis.feet.clone(), eye: vis.eye.clone() };
    // A look exits any active scan.
    this.searching = false;
    this.scanBase = null;
    this.scanElapsed = 0;

    // Planar steering basis, derived from the observation — the only target
    // geometry the brain has. STEERING is planar (a step only ever moves in
    // x/z); ranging reads the observation's true 3D numbers instead.
    const toTarget = new THREE.Vector3(vis.feet.x - view.selfFeet.x, 0, vis.feet.z - view.selfFeet.z);
    const dist = toTarget.length();
    const dir = dist > 1e-9 ? toTarget.clone().multiplyScalar(1 / dist) : new THREE.Vector3();
    const dist3 = vis.dist3;
    const rise = vis.rise;

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
      ? rise > this.params.climbExit
      : rise > this.params.climbThreshold;

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
      if (!climbWants && dist3 <= this.params.farBand) {
        // Back inside the band: steering owns the problem again. Re-baseline
        // so a fresh wedge has to earn a fresh latch.
        this.flatRouted = false;
        this.stalledFor = 0;
        this.stallBase = dist;
      }
    } else if (!climbWants) {
      if (dist3 <= this.params.farBand || dist <= this.stallBase - this.params.noProgressEpsilon) {
        this.stallBase = dist;
        this.stalledFor = 0;
      } else if (dist >= this.stallBase + this.params.fleeReset) {
        this.stallBase = dist;
        this.stalledFor = 0;
      } else {
        this.stalledFor += dt;
        if (this.stalledFor >= this.params.noProgressTime) {
          this.flatRouted = true;
          this.stalledFor = 0;
          this.stallBase = dist;
        }
      }
    }

    const wantRoute = climbWants || this.flatRouted;
    const requested = wantRoute ? view.nextWaypoint(vis.feet) : null;
    // undefined (budget deferred) falls back to band steering at the VISIBLE
    // target — the observation is fresh, so steering at it is never worse
    // than standing still. null keeps the existing no-route fallback.
    const waypoint = requested === undefined ? null : requested;
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
      const overhead = rise > this.params.climbThreshold;
      if (dist3 > this.params.farBand || overhead) step.add(dir);
      else if (dist3 < this.params.nearBand) step.sub(dir);
      const strafe = new THREE.Vector3(-toTarget.z, 0, toTarget.x)
        .normalize()
        .multiplyScalar(this.strafeDir * this.params.strafeFactor);
      step.add(strafe).normalize().multiplyScalar(view.selfSpeed * dt);
    }

    // Random juke (~jukeRate flips/sec). The draw was hoisted to the top of
    // decide() (one draw per frame in every mode); the FLIP lands after this
    // frame's step, the original statement order, so it steers from the NEXT
    // frame on.
    if (jukeDraw < dt * this.params.jukeRate) {
      this.strafeDir = this.strafeDir === 1 ? -1 : 1;
    }

    // Trigger: cooldown-gated, range-gated. There is NO LOS probe here — the
    // observation IS this frame's successful look (acquisition spent the
    // frame's one ray), so a visible target inside engage range fires when
    // the cooldown expires, and the old blocked-sight retry path is gone: a
    // target that stops being seen stops being engaged (hold), not re-probed.
    let wantShoot = false;
    if (dist3 < this.params.engageRange && this.cooldown <= 0) {
      this.cooldown = this.params.cooldownMin + this.rng() * this.params.cooldownSpan;
      wantShoot = true;
    }

    // Face what the bot sees. The normalized planar direction to the visible
    // point, falling back to the body's own facing when the point is
    // degenerate (zero planar offset).
    const facing = dist > 1e-9 ? dir.clone() : view.facing.clone();

    return {
      step,
      wantShoot,
      mode: this.routing ? 'route' : 'engage',
      focusId: this.focus,
      lookAt: vis.eye.clone(),
      facing,
    };
  }

  /**
   * Priority 3: pursue the frozen last-known position. Route to the
   * remembered FEET — never a candidate's live position — face the frozen
   * point, and NEVER shoot: the memory is not sight, and no ray was spent
   * to confirm anything is still there. A deferred route waits in `route`
   * with zero step (and does not age the forget timer, which starts only at
   * search entry); a confirmed dead end and the inclusive arrival radius
   * hand over to a search, with the arrival direction as its base bearing.
   */
  private memoryIntent(view: BrainView, dt: number, jukeDraw: number): BrainIntent {
    const mem = this.memory!;
    const toMem = new THREE.Vector3(mem.feet.x - view.selfFeet.x, 0, mem.feet.z - view.selfFeet.z);
    const dist = toMem.length();
    const toward = dist > 1e-9 ? toMem.clone().multiplyScalar(1 / dist) : view.facing.clone();

    // Arrived (inclusive boundary): scan here without asking the graph again.
    if (dist <= this.params.memoryArrivalRadius) {
      this.enterSearch(toward);
      if (jukeDraw < dt * this.params.jukeRate) {
        this.strafeDir = this.strafeDir === 1 ? -1 : 1;
      }
      return this.searchFrameIntent(view, toward);
    }

    const waypoint = view.nextWaypoint(mem.feet);
    if (waypoint === undefined) {
      // Budget deferred: wait in place. Zero step, forget timer untouched —
      // only a search ages the memory.
      return {
        step: new THREE.Vector3(),
        wantShoot: false,
        mode: 'route',
        focusId: this.focus,
        lookAt: mem.eye.clone(),
        facing: toward.clone(),
      };
    }
    if (waypoint === null) {
      // The graph confirmed there is no way there: search where we stand.
      this.enterSearch(toward);
      if (jukeDraw < dt * this.params.jukeRate) {
        this.strafeDir = this.strafeDir === 1 ? -1 : 1;
      }
      return this.searchFrameIntent(view, toward);
    }
    // A real waypoint: the executor's existing travel() recovery applies.
    const step = new THREE.Vector3();
    this.travel(step, waypoint, view, dt);
    return {
      step,
      wantShoot: false,
      mode: 'route',
      focusId: this.focus,
      lookAt: mem.eye.clone(),
      facing: toward.clone(),
    };
  }
}
